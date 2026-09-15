import { and, eq, gte, lt, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bucket, bucketTransaction, recurringRule, user, workspaceMember } from '$lib/db/schema';
import type { Period } from '$lib/domain/analytics/period';
import { bucketFlows, type BucketFlows } from '$lib/domain/bucket/flows';
import { zonedTimeToUtc } from '$lib/domain/time/zoned';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';

export type BucketRow = typeof bucket.$inferSelect;
export type BucketTransactionRow = typeof bucketTransaction.$inferSelect;

export interface CreateBucketCmd {
	workspaceId: string;
	memberId: string;
	name: string;
	amountMinor: bigint;
	currency: string;
	rrule: string;
	goalCapMinor?: bigint | null;
	color?: string | null;
	icon?: string | null;
	nextAccrualAt?: Date | null;
	/** Who else may charge it. Absent or null means anyone, which is how every
	 *  bucket behaved before the column. */
	chargeMemberIds?: string[] | null;
	/** Set only by the allowance setup; see `bucket.isAllowance`. */
	isAllowance?: boolean;
}

export interface BucketListItem {
	bucket: BucketRow;
	memberName: string;
	/** Net of everything ever moved. Negative once the bucket's been overdrawn. */
	balanceMinor: bigint;
	/** How many movements it has ever had — "has this run yet?", which a balance
	 *  can't answer: an overdrawn bucket and an untouched one both sit at zero. */
	txCount: number;
}

export interface AddTransactionCmd {
	bucketId: string;
	amountMinor: bigint;
	currency: string;
	type: BucketTransactionRow['type'];
	note?: string | null;
	/** When the transaction belongs — sweep accruals are dated at their
	 *  occurrence, not at the moment the sweep happened to run. */
	at?: Date;
}

export async function createBucket(
	db: Db,
	deps: { clock: Clock; ids: IdGenerator },
	cmd: CreateBucketCmd
): Promise<BucketRow> {
	const id = deps.ids.newId();
	const now = deps.clock.now();
	await db.insert(bucket).values({
		id,
		workspaceId: cmd.workspaceId,
		memberId: cmd.memberId,
		name: cmd.name,
		amountMinor: cmd.amountMinor,
		currency: cmd.currency,
		rrule: cmd.rrule,
		goalCapMinor: cmd.goalCapMinor ?? null,
		color: cmd.color ?? null,
		icon: cmd.icon ?? null,
		nextAccrualAt: cmd.nextAccrualAt ?? null,
		chargeMemberIds: cmd.chargeMemberIds ?? null,
		isAllowance: cmd.isAllowance ?? false,
		status: 'active',
		createdAt: now
	});
	const [row] = await db.select().from(bucket).where(eq(bucket.id, id)).limit(1);
	return row!;
}

export async function listBuckets(db: Db, workspaceId: string): Promise<BucketListItem[]> {
	const rows = await db
		.select({
			bucket,
			memberName: user.displayName,
			balanceMinor: sql<string>`coalesce(sum(${bucketTransaction.amountMinor}), 0)`,
			txCount: sql<string>`count(${bucketTransaction.id})`
		})
		.from(bucket)
		.innerJoin(workspaceMember, eq(bucket.memberId, workspaceMember.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.leftJoin(bucketTransaction, eq(bucket.id, bucketTransaction.bucketId))
		.where(and(eq(bucket.workspaceId, workspaceId), ne(bucket.status, 'archived')))
		.groupBy(bucket.id, workspaceMember.id, user.id)
		.orderBy(bucket.createdAt);

	return rows.map((r) => ({
		bucket: r.bucket,
		memberName: r.memberName,
		balanceMinor: BigInt(r.balanceMinor),
		txCount: Number(r.txCount)
	}));
}

export async function loadBucket(
	db: Db,
	workspaceId: string,
	bucketId: string
): Promise<BucketRow | null> {
	const rows = await db
		.select()
		.from(bucket)
		.where(and(eq(bucket.id, bucketId), eq(bucket.workspaceId, workspaceId)))
		.limit(1);
	return rows[0] ?? null;
}

export interface UpdateBucketCmd {
	name?: string;
	amountMinor?: bigint;
	rrule?: string;
	nextAccrualAt?: Date | null;
	goalCapMinor?: bigint | null;
	color?: string | null;
	icon?: string | null;
	chargeMemberIds?: string[] | null;
}

/** Owner-scoped load. Every mutation goes through this, not `loadBucket`. */
export async function loadOwnBucket(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	bucketId: string
) {
	const b = await loadBucket(db, scope.workspaceId, bucketId);
	if (!b) return null;
	if (b.memberId !== scope.memberId) return null;
	return b;
}

export async function updateBucket(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	bucketId: string,
	changes: UpdateBucketCmd
): Promise<BucketRow | null> {
	const b = await loadOwnBucket(db, scope, bucketId);
	if (!b) return null;

	if (Object.keys(changes).length === 0) return b;

	const updates: Record<string, unknown> = {};
	if (changes.name !== undefined) updates.name = changes.name;
	if (changes.amountMinor !== undefined) updates.amountMinor = changes.amountMinor;
	if (changes.rrule !== undefined) updates.rrule = changes.rrule;
	if (changes.nextAccrualAt !== undefined) updates.nextAccrualAt = changes.nextAccrualAt;
	if (changes.goalCapMinor !== undefined) updates.goalCapMinor = changes.goalCapMinor;
	if (changes.color !== undefined) updates.color = changes.color;
	if (changes.icon !== undefined) updates.icon = changes.icon;
	if (changes.chargeMemberIds !== undefined) updates.chargeMemberIds = changes.chargeMemberIds;

	if (Object.keys(updates).length === 0) return b;

	await db.update(bucket).set(updates).where(eq(bucket.id, bucketId));

	/*
	 * Narrowing a bucket also closes the standing instructions pointed at it.
	 *
	 * A recurring rule is checked when it is written, and then runs unattended
	 * for years. Without this, restricting a bucket would leave the rules of
	 * everyone newly excluded quietly drawing on it every month, which is the
	 * same bypass the charge check exists to close, just on a delay. The rules
	 * keep running; they stop charging this bucket, and their purchases become
	 * ordinary spending.
	 */
	if (changes.chargeMemberIds !== undefined && changes.chargeMemberIds !== null) {
		const allowed = [b.memberId, ...changes.chargeMemberIds];
		await db
			.update(recurringRule)
			.set({ bucketId: null })
			.where(
				and(eq(recurringRule.bucketId, bucketId), notInArray(recurringRule.memberId, allowed))
			);
	}

	const [row] = await db.select().from(bucket).where(eq(bucket.id, bucketId)).limit(1);
	return row!;
}

export async function pauseBucket(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	bucketId: string
) {
	const b = await loadOwnBucket(db, scope, bucketId);
	if (!b) throw new Error('Bucket not found');
	if (b.status !== 'active') throw new Error('Only active buckets can be paused');
	await db.update(bucket).set({ status: 'paused' }).where(eq(bucket.id, bucketId));
}

/**
 * Resuming skips anything missed while paused — the caller passes the next
 * future occurrence so the sweep doesn't catch up the paused gap.
 */
export async function resumeBucket(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	bucketId: string,
	nextAccrualAt: Date
) {
	const b = await loadOwnBucket(db, scope, bucketId);
	if (!b) throw new Error('Bucket not found');
	if (b.status !== 'paused') throw new Error('Only paused buckets can be resumed');
	await db.update(bucket).set({ status: 'active', nextAccrualAt }).where(eq(bucket.id, bucketId));
}

export async function archiveBucket(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	bucketId: string
) {
	const b = await loadOwnBucket(db, scope, bucketId);
	if (!b) throw new Error('Bucket not found');
	if (b.status === 'archived') throw new Error('Bucket is already archived');
	await db.update(bucket).set({ status: 'archived' }).where(eq(bucket.id, bucketId));
}

export async function addTransaction(
	db: Db,
	deps: { clock: Clock; ids: IdGenerator },
	cmd: AddTransactionCmd
): Promise<BucketTransactionRow> {
	const id = deps.ids.newId();
	await db.insert(bucketTransaction).values({
		id,
		bucketId: cmd.bucketId,
		amountMinor: cmd.amountMinor,
		currency: cmd.currency,
		type: cmd.type,
		note: cmd.note ?? null,
		createdAt: cmd.at ?? deps.clock.now()
	});
	const [row] = await db
		.select()
		.from(bucketTransaction)
		.where(eq(bucketTransaction.id, id))
		.limit(1);
	return row!;
}

/** Net balance across every bucket — what's actually on hand right now. */
export async function totalSaved(db: Db, workspaceId: string): Promise<bigint> {
	const rows = await db
		.select({
			total: sql<string>`coalesce(sum(${bucketTransaction.amountMinor}), 0)`
		})
		.from(bucketTransaction)
		.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
		.where(eq(bucket.workspaceId, workspaceId));
	return BigInt(rows[0]?.total ?? '0');
}

/**
 * Gross of everything ever put into buckets — accruals, deposits, credits — not
 * reduced by what's since been spent. "How much you've set aside over time",
 * versus totalSaved's "what's left". The difference is what's been withdrawn.
 */
export async function lifetimeSaved(db: Db, workspaceId: string): Promise<bigint> {
	const rows = await db
		.select({
			total: sql<string>`coalesce(sum(${bucketTransaction.amountMinor}) filter (where ${bucketTransaction.amountMinor} > 0), 0)`
		})
		.from(bucketTransaction)
		.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
		.where(eq(bucket.workspaceId, workspaceId));
	return BigInt(rows[0]?.total ?? '0');
}

/** What a single bucket holds right now. Negative once it's been overdrawn. */
export async function bucketBalance(db: Db, bucketId: string): Promise<bigint> {
	const rows = await db
		.select({ total: sql<string>`coalesce(sum(${bucketTransaction.amountMinor}), 0)` })
		.from(bucketTransaction)
		.where(eq(bucketTransaction.bucketId, bucketId));
	return BigInt(rows[0]?.total ?? '0');
}

/**
 * Bucket movement in a period, split into set-aside / released / overdraft.
 *
 * Replays the window against each bucket's opening balance rather than summing
 * the signed amounts, because "was this withdrawal funded?" depends on the
 * balance at the instant it landed. See domain/bucket/flows for why one signed
 * total isn't good enough — in short, a charge against an empty bucket would
 * otherwise read as negative savings and *credit* net position.
 *
 * Rows are ordered by (createdAt, id); ids are uuidv7, so same-instant
 * transactions still replay in the order they were written.
 */
export async function bucketFlowsInPeriod(
	db: Db,
	workspaceId: string,
	period: Period,
	timezone: string
): Promise<BucketFlows> {
	const from = zonedTimeToUtc(period.from, 0, 0, timezone);
	const to = zonedTimeToUtc(period.toExclusive, 0, 0, timezone);

	const [openingRows, txns] = await Promise.all([
		db
			.select({
				bucketId: bucketTransaction.bucketId,
				total: sql<string>`coalesce(sum(${bucketTransaction.amountMinor}), 0)`
			})
			.from(bucketTransaction)
			.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
			.where(and(eq(bucket.workspaceId, workspaceId), lt(bucketTransaction.createdAt, from)))
			.groupBy(bucketTransaction.bucketId),
		db
			.select({
				bucketId: bucketTransaction.bucketId,
				amountMinor: bucketTransaction.amountMinor
			})
			.from(bucketTransaction)
			.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
			.where(
				and(
					eq(bucket.workspaceId, workspaceId),
					gte(bucketTransaction.createdAt, from),
					lt(bucketTransaction.createdAt, to)
				)
			)
			.orderBy(bucketTransaction.createdAt, bucketTransaction.id)
	]);

	return bucketFlows(new Map(openingRows.map((r) => [r.bucketId, BigInt(r.total)])), txns);
}
