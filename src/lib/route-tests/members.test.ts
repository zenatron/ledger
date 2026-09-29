/**
 * The members actions, driven the way the sheet drives them.
 *
 * Route actions had no tests: the domain rules underneath were covered, and a
 * form field the action forgot to read slipped between the two. `bucketScope`
 * was in the schema and on the sheet but not in the fields the action parsed,
 * so "Only their own buckets" never saved and any other edit wiped it — an
 * allowance member could then charge the shared buckets, skipping approval.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { bucket, recurringRule, workspace, workspaceMember, user } from '$lib/db/schema';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';

let h: TestDb | undefined;
vi.mock('$lib/server/db', () => ({ getDb: () => h!.db }));
vi.mock('$lib/server/audit', () => ({ audit: async () => {} }));

const { actions } = await import('../../routes/w/[workspace]/settings/members/+page.server');

afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function seed() {
	h = await makeTestDb();
	const db = h.db;
	const ws = await seedWorkspace(db);
	const kid = await ws.addMember({
		display: 'Kid',
		policy: {
			mode: 'always',
			bucket_charges: 'skip',
			own_buckets_only: true,
			routing: { mode: 'any_of', approver_ids: [ws.ownerMemberId] }
		}
	});
	const [wsRow] = await db.select().from(workspace).where(eq(workspace.id, ws.workspaceId));
	const [ownerRow] = await db
		.select({ member: workspaceMember, user })
		.from(workspaceMember)
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(eq(workspaceMember.id, ws.ownerMemberId));
	return { db, ws, kid, wsRow, ownerRow };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function post(
	s: Seeded,
	fields: [string, string][],
	action: 'policy' | 'setMemberStatus' = 'policy'
) {
	const form = new FormData();
	for (const [k, v] of fields) form.append(k, v);
	const event = {
		request: new Request(`http://x/?/${action}`, { method: 'POST', body: form }),
		locals: { workspace: s.wsRow, member: s.ownerRow.member, user: s.ownerRow.user },
		getClientAddress: () => '127.0.0.1'
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return actions[action](event as any);
}

async function policyOf(s: Seeded, memberId: string) {
	const [row] = await s.db
		.select({ p: workspaceMember.approvalPolicy })
		.from(workspaceMember)
		.where(eq(workspaceMember.id, memberId));
	return row.p as ApprovalPolicy;
}

describe('policy action', () => {
	it('keeps "only their own buckets" when another part of the policy is edited', async () => {
		const s = await seed();
		await post(s, [
			['memberId', s.kid],
			['mode', 'threshold'],
			['threshold', '20'],
			['bucketCharges', 'skip'],
			['bucketScope', 'own'],
			['routingMode', 'any_of'],
			['approverIds', s.ws.ownerMemberId]
		]);
		const p = await policyOf(s, s.kid);
		expect(p.mode).toBe('threshold');
		expect(p.own_buckets_only).toBe(true);
	});

	it('turns it off when the sheet says any bucket', async () => {
		const s = await seed();
		await post(s, [
			['memberId', s.kid],
			['mode', 'always'],
			['bucketScope', 'any'],
			['routingMode', 'any_of'],
			['approverIds', s.ws.ownerMemberId]
		]);
		expect((await policyOf(s, s.kid)).own_buckets_only).toBeUndefined();
	});

	it('turns it on from a member who never had it', async () => {
		const s = await seed();
		const adult = await s.ws.addMember({ display: 'Adult' });
		await post(s, [
			['memberId', adult],
			['mode', 'none'],
			['bucketScope', 'own'],
			['routingMode', 'any_of']
		]);
		expect((await policyOf(s, adult)).own_buckets_only).toBe(true);
	});
});

describe('disabling a member', () => {
	it('pauses the recurring charges and buckets they left running', async () => {
		const s = await seed();
		const rule = await s.ws.addRecurring({
			memberId: s.kid,
			itemName: 'Game pass',
			amountMinor: 1500n,
			rrule: 'DTSTART=2026-08-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1'
		});
		const pot = await s.ws.addBucket({
			memberId: s.kid,
			amountMinor: 1000n,
			rrule: 'DTSTART=2026-08-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1'
		});
		const ownRule = await s.ws.addRecurring({
			itemName: 'Rent',
			amountMinor: 200000n,
			rrule: 'DTSTART=2026-08-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1'
		});
		await post(
			s,
			[
				['memberId', s.kid],
				['disabled', 'true']
			],
			'setMemberStatus'
		);
		const status = async (id: string) =>
			(await s.db.select().from(recurringRule).where(eq(recurringRule.id, id)))[0].status;
		expect(await status(rule)).toBe('paused');
		expect(await status(ownRule)).toBe('active');
		const [b] = await s.db.select().from(bucket).where(eq(bucket.id, pot));
		expect(b.status).toBe('paused');
	});
});
