/**
 * In-memory Postgres for repo and application integration tests.
 *
 * The repo layer — the seal filter, every analytics window function, ledger
 * paging, forecast orchestration, refunds, accrual — had zero tests: it ran
 * only under the five Playwright specs. That gap closed the moment the demo
 * build proved the repo layer runs unchanged on PGlite (see
 * `scripts/pglite-probe.ts`); this is that proof turned into a test harness.
 *
 * Each `makeTestDb()` is a fresh, isolated database with the full schema, so a
 * test can assert on real SQL — a seal that must not leak, a refund that must
 * net to zero — in-process, in milliseconds, with no Docker.
 *
 * PGlite is a devDependency and nothing in `src/` imports this file outside a
 * `*.test.ts`, so none of it reaches the production bundle.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFile, readdir } from 'node:fs/promises';
import * as schema from '$lib/db/schema';
import type { Db } from '$lib/db/types';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';

const MIGRATIONS = new URL('../../../../drizzle', import.meta.url).pathname;

/**
 * Not drizzle's migrator: several migrations bundle multiple statements with no
 * `--> statement-breakpoint`, and PGlite's extended protocol takes one statement
 * per query. `exec()` is the simple protocol, which is what psql would use.
 */
async function applyMigrations(client: PGlite): Promise<void> {
	const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
	for (const f of files) {
		await client.exec(await readFile(`${MIGRATIONS}/${f}`, 'utf8'));
	}
}

export interface TestDb {
	db: Db;
	close: () => Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
	const client = new PGlite();
	await applyMigrations(client);
	return {
		db: drizzle(client, { schema }) as unknown as Db,
		close: () => client.close()
	};
}

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export interface SeededWorkspace {
	workspaceId: string;
	ownerUserId: string;
	ownerMemberId: string;
	currency: string;
	timezone: string;
	/** Add a second (or third) member; returns the member id. */
	addMember(opts?: { display?: string; policy?: ApprovalPolicy }): Promise<string>;
	addCategory(name?: string): Promise<string>;
	addMerchant(opts: { name: string; normalizedName?: string }): Promise<string>;
	addIncome(opts: {
		memberId?: string;
		amountMinor: bigint;
		receivedAt: Date;
		rrule?: string;
	}): Promise<string>;
	addRecurring(opts: {
		memberId?: string;
		itemName?: string;
		amountMinor: bigint;
		rrule: string;
		nextOccurrenceAt?: Date | null;
		status?: 'active' | 'paused' | 'ended';
		autoComplete?: boolean;
		bucketId?: string | null;
	}): Promise<string>;
	addBucket(opts: {
		memberId?: string;
		name?: string;
		amountMinor: bigint;
		rrule: string;
		nextAccrualAt?: Date | null;
		status?: 'active' | 'paused' | 'archived';
		/** Who else may charge it. Null (the default) means anyone; [] means only
		 *  its owner, which is what makes it an allowance pot. */
		chargeMemberIds?: string[] | null;
	}): Promise<string>;
	addPurchase(opts: {
		memberId?: string;
		itemName?: string;
		categoryId?: string | null;
		amountMinor: bigint;
		state?:
			| 'draft'
			| 'pending_approval'
			| 'approved'
			| 'completed'
			| 'refunded'
			| 'denied'
			| 'cancelled'
			| 'held';
		completedAt?: Date | null;
		sealedFromMemberIds?: string[];
		sealedUntil?: Date | null;
		bucketId?: string | null;
		parentPurchaseId?: string | null;
		merchantId?: string | null;
		/** Link it to the rule that generated it, as materializeDueRules does. */
		recurringRuleId?: string | null;
	}): Promise<string>;
}

/** A minimal workspace with an owner, ready to hang fixtures off. */
export async function seedWorkspace(
	db: Db,
	opts: { currency?: string; timezone?: string } = {}
): Promise<SeededWorkspace> {
	const currency = opts.currency ?? 'USD';
	const timezone = opts.timezone ?? 'America/New_York';
	const now = new Date();
	const ownerUserId = uid();
	const workspaceId = uid();
	const ownerMemberId = uid();

	await db.insert(schema.user).values({
		id: ownerUserId,
		oidcSubject: `sub-${ownerUserId}`,
		email: `${ownerUserId}@example.com`,
		displayName: 'Owner',
		createdAt: now
	});
	await db.insert(schema.workspace).values({
		id: workspaceId,
		name: 'Test WS',
		slug: `ws-${workspaceId.slice(-6)}`,
		ownerUserId,
		currency,
		timezone,
		createdAt: now
	});
	await db.insert(schema.workspaceMember).values({
		id: ownerMemberId,
		workspaceId,
		userId: ownerUserId,
		role: 'owner',
		approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
		status: 'active',
		joinedAt: now
	});

	return {
		workspaceId,
		ownerUserId,
		ownerMemberId,
		currency,
		timezone,
		async addMember({
			display = 'Member',
			policy
		}: { display?: string; policy?: ApprovalPolicy } = {}) {
			const userId = uid();
			const memberId = uid();
			await db.insert(schema.user).values({
				id: userId,
				oidcSubject: `sub-${userId}`,
				email: `${userId}@example.com`,
				displayName: display,
				createdAt: now
			});
			await db.insert(schema.workspaceMember).values({
				id: memberId,
				workspaceId,
				userId,
				role: 'member',
				approvalPolicy: policy ?? { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
				status: 'active',
				joinedAt: now
			});
			return memberId;
		},
		async addCategory(name = 'Groceries') {
			const id = uid();
			await db.insert(schema.category).values({ id, workspaceId, name });
			return id;
		},
		async addMerchant({ name, normalizedName }) {
			const id = uid();
			await db.insert(schema.merchant).values({
				id,
				workspaceId,
				name,
				normalizedName: normalizedName ?? name.trim().toLowerCase()
			});
			return id;
		},
		async addIncome({ memberId, amountMinor, receivedAt, rrule }) {
			const id = uid();
			await db.insert(schema.income).values({
				id,
				workspaceId,
				memberId: memberId ?? ownerMemberId,
				source: 'Pay',
				amountMinor,
				currency,
				receivedAt,
				rrule: rrule ?? null
			});
			return id;
		},
		async addRecurring({
			memberId,
			itemName = 'Subscription',
			amountMinor,
			rrule,
			nextOccurrenceAt,
			status = 'active',
			autoComplete = true,
			bucketId = null
		}) {
			const id = uid();
			await db.insert(schema.recurringRule).values({
				id,
				workspaceId,
				memberId: memberId ?? ownerMemberId,
				itemName,
				amountMinor,
				currency,
				rrule,
				nextOccurrenceAt: nextOccurrenceAt === undefined ? now : nextOccurrenceAt,
				status,
				autoComplete,
				bucketId
			});
			return id;
		},
		async addBucket({
			memberId,
			name = 'Savings',
			amountMinor,
			rrule,
			nextAccrualAt,
			status = 'active',
			chargeMemberIds = null
		}) {
			const id = uid();
			await db.insert(schema.bucket).values({
				id,
				workspaceId,
				memberId: memberId ?? ownerMemberId,
				name,
				amountMinor,
				currency,
				rrule,
				nextAccrualAt: nextAccrualAt === undefined ? now : nextAccrualAt,
				status,
				chargeMemberIds,
				createdAt: now
			});
			return id;
		},
		async addPurchase({
			memberId,
			itemName = 'Thing',
			categoryId = null,
			amountMinor,
			state = 'completed',
			completedAt,
			sealedFromMemberIds = [],
			sealedUntil = null,
			bucketId = null,
			parentPurchaseId = null,
			merchantId = null,
			recurringRuleId = null
		}) {
			const id = uid();
			await db.insert(schema.purchase).values({
				id,
				workspaceId,
				memberId: memberId ?? ownerMemberId,
				itemName,
				categoryId,
				requestedAmountMinor: amountMinor,
				approvedAmountMinor: amountMinor,
				finalAmountMinor: state === 'completed' || state === 'refunded' ? amountMinor : null,
				currency,
				state,
				completedAt: completedAt === undefined ? (state === 'completed' ? now : null) : completedAt,
				sealedFromMemberIds,
				sealedUntil,
				bucketId,
				parentPurchaseId,
				merchantId,
				recurringRuleId,
				createdAt: now,
				updatedAt: now
			});
			return id;
		}
	};
}
