import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { bankConnection, statementLine, workspaceMember } from '$lib/db/schema';
import {
	connectSimplefin,
	linkFeedAccount,
	syncConnection,
	syncDueConnections,
	type SecretBox
} from '$lib/application/bank-sync';
import {
	bankReviewTag,
	flushBankReviewAlerts,
	isDaytime,
	markReviewPending
} from '$lib/application/bank-review-alerts';
import { listConnections } from '$lib/repo/bank-feeds';
import type { NotificationMessage, Notifier, Recipient } from '$lib/ports/notifier';
import type { BankFeed } from '$lib/ports/bank-feed';
import type { FeedAccount } from '$lib/domain/bankfeed/simplefin';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

// The seeded workspace is in America/New_York: 15:00Z is 11:00 there.
const DAY = new Date('2026-10-12T15:00:00Z');
const NIGHT = new Date('2026-10-12T07:00:00Z'); // 03:00 in New York
const MORNING = new Date('2026-10-12T12:30:00Z'); // 08:30 in New York

const ids = { newId: () => crypto.randomUUID() };
const sealing: SecretBox = { seal: (p) => `sealed:${p}`, open: (s) => s.replace(/^sealed:/, '') };
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

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

function recorder() {
	const sent: { recipients: Recipient[]; eventType: string; msg: NotificationMessage }[] = [];
	const notifier: Notifier = {
		notify: async (recipients, eventType, msg) => {
			sent.push({ recipients, eventType, msg });
		}
	};
	return { sent, notifier };
}

async function setup() {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db);
	const account: FeedAccount = {
		externalId: 'ACT-VISA',
		name: 'Visa Signature',
		orgName: 'Chase',
		currency: 'USD',
		balanceMinor: 0n,
		balanceAt: DAY,
		transactions: []
	};
	const feed: BankFeed = {
		claim: async () => 'https://u:p@beta-bridge.simplefin.org/simplefin',
		accounts: async () => ({ accounts: [structuredClone(account)], errors: [] })
	};
	const clock = {
		at: DAY,
		now() {
			return this.at;
		}
	};
	const { sent, notifier } = recorder();
	const deps = { clock, ids, notifier, feed, secrets: sealing };
	const scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
	const { connectionId } = await connectSimplefin(h.db, deps, scope, 'good-token');
	const [conn] = await listConnections(h.db, ws.workspaceId);
	await linkFeedAccount(h.db, deps, scope, conn.accounts[0].id, { create: true });
	return { db: h.db, ws, deps, clock, sent, account, connectionId };
}

describe('bank review alerts', () => {
	it('tells the owner once, with only a count, after a sync leaves lines', async () => {
		const { db, ws, deps, sent, account } = await setup();
		account.transactions = [
			txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE 0042'),
			txn('t2', 9, -8400n, 'WHOLE FOODS #123')
		];

		await syncDueConnections(db, deps);

		expect(sent).toHaveLength(1);
		const [{ recipients, eventType, msg }] = sent;
		expect(eventType).toBe('bank_review');
		expect(recipients.map((r) => r.memberId)).toEqual([ws.ownerMemberId]);
		expect(msg.title).toBe('2 bank transactions to review');
		expect(msg.tag).toBe(bankReviewTag(ws.workspaceId));
		expect(msg.path).toMatch(/^\/w\/ws-[\w-]+\/reconcile\/[0-9a-f-]{36}$/);
		// The lock screen gets a count, never what was bought or for how much.
		const shown = `${msg.title} ${msg.body}`;
		expect(shown).not.toMatch(/BLUE BOTTLE|WHOLE FOODS|12\.50|84\.00|\bChase\b/i);
	});

	it('says nothing when a sync brings nothing new', async () => {
		const { db, deps, sent, account, clock } = await setup();
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];
		await syncDueConnections(db, deps);
		expect(sent).toHaveLength(1);

		// Six hours on, the same transaction comes back in the overlap window.
		clock.at = new Date(DAY.getTime() + 7 * 3600_000);
		await syncDueConnections(db, deps);
		expect(sent).toHaveLength(1);
	});

	it('holds a night-time sync until the morning', async () => {
		const { db, deps, sent, account, clock, connectionId } = await setup();
		clock.at = NIGHT;
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];

		await syncDueConnections(db, deps);
		expect(sent).toHaveLength(0);
		const [held] = await db
			.select({ at: bankConnection.reviewAlertPendingAt })
			.from(bankConnection)
			.where(eq(bankConnection.id, connectionId));
		expect(held.at).toEqual(NIGHT);

		// A sweep tick at 08:30 syncs nothing new but sends what was held.
		clock.at = MORNING;
		await syncDueConnections(db, deps);
		expect(sent).toHaveLength(1);
		expect(sent[0].msg.title).toBe('1 bank transaction to review');
	});

	it('counts everything still waiting, so the newest alert replaces the last', async () => {
		const { db, deps, sent, account, clock } = await setup();
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];
		await syncDueConnections(db, deps);

		clock.at = new Date(DAY.getTime() + 7 * 3600_000); // 18:00 in New York
		account.transactions.push(txn('t2', 10, -900n, 'CORNER STORE'));
		await syncDueConnections(db, deps);

		expect(sent.map((s) => s.msg.title)).toEqual([
			'1 bank transaction to review',
			'2 bank transactions to review'
		]);
		expect(new Set(sent.map((s) => s.msg.tag)).size).toBe(1);
	});

	it('does not buzz the person who pressed Sync now, but tells the other owner', async () => {
		const { db, ws, deps, sent, account, connectionId } = await setup();
		const coOwner = await ws.addMember({ display: 'Dana' });
		await db.update(workspaceMember).set({ role: 'owner' }).where(eq(workspaceMember.id, coOwner));
		const member = await ws.addMember({ display: 'Elliot' });
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];

		await syncConnection(db, deps, ws.workspaceId, connectionId, {
			actorMemberId: ws.ownerMemberId
		});

		expect(sent).toHaveLength(1);
		const told = sent[0].recipients.map((r) => r.memberId);
		expect(told).toEqual([coOwner]);
		expect(told).not.toContain(member);
	});

	it('sends once when two sweeps race for the same pending alert', async () => {
		const { db, ws, deps, sent, account, connectionId } = await setup();
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];
		await syncConnection(db, deps, ws.workspaceId, connectionId); // marks, sends nothing
		expect(sent).toHaveLength(0);

		const results = await Promise.all([
			flushBankReviewAlerts(db, deps),
			flushBankReviewAlerts(db, deps)
		]);
		expect(results.reduce((a, b) => a + b, 0)).toBe(1);
		expect(sent).toHaveLength(1);
	});

	it('stays quiet if the lines were answered before it could be sent', async () => {
		const { db, ws, deps, sent, clock, account, connectionId } = await setup();
		clock.at = NIGHT;
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];
		await syncConnection(db, deps, ws.workspaceId, connectionId);
		// Someone up late ignored it in Reconcile.
		await db.update(statementLine).set({ matchState: 'ignored' });

		clock.at = MORNING;
		await flushBankReviewAlerts(db, deps);
		expect(sent).toHaveLength(0);
		// And the mark is gone, so it can't fire later for lines that no longer wait.
		const [row] = await db.select({ at: bankConnection.reviewAlertPendingAt }).from(bankConnection);
		expect(row.at).toBeNull();
	});

	it('never turns a good sync into a failure when the alert cannot be sent', async () => {
		const { db, ws, deps, account, connectionId } = await setup();
		account.transactions = [txn('t1', 8, -1250n, 'BLUE BOTTLE COFFEE')];
		const broken = {
			...deps,
			notifier: {
				notify: async () => {
					throw new Error('push service down');
				}
			}
		};
		const result = await syncConnection(db, broken, ws.workspaceId, connectionId, {
			actorMemberId: crypto.randomUUID()
		});
		expect(result.added).toBe(1);
		const [row] = await db.select({ status: bankConnection.status }).from(bankConnection);
		expect(row.status).toBe('ok');
	});

	it('keeps the earliest pending mark', async () => {
		const { db, connectionId } = await setup();
		await markReviewPending(db, connectionId, NIGHT);
		await markReviewPending(db, connectionId, MORNING);
		const [row] = await db.select({ at: bankConnection.reviewAlertPendingAt }).from(bankConnection);
		expect(row.at).toEqual(NIGHT);
	});
});

describe('isDaytime', () => {
	it('is 08:00 up to 21:00 in the workspace timezone', () => {
		const ny = 'America/New_York';
		expect(isDaytime(new Date('2026-10-12T11:59:00Z'), ny)).toBe(false); // 07:59
		expect(isDaytime(new Date('2026-10-12T12:00:00Z'), ny)).toBe(true); // 08:00
		expect(isDaytime(new Date('2026-10-13T00:59:00Z'), ny)).toBe(true); // 20:59
		expect(isDaytime(new Date('2026-10-13T01:00:00Z'), ny)).toBe(false); // 21:00
		expect(isDaytime(new Date('2026-10-12T01:00:00Z'), 'Asia/Tokyo')).toBe(true); // 10:00
	});
});
