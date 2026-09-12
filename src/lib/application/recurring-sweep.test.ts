import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { bucket, bucketTransaction, recurringRule } from '$lib/db/schema';
import { materializeBucketAccruals } from '$lib/application/buckets';
import { materializeDueRules } from '$lib/application/recurring';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { nullNotifier } from '$lib/ports/notifier';

// A fixed clock so "due" is deterministic.
const NOW = new Date('2026-06-15T12:00:00Z');
const clock = { now: () => NOW };
const past = new Date('2026-06-01T09:00:00Z'); // before NOW → due

// The exact shape that wedged the sweep in the wild: a monthly rule with no
// DTSTART. parseRRule throws "Rule needs DTSTART=YYYY-MM-DD" on it.
const BAD = 'FREQ=MONTHLY;BYMONTHDAY=1';
const GOOD = 'DTSTART=2026-01-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1';

let h: TestDb;
afterEach(() => h?.close());

describe('materializeBucketAccruals — malformed rule must not wedge the sweep', () => {
	it('pauses the bad bucket and still accrues the good one', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const bad = await ws.addBucket({
			name: 'Bad',
			amountMinor: 5000n,
			rrule: BAD,
			nextAccrualAt: past
		});
		const good = await ws.addBucket({
			name: 'Good',
			amountMinor: 2000n,
			rrule: GOOD,
			nextAccrualAt: past
		});

		// The bug: this used to throw out of the whole function and, worse, leave
		// the pointer unadvanced so it re-threw every sweep.
		await expect(materializeBucketAccruals(h.db, { clock, ids: uuidv7 })).resolves.toBeTypeOf(
			'number'
		);

		const [badRow] = await h.db.select().from(bucket).where(eq(bucket.id, bad));
		const [goodRow] = await h.db.select().from(bucket).where(eq(bucket.id, good));
		expect(badRow.status).toBe('paused'); // quarantined, off the queue for good
		expect(goodRow.status).toBe('active'); // untouched

		// The good bucket actually accrued — the bad one didn't starve it.
		const goodTx = await h.db
			.select()
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, good));
		expect(goodTx.length).toBeGreaterThan(0);
		expect(goodTx.every((t) => t.type === 'accrual')).toBe(true);

		const badTx = await h.db
			.select()
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, bad));
		expect(badTx.length).toBe(0); // nothing charged against the broken rule
	});

	it('a second sweep does not re-throw on the paused bucket', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		await ws.addBucket({ name: 'Bad', amountMinor: 5000n, rrule: BAD, nextAccrualAt: past });

		await materializeBucketAccruals(h.db, { clock, ids: uuidv7 });
		// The wedge was: it stayed due and threw forever. Now it's paused, so the
		// candidate query (status='active') never selects it again.
		await expect(materializeBucketAccruals(h.db, { clock, ids: uuidv7 })).resolves.toBe(0);
	});
});

describe('materializeDueRules — malformed rule must not wedge the sweep', () => {
	it('pauses the bad rule and still materializes the good one', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const bad = await ws.addRecurring({
			itemName: 'Bad',
			amountMinor: 1000n,
			rrule: BAD,
			nextOccurrenceAt: past
		});
		const good = await ws.addRecurring({
			itemName: 'Good',
			amountMinor: 3000n,
			rrule: GOOD,
			nextOccurrenceAt: past
		});

		await expect(
			materializeDueRules(h.db, { clock, ids: uuidv7, notifier: nullNotifier })
		).resolves.toBeTypeOf('number');

		const [badRow] = await h.db.select().from(recurringRule).where(eq(recurringRule.id, bad));
		const [goodRow] = await h.db.select().from(recurringRule).where(eq(recurringRule.id, good));
		expect(badRow.status).toBe('paused');
		expect(goodRow.status).toBe('active');
		// The good rule advanced its pointer (it fired at least once).
		expect(goodRow.nextOccurrenceAt).not.toBeNull();
		expect(goodRow.nextOccurrenceAt! > past).toBe(true);
	});
});

describe('materializeBucketAccruals — goal cap', () => {
	it('accrues only the room left under the goal, then idles at the cap', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		// $20/month into a bucket capped at $25, due right now.
		const capped = await ws.addBucket({
			name: 'Capped',
			amountMinor: 2000n,
			rrule: GOOD,
			goalCapMinor: 2500n,
			nextAccrualAt: past
		});

		await materializeBucketAccruals(h.db, { clock, ids: uuidv7 });

		// First accrual is partial: the $25 goal leaves $25 of room, so the
		// full $20 fits — run the pointer forward twice and the second write
		// is clipped to the remaining $5.
		const first = await h.db
			.select()
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, capped));
		expect(first).toHaveLength(1);
		expect(first[0].amountMinor).toBe(2000n);

		// Pull the pointer back so the next occurrence is due again.
		await h.db.update(bucket).set({ nextAccrualAt: past }).where(eq(bucket.id, capped));
		await materializeBucketAccruals(h.db, { clock, ids: uuidv7 });

		const second = await h.db
			.select()
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, capped));
		expect(second).toHaveLength(2);
		expect(second[1].amountMinor).toBe(500n); // clipped to the room left

		// Now at the goal: a third due occurrence writes nothing but still
		// advances the pointer (no stuck queue, no re-run).
		await h.db.update(bucket).set({ nextAccrualAt: past }).where(eq(bucket.id, capped));
		await materializeBucketAccruals(h.db, { clock, ids: uuidv7 });

		const third = await h.db
			.select()
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, capped));
		expect(third).toHaveLength(2); // nothing new

		const [row] = await h.db.select().from(bucket).where(eq(bucket.id, capped));
		expect(row.nextAccrualAt!.getTime()).toBeGreaterThan(NOW.getTime());
	});
});
