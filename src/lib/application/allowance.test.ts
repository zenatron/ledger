/**
 * The allowance, end to end against real SQL.
 *
 * An allowance is not one thing in this codebase, it is three settings that
 * compose: a bucket only its owner can charge, a member held to their own
 * buckets, and an overdrawing charge that falls back to approval. Each piece is
 * unit-tested where it lives. What needs a database is whether they still add up
 * to the behaviour a parent thinks they bought, once the balance comes from a
 * live sum of transactions and the policy comes off a jsonb column.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { purchase, recurringRule } from '$lib/db/schema';
import type { Db } from '$lib/db/types';
import { submitPurchase } from '$lib/application/purchases';
import { createRule, RecurringRuleError } from '$lib/application/recurring';
import {
	addTransaction,
	bucketBalance,
	createBucket,
	listBuckets,
	updateBucket
} from '$lib/repo/buckets';
import { PurchaseStateError } from '$lib/domain/purchase/purchase';
import { Money } from '$lib/domain/money/money';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import { nullNotifier } from '$lib/ports/notifier';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const NOW = new Date('2026-08-19T12:00:00Z');
const deps = {
	clock: { now: () => NOW },
	ids: { newId: () => crypto.randomUUID() },
	notifier: nullNotifier
};

const MONTHLY = 'DTSTART=2026-08-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1';

/** What the guided setup composes: a capped kid and the parent who decides. */
function allowancePolicy(approverId: string): ApprovalPolicy {
	return {
		mode: 'always',
		bucket_charges: 'skip',
		own_buckets_only: true,
		routing: { mode: 'any_of', approver_ids: [approverId] }
	};
}

async function seedAllowance() {
	h = await makeTestDb();
	const db = h.db;
	const ws = await seedWorkspace(db);
	const kidId = await ws.addMember({
		display: 'Kid',
		policy: allowancePolicy(ws.ownerMemberId)
	});

	// The kid's allowance pot, with two weeks of it already in.
	const potId = await ws.addBucket({
		memberId: kidId,
		name: "Kid's allowance",
		amountMinor: 4000n,
		rrule: MONTHLY,
		chargeMemberIds: []
	});
	await addTransaction(db, deps, {
		bucketId: potId,
		amountMinor: 4000n,
		currency: ws.currency,
		type: 'accrual'
	});

	// The household's shared holiday fund, which the kid must not be able to
	// reach even though everyone else can.
	const sharedId = await ws.addBucket({
		memberId: ws.ownerMemberId,
		name: 'Holiday',
		amountMinor: 20_000n,
		rrule: MONTHLY
	});
	await addTransaction(db, deps, {
		bucketId: sharedId,
		amountMinor: 100_000n,
		currency: ws.currency,
		type: 'accrual'
	});

	return { db, ws, kidId, potId, sharedId };
}

const kidScope = (ws: { workspaceId: string }, kidId: string) => ({
	workspaceId: ws.workspaceId,
	memberId: kidId
});

async function stateOf(db: Db, purchaseId: string) {
	const [row] = await db
		.select({ state: purchase.state })
		.from(purchase)
		.where(eq(purchase.id, purchaseId));
	return row.state;
}

describe('an allowance', () => {
	it('spends inside the pot without asking anyone', async () => {
		const { db, ws, kidId, potId } = await seedAllowance();
		const { purchaseId } = await submitPurchase(db, deps, kidScope(ws, kidId), {
			itemName: 'Comic',
			amount: Money.of(1500n, ws.currency),
			categoryId: null,
			note: null,
			intent: 'log',
			bucketId: potId
		});

		expect(await stateOf(db, purchaseId)).toBe('completed');
		// The pot paid for it: 40.00 in, 15.00 out.
		expect(await bucketBalance(db, potId)).toBe(2500n);
	});

	it('routes a charge past the balance to the parent', async () => {
		const { db, ws, kidId, potId } = await seedAllowance();
		const { purchaseId } = await submitPurchase(db, deps, kidScope(ws, kidId), {
			itemName: 'Headphones',
			amount: Money.of(6000n, ws.currency),
			categoryId: null,
			note: null,
			intent: 'log',
			bucketId: potId
		});

		expect(await stateOf(db, purchaseId)).toBe('pending_approval');
		// Nothing left the pot: the withdrawal happens on completion, and this is
		// not completed. The cap held.
		expect(await bucketBalance(db, potId)).toBe(4000n);
	});

	it('asks at the exact edge only when the pot cannot cover it', async () => {
		const { db, ws, kidId, potId } = await seedAllowance();
		const exact = await submitPurchase(db, deps, kidScope(ws, kidId), {
			itemName: 'Exactly it',
			amount: Money.of(4000n, ws.currency),
			categoryId: null,
			note: null,
			intent: 'log',
			bucketId: potId
		});
		expect(await stateOf(db, exact.purchaseId)).toBe('completed');
		expect(await bucketBalance(db, potId)).toBe(0n);

		// Now the pot is empty, so a penny is already past it.
		const penny = await submitPurchase(db, deps, kidScope(ws, kidId), {
			itemName: 'One more',
			amount: Money.of(1n, ws.currency),
			categoryId: null,
			note: null,
			intent: 'log',
			bucketId: potId
		});
		expect(await stateOf(db, penny.purchaseId)).toBe('pending_approval');
	});

	it('refuses the household bucket outright', async () => {
		const { db, ws, kidId, sharedId } = await seedAllowance();
		await expect(
			submitPurchase(db, deps, kidScope(ws, kidId), {
				itemName: 'Console',
				amount: Money.of(30_000n, ws.currency),
				categoryId: null,
				note: null,
				intent: 'log',
				bucketId: sharedId
			})
		).rejects.toThrow(PurchaseStateError);

		// Refused, so it left no trace and took no money.
		expect(await bucketBalance(db, sharedId)).toBe(100_000n);
		const rows = await db.select({ id: purchase.id }).from(purchase);
		expect(rows).toHaveLength(0);
	});

	it('refuses a standing rule aimed at the household bucket too', async () => {
		const { db, ws, kidId, sharedId } = await seedAllowance();
		await expect(
			createRule(db, deps, kidScope(ws, kidId), {
				itemName: 'Streaming',
				amount: Money.of(1200n, ws.currency),
				categoryId: null,
				bucketId: sharedId,
				rrule: MONTHLY,
				autoComplete: true
			})
		).rejects.toThrow(RecurringRuleError);
	});

	it('still asks for spending that touches no bucket', async () => {
		const { db, ws, kidId } = await seedAllowance();
		const { purchaseId } = await submitPurchase(db, deps, kidScope(ws, kidId), {
			itemName: 'School trip',
			amount: Money.of(500n, ws.currency),
			categoryId: null,
			note: null,
			intent: 'request'
		});
		expect(await stateOf(db, purchaseId)).toBe('pending_approval');
	});
});

describe('a personal bucket', () => {
	it('is not an allowance unless one was set up', async () => {
		/*
		 * A member's own "only me" savings bucket and an allowance an owner set
		 * up for them hold the same charge list. The Members page used to infer
		 * the allowance from that list, so a Savings pot showed up as one. Only
		 * the flag says which is which.
		 */
		h = await makeTestDb();
		const db = h.db;
		const ws = await seedWorkspace(db);
		const savings = await createBucket(db, deps, {
			workspaceId: ws.workspaceId,
			memberId: ws.ownerMemberId,
			name: 'Savings',
			amountMinor: 10_000n,
			currency: ws.currency,
			rrule: MONTHLY,
			chargeMemberIds: []
		});
		const allowance = await createBucket(db, deps, {
			workspaceId: ws.workspaceId,
			memberId: ws.ownerMemberId,
			name: "Owner's allowance",
			amountMinor: 2000n,
			currency: ws.currency,
			rrule: MONTHLY,
			chargeMemberIds: [],
			isAllowance: true
		});

		const listed = await listBuckets(db, ws.workspaceId);
		const flag = (id: string) => listed.find((b) => b.bucket.id === id)?.bucket.isAllowance;
		expect(flag(savings.id)).toBe(false);
		expect(flag(allowance.id)).toBe(true);
	});

	it('is closed to other members, however unrestricted they are', async () => {
		const { db, ws, potId } = await seedAllowance();
		// The owner has the default do-anything policy, and still cannot spend
		// out of the kid's pot.
		await expect(
			submitPurchase(
				db,
				deps,
				{ workspaceId: ws.workspaceId, memberId: ws.ownerMemberId },
				{
					itemName: 'Groceries',
					amount: Money.of(1000n, ws.currency),
					categoryId: null,
					note: null,
					intent: 'log',
					bucketId: potId
				}
			)
		).rejects.toThrow(/owner/);
	});

	it('leaves shared buckets open to everyone, as before', async () => {
		const { db, ws, sharedId } = await seedAllowance();
		const otherId = await ws.addMember({ display: 'Partner' });
		const { purchaseId } = await submitPurchase(
			db,
			deps,
			{ workspaceId: ws.workspaceId, memberId: otherId },
			{
				itemName: 'Flights',
				amount: Money.of(50_000n, ws.currency),
				categoryId: null,
				note: null,
				intent: 'log',
				bucketId: sharedId
			}
		);
		expect(await stateOf(db, purchaseId)).toBe('completed');
		expect(await bucketBalance(db, sharedId)).toBe(50_000n);
	});

	it("drops other members' standing rules when it is closed", async () => {
		const { db, ws, kidId, sharedId } = await seedAllowance();
		// Two rules on the holiday bucket: the owner's, and one the kid wrote back
		// when the bucket was still open to everyone.
		const mine = await ws.addRecurring({
			memberId: ws.ownerMemberId,
			amountMinor: 1000n,
			rrule: MONTHLY,
			bucketId: sharedId
		});
		const theirs = await ws.addRecurring({
			memberId: kidId,
			amountMinor: 1000n,
			rrule: MONTHLY,
			bucketId: sharedId
		});

		await updateBucket(db, { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId }, sharedId, {
			chargeMemberIds: []
		});

		const rows = await db
			.select({ id: recurringRule.id, bucketId: recurringRule.bucketId })
			.from(recurringRule);
		// The owner's rule is untouched; the kid's no longer charges the bucket.
		expect(rows.find((r) => r.id === mine)!.bucketId).toBe(sharedId);
		expect(rows.find((r) => r.id === theirs)!.bucketId).toBeNull();
	});

	it('lets an unrestricted member overdraw a bucket exactly as before', async () => {
		const { db, ws, sharedId } = await seedAllowance();
		const { purchaseId } = await submitPurchase(
			db,
			deps,
			{ workspaceId: ws.workspaceId, memberId: ws.ownerMemberId },
			{
				itemName: 'Whole holiday',
				amount: Money.of(150_000n, ws.currency),
				categoryId: null,
				note: null,
				intent: 'log',
				bucketId: sharedId
			}
		);
		expect(await stateOf(db, purchaseId)).toBe('completed');
		expect(await bucketBalance(db, sharedId)).toBe(-50_000n);
	});
});
