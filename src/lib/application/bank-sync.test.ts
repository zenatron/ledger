import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import {
	bankBalanceSnapshot,
	bankConnection,
	bankFeedAccount,
	bankSyncRun,
	statementImport,
	statementLine
} from '$lib/db/schema';
import type { BankFeedClient } from '$lib/ports/bank-feed';
import { SimpleFinError, type FeedAccount } from '$lib/domain/banksync/simplefin';
import {
	BankSyncError,
	MAX_RUNS_PER_DAY,
	connectSimpleFin,
	createRule,
	disconnect,
	reapplyRules,
	setFeedAccountEnabled,
	syncConnection,
	syncDueConnections,
	type BankSyncDeps
} from './bank-sync';
import { createPurchaseFromLine } from './reconcile';
import { deleteWorkspace } from './delete-workspace';
import { nullNotifier } from '$lib/ports/notifier';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const ACCESS = 'https://user:pass@beta-bridge.simplefin.org/simplefin';

function fakeFeed() {
	const state = {
		accounts: [] as FeedAccount[],
		fail: null as SimpleFinError | null,
		calls: [] as { start: Date; end: Date; balancesOnly?: boolean }[]
	};
	const feed: BankFeedClient = {
		async claim(token) {
			if (token === 'used') throw new SimpleFinError('already used', 'claimed');
			return ACCESS;
		},
		async fetchAccounts(url, q) {
			expect(url).toBe(ACCESS);
			state.calls.push(q);
			if (state.fail) throw state.fail;
			return {
				httpStatus: 200,
				messages: [],
				accounts: state.accounts.map((a) => ({
					...a,
					transactions: q.balancesOnly ? [] : a.transactions
				}))
			};
		}
	};
	return { state, feed };
}

function setup(now: { t: Date }, opts: { secrets?: boolean } = {}) {
	const { state, feed } = fakeFeed();
	let n = 0;
	const deps: BankSyncDeps = {
		clock: { now: () => now.t },
		ids: { newId: () => crypto.randomUUID() },
		feed,
		secrets: {
			available: opts.secrets ?? true,
			seal: (s) => `enc:test:${Buffer.from(s).toString('base64')}`,
			open: (s) => Buffer.from(s.slice('enc:test:'.length), 'base64').toString()
		},
		config: { intervalHours: 6, backfillDays: 30 },
		random: () => (n++ % 2) * 0
	};
	return { state, deps };
}

const card = (
	txns: { id: string; at: string; amt: bigint; desc: string; pending?: boolean }[]
): FeedAccount => ({
	id: 'ACC-1',
	name: 'Sapphire Visa 1234',
	institution: 'Chase',
	currency: 'USD',
	unsupported: null,
	balanceMinor: -51234n,
	availableBalanceMinor: 448766n,
	balanceAt: null,
	transactions: txns.map((t) => ({
		id: t.id,
		postedAt: new Date(t.at),
		transactedAt: null,
		amountMinor: t.amt,
		description: t.desc,
		pending: t.pending ?? false
	}))
});

async function connected() {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db, { timezone: 'America/New_York' });
	const now = { t: new Date('2026-10-20T12:00:00Z') };
	const { state, deps } = setup(now);
	const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
	state.accounts = [
		card([
			{ id: 'T1', at: '2026-10-10T16:00:00Z', amt: -1234n, desc: 'SQ *BLUE BOTTLE COFFEE' },
			{ id: 'T2', at: '2026-10-11T16:00:00Z', amt: -4800n, desc: 'COSTCO WHSE #0144' },
			{ id: 'T3', at: '2026-10-12T16:00:00Z', amt: -50000n, desc: 'AUTOPAY PAYMENT THANK YOU' },
			{ id: 'T4', at: '2026-09-28T16:00:00Z', amt: -999n, desc: 'NETFLIX.COM' },
			{ id: 'T5', at: '2026-10-19T16:00:00Z', amt: -700n, desc: 'PENDING THING', pending: true },
			{ id: 'T7', at: '2026-10-13T16:00:00Z', amt: 0n, desc: 'CARD VERIFICATION' }
		])
	];
	const { connectionId } = await connectSimpleFin(h.db, deps, scope, {
		setupToken: 'tok',
		label: 'Our banks'
	});
	return { ws, now, state, deps, scope, connectionId };
}

describe('connect', () => {
	it('stores the credential sealed and discovers accounts switched off', async () => {
		const { state, connectionId } = await connected();
		const [c] = await h!.db
			.select()
			.from(bankConnection)
			.where(eq(bankConnection.id, connectionId));
		expect(c.credentialSealed).toMatch(/^enc:/);
		expect(c.credentialSealed).not.toContain('pass');
		expect(c.host).toBe('beta-bridge.simplefin.org');

		const feeds = await h!.db.select().from(bankFeedAccount);
		expect(feeds).toHaveLength(1);
		expect(feeds[0].enabled).toBe(false);
		// Discovery asks for balances only: no transactions leave the bridge
		// until a person opts an account in.
		expect(state.calls[0].balancesOnly).toBe(true);
		expect(await h!.db.select().from(statementLine)).toHaveLength(0);
	});

	it('refuses without SECRETS_KEY', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { deps } = setup({ t: new Date() }, { secrets: false });
		await expect(
			connectSimpleFin(
				h.db,
				deps,
				{ workspaceId: ws.workspaceId, memberId: ws.ownerMemberId },
				{ setupToken: 't' }
			)
		).rejects.toBeInstanceOf(BankSyncError);
		expect(await h.db.select().from(bankConnection)).toHaveLength(0);
	});
});

describe('sync', () => {
	it('adds posted lines to monthly imports, matching, categorising and ignoring', async () => {
		const { ws, now, deps, scope, connectionId } = await connected();
		const groceries = await ws.addCategory('Groceries');
		const coffee = await ws.addCategory('Coffee');
		const bb = await ws.addMerchant({ name: 'Blue Bottle' });
		// A purchase from before, filed under Coffee, teaches merchant memory.
		await ws.addPurchase({
			itemName: 'Latte',
			amountMinor: 650n,
			categoryId: coffee,
			merchantId: bb,
			state: 'completed',
			completedAt: new Date('2026-08-01T15:00:00Z')
		});
		// And an existing purchase the Costco line should match.
		const costcoPurchase = await ws.addPurchase({
			itemName: 'Costco run',
			amountMinor: 4800n,
			state: 'completed',
			completedAt: new Date('2026-10-11T14:00:00Z')
		});
		await createRule(h!.db, deps, scope, {
			match: 'starts_with',
			pattern: 'AUTOPAY',
			direction: 'out',
			action: 'ignore',
			categoryId: null,
			renameTo: null,
			feedAccountId: null,
			minAmountMinor: null,
			maxAmountMinor: null
		});
		await createRule(h!.db, deps, scope, {
			match: 'contains',
			pattern: 'netflix',
			direction: 'out',
			action: 'categorize',
			categoryId: groceries,
			renameTo: 'Netflix',
			feedAccountId: null,
			minAmountMinor: null,
			maxAmountMinor: null
		});

		const [feed] = await h!.db.select().from(bankFeedAccount);
		await setFeedAccountEnabled(h!.db, deps, scope, feed.id, true);

		now.t = new Date(now.t.getTime() + 20 * 60_000);
		const r = await syncConnection(h!.db, deps, connectionId, 'manual');
		expect(r.status).toBe('ok');
		expect(r.inserted).toBe(4); // pending T5 and zero-amount T7 are never stored
		expect(r.matched).toBe(1);

		const lines = await h!.db.select().from(statementLine);
		const by = (d: string) => lines.find((l) => l.rawDescription.startsWith(d))!;
		expect(by('COSTCO').matchState).toBe('matched');
		expect(by('COSTCO').matchedPurchaseId).toBe(costcoPurchase);
		expect(by('AUTOPAY').matchState).toBe('ignored');
		expect(by('NETFLIX')).toMatchObject({
			suggestedCategoryId: groceries,
			suggestedName: 'Netflix',
			suggestionSource: 'rule'
		});
		expect(by('SQ *BLUE')).toMatchObject({
			suggestedCategoryId: coffee,
			suggestionSource: 'memory'
		});

		// Two months → two rolling imports, attributed to the card created on enable.
		const imports = await h!.db.select().from(statementImport);
		expect(imports.map((i) => i.filename).sort()).toEqual([
			'Sapphire Visa 1234 · Oct 2026 (bank sync)',
			'Sapphire Visa 1234 · Sep 2026 (bank sync)'
		]);
		expect(imports.every((i) => i.format === 'sync' && i.accountId)).toBe(true);
		expect(imports.reduce((s, i) => s + i.lineCount, 0)).toBe(4);

		// Balance tracked for the day.
		const snaps = await h!.db.select().from(bankBalanceSnapshot);
		expect(snaps).toHaveLength(1);
		expect(snaps[0].balanceMinor).toBe(-51234n);

		// The suggestion flows into "Add to ledger".
		const created = await createPurchaseFromLine(
			h!.db,
			{ ...deps, notifier: nullNotifier },
			scope,
			by('NETFLIX').id
		);
		expect(created.state).toBe('completed');
	});

	it('is idempotent across overlapping windows', async () => {
		const { now, state, deps, scope, connectionId } = await connected();
		const [feed] = await h!.db.select().from(bankFeedAccount);
		await setFeedAccountEnabled(h!.db, deps, scope, feed.id, true);
		now.t = new Date(now.t.getTime() + 20 * 60_000);
		await syncConnection(h!.db, deps, connectionId, 'manual');

		// Next day: the bridge re-sends everything plus one new line.
		state.accounts[0].transactions.push({
			id: 'T6',
			postedAt: new Date('2026-10-20T16:00:00Z'),
			transactedAt: null,
			amountMinor: -2500n,
			description: 'SAFEWAY',
			pending: false
		});
		now.t = new Date(now.t.getTime() + 24 * 3_600_000);
		const r = await syncConnection(h!.db, deps, connectionId, 'schedule');
		expect(r.inserted).toBe(1);
		const [run] = await h!.db.select().from(bankSyncRun).where(eq(bankSyncRun.id, r.runId!));
		expect(run.duplicates).toBe(4);
		expect(await h!.db.select().from(statementLine)).toHaveLength(5);

		// The second window starts a few days before where the first got to.
		const last = state.calls.at(-1)!;
		expect(last.balancesOnly).toBe(false);
		expect(now.t.getTime() - last.start.getTime()).toBeLessThan(7 * 86_400_000);
	});

	it('first window backfills, capped by the config', async () => {
		const { now, state, deps, scope, connectionId } = await connected();
		const [feed] = await h!.db.select().from(bankFeedAccount);
		await setFeedAccountEnabled(h!.db, deps, scope, feed.id, true);
		now.t = new Date(now.t.getTime() + 20 * 60_000);
		await syncConnection(h!.db, deps, connectionId, 'manual');
		const q = state.calls.at(-1)!;
		expect(Math.round((q.end.getTime() - q.start.getTime()) / 86_400_000)).toBe(30);
	});

	it('refuses a manual sync during the cooldown, and two at once', async () => {
		const { now, deps, connectionId } = await connected();
		await expect(syncConnection(h!.db, deps, connectionId, 'manual')).rejects.toBeInstanceOf(
			BankSyncError
		);
		now.t = new Date(now.t.getTime() + 11 * 60_000);
		const results = await Promise.allSettled([
			syncConnection(h!.db, deps, connectionId, 'manual'),
			syncConnection(h!.db, deps, connectionId, 'manual')
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	});

	it('stops at the daily cap', async () => {
		const { now, deps, connectionId } = await connected();
		for (let i = 1; i < MAX_RUNS_PER_DAY; i++) {
			now.t = new Date(now.t.getTime() + 6 * 60_000);
			await syncConnection(h!.db, deps, connectionId, 'schedule');
		}
		now.t = new Date(now.t.getTime() + 6 * 60_000);
		await expect(syncConnection(h!.db, deps, connectionId, 'schedule')).rejects.toThrow(
			/daily sync limit/
		);
	});

	it('marks a revoked token and stops scheduling it', async () => {
		const { now, state, deps, connectionId } = await connected();
		state.fail = new SimpleFinError('refused', 'revoked');
		now.t = new Date(now.t.getTime() + 7 * 3_600_000);
		expect(await syncDueConnections(h!.db, deps)).toBe(0);
		const [c] = await h!.db.select().from(bankConnection);
		expect(c.status).toBe('revoked');
		expect(c.nextSyncAt).toBeNull();
		const runs = await h!.db
			.select()
			.from(bankSyncRun)
			.where(eq(bankSyncRun.connectionId, connectionId));
		expect(runs.at(-1)?.status).toBe('error');
		expect(JSON.stringify(runs)).not.toContain('pass');
	});

	it('a later rule answers lines already waiting', async () => {
		const { ws, now, deps, scope, connectionId } = await connected();
		const [feed] = await h!.db.select().from(bankFeedAccount);
		await setFeedAccountEnabled(h!.db, deps, scope, feed.id, true);
		now.t = new Date(now.t.getTime() + 20 * 60_000);
		await syncConnection(h!.db, deps, connectionId, 'manual');
		const subs = await ws.addCategory('Subscriptions');
		await createRule(h!.db, deps, scope, {
			match: 'equals',
			pattern: 'netflix.com',
			direction: 'out',
			action: 'categorize',
			categoryId: subs,
			renameTo: null,
			feedAccountId: null,
			minAmountMinor: null,
			maxAmountMinor: null
		});
		expect(await reapplyRules(h!.db, scope)).toBe(1);
		const [l] = await h!.db
			.select()
			.from(statementLine)
			.where(eq(statementLine.rawDescription, 'NETFLIX.COM'));
		expect(l.suggestedCategoryId).toBe(subs);
	});
});

describe('disconnect', () => {
	it('destroys the credential and keeps history; the workspace can still be deleted', async () => {
		const { ws, now, deps, scope, connectionId } = await connected();
		const [feed] = await h!.db.select().from(bankFeedAccount);
		await setFeedAccountEnabled(h!.db, deps, scope, feed.id, true);
		now.t = new Date(now.t.getTime() + 20 * 60_000);
		await syncConnection(h!.db, deps, connectionId, 'manual');

		expect(await disconnect(h!.db, deps, scope, connectionId)).toBe(true);
		const [c] = await h!.db.select().from(bankConnection);
		expect(c.credentialSealed).toBeNull();
		expect(c.status).toBe('disconnected');
		expect((await h!.db.select().from(statementLine)).length).toBeGreaterThan(0);
		now.t = new Date(now.t.getTime() + 60 * 60_000);
		await expect(syncConnection(h!.db, deps, connectionId, 'manual')).rejects.toBeInstanceOf(
			BankSyncError
		);

		await deleteWorkspace(h!.db, ws.workspaceId);
		expect(await h!.db.select().from(bankConnection)).toHaveLength(0);
		expect(await h!.db.select().from(statementLine)).toHaveLength(0);
	});

	it('another workspace cannot disconnect it', async () => {
		const { connectionId, deps } = await connected();
		const other = await seedWorkspace(h!.db);
		expect(
			await disconnect(
				h!.db,
				deps,
				{ workspaceId: other.workspaceId, memberId: other.ownerMemberId },
				connectionId
			)
		).toBe(false);
	});
});
