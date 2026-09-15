import type { WorkspaceContext } from '$lib/ports/context';
import type { ActionEvent, LoadEvent } from '$lib/ports/handlers';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as v from 'valibot';
import { workspaceMember } from '$lib/db/schema';
import {
	InvalidPolicyError,
	validatePolicy,
	type ApprovalPolicy
} from '$lib/domain/approval/policy';
import { calDateInZone } from '$lib/domain/time/zoned';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import {
	RecurrenceError,
	describeRecurrence,
	formatRRule,
	parseRRule,
	type Recurrence
} from '$lib/domain/recurrence/rrule';
import { recurrenceFromFields } from '$lib/domain/recurrence/from-fields';
import { firstAccrualAt, materializeBucketAccruals } from '$lib/application/buckets';
import { listMembers } from '$lib/repo/workspaces';
import {
	createBucket,
	listBuckets,
	lifetimeSaved,
	loadOwnBucket,
	updateBucket,
	pauseBucket,
	resumeBucket,
	archiveBucket,
	addTransaction
} from '$lib/repo/buckets';

export async function load(ctx: WorkspaceContext, { params }: LoadEvent) {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const db = ctx.db;
	const ws = ctx.workspace;
	const [rows, lifetimeSavedMinor, members] = await Promise.all([
		listBuckets(db, ws.id),
		lifetimeSaved(db, ws.id),
		listMembers(db, ws.id)
	]);
	// Everyone a bucket could name, and everyone a scope label has to spell out.
	const people = members
		.filter((m) => m.member.status === 'active')
		.map((m) => ({ id: m.member.id, displayName: m.user.displayName }));

	return {
		currency: ws.currency,
		viewerMemberId: ctx.member.id,
		// Allowances are set up and changed by owners; everyone sees them.
		isOwner: ctx.member.role === 'owner',
		members: people,
		// What's actually in the visible buckets right now (active + paused;
		// archived already excluded by listBuckets).
		onHandMinor: rows.reduce((sum, r) => sum + r.balanceMinor, 0n),
		// Gross ever set aside across the workspace — matches the Activity page's
		// lifetime "Saved" figure. Bigger than on-hand once anything's been spent.
		lifetimeSavedMinor,
		buckets: rows.map((r) => {
			let parsed: Recurrence | null = null;
			try {
				parsed = parseRRule(r.bucket.rrule);
			} catch {
				/* malformed rule — skip pre-population */
			}
			return {
				id: r.bucket.id,
				name: r.bucket.name,
				amountMinor: r.bucket.amountMinor,
				currency: r.bucket.currency,
				goalCapMinor: r.bucket.goalCapMinor,
				color: r.bucket.color,
				icon: r.bucket.icon,
				status: r.bucket.status,
				chargeMemberIds: r.bucket.chargeMemberIds,
				isAllowance: r.bucket.isAllowance,
				memberId: r.bucket.memberId,
				balanceMinor: r.balanceMinor,
				memberName: r.memberName,
				mine: r.bucket.memberId === ctx.member.id,
				nextAccrualAt: r.bucket.nextAccrualAt,
				// "next" vs "first" accrual. Asked of the transaction count, not the
				// balance: a bucket that accrued and was then spent flat sits at zero
				// with a history behind it, and calling that one "first" was wrong.
				everAccrued: r.txCount > 0,
				cadence: parsed ? describeRecurrence(parsed) : '',
				freq: parsed?.freq ?? 'monthly',
				interval: parsed?.interval ?? 1,
				byDay: parsed?.byDay ?? [],
				monthDay: parsed?.byMonthDay ?? null,
				// The rule's real anchor. Defaulting the edit form to today would
				// silently re-anchor the schedule on every save — enough to move a
				// weekly rule onto a different weekday.
				startDate: parsed
					? `${parsed.start.y}-${String(parsed.start.m).padStart(2, '0')}-${String(parsed.start.d).padStart(2, '0')}`
					: null
			};
		})
	};
}

const CreateSchema = v.object({
	name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Bucket needs a name'), v.maxLength(120)),
	amount: v.pipe(v.string(), v.trim(), v.minLength(1, 'Amount is required')),
	freq: v.picklist(['daily', 'weekly', 'monthly', 'yearly']),
	interval: v.pipe(
		v.string(),
		v.transform(Number),
		v.integer('Interval must be a whole number'),
		v.minValue(1),
		v.maxValue(52)
	),
	monthDay: v.optional(v.string()),
	startDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date')),
	goalCap: v.optional(v.string()),
	color: v.optional(v.string())
});

const AllowanceSchema = v.object({
	memberId: v.pipe(v.string(), v.nonEmpty('Who is it for?')),
	amount: v.pipe(v.string(), v.trim(), v.minLength(1, 'How much?')),
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

/**
 * The charge-scope control, off both bucket forms.
 *
 * Three states arrive as one hidden field plus a set of checkboxes: `anyone`
 * means null (no restriction at all), `only-me` means the empty list, and
 * `choose` means exactly whoever is ticked. Undefined means the form never
 * carried the control, which is what keeps a caller that doesn't know about it
 * from widening a bucket it never meant to touch.
 *
 * The owner is dropped if they somehow appear: they are always allowed, and
 * storing that would let the row contradict itself.
 */
function chargeScopeFromForm(form: FormData, ownerMemberId: string): string[] | null | undefined {
	const mode = form.get('chargeScope');
	if (mode === null) return undefined;
	if (mode === 'anyone') return null;
	if (mode === 'only-me') return [];
	return form
		.getAll('chargeMemberId')
		.map(String)
		.filter((id) => id && id !== ownerMemberId);
}

export const actions = {
	create: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const form = await request.formData();
		const weekDays = form.getAll('weekDay').map(Number);
		const backfill = form.get('backfill') === 'on';
		const parsed = v.safeParse(CreateSchema, Object.fromEntries(form));
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		try {
			const amount = Money.fromDecimal(f.amount, ctx.workspace.currency);
			if (!amount.isPositive) return fail(400, { error: 'Amount must be positive' });
			let goalCapMinor: bigint | null = null;
			if (f.goalCap?.trim()) {
				goalCapMinor = Money.fromDecimal(f.goalCap, ctx.workspace.currency).minor;
			}

			const ws = ctx.workspace;
			const rrule = formatRRule(recurrenceFromFields({ ...f, weekDays }));
			const today = calDateInZone(ctx.deps.clock.now(), ws.timezone);

			await createBucket(ctx.db, ctx.deps, {
				workspaceId: ws.id,
				memberId: ctx.member.id,
				name: f.name,
				amountMinor: amount.minor,
				currency: amount.currency,
				rrule,
				goalCapMinor,
				color: f.color?.trim() || null,
				icon: null,
				chargeMemberIds: chargeScopeFromForm(form, ctx.member.id) ?? null,
				nextAccrualAt: firstAccrualAt(rrule, today, ws.timezone, { backfill })
			});

			// Backfill has to land now, not whenever the sweep next runs: the user
			// just asked for past accruals and would be looking at a balance that
			// doesn't have them yet. The sweep takes a row lock, so racing it is safe.
			if (backfill) await materializeBucketAccruals(ctx.db, ctx.deps);
		} catch (e) {
			if (e instanceof InvalidMoneyError || e instanceof RecurrenceError) {
				return fail(400, { error: e.message });
			}
			throw e;
		}
		return { ok: true };
	},

	/**
	 * Set someone up with an allowance, or change the one they have.
	 *
	 * An allowance is three settings that already exist, pointed at each other: a
	 * bucket only its owner can charge, an accrual rule that tops it up, and a
	 * policy that says "ask me for anything, except what comes out of your own
	 * bucket, unless it would overdraw it." This action assembles them, and marks
	 * the bucket as an allowance so it is listed and managed as one — rather than
	 * every "only me" bucket being taken for one.
	 *
	 * Moved here from the Members page: it is a bucket first, and the Buckets
	 * page is where people go looking for it.
	 */
	allowance: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		if (ctx.member.role !== 'owner') {
			return fail(403, { error: 'Only an owner can set up an allowance' });
		}
		const form = await request.formData();
		const parsed = v.safeParse(AllowanceSchema, Object.fromEntries(form));
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		const ws = ctx.workspace;
		const members = await listMembers(ctx.db, ws.id);
		const target = members.find((m) => m.member.id === f.memberId);
		if (!target) return fail(400, { error: 'Unknown member' });
		if (target.member.status !== 'active') {
			return fail(400, { error: 'Restore this member before setting up an allowance' });
		}

		// Someone other than them has to be able to say yes, or every over-budget
		// purchase would stall with nobody able to decide it. Owners are who can.
		const approverIds = members
			.filter(
				(m) =>
					m.member.status === 'active' && m.member.role === 'owner' && m.member.id !== f.memberId
			)
			.map((m) => m.member.id);
		if (approverIds.length === 0) {
			return fail(400, {
				error: 'Somebody else has to be able to approve. Make another member an owner first.'
			});
		}

		let amount: Money;
		let rrule: string;
		try {
			amount = Money.fromDecimal(f.amount, ws.currency);
			rrule = formatRRule(
				recurrenceFromFields({ ...f, weekDays: form.getAll('weekDay').map(Number) })
			);
		} catch (e) {
			if (e instanceof InvalidMoneyError || e instanceof RecurrenceError) {
				return fail(400, { error: e.message });
			}
			throw e;
		}
		if (!amount.isPositive) return fail(400, { error: 'Amount must be positive' });

		const today = calDateInZone(ctx.deps.clock.now(), ws.timezone);
		const nextAccrualAt = firstAccrualAt(rrule, today, ws.timezone);

		// Their existing allowance, if they have one. Changing it keeps one pot
		// with one history, so raising an allowance doesn't strand the balance.
		const buckets = await listBuckets(ctx.db, ws.id);
		const existing = buckets.find((b) => b.bucket.memberId === f.memberId && b.bucket.isAllowance);
		if (existing) {
			await updateBucket(ctx.db, { workspaceId: ws.id, memberId: f.memberId }, existing.bucket.id, {
				amountMinor: amount.minor,
				rrule,
				nextAccrualAt,
				chargeMemberIds: []
			});
		} else {
			await createBucket(ctx.db, ctx.deps, {
				workspaceId: ws.id,
				memberId: f.memberId,
				name: `${target.user.displayName}'s allowance`,
				amountMinor: amount.minor,
				currency: ws.currency,
				rrule,
				// Empty list, so only they can spend from it.
				chargeMemberIds: [],
				isAllowance: true,
				nextAccrualAt
			});
		}

		const existingPolicy = target.member.approvalPolicy as ApprovalPolicy;
		const policy: ApprovalPolicy = {
			mode: 'always',
			category_overrides: existingPolicy.category_overrides,
			bucket_charges: 'skip',
			own_buckets_only: true,
			routing: { mode: 'any_of', approver_ids: approverIds }
		};
		const activeIds = members.filter((m) => m.member.status === 'active').map((m) => m.member.id);
		try {
			validatePolicy(policy, activeIds);
		} catch (e) {
			if (e instanceof InvalidPolicyError) return fail(400, { error: e.message });
			throw e;
		}
		await ctx.db
			.update(workspaceMember)
			.set({ approvalPolicy: policy })
			.where(and(eq(workspaceMember.id, f.memberId), eq(workspaceMember.workspaceId, ws.id)));
		return { ok: true };
	},

	edit: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const form = await request.formData();
		const bucketId = String(form.get('bucketId') ?? '');
		const weekDays = form.getAll('weekDay').map(Number);
		const name = String(form.get('name') ?? '').trim();
		const amountRaw = String(form.get('amount') ?? '').trim();
		const freq = String(form.get('freq') ?? '');
		const intervalRaw = String(form.get('interval') ?? '1');
		const monthDay = form.get('monthDay') as string | null;
		const startDate = String(form.get('startDate') ?? '');
		const goalCapRaw = form.get('goalCap') as string | null;
		const colorRaw = form.get('color') as string | null;

		if (!name) return fail(400, { error: 'Bucket needs a name' });
		if (!amountRaw) return fail(400, { error: 'Amount is required' });

		try {
			const ws = ctx.workspace;
			const amount = Money.fromDecimal(amountRaw, ws.currency);
			if (!amount.isPositive) return fail(400, { error: 'Amount must be positive' });
			const changes: {
				name?: string;
				amountMinor?: bigint;
				rrule?: string;
				nextAccrualAt?: Date | null;
				goalCapMinor?: bigint | null;
				color?: string | null;
				chargeMemberIds?: string[] | null;
			} = { name, amountMinor: amount.minor };

			const chargeMemberIds = chargeScopeFromForm(form, ctx.member.id);
			if (chargeMemberIds !== undefined) changes.chargeMemberIds = chargeMemberIds;

			if (freq && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
				const interval = Math.max(1, Math.min(52, parseInt(intervalRaw) || 1));
				const rrule = formatRRule(
					recurrenceFromFields({
						freq,
						interval,
						monthDay: monthDay ?? undefined,
						startDate,
						weekDays
					})
				);
				changes.rrule = rrule;
				// A cadence change reschedules future-only — what's already accrued
				// stays accrued, the new rule picks up from today.
				const today = calDateInZone(ctx.deps.clock.now(), ws.timezone);
				changes.nextAccrualAt = firstAccrualAt(rrule, today, ws.timezone);
			}

			if (goalCapRaw !== null && goalCapRaw !== undefined) {
				if (goalCapRaw.trim()) {
					changes.goalCapMinor = Money.fromDecimal(goalCapRaw, ws.currency).minor;
				} else {
					changes.goalCapMinor = null;
				}
			}
			if (colorRaw !== null && colorRaw !== undefined) {
				changes.color = colorRaw.trim() || null;
			}

			await updateBucket(
				ctx.db,
				{ workspaceId: ws.id, memberId: ctx.member.id },
				bucketId,
				changes
			);
		} catch (e) {
			if (e instanceof InvalidMoneyError || e instanceof RecurrenceError) {
				return fail(400, { error: e.message });
			}
			if (e instanceof Error) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	},

	pause: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const bucketId = String((await request.formData()).get('bucketId') ?? '');
		try {
			await pauseBucket(
				ctx.db,
				{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
				bucketId
			);
		} catch (e) {
			if (e instanceof Error) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	},

	resume: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const bucketId = String((await request.formData()).get('bucketId') ?? '');
		const ws = ctx.workspace;
		try {
			const b = await loadOwnBucket(
				ctx.db,
				{ workspaceId: ws.id, memberId: ctx.member.id },
				bucketId
			);
			if (!b) return fail(400, { error: 'Bucket not found' });
			const today = calDateInZone(ctx.deps.clock.now(), ws.timezone);
			await resumeBucket(
				ctx.db,
				{ workspaceId: ws.id, memberId: ctx.member.id },
				bucketId,
				firstAccrualAt(b.rrule, today, ws.timezone)
			);
		} catch (e) {
			if (e instanceof Error) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	},

	archive: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const bucketId = String((await request.formData()).get('bucketId') ?? '');
		try {
			await archiveBucket(
				ctx.db,
				{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
				bucketId
			);
		} catch (e) {
			if (e instanceof Error) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	},

	adjust: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const form = await request.formData();
		const bucketId = String(form.get('bucketId') ?? '');
		const amountRaw = String(form.get('amount') ?? '').trim();
		const type = String(form.get('type') ?? 'withdrawal') as 'withdrawal' | 'adjustment';
		const note = form.get('note') as string | null;

		if (!amountRaw) return fail(400, { error: 'Amount is required' });
		if (type !== 'withdrawal' && type !== 'adjustment') {
			return fail(400, { error: 'Type must be withdrawal or adjustment' });
		}

		// Owner-scoped, like every other bucket mutation: a workspace-scoped load
		// would let any member withdraw from someone else's bucket.
		const b = await loadOwnBucket(
			ctx.db,
			{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
			bucketId
		);
		if (!b) return fail(400, { error: 'Bucket not found' });

		try {
			const money = Money.fromDecimal(amountRaw, b.currency);
			const amountMinor = type === 'withdrawal' ? -money.minor : money.minor;

			await addTransaction(ctx.db, ctx.deps, {
				bucketId,
				amountMinor,
				currency: b.currency,
				type,
				note: note?.trim() || null
			});
		} catch (e) {
			if (e instanceof InvalidMoneyError) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	}
};
