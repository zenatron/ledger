/**
 * Bank sync edge cases: who sees what (cardholder privacy, gifts), pending
 * transactions, and charges for purchases that were asked for first.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	makeTestDb,
	seedWorkspace,
	type TestDb,
	type SeededWorkspace
} from '$lib/repo/_test/harness';
import {
	bankFeedAccount,
	purchase,
	purchaseApprover,
	statementImport,
	statementLine
} from '$lib/db/schema';
import type { BankFeedClient } from '$lib/ports/bank-feed';
import type { FeedAccount, FeedTransaction } from '$lib/domain/banksync/simplefin';
import {
	connectSimpleFin,
	setFeedAccountEnabled,
	syncConnection,
	type BankSyncDeps
} from './bank-sync';
import {
	ReconcileError,
	confirmMatch,
	createPurchaseFromLine,
	deleteImport,
	ignoreLine,
	linkManually,
	settleOpenFromLine,
	unignoreLine,
	unlinkMatch
} from './reconcile';
import { getImport, getLine, listImports, listLines } from '$lib/repo/statements';
import { nullNotifier } from '$lib/ports/notifier';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const ACCESS = 'https://u:p@beta-bridge.simplefin.org/simplefin';
const DAY = 86_400_000;

function txn(id: string, at: string, amt: bigint, desc: string, pending = false): FeedTransaction {
	return {
		id,
		postedAt: new Date(at),
		transactedAt: null,
		amountMinor: amt,
		description: desc,
		pending
	};
}

interface World {
	ws: SeededWorkspace;
	alice: string; // owner, connects the bridge
	bob: string; // another member
	now: { t: Date };
	txns: FeedTransaction[];
	deps: BankSyncDeps;
	connectionId: string;
	feedId: string;
	/** Advance past the manual cooldown and sync. */
	sync(): Promise<Awaited<ReturnType<typeof syncConnection>>>;
	lines(): Promise<(typeof statementLine.$inferSelect)[]>;
	line(desc: string): Promise<typeof statementLine.$inferSelect>;
}

async function world(
	opts: { holder?: 'alice' | 'bob'; visibility?: 'holder' | 'shared' } = {}
): Promise<World> {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db, { timezone: 'UTC' });
	const alice = ws.ownerMemberId;
	const bob = await ws.addMember({ display: 'Bob' });
	const now = { t: new Date('2026-10-20T12:00:00Z') };
	const txns: FeedTransaction[] = [];
	const feed: BankFeedClient = {
		claim: async () => ACCESS,
		fetchAccounts: async (_u, q) => ({
			httpStatus: 200,
			messages: [],
			accounts: [
				{
					id: 'CARD',
					name: 'Visa 4242',
					institution: 'Bank',
					currency: 'USD',
					unsupported: null,
					balanceMinor: -1000n,
					availableBalanceMinor: null,
					balanceAt: null,
					transactions: q.balancesOnly ? [] : txns
				} satisfies FeedAccount
			]
		})
	};
	const deps: BankSyncDeps = {
		clock: { now: () => now.t },
		ids: { newId: () => crypto.randomUUID() },
		feed,
		secrets: { available: true, seal: (s) => `enc:${s}`, open: (s) => s.slice(4) },
		config: { intervalHours: 6, backfillDays: 30 },
		random: () => 0
	};
	const scope = { workspaceId: ws.workspaceId, memberId: alice };
	const { connectionId } = await connectSimpleFin(h.db, deps, scope, { setupToken: 't' });
	const [f] = await h.db.select().from(bankFeedAccount);
	await setFeedAccountEnabled(h.db, deps, scope, f.id, true, null, {
		holderMemberId: opts.holder === 'bob' ? bob : alice,
		visibility: opts.visibility ?? 'holder'
	});
	const db = h.db;
	return {
		ws,
		alice,
		bob,
		now,
		txns,
		deps,
		connectionId,
		feedId: f.id,
		async sync() {
			now.t = new Date(now.t.getTime() + 11 * 60_000);
			return syncConnection(db, deps, connectionId, 'manual');
		},
		lines: () => db.select().from(statementLine),
		async line(desc) {
			const [l] = await db
				.select()
				.from(statementLine)
				.where(eq(statementLine.rawDescription, desc));
			if (!l) throw new Error(`no line ${desc}`);
			return l;
		}
	};
}

/** An "ask first" purchase, asked (and decided) at a given time. */
async function askFirst(
	w: World,
	opts: {
		member: string;
		amount: bigint;
		state: 'approved' | 'pending_approval' | 'held';
		askedAt: string;
		item?: string;
		approver?: string;
	}
): Promise<string> {
	const id = await w.ws.addPurchase({
		memberId: opts.member,
		itemName: opts.item ?? 'Headphones',
		amountMinor: opts.amount,
		state: opts.state,
		completedAt: null
	});
	await h!.db
		.update(purchase)
		.set({
			requestedAt: new Date(opts.askedAt),
			decidedAt: opts.state === 'approved' ? new Date(opts.askedAt) : null,
			createdAt: new Date(opts.askedAt)
		})
		.where(eq(purchase.id, id));
	if (opts.approver) {
		await h!.db.insert(purchaseApprover).values({ purchaseId: id, memberId: opts.approver });
	}
	return id;
}

const deps = (w: World) => ({ ...w.deps, notifier: nullNotifier });

// ---------------------------------------------------------------------------

describe('cardholder privacy', () => {
	it('a private card’s statements are invisible to everyone else, owners included', async () => {
		const w = await world({ holder: 'bob' });
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -45000n, 'TIFFANY & CO'));
		await w.sync();

		// Bob, the cardholder, sees it.
		const bobs = await listImports(h!.db, w.ws.workspaceId, w.bob);
		expect(bobs).toHaveLength(1);
		expect(bobs[0].privateToViewer).toBe(true);

		// Alice — an owner, and the person who connected the bridge — does not.
		expect(await listImports(h!.db, w.ws.workspaceId, w.alice)).toHaveLength(0);
		const impId = bobs[0].id;
		expect(await getImport(h!.db, w.ws.workspaceId, impId, w.alice)).toBeNull();
		const l = await w.line('TIFFANY & CO');
		expect(await getLine(h!.db, w.ws.workspaceId, l.id, w.alice, w.now.t)).toBeNull();
		expect(
			await listLines(h!.db, { workspaceId: w.ws.workspaceId, viewerId: w.alice }, impId, w.now.t)
		).toEqual([]);

		// And can't act on it by id either.
		const aliceScope = { workspaceId: w.ws.workspaceId, memberId: w.alice };
		await expect(confirmMatch(h!.db, deps(w), aliceScope, l.id)).rejects.toBeInstanceOf(
			ReconcileError
		);
		await expect(deleteImport(h!.db, deps(w), aliceScope, impId)).rejects.toBeInstanceOf(
			ReconcileError
		);
		expect(await w.lines()).toHaveLength(1);
	});

	it('making the account shared opens its history; making it private again closes it', async () => {
		const w = await world({ holder: 'bob' });
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -1200n, 'COFFEE'));
		await w.sync();
		const scope = { workspaceId: w.ws.workspaceId, memberId: w.bob };
		await setFeedAccountEnabled(h!.db, w.deps, scope, w.feedId, true, null, {
			visibility: 'shared'
		});
		expect(await listImports(h!.db, w.ws.workspaceId, w.alice)).toHaveLength(1);
		await setFeedAccountEnabled(h!.db, w.deps, scope, w.feedId, true, null, {
			visibility: 'holder'
		});
		expect(await listImports(h!.db, w.ws.workspaceId, w.alice)).toHaveLength(0);
	});

	it('on a shared card, a gift sealed from Bob reads to Bob as a hidden purchase', async () => {
		const w = await world({ holder: 'alice', visibility: 'shared' });
		// Alice logged the gift first, sealed from Bob.
		const gift = await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Watch for Bob',
			amountMinor: 45000n,
			state: 'completed',
			completedAt: new Date('2026-10-17T18:00:00Z'),
			sealedFromMemberIds: [w.bob],
			sealedUntil: new Date('2026-12-25T00:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -45000n, 'TIFFANY & CO'));
		await w.sync();

		const l = await w.line('TIFFANY & CO');
		expect(l.matchState).toBe('matched');
		expect(l.matchedPurchaseId).toBe(gift);

		const [imp] = await listImports(h!.db, w.ws.workspaceId, w.bob);
		const forBob = await listLines(
			h!.db,
			{ workspaceId: w.ws.workspaceId, viewerId: w.bob },
			imp.id,
			w.now.t
		);
		expect(forBob[0]).toMatchObject({
			matchState: 'private',
			rawDescription: 'Hidden purchase',
			purchase: null,
			suggestions: []
		});
		const forAlice = await listLines(
			h!.db,
			{ workspaceId: w.ws.workspaceId, viewerId: w.alice },
			imp.id,
			w.now.t
		);
		expect(forAlice[0].rawDescription).toBe('TIFFANY & CO');
		expect(forAlice[0].purchase?.id).toBe(gift);
	});

	it('Bob can’t unmask a hidden gift line by acting on it directly', async () => {
		const w = await world({ holder: 'alice', visibility: 'shared' });
		const gift = await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Watch for Bob',
			amountMinor: 45000n,
			state: 'completed',
			completedAt: new Date('2026-10-17T18:00:00Z'),
			sealedFromMemberIds: [w.bob],
			sealedUntil: new Date('2026-12-25T00:00:00Z')
		});
		const decoy = await w.ws.addPurchase({
			memberId: w.bob,
			itemName: 'Coffee',
			amountMinor: 500n,
			state: 'completed',
			completedAt: new Date('2026-10-17T18:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -45000n, 'TIFFANY & CO'));
		await w.sync();
		const l = await w.line('TIFFANY & CO');
		expect(l.matchedPurchaseId).toBe(gift);

		// The id is in Bob's page data; every action on it must refuse.
		const bob = { workspaceId: w.ws.workspaceId, memberId: w.bob };
		const d = deps(w);
		expect(await getLine(h!.db, w.ws.workspaceId, l.id, w.bob, w.now.t)).toBeNull();
		for (const act of [
			() => unlinkMatch(h!.db, d, bob, l.id),
			() => ignoreLine(h!.db, d, bob, l.id),
			() => confirmMatch(h!.db, d, bob, l.id),
			() => unignoreLine(h!.db, d, bob, l.id),
			() => linkManually(h!.db, d, bob, l.id, decoy),
			() => createPurchaseFromLine(h!.db, d, bob, l.id)
		]) {
			await expect(act()).rejects.toThrow('That statement line no longer exists.');
		}

		// Nothing moved: still matched to the gift, the gift untouched, and Bob
		// still reads it as a hidden purchase.
		const after = await w.line('TIFFANY & CO');
		expect(after.matchState).toBe('matched');
		expect(after.matchedPurchaseId).toBe(gift);
		const [g] = await h!.db.select().from(purchase).where(eq(purchase.id, gift));
		expect(g.clearedAt).toBeNull();
		const [imp] = await listImports(h!.db, w.ws.workspaceId, w.bob);
		const [shown] = await listLines(
			h!.db,
			{ workspaceId: w.ws.workspaceId, viewerId: w.bob },
			imp.id,
			w.now.t
		);
		expect(shown.rawDescription).toBe('Hidden purchase');

		// Alice, who can see the gift, can still answer the line as usual.
		const alice = { workspaceId: w.ws.workspaceId, memberId: w.alice };
		await confirmMatch(h!.db, d, alice, l.id);
		expect((await w.line('TIFFANY & CO')).matchState).toBe('confirmed');
	});

	it('Bob can’t act on a line stored private on someone else’s statement either', async () => {
		// Bob's card, a gift sealed from him: the line is stored `private`. Alice
		// shares the account later; Bob still owns it, so for him it stays his own
		// statement — but for Alice viewing Bob's shared card it is not hers.
		const w = await world({ holder: 'bob', visibility: 'shared' });
		await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Watch for Bob',
			amountMinor: 45000n,
			state: 'completed',
			completedAt: new Date('2026-10-17T18:00:00Z'),
			sealedFromMemberIds: [w.bob],
			sealedUntil: new Date('2026-12-25T00:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -45000n, 'TIFFANY & CO'));
		await w.sync();
		const l = await w.line('TIFFANY & CO');
		expect(l.matchState).toBe('private');
		// Shared and not holder-owned for Alice: the private line is off-limits.
		const alice = { workspaceId: w.ws.workspaceId, memberId: w.alice };
		await expect(ignoreLine(h!.db, deps(w), alice, l.id)).rejects.toThrow(
			'That statement line no longer exists.'
		);
		expect((await w.line('TIFFANY & CO')).matchState).toBe('private');
	});

	it('a gift bought on the recipient’s own card is “accounted for”, not a question', async () => {
		// Bob's card, but Alice used it for Bob's gift and sealed it from him.
		const w = await world({ holder: 'bob' });
		await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Watch for Bob',
			amountMinor: 45000n,
			state: 'completed',
			completedAt: new Date('2026-10-17T18:00:00Z'),
			sealedFromMemberIds: [w.bob],
			sealedUntil: new Date('2026-12-25T00:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -45000n, 'TIFFANY & CO'));
		await w.sync();
		const l = await w.line('TIFFANY & CO');
		// Matching ran as Bob, the cardholder: he can't see the gift, so the line
		// is marked private instead of inviting him to log a duplicate.
		expect(l.matchState).toBe('private');
		expect(l.matchedPurchaseId).toBeNull();
	});

	it('merchant memory never learns from a sealed purchase', async () => {
		const w = await world({ holder: 'alice', visibility: 'shared' });
		const gifts = await w.ws.addCategory('Gifts');
		const m = await w.ws.addMerchant({ name: 'Tiffany' });
		await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Ring',
			categoryId: gifts,
			merchantId: m,
			amountMinor: 99000n,
			state: 'completed',
			completedAt: new Date('2026-08-01T12:00:00Z'),
			sealedFromMemberIds: [w.bob],
			sealedUntil: new Date('2027-01-01T00:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -2000n, 'TIFFANY & CO NYC'));
		await w.sync();
		expect((await w.line('TIFFANY & CO NYC')).suggestedCategoryId).toBeNull();
	});
});

describe('pending transactions', () => {
	it('are never stored; the posted version arrives once, even with a new id', async () => {
		const w = await world();
		w.txns.push(txn('P1', '2026-10-19T10:00:00Z', -800n, 'LYFT RIDE', true));
		expect((await w.sync()).inserted).toBe(0);
		expect(await w.lines()).toHaveLength(0);

		// It posts the next day under a different id (common with card networks).
		w.txns.length = 0;
		w.txns.push(txn('X9', '2026-10-20T10:00:00Z', -800n, 'LYFT RIDE'));
		w.now.t = new Date(w.now.t.getTime() + DAY);
		expect((await w.sync()).inserted).toBe(1);
		// And again: no duplicate.
		w.now.t = new Date(w.now.t.getTime() + DAY);
		expect((await w.sync()).inserted).toBe(0);
		expect(await w.lines()).toHaveLength(1);
	});
});

describe('charges for purchases asked for first', () => {
	const scopeOf = (w: World, m: string) => ({ workspaceId: w.ws.workspaceId, memberId: m });

	it('an approved request is offered, never auto-matched; marking it bought completes it', async () => {
		const w = await world();
		const p = await askFirst(w, {
			member: w.alice,
			amount: 5000n,
			state: 'approved',
			askedAt: '2026-10-10T12:00:00Z'
		});
		w.txns.push(txn('T1', '2026-10-14T10:00:00Z', -5000n, 'BEST BUY 00123'));
		await w.sync();
		const l = await w.line('BEST BUY 00123');
		expect(l.matchState).toBe('unmatched');
		expect(l.suggestedPurchaseIds).toEqual([p]);

		const r = await settleOpenFromLine(h!.db, deps(w), scopeOf(w, w.alice), l.id, p);
		expect(r.state).toBe('completed');
		const [after] = await h!.db.select().from(purchase).where(eq(purchase.id, p));
		expect(after.state).toBe('completed');
		expect(after.finalAmountMinor).toBe(5000n);
		expect(after.completedAt?.toISOString()).toBe('2026-10-14T10:00:00.000Z');
		expect(after.clearedAt).not.toBeNull();
		expect((await w.line('BEST BUY 00123')).matchState).toBe('confirmed');
	});

	it('tax on top: the bank figure becomes the final amount', async () => {
		const w = await world();
		const p = await askFirst(w, {
			member: w.alice,
			amount: 5000n,
			state: 'approved',
			askedAt: '2026-10-10T12:00:00Z'
		});
		w.txns.push(txn('T1', '2026-10-12T10:00:00Z', -5417n, 'BEST BUY 00123'));
		await w.sync();
		const l = await w.line('BEST BUY 00123');
		expect(l.suggestedPurchaseIds).toEqual([p]);
		await settleOpenFromLine(h!.db, deps(w), scopeOf(w, w.alice), l.id, p);
		const [after] = await h!.db.select().from(purchase).where(eq(purchase.id, p));
		expect(after.state).toBe('completed');
		expect(after.finalAmountMinor).toBe(5417n);
	});

	it('over the re-approval threshold, it goes back for approval and the line waits', async () => {
		const w = await world();
		const p = await askFirst(w, {
			member: w.alice,
			amount: 5000n,
			state: 'approved',
			askedAt: '2026-10-10T12:00:00Z',
			item: 'Headphones',
			approver: w.bob
		});
		// 16% over a 10% threshold — but still within the 25% "names the
		// merchant" offer band because the descriptor mentions it.
		w.txns.push(txn('T1', '2026-10-12T10:00:00Z', -5800n, 'HEADPHONES SHOP'));
		await w.sync();
		const l = await w.line('HEADPHONES SHOP');
		expect(l.suggestedPurchaseIds).toEqual([p]);
		const r = await settleOpenFromLine(h!.db, deps(w), scopeOf(w, w.alice), l.id, p);
		expect(r.state).toBe('pending_approval');
		const [after] = await h!.db.select().from(purchase).where(eq(purchase.id, p));
		expect(after.state).toBe('pending_approval');
		expect(after.clearedAt).toBeNull();
		const lineAfter = await w.line('HEADPHONES SHOP');
		expect(lineAfter.matchState).toBe('matched');
		expect(lineAfter.matchedPurchaseId).toBe(p);
	});

	it('charged before approval: matched to the request, which is left untouched', async () => {
		const w = await world();
		const p = await askFirst(w, {
			member: w.alice,
			amount: 5000n,
			state: 'pending_approval',
			askedAt: '2026-10-10T12:00:00Z'
		});
		w.txns.push(txn('T1', '2026-10-11T10:00:00Z', -5000n, 'BEST BUY'));
		await w.sync();
		const l = await w.line('BEST BUY');
		const r = await settleOpenFromLine(h!.db, deps(w), scopeOf(w, w.alice), l.id, p);
		expect(r.state).toBe('linked');
		const [after] = await h!.db.select().from(purchase).where(eq(purchase.id, p));
		expect(after.state).toBe('pending_approval');
		expect((await w.line('BEST BUY')).matchState).toBe('matched');
	});

	it('on someone else’s card, a charge is held against their request until they mark it bought', async () => {
		const w = await world({ visibility: 'shared' });
		const p = await askFirst(w, {
			member: w.bob,
			amount: 5000n,
			state: 'approved',
			askedAt: '2026-10-10T12:00:00Z'
		});
		w.txns.push(txn('T1', '2026-10-12T10:00:00Z', -5000n, 'BEST BUY'));
		await w.sync();
		const l = await w.line('BEST BUY');
		const r = await settleOpenFromLine(h!.db, deps(w), scopeOf(w, w.alice), l.id, p);
		expect(r.state).toBe('linked');
		// Alice didn't mark Bob's purchase bought for him…
		const [after] = await h!.db.select().from(purchase).where(eq(purchase.id, p));
		expect(after.state).toBe('approved');
		// …but the line is spoken for, so nobody logs it a second time.
		const held = await w.line('BEST BUY');
		expect(held.matchState).toBe('matched');
		expect(held.matchedPurchaseId).toBe(p);
	});

	it('a request older than the window, or for a very different amount, is not offered', async () => {
		const w = await world();
		await askFirst(w, {
			member: w.alice,
			amount: 5000n,
			state: 'approved',
			askedAt: '2026-08-01T12:00:00Z'
		});
		await askFirst(w, {
			member: w.alice,
			amount: 20000n,
			state: 'approved',
			askedAt: '2026-10-10T12:00:00Z'
		});
		w.txns.push(txn('T1', '2026-10-12T10:00:00Z', -5000n, 'BEST BUY'));
		await w.sync();
		expect((await w.line('BEST BUY')).suggestedPurchaseIds).toEqual([]);
	});
});

describe('the ledger catching up', () => {
	it('a line that arrived first is matched once the purchase is logged', async () => {
		const w = await world();
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -1234n, 'SQ *BLUE BOTTLE'));
		await w.sync();
		expect((await w.line('SQ *BLUE BOTTLE')).matchState).toBe('unmatched');

		const p = await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Coffee',
			amountMinor: 1234n,
			state: 'completed',
			completedAt: new Date('2026-10-18T09:00:00Z')
		});
		w.now.t = new Date(w.now.t.getTime() + DAY);
		const r = await w.sync();
		expect(r.matched).toBe(1);
		const l = await w.line('SQ *BLUE BOTTLE');
		expect(l.matchState).toBe('matched');
		expect(l.matchedPurchaseId).toBe(p);
	});

	it('one purchase is never proposed to two lines across syncs', async () => {
		const w = await world();
		await w.ws.addPurchase({
			memberId: w.alice,
			itemName: 'Coffee',
			amountMinor: 500n,
			state: 'completed',
			completedAt: new Date('2026-10-18T09:00:00Z')
		});
		w.txns.push(txn('T1', '2026-10-18T10:00:00Z', -500n, 'CAFE'));
		await w.sync();
		w.txns.push(txn('T2', '2026-10-19T10:00:00Z', -500n, 'CAFE AGAIN'));
		w.now.t = new Date(w.now.t.getTime() + DAY);
		await w.sync();
		const matched = (await w.lines()).filter((l) => l.matchState === 'matched');
		expect(matched).toHaveLength(1);
		expect((await w.line('CAFE AGAIN')).matchState).toBe('unmatched');
	});

	it('every synced import for the card is attributed to the cardholder', async () => {
		const w = await world({ holder: 'bob' });
		w.txns.push(txn('T1', '2026-09-28T10:00:00Z', -100n, 'A'));
		w.txns.push(txn('T2', '2026-10-02T10:00:00Z', -100n, 'B'));
		await w.sync();
		const imps = await h!.db.select().from(statementImport);
		expect(imps).toHaveLength(2);
		expect(imps.every((i) => i.visibleToMemberId === w.bob && i.memberId === w.bob)).toBe(true);
	});
});
