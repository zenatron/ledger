import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bucket, workspace } from '$lib/db/schema';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import {
	addDays,
	formatRRule,
	nextOccurrence,
	parseRRule,
	type CalDate
} from '$lib/domain/recurrence/rrule';
import { calDateInZone, zonedTimeToUtc } from '$lib/domain/time/zoned';
import { addTransaction, bucketBalance } from '$lib/repo/buckets';

/** Accruals land at 09:00 workspace-local — the same hour recurring charges materialize. */
const ACCRUAL_HOUR = 9;

interface Deps {
	clock: Clock;
	ids: IdGenerator;
}

/**
 * Monthly rule for the entry points that still think in day-of-month terms
 * (command palette, MCP, seeds). The day is stored as BYMONTHDAY, so a 31st
 * clamps to shorter months at occurrence time — how the old clamp behaved.
 */
export function monthlyAccrualRule(dayOfMonth: number, start: CalDate): string {
	return formatRRule({ start, freq: 'monthly', interval: 1, byMonthDay: dayOfMonth });
}

/**
 * When a rule's first accrual lands, as an instant. Normally today at the
 * earliest — nothing in the past. `backfill` anchors to the rule's own start
 * date instead, and the sweep walks forward from there on its next pass.
 */
export function firstAccrualAt(
	rrule: string,
	today: CalDate,
	timezone: string,
	opts?: { backfill?: boolean }
): Date {
	const rec = parseRRule(rrule); // throws RecurrenceError on bad input
	const from = opts?.backfill ? addDays(rec.start, -1) : addDays(today, -1);
	return zonedTimeToUtc(nextOccurrence(rec, from), ACCRUAL_HOUR, 0, timezone);
}

/**
 * Accrual sweep. Each due bucket generates its missed occurrences (capped,
 * same as recurring rules), advancing next_accrual_at as it goes — the pointer
 * plus the row lock is the "never twice" guarantee, there is no per-month
 * guard anymore because a rule may legitimately accrue several times a month.
 * Accruals are dated at their occurrence, not at sweep time, so catch-up
 * months land in the month they belong to.
 */
export async function materializeBucketAccruals(db: Db, deps: Deps): Promise<number> {
	const now = deps.clock.now();

	const candidates = await db
		.select({
			bucketId: bucket.id,
			tz: workspace.timezone,
			catchupMax: workspace.recurringCatchupMax
		})
		.from(bucket)
		.innerJoin(workspace, eq(bucket.workspaceId, workspace.id))
		.where(
			and(
				eq(bucket.status, 'active'),
				or(isNull(bucket.nextAccrualAt), lte(bucket.nextAccrualAt, now))
			)
		);

	let accrued = 0;
	for (const { bucketId, tz, catchupMax } of candidates) {
		// One transaction per occurrence, not per catch-up batch: a failure on
		// the 30th missed accrual must not roll back the 29 already generated
		// and leave next_accrual_at unadvanced (which would replay them forever).
		for (let i = 0; i < catchupMax; i++) {
			const made = await db.transaction(async (tx) => {
				// Re-check under lock; a concurrent sweep may have handled this bucket.
				const locked = await tx
					.select()
					.from(bucket)
					.where(eq(bucket.id, bucketId))
					.for('update')
					.limit(1);
				const b = locked[0];
				if (!b || b.status !== 'active') return null;

				// A malformed rule (e.g. a legacy row missing DTSTART) must not wedge
				// the sweep. Parsing throws, the transaction would roll back with the
				// accrual pointer unadvanced, and the row would re-throw on every sweep
				// — starving every bucket after it. Pause it instead: the candidate
				// query filters status='active', so a paused bucket leaves the queue
				// for good, the owner sees it stopped, and it's one resume away once
				// the rule is fixed.
				let rec;
				try {
					rec = parseRRule(b.rrule);
				} catch (e) {
					await tx.update(bucket).set({ status: 'paused' }).where(eq(bucket.id, b.id));
					console.log(
						JSON.stringify({
							level: 'warn',
							msg: 'sweep: bucket paused (unparseable rule)',
							bucketId: b.id,
							err: (e as Error).message
						})
					);
					return null;
				}

				// Never scheduled (legacy row, or created before the pointer existed):
				// anchor to the next future occurrence and wait for it. No catch-up —
				// backfilling history is an explicit choice at creation time.
				if (!b.nextAccrualAt) {
					const today = calDateInZone(now, tz);
					const next = nextOccurrence(rec, addDays(today, -1));
					await tx
						.update(bucket)
						.set({ nextAccrualAt: zonedTimeToUtc(next, ACCRUAL_HOUR, 0, tz) })
						.where(eq(bucket.id, b.id));
					return null;
				}
				if (b.nextAccrualAt > now) return null;

				const occurrenceAt = b.nextAccrualAt;
				const next = nextOccurrence(rec, calDateInZone(occurrenceAt, tz));

				// A goal caps the accrual, matching what the forecast projects
				// ("only the room left, at most what's due"): writing the full
				// rule amount would sail past the target the owner set. At or
				// past the goal the write skips entirely while the pointer still
				// advances, so saving resumes on its own once a charge frees up
				// room.
				let amountMinor = b.amountMinor;
				if (b.goalCapMinor !== null) {
					const room = b.goalCapMinor - (await bucketBalance(tx, b.id));
					if (room <= 0n) amountMinor = 0n;
					else if (room < amountMinor) amountMinor = room;
				}

				if (amountMinor > 0n) {
					await addTransaction(tx, deps, {
						bucketId: b.id,
						amountMinor,
						currency: b.currency,
						type: 'accrual',
						at: occurrenceAt
					});
				}

				await tx
					.update(bucket)
					.set({ nextAccrualAt: zonedTimeToUtc(next, ACCRUAL_HOUR, 0, tz) })
					.where(eq(bucket.id, b.id));
				return true;
			});

			if (!made) break;
			accrued += 1;
		}
	}

	return accrued;
}
