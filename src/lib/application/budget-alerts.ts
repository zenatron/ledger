import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	budget,
	budgetAlertLog,
	category,
	purchase,
	workspace,
	workspaceMember
} from '$lib/db/schema';
import { calDateInZone } from '$lib/domain/time/zoned';
import {
	monthPeriod,
	periodBoundsUtc,
	weekPeriod,
	type Period
} from '$lib/domain/analytics/period';
import { decideBudgetAlert, type BudgetAlertLevel } from '$lib/domain/budget/alert';
import { Money } from '$lib/domain/money/money';
import { visibleTo } from '$lib/repo/purchases';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { Notifier, Recipient } from '$lib/ports/notifier';

/**
 * Budget alerts, two triggers sharing one evaluator:
 *  - the sweep (checkBudgetAlerts) walks every workspace's current month and
 *    current week;
 *  - completing a purchase (checkBudgetsForPurchase) checks only the budgets
 *    that purchase touched — its category's and the overall one — against the
 *    month and the week the money was spent in.
 *
 * Alert state lives in budget_alert_log keyed by (workspace, category, period):
 * 'YYYY-MM' for monthly budgets, the week's first day for weekly ones, so a
 * weekly overspend never satisfies a monthly cooldown and vice versa. Editing
 * a budget amount never resets the cooldown, and every message names its
 * budget — "Groceries budget exceeded", not a bare "Budget exceeded".
 */

/** Stable key of the all-category budget line in budget_alert_log. */
const OVERALL_KEY = 'overall';

interface Deps {
	clock: Clock;
	ids: IdGenerator;
	notifier: Notifier;
}

interface WorkspaceRow {
	id: string;
	name: string;
	slug: string;
	timezone: string;
	currency: string;
	ownerUserId: string;
	budgetAlertPct: number;
	budgetAlertCooldownHours: number;
}

const WORKSPACE_COLUMNS = {
	id: workspace.id,
	name: workspace.name,
	slug: workspace.slug,
	timezone: workspace.timezone,
	currency: workspace.currency,
	ownerUserId: workspace.ownerUserId,
	weekStartDay: workspace.weekStartDay,
	budgetAlertPct: workspace.budgetAlertPct,
	budgetAlertCooldownHours: workspace.budgetAlertCooldownHours
} as const;

/** Sweep entry point: current month and current week, every workspace, every line. */
export async function checkBudgetAlerts(db: Db, deps: Deps): Promise<number> {
	const now = deps.clock.now();
	const workspaces = await db.select(WORKSPACE_COLUMNS).from(workspace);

	let alerted = 0;
	for (const ws of workspaces) {
		const today = calDateInZone(now, ws.timezone);
		alerted += await evaluateBudgets(db, deps, ws, monthPeriod(today), null, now, 'month');
		alerted += await evaluateBudgets(
			db,
			deps,
			ws,
			weekPeriod(today, ws.weekStartDay),
			null,
			now,
			'week'
		);
	}
	return alerted;
}

/**
 * Purchase-time entry point: the budgets a completed purchase actually counts
 * toward, evaluated against the month and the week it was spent in. Never
 * throws — an alert hiccup must not fail the mutation that caused it.
 */
export async function checkBudgetsForPurchase(
	db: Db,
	deps: Deps,
	p: { workspaceId: string; categoryId: string | null; completedAt: Date }
): Promise<void> {
	try {
		const [ws] = await db
			.select(WORKSPACE_COLUMNS)
			.from(workspace)
			.where(eq(workspace.id, p.workspaceId))
			.limit(1);
		if (!ws) return;
		const now = deps.clock.now();
		const spentOn = calDateInZone(p.completedAt, ws.timezone);
		const keys = new Set([OVERALL_KEY, p.categoryId ?? OVERALL_KEY]);
		await evaluateBudgets(db, deps, ws, monthPeriod(spentOn), keys, now, 'month');
		await evaluateBudgets(db, deps, ws, weekPeriod(spentOn, ws.weekStartDay), keys, now, 'week');
	} catch (e) {
		console.log(
			JSON.stringify({
				level: 'error',
				msg: 'budget alert: purchase-time check failed',
				err: (e as Error).message
			})
		);
	}
}

async function evaluateBudgets(
	db: Db,
	deps: Deps,
	ws: WorkspaceRow,
	period: Period,
	/** When set, only these category keys are evaluated (purchase-time check). */
	onlyKeys: Set<string> | null,
	now: Date,
	/** Which cadence's budget lines this pass reads — one pass per cadence. */
	kind: 'month' | 'week'
): Promise<number> {
	const { from, to } = periodBoundsUtc(period, ws.timezone);
	const pad = (n: number) => String(n).padStart(2, '0');
	const fromStr = `${period.from.y}-${pad(period.from.m)}-${pad(period.from.d)}`;
	// The alert-state key: monthly budgets key by month, weekly ones by the
	// week's first day. The two shapes can't collide.
	const periodKey = kind === 'month' ? fromStr.slice(0, 7) : fromStr;

	const budgets = await db
		.select({
			id: budget.id,
			categoryId: budget.categoryId,
			amountMinor: budget.amountMinor,
			categoryName: category.name
		})
		.from(budget)
		.leftJoin(category, eq(budget.categoryId, category.id))
		.where(
			and(
				eq(budget.workspaceId, ws.id),
				eq(budget.period, kind),
				lte(budget.effectiveFrom, fromStr),
				or(isNull(budget.effectiveTo), gt(budget.effectiveTo, fromStr))
			)
		);
	if (budgets.length === 0) return 0;

	const [ownerMember] = await db
		.select({
			memberId: workspaceMember.id,
			userId: workspaceMember.userId
		})
		.from(workspaceMember)
		.where(
			and(
				eq(workspaceMember.workspaceId, ws.id),
				eq(workspaceMember.userId, ws.ownerUserId),
				eq(workspaceMember.status, 'active')
			)
		)
		.limit(1);
	if (!ownerMember) return 0;

	const logs = await db
		.select()
		.from(budgetAlertLog)
		.where(and(eq(budgetAlertLog.workspaceId, ws.id), eq(budgetAlertLog.periodKey, periodKey)));
	const logByKey = new Map(logs.map((l) => [l.categoryKey, l]));

	const recipients: Recipient[] = [{ userId: ownerMember.userId, memberId: ownerMember.memberId }];

	let alerted = 0;
	// One grouped pass instead of a SUM per budget line: every line's total
	// comes out of the same period scan, keyed by category. The null-category
	// group exists here too, and the overall budget's number is all groups
	// summed — the period total exactly.
	const groups = await db
		.select({
			categoryId: purchase.categoryId,
			total: sql<string>`coalesce(sum(${purchase.finalAmountMinor}), 0)`
		})
		.from(purchase)
		.where(
			and(
				eq(purchase.workspaceId, ws.id),
				inArray(purchase.state, ['completed', 'refunded']),
				gte(purchase.completedAt, from),
				lt(purchase.completedAt, to),
				// The owner is the recipient: rows sealed from them stay out of the
				// totals, or a gift would leak through the alert.
				visibleTo(ownerMember.memberId, now)
			)
		)
		.groupBy(purchase.categoryId);
	const totalByCategory = new Map(groups.map((g) => [g.categoryId, BigInt(g.total)]));
	const overallTotal = groups.reduce((a, g) => a + BigInt(g.total), 0n);

	for (const b of budgets) {
		const key = b.categoryId ?? OVERALL_KEY;
		if (onlyKeys && !onlyKeys.has(key)) continue;

		const actualMinor =
			b.categoryId === null ? overallTotal : (totalByCategory.get(b.categoryId) ?? 0n);
		const last = logByKey.get(key) ?? null;

		const decision = decideBudgetAlert({
			budgetMinor: b.amountMinor,
			actualMinor,
			alertPct: ws.budgetAlertPct,
			cooldownHours: ws.budgetAlertCooldownHours,
			now,
			last: last
				? {
						level: last.level as BudgetAlertLevel,
						actualMinor: last.actualMinor,
						alertedAt: last.lastAlertedAt
					}
				: null
		});

		// De-escalation (a refund, a raised budget) is recorded silently so a
		// later re-crossing reads as escalation — without touching the cooldown.
		if (!decision.fire) {
			if (last && decision.level && decision.level !== last.level) {
				await db
					.update(budgetAlertLog)
					.set({ level: decision.level, actualMinor })
					.where(eq(budgetAlertLog.id, last.id));
			}
			continue;
		}

		// Claim before sending. Insert wins the race for a first alert; updates
		// carry their own guard (cooldown for re-alerts, level change for
		// escalations), so overlapping runs can't double-send.
		const claimed = await claimAlert(
			db,
			deps.ids,
			ws,
			key,
			periodKey,
			// decision.fire implies a non-null level.
			{ level: decision.level!, reason: decision.reason },
			actualMinor,
			now,
			last
		);
		if (!claimed) continue;

		const name = b.categoryId === null ? 'Everything' : (b.categoryName ?? 'Unknown');
		const budgetMoney = Money.of(b.amountMinor, ws.currency);
		const actualMoney = Money.of(actualMinor, ws.currency);
		const pct = b.amountMinor > 0n ? Number((actualMinor * 100n) / b.amountMinor) : 100;

		await deps.notifier.notify(recipients, 'budget_exceeded', {
			title:
				decision.level === 'exceeded' ? `${name} budget exceeded` : `${name} budget nearing limit`,
			body: `${ws.name}: spent ${actualMoney.format()} of ${budgetMoney.format()} (${pct}%) this ${kind}`,
			path: `/w/${ws.slug}/analytics`,
			tag: `budget-alert:${key}:${periodKey}`
		});

		alerted += 1;
	}

	return alerted;
}

async function claimAlert(
	db: Db,
	ids: IdGenerator,
	ws: WorkspaceRow,
	key: string,
	periodKey: string,
	decision: { level: BudgetAlertLevel; reason: string | null },
	actualMinor: bigint,
	now: Date,
	last: { id: string } | null
): Promise<boolean> {
	if (!last) {
		const inserted = await db
			.insert(budgetAlertLog)
			.values({
				id: ids.newId(),
				workspaceId: ws.id,
				categoryKey: key,
				periodKey,
				level: decision.level,
				actualMinor,
				lastAlertedAt: now
			})
			.onConflictDoNothing({
				target: [budgetAlertLog.workspaceId, budgetAlertLog.categoryKey, budgetAlertLog.periodKey]
			})
			.returning({ id: budgetAlertLog.id });
		return inserted.length > 0;
	}

	// The domain decision already applied the cooldown; these guards are the
	// race gate — a concurrent run that claimed first makes this update a
	// no-op, exactly like the old conditional last_alerted_at update did.
	const guard =
		decision.reason === 'threshold crossed'
			? and(eq(budgetAlertLog.id, last.id), ne(budgetAlertLog.level, decision.level))
			: and(
					eq(budgetAlertLog.id, last.id),
					lt(
						budgetAlertLog.lastAlertedAt,
						new Date(now.getTime() - ws.budgetAlertCooldownHours * 3_600_000)
					)
				);

	const updated = await db
		.update(budgetAlertLog)
		.set({ level: decision.level, actualMinor, lastAlertedAt: now })
		.where(guard)
		.returning({ id: budgetAlertLog.id });
	return updated.length > 0;
}
