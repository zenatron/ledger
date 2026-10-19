/**
 * An allowance holder's own controls, driven through the bucket actions.
 *
 * The pot belongs to the member it is for, so every "your own bucket" action
 * reached it — including raising its amount and depositing into it. A deposit
 * is bookkeeping, not money, and the allowance policy lets anything the pot
 * covers through without asking: a kid could top up their own pot and then
 * spend the top-up with no one hearing about it. The amount, schedule and
 * who-can-charge are the parent's, through "Change allowance"; the rest of the
 * pot (name, colour, goal, spending out of it) stays the holder's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { bucket, purchase, workspace, workspaceMember, user } from '$lib/db/schema';
import { addTransaction, bucketBalance } from '$lib/repo/buckets';
import { submitPurchase } from '$lib/application/purchases';
import { Money } from '$lib/domain/money/money';
import { nullNotifier } from '$lib/ports/notifier';
import type { WorkspaceContext } from '$lib/ports/context';
import { actions } from '../../routes/w/[workspace]/buckets/handlers';

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

async function seed() {
	h = await makeTestDb();
	const db = h.db;
	const ws = await seedWorkspace(db);
	const kidId = await ws.addMember({
		display: 'Kid',
		policy: {
			mode: 'always',
			bucket_charges: 'skip',
			own_buckets_only: true,
			routing: { mode: 'any_of', approver_ids: [ws.ownerMemberId] }
		}
	});
	const potId = await ws.addBucket({
		memberId: kidId,
		name: "Kid's allowance",
		amountMinor: 4000n,
		rrule: MONTHLY,
		chargeMemberIds: []
	});
	await db.update(bucket).set({ isAllowance: true }).where(eq(bucket.id, potId));
	await addTransaction(db, deps, {
		bucketId: potId,
		amountMinor: 4000n,
		currency: ws.currency,
		type: 'accrual'
	});
	const [wsRow] = await db.select().from(workspace).where(eq(workspace.id, ws.workspaceId));
	const [kidRow] = await db
		.select({ member: workspaceMember, user })
		.from(workspaceMember)
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(eq(workspaceMember.id, kidId));
	const ctx = {
		db,
		deps,
		user: kidRow.user,
		workspace: wsRow,
		member: kidRow.member
	} as unknown as WorkspaceContext;
	return { db, ws, kidId, potId, ctx };
}

function post(fields: Record<string, string>) {
	const form = new FormData();
	for (const [k, val] of Object.entries(fields)) form.append(k, val);
	return { request: new Request('http://x/', { method: 'POST', body: form }) } as never;
}

describe("an allowance holder's own bucket controls", () => {
	it('cannot deposit into their own allowance', async () => {
		const { db, potId, ctx } = await seed();
		const res = await actions.adjust(
			ctx,
			post({ bucketId: potId, amount: '1000', type: 'adjustment' })
		);
		expect(res).toMatchObject({ status: 403 });
		expect(await bucketBalance(db, potId)).toBe(4000n);
	});

	it('so a top-up can never turn into spending nobody was asked about', async () => {
		const { db, ws, kidId, potId, ctx } = await seed();
		await actions.adjust(ctx, post({ bucketId: potId, amount: '1000', type: 'adjustment' }));
		const { purchaseId } = await submitPurchase(
			db,
			deps,
			{ workspaceId: ws.workspaceId, memberId: kidId },
			{
				intent: 'request',
				itemName: 'Console',
				note: null,
				categoryId: null,
				amount: Money.fromDecimal('500', ws.currency),
				bucketId: potId
			} as never
		);
		const [row] = await db
			.select({ state: purchase.state })
			.from(purchase)
			.where(eq(purchase.id, purchaseId));
		expect(row.state).toBe('pending_approval');
	});

	it('can still take money out of it', async () => {
		const { db, potId, ctx } = await seed();
		const res = await actions.adjust(
			ctx,
			post({ bucketId: potId, amount: '5', type: 'withdrawal' })
		);
		expect(res).toEqual({ ok: true });
		expect(await bucketBalance(db, potId)).toBe(3500n);
	});

	it('cannot change the amount or the schedule', async () => {
		const { db, potId, ctx } = await seed();
		const amount = await actions.edit(
			ctx,
			post({ bucketId: potId, name: "Kid's allowance", amount: '1000' })
		);
		expect(amount).toMatchObject({ status: 403 });
		const schedule = await actions.edit(
			ctx,
			post({
				bucketId: potId,
				name: "Kid's allowance",
				amount: '40',
				freq: 'weekly',
				interval: '1',
				weekDay: '1',
				startDate: '2026-08-19'
			})
		);
		expect(schedule).toMatchObject({ status: 403 });
		const [b] = await db.select().from(bucket).where(eq(bucket.id, potId));
		expect(b.amountMinor).toBe(4000n);
		expect(b.rrule).toBe(MONTHLY);
	});

	it('cannot open it to other members', async () => {
		const { db, potId, ctx } = await seed();
		const res = await actions.edit(
			ctx,
			post({ bucketId: potId, name: "Kid's allowance", amount: '40', chargeScope: 'anyone' })
		);
		expect(res).toMatchObject({ status: 403 });
		const [b] = await db.select().from(bucket).where(eq(bucket.id, potId));
		expect(b.chargeMemberIds).toEqual([]);
	});

	it('can still rename it and set a goal', async () => {
		const { db, potId, ctx } = await seed();
		const res = await actions.edit(
			ctx,
			post({ bucketId: potId, name: 'Saving for a bike', amount: '40', goalCap: '200' })
		);
		expect(res).toEqual({ ok: true });
		const [b] = await db.select().from(bucket).where(eq(bucket.id, potId));
		expect(b.name).toBe('Saving for a bike');
		expect(b.goalCapMinor).toBe(20000n);
	});
});
