import { describe, it, expect, afterEach } from 'vitest';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { periodTotal, categoryBreakdown } from '$lib/repo/analytics';
import { monthPeriod } from '$lib/domain/analytics/period';
import { calDateInZone } from '$lib/domain/time/zoned';

const NOW = new Date('2026-06-15T12:00:00Z');
const IN_MONTH = new Date('2026-06-10T15:00:00Z');

let h: TestDb;
afterEach(() => h?.close());

describe('analytics seal filter (the subtraction-attack defense)', () => {
	it('a sealed purchase is in the owner total but not the concealed member total', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db, { timezone: 'America/New_York' });
		const bob = await ws.addMember({ display: 'Bob' });
		const future = new Date('2026-12-25T00:00:00Z');

		// Owner buys a gift, sealed from Bob until Christmas.
		await ws.addPurchase({
			memberId: ws.ownerMemberId,
			amountMinor: 5000n,
			state: 'completed',
			completedAt: IN_MONTH,
			sealedFromMemberIds: [bob],
			sealedUntil: future
		});
		// A normal shared purchase everyone sees.
		await ws.addPurchase({ amountMinor: 1000n, state: 'completed', completedAt: IN_MONTH });

		const period = monthPeriod(calDateInZone(NOW, ws.timezone));
		const ownerScope = {
			workspaceId: ws.workspaceId,
			viewerId: ws.ownerMemberId,
			timezone: ws.timezone
		};
		const bobScope = { workspaceId: ws.workspaceId, viewerId: bob, timezone: ws.timezone };

		// The owner sees both; Bob sees only the shared one. Critically, Bob's
		// TOTAL must not include the sealed amount — otherwise he could subtract
		// the visible rows from the total and recover the hidden gift.
		expect(await periodTotal(h.db, ownerScope, period, NOW)).toBe(6000n);
		expect(await periodTotal(h.db, bobScope, period, NOW)).toBe(1000n);
	});

	it('the seal lifts once sealedUntil passes', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const bob = await ws.addMember();
		const past = new Date('2026-06-05T00:00:00Z'); // already lifted by NOW

		await ws.addPurchase({
			amountMinor: 5000n,
			state: 'completed',
			completedAt: IN_MONTH,
			sealedFromMemberIds: [bob],
			sealedUntil: past
		});

		const period = monthPeriod(calDateInZone(NOW, ws.timezone));
		const bobScope = { workspaceId: ws.workspaceId, viewerId: bob, timezone: ws.timezone };
		expect(await periodTotal(h.db, bobScope, period, NOW)).toBe(5000n); // now visible
	});
});

describe('analytics refund netting', () => {
	it('a negative refund row subtracts from the period total', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const cat = await ws.addCategory('Groceries');

		await ws.addPurchase({
			categoryId: cat,
			amountMinor: 4000n,
			state: 'completed',
			completedAt: IN_MONTH
		});
		// A refund: same shape, negative amount.
		await ws.addPurchase({
			categoryId: cat,
			amountMinor: -1500n,
			state: 'completed',
			completedAt: IN_MONTH
		});

		const period = monthPeriod(calDateInZone(NOW, ws.timezone));
		const scope = {
			workspaceId: ws.workspaceId,
			viewerId: ws.ownerMemberId,
			timezone: ws.timezone
		};
		expect(await periodTotal(h.db, scope, period, NOW)).toBe(2500n);

		const byCat = await categoryBreakdown(h.db, scope, period, NOW);
		const groceries = byCat.find((c) => c.name === 'Groceries');
		expect(groceries?.totalMinor).toBe(2500n);
	});
});
