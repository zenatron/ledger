import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { purchase, recurringRule } from '$lib/db/schema';
import {
	deleteRule,
	materializeDueRules,
	restartRule,
	RecurringRuleError
} from '$lib/application/recurring';
import { Money } from '$lib/domain/money/money';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { nullNotifier } from '$lib/ports/notifier';

// Fixed clock, so "starts again from today" is a date we can assert against.
const NOW = new Date('2026-06-15T12:00:00Z');
const deps = { clock: { now: () => NOW }, ids: uuidv7, notifier: nullNotifier };

const MONTHLY = 'DTSTART=2025-01-10;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10';
const ENDED_AT = new Date('2026-02-14T09:00:00Z');

let h: TestDb;
afterEach(() => h?.close());

async function endedRule(amountMinor = 15_49n) {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db);
	const id = await ws.addRecurring({
		itemName: 'Netflix',
		amountMinor,
		rrule: MONTHLY,
		status: 'ended',
		nextOccurrenceAt: null
	});
	await h.db.update(recurringRule).set({ endedAt: ENDED_AT }).where(eq(recurringRule.id, id));
	const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
	return { ws, id, scope };
}

const row = async (id: string) =>
	(await h.db.select().from(recurringRule).where(eq(recurringRule.id, id)))[0];

describe('restartRule', () => {
	it('brings an ended rule back and schedules it forward', async () => {
		const { id, scope } = await endedRule();

		await restartRule(h.db, deps, scope, id);

		const r = await row(id);
		expect(r.status).toBe('active');
		expect(r.endedAt).toBeNull();
		expect(r.nextOccurrenceAt).not.toBeNull();
		// Forward-only: the months it sat ended are a gap, not a backlog.
		expect(r.nextOccurrenceAt!.getTime()).toBeGreaterThan(NOW.getTime());
	});

	it('applies a new price and cadence on the way back', async () => {
		const { ws, id, scope } = await endedRule();

		await restartRule(h.db, deps, scope, id, {
			amount: Money.fromDecimal('18.99', ws.currency),
			rrule: 'DTSTART=2026-06-15;FREQ=WEEKLY;INTERVAL=1'
		});

		const r = await row(id);
		expect(r.amountMinor).toBe(18_99n);
		expect(r.rrule).toContain('FREQ=WEEKLY');
		expect(r.status).toBe('active');
	});

	it('charges at the new price, and does not backfill the lapse', async () => {
		const { ws, id, scope } = await endedRule();

		// Keeps its original schedule (monthly on the 10th, anchored in Jan 2025),
		// so the only thing standing between this rule and eighteen months of
		// catch-up charges is the forward-only next date restartRule sets.
		await restartRule(h.db, deps, scope, id, {
			amount: Money.fromDecimal('18.99', ws.currency)
		});

		// Sweep just after the first occurrence back, on July 10th.
		const afterFirst = { ...deps, clock: { now: () => new Date('2026-07-11T20:00:00Z') } };
		await materializeDueRules(h.db, afterFirst);

		const made = await h.db.select().from(purchase).where(eq(purchase.recurringRuleId, id));
		expect(made.length).toBe(1); // July only. February through June never happened.
		expect(made[0].requestedAmountMinor).toBe(18_99n);
	});

	it('refuses a rule that is still running', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
		const active = await ws.addRecurring({ amountMinor: 100n, rrule: MONTHLY });
		const paused = await ws.addRecurring({ amountMinor: 100n, rrule: MONTHLY, status: 'paused' });

		await expect(restartRule(h.db, deps, scope, active)).rejects.toThrow(RecurringRuleError);
		await expect(restartRule(h.db, deps, scope, paused)).rejects.toThrow(RecurringRuleError);
	});

	it('refuses a rule belonging to someone else', async () => {
		const { ws, id } = await endedRule();
		const other = await ws.addMember();

		await expect(
			restartRule(h.db, deps, { workspaceId: ws.workspaceId, memberId: other }, id)
		).rejects.toThrow(/Only the rule owner/);
	});
});

describe('deleteRule', () => {
	it('removes the rule and lets its charges go, keeping them in the ledger', async () => {
		const { ws, id, scope } = await endedRule();
		const p1 = await ws.addPurchase({ amountMinor: 15_49n, recurringRuleId: id });
		const p2 = await ws.addPurchase({ amountMinor: 15_49n, recurringRuleId: id });

		await deleteRule(h.db, deps, scope, id);

		expect(await row(id)).toBeUndefined();
		// The FK would have refused the delete if the charges had not been
		// detached first. They keep their money and their place in the ledger.
		const kept = await h.db.select().from(purchase);
		expect(kept.map((p) => p.id).sort()).toEqual([p1, p2].sort());
		expect(kept.every((p) => p.recurringRuleId === null)).toBe(true);
		expect(kept.every((p) => p.finalAmountMinor === 15_49n)).toBe(true);
	});

	it('refuses a rule that has not been ended', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
		const active = await ws.addRecurring({ amountMinor: 100n, rrule: MONTHLY });

		await expect(deleteRule(h.db, deps, scope, active)).rejects.toThrow(/End the rule/);
		expect(await row(active)).toBeDefined();
	});

	it('refuses a rule belonging to someone else', async () => {
		const { ws, id } = await endedRule();
		const other = await ws.addMember();

		await expect(
			deleteRule(h.db, deps, { workspaceId: ws.workspaceId, memberId: other }, id)
		).rejects.toThrow(/Only the rule owner/);
		expect(await row(id)).toBeDefined();
	});
});
