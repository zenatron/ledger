/**
 * The sources a month's calendar is built from.
 *
 * Nothing here decides anything — it reads rules and dates and hands them to
 * `domain/calendar/month`, which does the expansion. The split matters because
 * the interesting logic (which occurrences count, what is a projection, how a
 * day is ordered) is then testable without a database, and this file stays a
 * query.
 *
 * Seal-aware where it needs to be. Recurring rules, buckets and income are all
 * household-wide by construction — a recurring purchase cannot be sealed, and
 * income is workspace-open by design — so those need no viewer filter. Held
 * purchases *are* ordinary purchases and can be sealed, so they go through
 * `visibleTo` like everything else: a gift someone is sleeping on stays out of
 * the calendar of the person it is for.
 */

import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bucket, income, purchase, recurringRule } from '$lib/db/schema';
import { visibleTo } from './purchases';
import { calDateInZone } from '$lib/domain/time/zoned';
import type { CalendarInput, DatedSource, ScheduledSource } from '$lib/domain/calendar/month';

export interface CalendarScope {
	workspaceId: string;
	viewerId: string;
	timezone: string;
}

/**
 * Everything scheduled or dated inside [from, to).
 *
 * `now` bounds what counts as still-to-come: an occurrence a rule has already
 * produced is a purchase in the ledger, and drawing it again would double it.
 * Each rule's own `next…At` stamp is the authority on where that line falls,
 * which is the same stamp the materialization sweep advances.
 */
export async function calendarSources(
	db: Db,
	scope: CalendarScope,
	windowFrom: Date,
	windowTo: Date,
	now: Date
): Promise<CalendarInput> {
	const [rules, buckets, incomes, held] = await Promise.all([
		db
			.select({
				id: recurringRule.id,
				itemName: recurringRule.itemName,
				amountMinor: recurringRule.amountMinor,
				rrule: recurringRule.rrule,
				nextOccurrenceAt: recurringRule.nextOccurrenceAt,
				autoComplete: recurringRule.autoComplete,
				memberId: recurringRule.memberId
			})
			.from(recurringRule)
			.where(
				and(eq(recurringRule.workspaceId, scope.workspaceId), eq(recurringRule.status, 'active'))
			),

		db
			.select({
				id: bucket.id,
				name: bucket.name,
				amountMinor: bucket.amountMinor,
				rrule: bucket.rrule,
				nextAccrualAt: bucket.nextAccrualAt,
				goalCapMinor: bucket.goalCapMinor,
				balance: sql<string>`coalesce((
					select sum(bt.amount_minor) from bucket_transaction bt where bt.bucket_id = ${bucket.id}
				), 0)`
			})
			.from(bucket)
			.where(and(eq(bucket.workspaceId, scope.workspaceId), eq(bucket.status, 'active'))),

		db
			.select({
				id: income.id,
				source: income.source,
				amountMinor: income.amountMinor,
				receivedAt: income.receivedAt,
				rrule: income.rrule
			})
			.from(income)
			.where(eq(income.workspaceId, scope.workspaceId)),

		// Purchases asleep and due to resurface. Seal-filtered: a held gift is
		// still a gift.
		db
			.select({
				id: purchase.id,
				itemName: purchase.itemName,
				requested: purchase.requestedAmountMinor,
				heldUntil: purchase.heldUntil
			})
			.from(purchase)
			.where(
				and(
					eq(purchase.workspaceId, scope.workspaceId),
					isNotNull(purchase.heldUntil),
					gte(purchase.heldUntil, windowFrom),
					lt(purchase.heldUntil, windowTo),
					visibleTo(scope.viewerId, now)
				)
			)
	]);

	const cal = (d: Date) => calDateInZone(d, scope.timezone);
	const scheduled: ScheduledSource[] = [];
	const dated: DatedSource[] = [];

	for (const r of rules) {
		if (!r.nextOccurrenceAt) continue;
		scheduled.push({
			kind: 'bill',
			sourceId: r.id,
			ownerMemberId: r.memberId,
			label: r.itemName,
			amountMinor: r.amountMinor,
			direction: 'out',
			rrule: r.rrule,
			notBefore: cal(r.nextOccurrenceAt),
			/*
			 * A rule that posts automatically charges what it says it will. One that
			 * asks you to confirm the price does so precisely because the price moves
			 * — a variable utility bill — so its figure is last month's, not next
			 * month's. That is the difference the grid has to show.
			 */
			estimate: !r.autoComplete
		});
	}

	for (const b of buckets) {
		if (!b.nextAccrualAt) continue;
		// A bucket at its goal stops accruing, so drawing future accruals for it
		// would promise savings that will not happen.
		const balance = BigInt(b.balance ?? '0');
		if (b.goalCapMinor !== null && balance >= b.goalCapMinor) continue;
		scheduled.push({
			kind: 'saving',
			sourceId: b.id,
			label: b.name,
			amountMinor: b.amountMinor,
			direction: 'out',
			rrule: b.rrule,
			notBefore: cal(b.nextAccrualAt),
			estimate: false
		});
	}

	for (const i of incomes) {
		if (i.rrule) {
			scheduled.push({
				kind: 'income',
				sourceId: i.id,
				label: i.source,
				amountMinor: i.amountMinor,
				direction: 'in',
				rrule: i.rrule,
				estimate: false
			});
		} else {
			dated.push({
				kind: 'income',
				sourceId: i.id,
				label: i.source,
				amountMinor: i.amountMinor,
				direction: 'in',
				date: cal(i.receivedAt),
				estimate: false
			});
		}
	}

	for (const h of held) {
		dated.push({
			kind: 'decision',
			sourceId: h.id,
			label: h.itemName,
			amountMinor: h.requested,
			// Nothing has moved and nothing may — it is a decision resurfacing, and
			// counting it as spending would overstate the month on a maybe.
			direction: 'none',
			date: cal(h.heldUntil!),
			estimate: false
		});
	}

	return { scheduled, dated };
}
