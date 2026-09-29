import { fail } from '@sveltejs/kit';
import { and, count, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import * as v from 'valibot';
import { purchase, recurringRule } from '$lib/db/schema';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import {
	RecurrenceError,
	describeRecurrence,
	formatRRule,
	parseRRule,
	type Recurrence
} from '$lib/domain/recurrence/rrule';
import {
	RecurringRuleError,
	materializeDueRules,
	createRule,
	deleteRule,
	endRule,
	pauseRule,
	restartRule,
	resumeRule,
	updateRule,
	type UpdateRuleCmd
} from '$lib/application/recurring';
import { listCategories } from '$lib/repo/workspaces';
import { annualMinor, costByCategory, type CategoryCost } from '$lib/domain/recurrence/cost';
import { NO_CATEGORY } from '$lib/ledger-filters';
import { calDateInZone, formatCalDate } from '$lib/domain/time/zoned';
import { addDays } from '$lib/domain/recurrence/rrule';
import { periodBoundsUtc } from '$lib/domain/analytics/period';
import { visibleTo } from '$lib/repo/purchases';
import { listBuckets } from '$lib/repo/buckets';
import { refuseBucketCharge } from '$lib/domain/bucket/scope';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import type { WorkspaceContext } from '$lib/ports/context';

export async function load(ctx: WorkspaceContext, { params }: { params: { workspace: string } }) {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const db = ctx.db;
	const now = ctx.deps.clock.now();
	/*
	 * "The last 12 months" as calendar days where the household lives — a year
	 * ago today through today — so the figure and the ledger it links to are cut
	 * on the same boundaries and the rows add up to the number that was tapped.
	 */
	const today = calDateInZone(now, ctx.workspace.timezone);
	const chargedWindow = { from: addDays(today, -365), to: today };
	const chargedBounds = periodBoundsUtc(
		{ from: chargedWindow.from, toExclusive: addDays(today, 1) },
		ctx.workspace.timezone
	);
	const [rules, categories, buckets, confirmRow, spendRows, chargedRows] = await Promise.all([
		db.select().from(recurringRule).where(eq(recurringRule.workspaceId, ctx.workspace.id)),
		listCategories(db, ctx.workspace.id),
		listBuckets(db, ctx.workspace.id, { viewerId: ctx.member.id, now: ctx.deps.clock.now() }),
		// My recurring charges that landed but still need the real amount recorded —
		// the ledger's "Confirm what you paid" section is where you clear them.
		db
			.select({ count: count() })
			.from(purchase)
			.where(
				and(
					eq(purchase.workspaceId, ctx.workspace.id),
					eq(purchase.memberId, ctx.member.id),
					eq(purchase.state, 'approved'),
					isNotNull(purchase.recurringRuleId)
				)
			),
		// What each rule has actually cost, for the lifetime figure on an ended
		// row. Same convention as repo/analytics.ts: the final amount summed over
		// completed and refunded rows, so a partial refund subtracts and a fully
		// refunded charge nets to zero.
		//
		// No `visibleTo` seal-scoping, unlike every other spend query in the app:
		// materializeDueRules sets sealedUntil unconditionally to null, so a
		// recurring charge is never sealed and there is nothing to scope away.
		db
			.select({
				ruleId: purchase.recurringRuleId,
				totalMinor: sql<string>`coalesce(sum(${purchase.finalAmountMinor}), 0)`,
				charges: count()
			})
			.from(purchase)
			.where(
				and(
					eq(purchase.workspaceId, ctx.workspace.id),
					isNotNull(purchase.recurringRuleId),
					inArray(purchase.state, ['completed', 'refunded'])
				)
			)
			.groupBy(purchase.recurringRuleId),
		/*
		 * What rules actually charged in the last twelve months, by category — the
		 * other half of "what am I spending on subscriptions". The breakdown above
		 * is the plan, from today's prices; this is what landed, price rises and
		 * cancelled months included. Grouped by the purchase's own category, which
		 * is the rule's at the time of the charge.
		 *
		 * Seal-scoped even though a rule's charges are never sealed (see above):
		 * this is a figure shown to a person, and every such figure goes through
		 * the filter, so a future sealable charge can't slip past it here.
		 */
		db
			.select({
				categoryId: purchase.categoryId,
				totalMinor: sql<string>`coalesce(sum(${purchase.finalAmountMinor}), 0)`
			})
			.from(purchase)
			.where(
				and(
					eq(purchase.workspaceId, ctx.workspace.id),
					isNotNull(purchase.recurringRuleId),
					inArray(purchase.state, ['completed', 'refunded']),
					gte(purchase.completedAt, chargedBounds.from),
					lt(purchase.completedAt, chargedBounds.to),
					visibleTo(ctx.member.id, now)
				)
			)
			.groupBy(purchase.categoryId)
	]);

	// Household outflow across every active rule, normalized to a common period,
	// and the same figure cut by category: rent and a streaming service are both
	// "recurring", and bundled together the second disappears into the first.
	const cost = costByCategory(rules);
	const categoryById = new Map(categories.map((c) => [c.id, c]));
	// Keyed like the breakdown: a charge under an archived category counts
	// toward the uncategorized remainder, as the plan side does.
	const charged = new Map<string, bigint>();
	for (const r of chargedRows) {
		const key = r.categoryId && categoryById.has(r.categoryId) ? r.categoryId : NO_CATEGORY;
		charged.set(key, (charged.get(key) ?? 0n) + BigInt(r.totalMinor));
	}

	const bucketNames = new Map(buckets.map((b) => [b.bucket.id, b.bucket.name]));
	const spend = new Map(spendRows.map((r) => [r.ruleId as string, r]));

	// One shape for every rule the page renders. Ended rows reuse it wholesale:
	// they need the same name, price and cadence, and the same schedule fields,
	// because starting one again opens the very form an edit does.
	const toView = (r: (typeof rules)[number]) => {
		let parsed: Recurrence | null = null;
		try {
			parsed = parseRRule(r.rrule);
		} catch {
			/* malformed rule — skip pre-population */
		}
		// Every cadence normalized to a per-month figure, so a yearly charge
		// can sit next to a monthly one on the same scale (and show a "/mo"
		// subtitle). Falls back to the raw amount for an unparseable rule.
		const monthlyMinor = parsed
			? BigInt(Math.round(annualMinor(r.amountMinor, parsed) / 12))
			: r.amountMinor;
		// A rule filed under a category since archived keeps it: listCategories
		// only returns live ones, so an archived category reads as uncategorized
		// here exactly as it does in the picker and in the breakdown.
		const cat = r.categoryId ? categoryById.get(r.categoryId) : undefined;
		return {
			id: r.id,
			itemName: r.itemName,
			amountMinor: r.amountMinor,
			monthlyMinor,
			categoryKey: cat ? cat.id : NO_CATEGORY,
			currency: r.currency,
			cadence: describe(r.rrule),
			nextAt: r.nextOccurrenceAt?.toISOString() ?? null,
			status: r.status,
			autoComplete: r.autoComplete,
			categoryId: r.categoryId,
			bucketId: r.bucketId,
			bucketName: r.bucketId ? (bucketNames.get(r.bucketId) ?? null) : null,
			mine: r.memberId === ctx.member.id,
			freq: parsed?.freq ?? 'monthly',
			interval: parsed?.interval ?? 1,
			monthDay: parsed?.byMonthDay ?? null,
			byDay: parsed?.byDay ?? [],
			// The rule's real anchor. The edit form used to default this to
			// today, which silently re-anchored the schedule on every save —
			// enough to move a weekly rule onto a different weekday.
			startDate: parsed
				? `${parsed.start.y}-${String(parsed.start.m).padStart(2, '0')}-${String(parsed.start.d).padStart(2, '0')}`
				: null
		};
	};

	const view = rules.filter((r) => r.status !== 'ended').map(toView);

	// Active before paused; within each, soonest next-occurrence first (a rule
	// with no next date sorts last). The view groups by cadence, but the sort
	// still decides the order *inside* each group.
	view.sort((a, b) => {
		const pausedA = a.status === 'paused' ? 1 : 0;
		const pausedB = b.status === 'paused' ? 1 : 0;
		if (pausedA !== pausedB) return pausedA - pausedB;
		const nextA = a.nextAt ?? '￿';
		const nextB = b.nextAt ?? '￿';
		return nextA < nextB ? -1 : nextA > nextB ? 1 : 0;
	});

	// Rules that have been ended, most recently ended first, each carrying what
	// it cost over its life. Everyone in the workspace sees the record; `mine`
	// still decides who gets the Start again and Delete actions.
	const past = rules
		.filter((r) => r.status === 'ended')
		.map((r) => {
			const s = spend.get(r.id);
			return {
				...toView(r),
				endedAt: r.endedAt?.toISOString() ?? null,
				lifetimeMinor: s ? BigInt(s.totalMinor) : 0n,
				chargeCount: s?.charges ?? 0
			};
		});
	past.sort((a, b) => {
		// A rule with no ended_at (ended before the column was populated) trails.
		const ea = a.endedAt ?? '';
		const eb = b.endedAt ?? '';
		return ea < eb ? 1 : ea > eb ? -1 : 0;
	});

	return {
		currency: ctx.workspace.currency,
		monthlyTotalMinor: cost.total.monthlyMinor,
		yearlyTotalMinor: cost.total.yearlyMinor,
		activeCount: cost.total.count,
		/*
		 * The breakdown the page's ribbon and chips draw. Keyed by `NO_CATEGORY`
		 * for the uncategorized remainder — the same sentinel the ledger's filter
		 * uses — so a key is never null in the URL. A category the view can't
		 * name (archived) folds into that remainder.
		 */
		categoryCosts: foldArchived(cost.categories, categoryById).map((c) => {
			const cat = c.categoryId ? categoryById.get(c.categoryId) : undefined;
			return {
				key: cat ? cat.id : NO_CATEGORY,
				name: cat?.name ?? 'Other',
				icon: cat?.icon ?? null,
				color: cat?.color ?? OTHER_COLOR,
				count: c.count,
				monthlyMinor: c.monthlyMinor,
				yearlyMinor: c.yearlyMinor,
				chargedYearMinor: charged.get(cat ? cat.id : NO_CATEGORY) ?? 0n
			};
		}),
		chargedYearMinor: [...charged.values()].reduce((s, v) => s + v, 0n),
		chargedFrom: formatCalDate(chargedWindow.from),
		chargedTo: formatCalDate(chargedWindow.to),
		needsConfirmingCount: confirmRow[0].count,
		rules: view,
		past,
		categories: categories.map((c) => ({
			id: c.id,
			name: c.name,
			icon: c.icon,
			color: c.color ?? OTHER_COLOR
		})),
		// Only active buckets you may spend from — the same list the new-purchase
		// form offers. Cosmetic: `createRule` refuses the rest whatever is posted.
		buckets: buckets
			.filter(
				(b) =>
					b.bucket.status === 'active' &&
					refuseBucketCharge(b.bucket, {
						memberId: ctx.member.id,
						ownBucketsOnly: (ctx.member.approvalPolicy as ApprovalPolicy).own_buckets_only === true
					}) === null
			)
			.map((b) => ({ id: b.bucket.id, name: b.bucket.name }))
	};
}

/** The neutral grey every chart here gives the uncategorized remainder. */
const OTHER_COLOR = '#8E8E93';

/**
 * Merge costs filed under a category the page can no longer name (archived)
 * into the uncategorized remainder, keeping it last. Without this the ribbon
 * would carry a nameless segment, and the rows would read "Other" twice.
 */
function foldArchived(costs: CategoryCost[], live: Map<string, unknown>): CategoryCost[] {
	const named = costs.filter((c) => c.categoryId !== null && live.has(c.categoryId));
	const rest = costs.filter((c) => !(c.categoryId !== null && live.has(c.categoryId)));
	if (rest.length === 0) return named;
	const other = rest.reduce<CategoryCost>(
		(o, c) => ({
			categoryId: null,
			count: o.count + c.count,
			monthlyMinor: o.monthlyMinor + c.monthlyMinor,
			yearlyMinor: o.yearlyMinor + c.yearlyMinor
		}),
		{ categoryId: null, count: 0, monthlyMinor: 0n, yearlyMinor: 0n }
	);
	return [...named, other];
}

function describe(rrule: string): string {
	try {
		return describeRecurrence(parseRRule(rrule));
	} catch {
		// Graceful fallback: strip DTSTART, convert FREQ to readable text
		const parts: Record<string, string> = {};
		for (const part of rrule.split(';')) {
			const [k, v] = part.split('=');
			if (k && v !== undefined) parts[k.toUpperCase()] = v;
		}
		const freq =
			{ DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[parts.FREQ] ??
			parts.FREQ ??
			'';
		const intv = parts.INTERVAL && parts.INTERVAL !== '1' ? ` (every ${parts.INTERVAL})` : '';
		const byday = parts.BYDAY ? ` on ${parts.BYDAY}` : '';
		const bymonthday = parts.BYMONTHDAY ? ` day ${parts.BYMONTHDAY}` : '';
		return `${freq}${intv}${byday}${bymonthday}` || rrule;
	}
}

const CreateSchema = v.object({
	itemName: v.pipe(v.string(), v.trim(), v.minLength(1, 'What is it?'), v.maxLength(120)),
	amount: v.pipe(v.string(), v.trim(), v.minLength(1, 'How much?')),
	categoryId: v.optional(v.string()),
	bucketId: v.optional(v.string()),
	freq: v.picklist(['daily', 'weekly', 'monthly', 'yearly']),
	interval: v.pipe(
		v.string(),
		v.transform(Number),
		v.integer('Interval must be a whole number'),
		v.minValue(1),
		v.maxValue(52)
	),
	monthDay: v.optional(v.string()),
	startDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date'))
});

export const actions = {
	create: async (ctx: WorkspaceContext, { request }: { request: Request }) => {
		const form = await request.formData();
		const weekDays = form.getAll('weekDay').map(Number);
		const backfill = form.get('backfill') === 'on';
		const parsed = v.safeParse(CreateSchema, Object.fromEntries(form));
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		const [y, m, d] = f.startDate.split('-').map(Number);
		const rec: Recurrence = { start: { y, m, d }, freq: f.freq, interval: f.interval };
		if (f.freq === 'weekly' && weekDays.length > 0) {
			rec.byDay = weekDays.filter((n) => n >= 1 && n <= 7);
		}
		if ((f.freq === 'monthly' || f.freq === 'yearly') && f.monthDay) {
			rec.byMonthDay = Number(f.monthDay);
			if (f.freq === 'yearly') rec.byMonth = m;
		}

		try {
			await createRule(
				ctx.db,
				ctx.deps,
				{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
				{
					itemName: f.itemName,
					amount: Money.fromDecimal(f.amount, ctx.workspace.currency),
					categoryId: f.categoryId || null,
					bucketId: f.bucketId || null,
					rrule: formatRRule(rec),
					autoComplete: form.get('autoComplete') === 'on',
					backfill
				}
			);

			// Backfill has to land now. The sweep would get to it within five
			// minutes, but the user just asked for past charges and would be looking
			// at a list that doesn't have them yet. Materializing is transactional
			// and takes a row lock, so racing the sweep is safe.
			if (backfill) await materializeDueRules(ctx.db, ctx.deps);
		} catch (e) {
			if (
				e instanceof InvalidMoneyError ||
				e instanceof RecurrenceError ||
				e instanceof RecurringRuleError
			) {
				return fail(400, { error: e.message });
			}
			throw e;
		}
		return { ok: true };
	},

	pause: (ctx: WorkspaceContext, e: { request: Request }) => ruleAction(ctx, e, pauseRule),
	resume: (ctx: WorkspaceContext, e: { request: Request }) => ruleAction(ctx, e, resumeRule),
	end: (ctx: WorkspaceContext, e: { request: Request }) => ruleAction(ctx, e, endRule),

	edit: (ctx: WorkspaceContext, e: { request: Request }) => ruleFormAction(ctx, e, updateRule),
	restart: (ctx: WorkspaceContext, e: { request: Request }) => ruleFormAction(ctx, e, restartRule),
	remove: (ctx: WorkspaceContext, e: { request: Request }) => ruleAction(ctx, e, deleteRule)
};

type RuleFn = (
	db: WorkspaceContext['db'],
	d: WorkspaceContext['deps'],
	scope: { workspaceId: string; memberId: string },
	ruleId: string
) => Promise<void>;

async function ruleAction(ctx: WorkspaceContext, { request }: { request: Request }, fn: RuleFn) {
	const ruleId = String((await request.formData()).get('ruleId') ?? '');
	try {
		await fn(ctx.db, ctx.deps, { workspaceId: ctx.workspace.id, memberId: ctx.member.id }, ruleId);
	} catch (e) {
		if (e instanceof RecurringRuleError) return fail(400, { error: e.message });
		throw e;
	}
	return { ok: true };
}

/**
 * The rule fields the inline form posts, validated into an update command.
 *
 * Shared by Edit and Start again, which render the very same form. The two
 * missing-field cases throw `RecurringRuleError`, so the caller has one catch
 * for them and for everything the application layer and
 * the money and recurrence parsers raise.
 */
function parseRuleForm(form: FormData, currency: string): UpdateRuleCmd {
	const raw = Object.fromEntries(form);
	const itemName = String(raw.itemName ?? '').trim();
	const amountRaw = String(raw.amount ?? '').trim();
	if (!itemName) throw new RecurringRuleError('What is it?');
	if (!amountRaw) throw new RecurringRuleError('How much?');

	const categoryId = raw.categoryId as string | undefined;
	const bucketId = raw.bucketId as string | undefined;
	const freq = raw.freq as string | undefined;
	const intervalRaw = raw.interval as string | undefined;
	const startDate = raw.startDate as string | undefined;

	const cmd: UpdateRuleCmd = {
		itemName,
		amount: Money.fromDecimal(amountRaw, currency),
		autoComplete: form.get('autoComplete') === 'on'
	};
	if (categoryId !== undefined) cmd.categoryId = categoryId || null;
	if (bucketId !== undefined) cmd.bucketId = bucketId || null;

	if (freq && startDate) {
		const [y, m, d] = startDate.split('-').map(Number);
		const interval = Math.max(1, Math.min(52, parseInt(intervalRaw ?? '1') || 1));
		const rec: Recurrence = { start: { y, m, d }, freq: freq as Recurrence['freq'], interval };
		const weekDays = form.getAll('weekDay').map(Number);
		if (freq === 'weekly' && weekDays.length > 0) {
			rec.byDay = weekDays.filter((n) => n >= 1 && n <= 7);
		}
		if ((freq === 'monthly' || freq === 'yearly') && raw.monthDay) {
			rec.byMonthDay = Number(raw.monthDay);
			if (freq === 'yearly') rec.byMonth = m;
		}
		cmd.rrule = formatRRule(rec);
	}
	return cmd;
}

type RuleFormFn = (
	db: WorkspaceContext['db'],
	d: WorkspaceContext['deps'],
	scope: { workspaceId: string; memberId: string },
	ruleId: string,
	cmd: UpdateRuleCmd
) => Promise<void>;

/** The two actions that post the rule form: saving an edit, and starting an ended rule again. */
async function ruleFormAction(
	ctx: WorkspaceContext,
	{ request }: { request: Request },
	fn: RuleFormFn
) {
	const form = await request.formData();
	const ruleId = String(form.get('ruleId') ?? '');
	try {
		const cmd = parseRuleForm(form, ctx.workspace.currency);
		await fn(
			ctx.db,
			ctx.deps,
			{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
			ruleId,
			cmd
		);
	} catch (e) {
		if (
			e instanceof InvalidMoneyError ||
			e instanceof RecurrenceError ||
			e instanceof RecurringRuleError
		) {
			return fail(400, { error: e.message });
		}
		throw e;
	}
	return { ok: true };
}
