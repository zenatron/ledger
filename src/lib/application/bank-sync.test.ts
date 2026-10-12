import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import {
	account,
	bankConnection,
	purchase,
	purchaseApprover,
	statementImport,
	statementLine
} from '$lib/db/schema';
import {
	BankSyncError,
	connectSimplefin,
	linkFeedAccount,
	syncConnection,
	syncDueConnections,
	type SecretBox
} from '$lib/application/bank-sync';
import { listConnections } from '$lib/repo/bank-feeds';
import { nullNotifier } from '$lib/ports/notifier';
import type { BankFeed } from '$lib/ports/bank-feed';
import type { AccountSet, FeedAccount } from '$lib/domain/bankfeed/simplefin';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const NOW = new Date('2026-10-12T15:00:00Z');
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));
const ids = { newId: () => crypto.randomUUID() };
const sealing: SecretBox = { seal: (p) => `sealed:${p}`, open: (s) => s.replace(/^sealed:/, '') };

function txn(id: string, d: number, amountMinor: bigint, desc: string) {
	return {
		id,
		postedAt: day(d),
		amountMinor,
		currency: 'USD',
		rawDescription: desc,
		normalizedDescription: desc.toLowerCase()
	};
}

/** A bridge that answers with whatever `accounts` holds at the time. */
function fakeFeed(accounts: FeedAccount[], errors: string[] = []) {
	const calls: unknown[] = [];
	const feed: BankFeed = {
		claim: async (t) => {
			if (t !== 'good-token') throw new BankSyncError('bad token');
			return 'https://u:p@beta-bridge.simplefin.org/simplefin';
		},
		accounts: async (_url, window): Promise<AccountSet> => {
			calls.push(window);
			return { accounts: structuredClone(accounts), errors };
		}
	};
	return { feed, calls };
}

function visa(transactions: ReturnType<typeof txn>[]): FeedAccount {
	return {
		externalId: 'ACT-VISA',
		name: 'Visa Signature',
		orgName: 'Chase',
		currency: 'USD',
		balanceMinor: -50000n,
		balanceAt: NOW,
		transactions
	};
}

async function setup(transactions: ReturnType<typeof txn>[]) {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db);
	const accounts = [visa(transactions)];
	const { feed, calls } = fakeFeed(accounts);
	const deps = { clock: { now: () => NOW }, ids, notifier: nullNotifier, feed, secrets: sealing };
	const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
	const { connectionId } = await connectSimplefin(h.db, deps, scope, 'good-token');
	const [conn] = await listConnections(h.db, ws.workspaceId);
	await linkFeedAccount(h.db, deps, scope, conn.accounts[0].id, { create: true });
	return { ws, deps, scope, connectionId, accounts, calls, db: h.db };
}

describe('connectSimplefin', () => {
	it('stores the access URL sealed and lists accounts unlinked', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { feed } = fakeFeed([visa([])]);
		const deps = { clock: { now: () => NOW }, ids, feed, secrets: sealing };
		const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
		await connectSimplefin(h.db, deps, scope, 'good-token');

		const [row] = await h.db.select().from(bankConnection);
		expect(row.accessUrl).toBe('sealed:https://u:p@beta-bridge.simplefin.org/simplefin');
		expect(row.label).toBe('Chase');
		const [conn] = await listConnections(h.db, ws.workspaceId);
		expect(conn.accounts).toHaveLength(1);
		expect(conn.accounts[0]).toMatchObject({ name: 'Visa Signature', accountId: null });
	});

	it('refuses to store a credential it could not seal', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { feed } = fakeFeed([]);
		const deps = {
			clock: { now: () => NOW },
			ids,
			feed,
			secrets: { seal: (p: string) => p, open: (s: string) => s }
		};
		await expect(
			connectSimplefin(
				h.db,
				deps,
				{ workspaceId: ws.workspaceId, memberId: ws.ownerMemberId },
				'good-token'
			)
		).rejects.toThrow(/SECRETS_KEY/);
		expect(await h.db.select().from(bankConnection)).toHaveLength(0);
	});
});

describe('linkFeedAccount', () => {
	it('creates a card named for the account', async () => {
		const { db, ws } = await setup([]);
		const cards = await db.select().from(account).where(eq(account.workspaceId, ws.workspaceId));
		expect(cards.map((c) => [c.name, c.kind])).toEqual([['Chase Visa Signature', 'card']]);
	});

	it('refuses an account in another currency', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { feed } = fakeFeed([{ ...visa([]), currency: 'EUR' }]);
		const deps = { clock: { now: () => NOW }, ids, feed, secrets: sealing };
		const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
		await connectSimplefin(h.db, deps, scope, 'good-token');
		const [conn] = await listConnections(h.db, ws.workspaceId);
		await expect(
			linkFeedAccount(h.db, deps, scope, conn.accounts[0].id, { create: true })
		).rejects.toThrow(/EUR/);
	});
});

describe('syncConnection', () => {
	it('clears a purchase the line names, leaves amount-only matches as proposals', async () => {
		const { db, ws, deps, connectionId } = await setup([
			txn('T1', 5, -1234n, 'SQ *BLUE BOTTLE COFFEE'),
			txn('T2', 6, -4800n, 'POS 99812'),
			txn('T3', 7, -999n, 'UNKNOWN SHOP')
		]);
		const merchantId = await ws.addMerchant({ name: 'Blue Bottle' });
		const coffee = await ws.addPurchase({
			itemName: 'Coffee',
			amountMinor: 1234n,
			merchantId,
			completedAt: day(5)
		});
		const groceries = await ws.addPurchase({
			itemName: 'Groceries',
			amountMinor: 4800n,
			completedAt: day(6)
		});

		const r = await syncConnection(db, deps, ws.workspaceId, connectionId);
		expect(r).toEqual({ added: 3, cleared: 1, completed: 0, toReview: 2 });

		const [p1] = await db.select().from(purchase).where(eq(purchase.id, coffee));
		expect(p1.clearedAt).toEqual(NOW);
		expect(p1.accountId).not.toBeNull();
		const [p2] = await db.select().from(purchase).where(eq(purchase.id, groceries));
		expect(p2.clearedAt).toBeNull();

		const lines = await db.select().from(statementLine);
		const byExt = Object.fromEntries(lines.map((l) => [l.externalId, l]));
		expect(byExt['sfin:ACT-VISA:T1'].matchState).toBe('confirmed');
		expect(byExt['sfin:ACT-VISA:T2'].matchState).toBe('matched');
		expect(byExt['sfin:ACT-VISA:T3'].matchState).toBe('unmatched');

		const [imp] = await db.select().from(statementImport);
		expect(imp).toMatchObject({ format: 'feed', lineCount: 3, status: 'reviewing' });
		expect(imp.filename).toBe('Chase Visa Signature · Oct 2026');
	});

	it('never brings the same transaction in twice', async () => {
		const { db, ws, deps, connectionId, accounts } = await setup([
			txn('T1', 5, -1000n, 'SHOP ONE')
		]);
		await syncConnection(db, deps, ws.workspaceId, connectionId);
		accounts[0].transactions.push(txn('T2', 9, -2000n, 'SHOP TWO'));
		const later = { ...deps, clock: { now: () => new Date(NOW.getTime() + 7 * 3600_000) } };
		const r = await syncConnection(db, later, ws.workspaceId, connectionId);
		expect(r.added).toBe(1);
		expect(await db.select().from(statementLine)).toHaveLength(2);
		const [imp] = await db.select().from(statementImport);
		expect(imp.lineCount).toBe(2);
	});

	it('splits a sync across months into one import each', async () => {
		const { db, ws, deps, connectionId } = await setup([
			{ ...txn('A', 1, -100n, 'X'), postedAt: new Date(Date.UTC(2026, 8, 28, 12)) },
			txn('B', 2, -200n, 'Y')
		]);
		await syncConnection(db, deps, ws.workspaceId, connectionId);
		const imports = await db.select().from(statementImport);
		expect(imports.map((i) => i.filename).sort()).toEqual([
			'Chase Visa Signature · Oct 2026',
			'Chase Visa Signature · Sep 2026'
		]);
	});

	it('completes an approved request the charge pays for', async () => {
		const { db, ws, deps, connectionId } = await setup([txn('T1', 10, -5249n, 'TARGET 00012345')]);
		const merchantId = await ws.addMerchant({ name: 'Target' });
		const req = await ws.addPurchase({
			itemName: 'Bath towels',
			amountMinor: 5000n,
			state: 'approved',
			merchantId
		});
		await db
			.update(purchase)
			.set({ decidedAt: day(8) })
			.where(eq(purchase.id, req));

		const r = await syncConnection(db, deps, ws.workspaceId, connectionId);
		expect(r).toMatchObject({ added: 1, completed: 1, toReview: 0 });

		const [p] = await db.select().from(purchase).where(eq(purchase.id, req));
		expect(p.state).toBe('completed');
		expect(p.finalAmountMinor).toBe(5249n);
		expect(p.completedAt).toEqual(day(10));
		expect(p.clearedAt).toEqual(NOW);
		const [l] = await db.select().from(statementLine);
		expect(l).toMatchObject({ matchState: 'confirmed', matchedPurchaseId: req });
	});

	it('sends an over-threshold charge back to the approver instead of completing', async () => {
		const { db, ws, deps, connectionId } = await setup([txn('T1', 10, -6000n, 'TARGET 00012345')]);
		const approver = await ws.addMember({ display: 'Approver' });
		const merchantId = await ws.addMerchant({ name: 'Target' });
		const req = await ws.addPurchase({
			itemName: 'Bath towels',
			amountMinor: 5000n,
			state: 'approved',
			merchantId
		});
		await db
			.update(purchase)
			.set({ decidedAt: day(8) })
			.where(eq(purchase.id, req));
		await db.insert(purchaseApprover).values({ purchaseId: req, memberId: approver });

		const r = await syncConnection(db, deps, ws.workspaceId, connectionId);
		expect(r).toMatchObject({ completed: 0, toReview: 1 });
		const [p] = await db.select().from(purchase).where(eq(purchase.id, req));
		expect(p.state).toBe('pending_approval');
		expect(p.clearedAt).toBeNull();
		const [l] = await db.select().from(statementLine);
		expect(l).toMatchObject({ matchState: 'matched', matchedPurchaseId: req });
	});

	it('ignores accounts nobody linked', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { feed } = fakeFeed([visa([txn('T1', 5, -100n, 'X')])]);
		const deps = { clock: { now: () => NOW }, ids, notifier: nullNotifier, feed, secrets: sealing };
		const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
		const { connectionId } = await connectSimplefin(h.db, deps, scope, 'good-token');
		const r = await syncConnection(h.db, deps, ws.workspaceId, connectionId);
		expect(r.added).toBe(0);
		expect(await h.db.select().from(statementLine)).toHaveLength(0);
	});

	it('records a failure on the connection and says so', async () => {
		const { db, ws, deps, connectionId } = await setup([]);
		const broken = {
			...deps,
			feed: {
				...deps.feed,
				accounts: async () => {
					throw new BankSyncError('SimpleFIN no longer accepts this connection.');
				}
			}
		};
		await expect(syncConnection(db, broken, ws.workspaceId, connectionId)).rejects.toThrow(
			/no longer accepts/
		);
		const [row] = await db.select().from(bankConnection);
		expect(row).toMatchObject({ status: 'error', lastAttemptAt: NOW, lastSyncedAt: null });
		expect(row.lastError).toMatch(/no longer accepts/);
	});

	it('widens the window back from the last good sync, capped at sixty days', async () => {
		const { db, ws, deps, connectionId, calls } = await setup([]);
		await syncConnection(db, deps, ws.workspaceId, connectionId);
		const first = calls.at(-1) as { start: Date; end: Date };
		expect(NOW.getTime() - first.start.getTime()).toBe(30 * 86_400_000);

		const muchLater = new Date(NOW.getTime() + 90 * 86_400_000);
		await syncConnection(
			db,
			{ ...deps, clock: { now: () => muchLater } },
			ws.workspaceId,
			connectionId
		);
		const second = calls.at(-1) as { start: Date; end: Date };
		expect(muchLater.getTime() - second.start.getTime()).toBe(60 * 86_400_000);
	});
});

describe('syncDueConnections', () => {
	it('syncs only connections not tried recently', async () => {
		const { db, deps } = await setup([txn('T1', 5, -100n, 'X')]);
		expect(await syncDueConnections(db, deps)).toBe(1);
		// Tried a moment ago: not due.
		expect(await syncDueConnections(db, deps)).toBe(0);
	});
});
