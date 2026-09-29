/**
 * The side doors a sealed purchase used to leak through, against real SQL.
 *
 * Every read of a purchase row was already seal-filtered. These are the paths
 * that reached a concealed member *without* reading the row: a notification
 * fanned out to an approver list built from the requester's live policy, a
 * reminder sweep that rebuilt the same list in SQL, and a bucket movement that
 * carried the item name in its note. Each test is the leak as it was first
 * reproduced, so a regression shows up as exactly the message that escaped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { bucketTransaction, workspaceMember } from '$lib/db/schema';
import type { Db } from '$lib/db/types';
import { deletePurchase, editPurchase, submitPurchase } from '$lib/application/purchases';
import { nudgeStaleRequests } from '$lib/application/nudge-stale';
import { listLedger } from '$lib/repo/ledger';
import { loadPurchase } from '$lib/repo/purchases';
import {
	addTransaction,
	bucketBalance,
	bucketFlowsInPeriod,
	listBuckets,
	totalSaved
} from '$lib/repo/buckets';
import { Money } from '$lib/domain/money/money';
import { monthPeriod } from '$lib/domain/analytics/period';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import type { NotificationMessage, Notifier, Recipient } from '$lib/ports/notifier';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const MONTHLY = 'DTSTART=2026-08-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1';

interface Sent {
	to: string[];
	msg: NotificationMessage;
}

/**
 * A household of three: the requester, the partner a gift is hidden from, and
 * a parent who can approve and see it. The requester's policy names *both*
 * others as approvers — the ordinary setup that made the partner reachable.
 */
async function seedHousehold() {
	h = await makeTestDb();
	const db = h.db;
	const ws = await seedWorkspace(db);
	const requester = ws.ownerMemberId;
	const partner = await ws.addMember({ display: 'Partner' });
	const parent = await ws.addMember({ display: 'Parent' });
	const policy: ApprovalPolicy = {
		mode: 'always',
		routing: { mode: 'any_of', approver_ids: [partner, parent] }
	};
	await db
		.update(workspaceMember)
		.set({ approvalPolicy: policy })
		.where(eq(workspaceMember.id, requester));

	const sent: Sent[] = [];
	const notifier: Notifier = {
		async notify(recipients: Recipient[], _type, msg) {
			sent.push({ to: recipients.map((r) => r.memberId), msg });
		}
	};
	const clock = { at: new Date('2026-08-19T12:00:00Z') };
	const deps = {
		clock: { now: () => clock.at },
		ids: { newId: () => crypto.randomUUID() },
		notifier
	};
	const seal = { sealedUntil: new Date('2026-09-30T00:00:00Z'), sealedFromMemberIds: [partner] };
	const scope = { workspaceId: ws.workspaceId, memberId: requester };
	return { db, ws, requester, partner, parent, sent, clock, deps, seal, scope };
}

function reached(sent: Sent[], memberId: string) {
	return sent.filter((s) => s.to.includes(memberId)).map((s) => s.msg.body);
}

describe('approver notifications', () => {
	it('never counts the concealed member among who can decide', async () => {
		const { db, ws, requester, partner, parent, deps, seal, scope, clock } = await seedHousehold();
		const { purchaseId } = await submitPurchase(db, deps, scope, {
			itemName: 'Engagement ring',
			amount: Money.of(300000n, 'USD'),
			categoryId: null,
			note: null,
			intent: 'request',
			seal
		});
		const p = await loadPurchase(
			db,
			{ workspaceId: ws.workspaceId, viewerId: requester },
			purchaseId,
			{ now: clock.at }
		);
		expect(p!.approverMemberIds).toContain(parent);
		expect(p!.approverMemberIds).not.toContain(partner);
	});

	it('does not tell the concealed member when an edit sends it back for approval', async () => {
		const { db, partner, parent, sent, deps, seal, scope } = await seedHousehold();
		const { purchaseId } = await submitPurchase(db, deps, scope, {
			itemName: 'Engagement ring',
			amount: Money.of(300000n, 'USD'),
			categoryId: null,
			note: null,
			intent: 'request',
			seal
		});
		sent.length = 0;
		await editPurchase(db, deps, scope, purchaseId, {
			itemName: 'Engagement ring',
			requestedAmount: Money.of(320000n, 'USD')
		});
		expect(reached(sent, partner)).toEqual([]);
		expect(reached(sent, parent)).toHaveLength(1);
	});

	it('does not nudge the concealed member about a stale sealed request', async () => {
		const { db, partner, parent, sent, deps, seal, scope, clock } = await seedHousehold();
		await submitPurchase(db, deps, scope, {
			itemName: 'Engagement ring',
			amount: Money.of(300000n, 'USD'),
			categoryId: null,
			note: null,
			intent: 'request',
			seal
		});
		sent.length = 0;
		clock.at = new Date('2026-08-25T12:00:00Z');
		await nudgeStaleRequests(db, deps);
		expect(reached(sent, partner)).toEqual([]);
		expect(reached(sent, parent)).toHaveLength(1);
	});

	it('nudges everyone the policy names once the seal has opened', async () => {
		const { db, partner, sent, deps, scope, clock } = await seedHousehold();
		await submitPurchase(db, deps, scope, {
			itemName: 'Anniversary dinner',
			amount: Money.of(20000n, 'USD'),
			categoryId: null,
			note: null,
			intent: 'request',
			seal: { sealedUntil: new Date('2026-08-21T00:00:00Z'), sealedFromMemberIds: [partner] }
		});
		sent.length = 0;
		clock.at = new Date('2026-08-25T12:00:00Z');
		await nudgeStaleRequests(db, deps);
		expect(reached(sent, partner)).toHaveLength(1);
	});
});

describe('bucket movements', () => {
	async function chargeSealedGift() {
		const ctx = await seedHousehold();
		const { db, ws, requester, deps, seal, scope } = ctx;
		// No approval needed, so the charge completes and withdraws immediately.
		await db
			.update(workspaceMember)
			.set({ approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } } })
			.where(eq(workspaceMember.id, requester));
		const bucketId = await ws.addBucket({
			memberId: requester,
			name: 'Gifts',
			amountMinor: 1000n,
			rrule: MONTHLY
		});
		await addTransaction(db, deps, {
			bucketId,
			amountMinor: 500000n,
			currency: 'USD',
			type: 'accrual'
		});
		const { purchaseId } = await submitPurchase(db, deps, scope, {
			itemName: 'Diamond necklace',
			amount: Money.of(90000n, 'USD'),
			categoryId: null,
			note: null,
			intent: 'log',
			seal,
			bucketId
		});
		return { ...ctx, bucketId, purchaseId };
	}

	async function ledgerNotes(db: Db, workspaceId: string, viewerId: string, now: Date) {
		const all = await listLedger(db, { workspaceId, viewerId }, now, { includeMovements: true });
		return all.entries.map((e) => (e.kind === 'movement' ? e.note : `purchase:${e.itemName}`));
	}

	it("keeps a sealed charge's movement off the concealed member's ledger", async () => {
		const { db, ws, requester, partner, clock } = await chargeSealedGift();
		expect(await ledgerNotes(db, ws.workspaceId, partner, clock.at)).not.toContain(
			'Diamond necklace'
		);
		// The requester still sees their own withdrawal.
		expect(await ledgerNotes(db, ws.workspaceId, requester, clock.at)).toContain(
			'Diamond necklace'
		);
	});

	it('cannot be found by searching for it', async () => {
		const { db, ws, partner, clock } = await chargeSealedGift();
		const hit = await listLedger(db, { workspaceId: ws.workspaceId, viewerId: partner }, clock.at, {
			includeMovements: true,
			search: 'necklace'
		});
		expect(hit.total).toBe(0);
	});

	it('leaves balances unable to be differenced against the gift', async () => {
		const { db, ws, partner, requester, bucketId, clock } = await chargeSealedGift();
		const forPartner = { viewerId: partner, now: clock.at };
		expect(await bucketBalance(db, bucketId, forPartner)).toBe(500000n);
		expect(await totalSaved(db, ws.workspaceId, forPartner)).toBe(500000n);
		const [listed] = await listBuckets(db, ws.workspaceId, forPartner);
		expect(listed.balanceMinor).toBe(500000n);
		const flows = await bucketFlowsInPeriod(
			db,
			ws.workspaceId,
			monthPeriod({ y: 2026, m: 8, d: 19 }),
			ws.timezone,
			forPartner
		);
		expect(flows.releasedMinor).toBe(0n);

		// The real balance — what charges are judged against — is untouched, and
		// the requester reads it.
		expect(await bucketBalance(db, bucketId)).toBe(410000n);
		expect(await bucketBalance(db, bucketId, { viewerId: requester, now: clock.at })).toBe(410000n);
	});

	it('shows the movement to everyone once the seal opens', async () => {
		const { db, ws, partner } = await chargeSealedGift();
		const after = new Date('2026-10-01T00:00:00Z');
		expect(await ledgerNotes(db, ws.workspaceId, partner, after)).toContain('Diamond necklace');
	});

	it('deletes the movement with its purchase instead of leaving the name behind', async () => {
		const { db, ws, partner, bucketId, purchaseId, deps, scope } = await chargeSealedGift();
		await deletePurchase(db, deps, scope, purchaseId);
		const rows = await db
			.select({ note: bucketTransaction.note })
			.from(bucketTransaction)
			.where(eq(bucketTransaction.bucketId, bucketId));
		expect(rows.map((r) => r.note)).toEqual([null]);
		expect(await bucketBalance(db, bucketId)).toBe(500000n);
		const after = new Date('2026-10-01T00:00:00Z');
		expect(await ledgerNotes(db, ws.workspaceId, partner, after)).not.toContain(
			'Removed: Diamond necklace'
		);
	});
});
