import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bucket, income, purchase, recurringRule } from '$lib/db/schema';
import { monthPeriod, periodBoundsUtc } from '$lib/domain/analytics/period';
import { calDateInZone } from '$lib/domain/time/zoned';
import { compareDates, parseRRule } from '$lib/domain/recurrence/rrule';
import {
	computeSafeToSpend,
	sumRecurringInWindow,
	type SafeToSpend
} from '$lib/domain/forecast/safe-to-spend';
import {
	projectRunway,
	nextMonthStart,
	type ProjectionInputs,
	type Runway
} from '$lib/domain/forecast/runway';
import { budgetVsActual } from './analytics';
import { bucketFlowsInPeriod } from './buckets';
import { visibleTo } from './purchases';

interface ForecastScope {
	workspaceId: string;
	/** Seal viewer: spent/committed/reserved/sleeping are computed as they see it. */
	viewerId: string;
	timezone: string;
}

/**
 * Compute Safe to Spend for the current month, seal-scoped to the viewer.
 *
 * Income, upcoming bills, and planned savings are household-wide (none of them
 * can be sealed). The purchase-derived flows — spent, committed, reserved,
 * sleeping — go through `visibleTo`, so a gift the viewer sealed lowers their own
 * number while staying invisible in the number the concealed member sees.
 */
export async function safeToSpend(db: Db, scope: ForecastScope, now: Date): Promise<SafeToSpend> {
	const today = calDateInZone(now, scope.timezone);
	const period = monthPeriod(today);
	const { from, to } = periodBoundsUtc(period, scope.timezone);

	const [incomeMinor, bills, stillToAccrueMinor, flows, bucket, budgetRemainingMinor] =
		await Promise.all([
			monthIncome(db, scope.workspaceId, period, scope.timezone),
			upcomingBills(db, scope.workspaceId, period, scope.timezone),
			plannedSavings(db, scope.workspaceId, period, scope.timezone),
			purchaseFlows(db, scope, from, to, now),
			bucketFlowsInPeriod(db, scope.workspaceId, period, scope.timezone),
			budgetRemaining(db, scope, period, now)
		]);

	/*
	 * Savings this month is what has already moved into buckets plus what is still
	 * due to.
	 *
	 * It used to be the second half alone, which read as £0 the moment the month's
	 * accrual ran — the figure went to zero exactly when the saving actually
	 * happened. It was also wrong in the arithmetic, not just the label: cash that
	 * left the spendable pool on the 1st stopped being subtracted from free money,
	 * so Safe to Spend quietly overstated itself by the accrual for the rest of
	 * the month.
	 *
	 * The two halves can't overlap. `plannedSavings` counts from each bucket's
	 * `nextAccrualAt` forward, and that pointer only advances once the accrual has
	 * been written — so an occurrence is in exactly one of the two terms, never
	 * both. Manual deposits land in the first, which is right: moving money into a
	 * bucket by hand is saving it just as much as a rule doing it.
	 */
	const savingsMinor = bucket.setAsideMinor + stillToAccrueMinor;

	return computeSafeToSpend(
		{
			incomeMinor,
			// Bucket-charged purchases are excluded from `cashSpentMinor` because the
			// money was set aside in an earlier month. Where it wasn't, the charge is
			// plain cash going out, so the overdrafted part comes back in here.
			cashSpentMinor: flows.cashSpentMinor + bucket.overdraftMinor,
			cashCommittedMinor: flows.cashCommittedMinor,
			upcomingBillsMinor: bills.minor,
			upcomingBillsEstimated: bills.estimated,
			savingsMinor,
			reservedMinor: flows.reservedMinor,
			sleepingMinor: flows.sleepingMinor,
			budgetRemainingMinor: budgetRemainingMinor?.minor ?? null,
			budgetRemainingKind: budgetRemainingMinor?.kind ?? null
		},
		period
	);
}

/**
 * Project the `months` months that follow the current one.
 *
 * Safe to Spend answers this month; this answers the ones after it, from the
 * same recurring facts — income and bills that repeat, cash that accrues into
 * buckets, and any one-off income already dated ahead. A future month has no
 * actuals, so every figure is a projection; the caller labels it as such.
 *
 * Not seal-scoped: income, bills and bucket accruals are household-wide and
 * cannot be sealed (the same reason Safe to Spend takes them un-filtered). Only
 * the purchase-derived actuals a seal touches, and those don't exist for a month
 * that hasn't happened.
 *
 * Bucket accruals are projected uncapped — a goal-capped bucket that is nearly
 * full is still shown as setting money aside. That overstates savings and so
 * *understates* projected free cash: the conservative direction for a "will we
 * be alright next month" read, and simple. Modelling the exact month a cap
 * stops a bucket is a refinement, not a correctness need.
 */
export async function forecastMonths(
	db: Db,
	scope: ForecastScope,
	now: Date,
	months: number
): Promise<Runway> {
	const today = calDateInZone(now, scope.timezone);
	const thisMonthStart = { y: today.y, m: today.m, d: 1 };
	const firstMonth = nextMonthStart(thisMonthStart);
	// The exclusive far edge of the whole horizon, for filtering one-off income.
	let horizonEnd = firstMonth;
	for (let i = 0; i < months; i++) horizonEnd = nextMonthStart(horizonEnd);

	const [incomeRows, billRows, bucketRows] = await Promise.all([
		db
			.select({
				amountMinor: income.amountMinor,
				rrule: income.rrule,
				receivedAt: income.receivedAt
			})
			.from(income)
			.where(eq(income.workspaceId, scope.workspaceId)),
		db
			.select({
				amountMinor: recurringRule.amountMinor,
				rrule: recurringRule.rrule,
				autoComplete: recurringRule.autoComplete
			})
			.from(recurringRule)
			.where(
				and(eq(recurringRule.workspaceId, scope.workspaceId), eq(recurringRule.status, 'active'))
			),
		db
			.select({ amountMinor: bucket.amountMinor, rrule: bucket.rrule })
			.from(bucket)
			.where(and(eq(bucket.workspaceId, scope.workspaceId), eq(bucket.status, 'active')))
	]);

	const inputs: ProjectionInputs = {
		incomeRules: [],
		billRules: [],
		savingRules: [],
		oneOffIncome: []
	};

	for (const r of incomeRows) {
		if (r.rrule) {
			// Malformed rule — leave it out rather than guess, as every other
			// projection here does.
			try {
				inputs.incomeRules.push({ rec: parseRRule(r.rrule), amountMinor: r.amountMinor });
			} catch {
				/* skip */
			}
		} else {
			const on = calDateInZone(r.receivedAt, scope.timezone);
			// Only one-off income dated inside the projected horizon matters; this
			// month's is Safe to Spend's, and the past is done.
			if (compareDates(on, firstMonth) >= 0 && compareDates(on, horizonEnd) < 0) {
				inputs.oneOffIncome.push({ on, amountMinor: r.amountMinor });
			}
		}
	}
	for (const r of billRows) {
		try {
			// A confirm-at-price rule projects at its last-known amount, so the
			// months it lands in carry the estimate flag — the same signal
			// upcomingBills turns into this month's dotted figure.
			inputs.billRules.push({
				rec: parseRRule(r.rrule),
				amountMinor: r.amountMinor,
				estimated: !r.autoComplete
			});
		} catch {
			/* skip */
		}
	}
	for (const r of bucketRows) {
		try {
			inputs.savingRules.push({ rec: parseRRule(r.rrule), amountMinor: r.amountMinor });
		} catch {
			/* skip */
		}
	}

	return projectRunway(inputs, firstMonth, months);
}

/** All income landing this month — one-off received + recurring projected across the whole period. */
async function monthIncome(
	db: Db,
	workspaceId: string,
	period: ReturnType<typeof monthPeriod>,
	tz: string
): Promise<bigint> {
	const { from, to } = periodBoundsUtc(period, tz);
	const rows = await db
		.select({ amountMinor: income.amountMinor, rrule: income.rrule, receivedAt: income.receivedAt })
		.from(income)
		.where(eq(income.workspaceId, workspaceId));

	let total = 0n;
	for (const r of rows) {
		if (r.rrule) {
			try {
				total += sumRecurringInWindow(
					parseRRule(r.rrule),
					r.amountMinor,
					period.from,
					period.toExclusive
				);
			} catch {
				/* malformed income rule — leave it out rather than guess */
			}
		} else if (r.receivedAt >= from && r.receivedAt < to) {
			total += r.amountMinor;
		}
	}
	return total;
}

/** Recurring charges still to land this month — projected from each rule's next unmaterialized occurrence. */
async function upcomingBills(
	db: Db,
	workspaceId: string,
	period: ReturnType<typeof monthPeriod>,
	tz: string
): Promise<{ minor: bigint; estimated: boolean }> {
	const rules = await db
		.select({
			amountMinor: recurringRule.amountMinor,
			rrule: recurringRule.rrule,
			nextOccurrenceAt: recurringRule.nextOccurrenceAt,
			autoComplete: recurringRule.autoComplete
		})
		.from(recurringRule)
		.where(and(eq(recurringRule.workspaceId, workspaceId), eq(recurringRule.status, 'active')));

	let total = 0n;
	let estimated = false;
	for (const r of rules) {
		if (!r.nextOccurrenceAt) continue;
		try {
			// Only count occurrences still to materialize this month: start at the
			// rule's next occurrence, but never before the month itself.
			const nextCal = calDateInZone(r.nextOccurrenceAt, tz);
			const fromCal = compareDates(nextCal, period.from) < 0 ? period.from : nextCal;
			const part = sumRecurringInWindow(
				parseRRule(r.rrule),
				r.amountMinor,
				fromCal,
				period.toExclusive
			);
			total += part;
			// Only rules that actually contribute this month can make the figure a
			// projection — a confirm-at-price rule with nothing due in the window
			// has no bearing on it.
			if (part > 0n && !r.autoComplete) estimated = true;
		} catch {
			/* malformed rule — skip it, the same way the sweep does */
		}
	}
	return { minor: total, estimated };
}

/**
 * This month's bucket accruals — the cash you've chosen to set aside, capped at
 * each goal. Projected from each bucket's recurrence the same way upcomingBills
 * projects recurring charges: only occurrences still to materialize this month
 * count, starting at the bucket's next scheduled accrual.
 */
async function plannedSavings(
	db: Db,
	workspaceId: string,
	period: ReturnType<typeof monthPeriod>,
	tz: string
): Promise<bigint> {
	const rows = await db
		.select({
			amountMinor: bucket.amountMinor,
			rrule: bucket.rrule,
			nextAccrualAt: bucket.nextAccrualAt,
			goalCap: bucket.goalCapMinor,
			balance: sql<string>`coalesce((
				select sum(bt.amount_minor) from bucket_transaction bt where bt.bucket_id = ${bucket.id}
			), 0)`
		})
		.from(bucket)
		.where(and(eq(bucket.workspaceId, workspaceId), eq(bucket.status, 'active')));

	let total = 0n;
	for (const r of rows) {
		if (!r.nextAccrualAt) continue;
		let due = 0n;
		try {
			const nextCal = calDateInZone(r.nextAccrualAt, tz);
			const fromCal = compareDates(nextCal, period.from) < 0 ? period.from : nextCal;
			due = sumRecurringInWindow(parseRRule(r.rrule), r.amountMinor, fromCal, period.toExclusive);
		} catch {
			/* malformed rule — skip it, the same way the sweep does */
		}
		if (r.goalCap === null) {
			total += due;
		} else {
			// Won't accrue past the goal: only the room left, at most what's due.
			const room = r.goalCap - BigInt(r.balance);
			total += room <= 0n ? 0n : room < due ? room : due;
		}
	}
	return total;
}

/**
 * The plan guardrail: how much budget is left this month, or null if none is set.
 * An overall budget (the "Everything" cap) is the truest ceiling, so it wins;
 * otherwise sum the room left in each category budget (a category under its cap
 * doesn't fund one that's over, so each line floors at zero). Seal-aware via
 * budgetVsActual → categoryBreakdown → visibleTo.
 */
async function budgetRemaining(
	db: Db,
	scope: ForecastScope,
	period: ReturnType<typeof monthPeriod>,
	now: Date
): Promise<{ minor: bigint; kind: 'overall' | 'categories' } | null> {
	const lines = await budgetVsActual(db, scope, period, now);
	if (lines.length === 0) return null;
	const overall = lines.find((l) => l.categoryId === null);
	// One ceiling for everything. May be negative: over the plan.
	if (overall) return { minor: overall.budgetMinor - overall.actualMinor, kind: 'overall' };
	/*
	 * No overall budget, so this is the headroom left across the category budgets
	 * — each floored at zero, because being £50 under on groceries does not buy
	 * you £50 more of anything else. That flooring is why the two cases need
	 * different words: this figure is a sum of separate allowances, not one pot.
	 */
	return {
		minor: lines.reduce((a, l) => {
			const room = l.budgetMinor - l.actualMinor;
			return a + (room > 0n ? room : 0n);
		}, 0n),
		kind: 'categories'
	};
}

/**
 * Seal-aware, cash-only (bucket-charged excluded) purchase flows for the viewer.
 *
 * Two queries, not one aggregate with FILTER clauses: the month's completed
 * spend is period-bounded and can ride `purchase_workspace_completed_idx`,
 * while the decided-but-not-spent states are unbounded in time but number a
 * handful of rows (served by the partial index on open states). One query with
 * everything in FILTER would scan the workspace's entire history on every
 * ledger load to reach the same numbers.
 */
async function purchaseFlows(
	db: Db,
	scope: ForecastScope,
	from: Date,
	to: Date,
	now: Date
): Promise<{
	cashSpentMinor: bigint;
	cashCommittedMinor: bigint;
	reservedMinor: bigint;
	sleepingMinor: bigint;
}> {
	const scopeFilter = and(
		eq(purchase.workspaceId, scope.workspaceId),
		visibleTo(scope.viewerId, now)
	);

	const [spentRow] = await db
		.select({
			// Completed non-bucket spend this month, refunds netting out.
			spent: sql<string>`coalesce(sum(${purchase.finalAmountMinor}), 0)`
		})
		.from(purchase)
		.where(
			and(
				scopeFilter,
				sql`${purchase.state} in ('completed', 'refunded')`,
				sql`${purchase.bucketId} is null`,
				gte(purchase.completedAt, from),
				lt(purchase.completedAt, to)
			)
		);

	const [openRow] = await db
		.select({
			// Approved but not yet completed — money greenlit, cash not out yet.
			committed: sql<string>`coalesce(sum(coalesce(${purchase.approvedAmountMinor}, ${purchase.requestedAmountMinor})) filter (
				where ${purchase.state} = 'approved'
			), 0)`,
			// Pending — the amount approving them will actually commit: an overage
			// bounce-back keeps the smaller requested figure as requested, but
			// approval completes at the final price, so reserve that one.
			reserved: sql<string>`coalesce(sum(coalesce(${purchase.finalAmountMinor}, ${purchase.requestedAmountMinor})) filter (
				where ${purchase.state} = 'pending_approval'
			), 0)`,
			sleeping: sql<string>`coalesce(sum(${purchase.requestedAmountMinor}) filter (
				where ${purchase.state} = 'held'
			), 0)`
		})
		.from(purchase)
		.where(
			and(
				scopeFilter,
				sql`${purchase.state} in ('approved', 'pending_approval', 'held')`,
				sql`${purchase.bucketId} is null`
			)
		);

	return {
		cashSpentMinor: BigInt(spentRow?.spent ?? '0'),
		cashCommittedMinor: BigInt(openRow?.committed ?? '0'),
		reservedMinor: BigInt(openRow?.reserved ?? '0'),
		sleepingMinor: BigInt(openRow?.sleeping ?? '0')
	};
}
