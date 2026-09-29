import {
	and,
	count,
	eq,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Db } from '$lib/db/types';
import { bucket, bucketTransaction, merchant, purchase } from '$lib/db/schema';
import { listPurchases, visibleTo, type PurchaseListItem } from './purchases';
import { movementVisibleTo } from './buckets';
import { containsPattern } from './like';

/**
 * The ledger: purchases and bucket movements on one timeline.
 *
 * Movements are a different kind of event — an accrual isn't spending, it's your
 * own money moving sideways — so they're opt-in, and the caller renders them
 * subordinate. Purchases stay the default reading of the page.
 *
 * Paged across both kinds via a union of (kind, id, date), which is then
 * hydrated. Fetching each kind separately and merging in memory would page each
 * one independently and drop rows at the boundaries.
 */

export interface BucketMovementItem {
	id: string;
	at: Date;
	bucketId: string;
	bucketName: string;
	bucketColor: string | null;
	type: 'accrual' | 'withdrawal' | 'adjustment';
	amountMinor: bigint;
	currency: string;
	note: string | null;
}

export type LedgerEntry =
	({ kind: 'purchase' } & PurchaseListItem) | ({ kind: 'movement' } & BucketMovementItem);

/**
 * Which reading of "in this window" a date filter means.
 *
 * `activity` — anything that happened, dated by when it last moved. What you
 * want when you pick a range by hand: pending requests and refusals are things
 * that happened in that week, and hiding them would make the ledger lie.
 *
 * `spend` — money actually spent, dated by `completedAt`, counting only the
 * states analytics counts. This is the basis every figure on the analytics page
 * is computed on, so drilling into one of those figures must use it or the rows
 * won't sum to the number that was tapped. See `spentInPeriod` in
 * repo/analytics.ts — the two predicates are deliberately the same shape.
 */
export type LedgerBasis = 'activity' | 'spend';

export interface LedgerOpts {
	search?: string;
	categoryId?: string;
	/** Sentinel for "has no category" — the rows analytics shows as "Other". */
	uncategorized?: boolean;
	memberId?: string;
	/** Only purchases known to be on this card. */
	accountId?: string;
	/** Only charges a recurring rule generated — what the Plan page links to. */
	recurringOnly?: boolean;
	/** Instants, half-open [from, to). Convert from calendar dates with
	 *  periodBoundsUtc so the boundary matches the analytics page exactly. */
	from?: Date;
	to?: Date;
	basis?: LedgerBasis;
	/**
	 * A geographic window, in millidegrees. The pin is the purchase's own, or
	 * the vendor's saved default — the same `coalesce` the map projects, so a
	 * bubble and the list you reach by tapping it hold exactly the same rows.
	 *
	 * A bucket movement has no place, so a bbox and `includeMovements` are
	 * mutually exclusive; `ledgerOptsFromUrl` enforces that, for the same reason
	 * the spend basis drops movements below — the rows have to sum to the figure
	 * that was tapped.
	 */
	bbox?: { minLatE3: number; minLngE3: number; maxLatE3: number; maxLngE3: number };
	/** Bucket movements are off unless asked for. */
	includeMovements?: boolean;
	limit?: number;
	offset?: number;
}

/** Purchases sort by when they happened, falling back through their lifecycle. */
const purchaseAt = sql`coalesce(${purchase.completedAt}, ${purchase.decidedAt}, ${purchase.requestedAt}, ${purchase.createdAt})`;

/*
 * Both key queries order by `at desc, id desc` — the id half is not cosmetic.
 *
 * Ties on `at` are ordinary, not exotic: a backfill, a recurring rule
 * materializing, or a statement import all write the same date-derived midnight
 * to many rows at once. `ORDER BY at DESC` alone leaves those rows in whatever
 * order the plan happens to produce, which means two things go wrong. The list
 * reshuffles between loads for no reason the person can see, and — because the
 * page window is LIMIT/OFFSET over that same unstable order — tapping "Show
 * more" can hand back a row already on screen while silently skipping another.
 *
 * Ids are uuidv7, so they ascend with creation time: `id desc` is a real
 * insertion-order tiebreak rather than an arbitrary one, and it total-orders the
 * result so the offset window is well defined.
 */

export async function listLedger(
	db: Db,
	scope: { workspaceId: string; viewerId: string },
	now: Date,
	opts: LedgerOpts = {}
): Promise<{ entries: LedgerEntry[]; hasMore: boolean; total: number }> {
	const limit = opts.limit ?? 20;
	const offset = opts.offset ?? 0;

	const basis = opts.basis ?? 'activity';

	const purchaseWhere: SQL[] = [
		eq(purchase.workspaceId, scope.workspaceId),
		visibleTo(scope.viewerId, now)
	];
	// Match the item name or the merchant it was bought from — the merchant is
	// left-joined below so this OR can see merchant.name.
	const pattern = opts.search ? containsPattern(opts.search) : null;
	if (pattern) {
		purchaseWhere.push(or(ilike(purchase.itemName, pattern), ilike(merchant.name, pattern))!);
	}
	if (opts.categoryId) purchaseWhere.push(eq(purchase.categoryId, opts.categoryId));
	if (opts.uncategorized) purchaseWhere.push(isNull(purchase.categoryId));
	if (opts.memberId) purchaseWhere.push(eq(purchase.memberId, opts.memberId));
	if (opts.accountId) purchaseWhere.push(eq(purchase.accountId, opts.accountId));
	if (opts.recurringOnly) purchaseWhere.push(isNotNull(purchase.recurringRuleId));
	if (opts.bbox) {
		const lat = sql`coalesce(${purchase.latE3}, ${merchant.latE3})`;
		const lng = sql`coalesce(${purchase.lngE3}, ${merchant.lngE3})`;
		purchaseWhere.push(sql`${lat} between ${opts.bbox.minLatE3} and ${opts.bbox.maxLatE3}`);
		purchaseWhere.push(sql`${lng} between ${opts.bbox.minLngE3} and ${opts.bbox.maxLngE3}`);
	}

	// On the spend basis a row is dated by when it completed, and only settled
	// states count — matching analytics exactly. On the activity basis a row is
	// dated by whenever it last moved, whatever state it reached.
	if (basis === 'spend') {
		purchaseWhere.push(inArray(purchase.state, ['completed', 'refunded']));
		if (opts.from) purchaseWhere.push(gte(purchase.completedAt, opts.from));
		if (opts.to) purchaseWhere.push(lt(purchase.completedAt, opts.to));
	} else {
		// purchaseAt is an expression, not a column, so there's no timestamptz
		// mapper to bind a Date through (gte()/lt() rely on the column for that).
		// A bare `${opts.from}` here serializes the Date via Date.toString() —
		// "Mon Jun 15 2026 …" — which Postgres can't parse as timestamptz, so the
		// whole query 500s. Send an ISO string and cast it explicitly instead.
		// This is the only date path a manual ledger filter takes (basis=activity);
		// analytics drill-throughs pin basis=spend and hit the gte() path above,
		// which is why the bug only surfaced when filtering by hand.
		if (opts.from)
			purchaseWhere.push(sql`${purchaseAt} >= ${opts.from.toISOString()}::timestamptz`);
		if (opts.to) purchaseWhere.push(sql`${purchaseAt} < ${opts.to.toISOString()}::timestamptz`);
	}

	const purchaseKeys = db
		.select({
			kind: sql<string>`'purchase'`.as('kind'),
			id: purchase.id,
			at: sql<string>`${purchaseAt}`.as('at')
		})
		.from(purchase)
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.where(and(...purchaseWhere));

	/*
	 * A movement has no category and no member, so those filters exclude them by
	 * construction rather than by an extra flag. The spend basis excludes them
	 * too: moving your own money sideways isn't spending, and analytics never
	 * counts it — so a drill-through that showed movements would list rows that
	 * aren't part of the total you tapped.
	 */
	const wantMovements =
		opts.includeMovements &&
		!opts.categoryId &&
		!opts.uncategorized &&
		!opts.memberId &&
		!opts.accountId &&
		// A bucket movement is not a charge any rule made.
		!opts.recurringOnly &&
		// Nobody stood anywhere to set money aside, so a geographic filter excludes
		// movements the same way a category filter does — by construction.
		!opts.bbox &&
		basis !== 'spend';

	/*
	 * How many rows match, ignoring the page window.
	 *
	 * The ledger header used to render the *loaded* row count as though it were a
	 * total: it under-reported whenever there was another page, and grew as you
	 * tapped "Show more". A count that moves when you scroll isn't a count, and
	 * this app's whole claim is that its numbers are honest — so the header gets
	 * the real one.
	 *
	 * Counted with the same predicates as the key queries above, not a subquery
	 * over them: the two kinds are unioned, so summing two counts is exactly the
	 * union's cardinality, and each count runs against the same indexes the key
	 * query uses.
	 */
	const countPurchases = db
		.select({ n: count() })
		.from(purchase)
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.where(and(...purchaseWhere));

	let keys: { kind: string; id: string; at: string }[];
	let total: number;
	if (wantMovements) {
		// A charge's movement carries its purchase's seal: without this, a gift
		// charged to a bucket showed on the concealed member's ledger by name, and
		// searching for it found it.
		const movementWhere: SQL[] = [
			eq(bucket.workspaceId, scope.workspaceId),
			movementVisibleTo(scope.viewerId, now)
		];
		if (opts.from) movementWhere.push(gte(bucketTransaction.createdAt, opts.from));
		if (opts.to) movementWhere.push(lt(bucketTransaction.createdAt, opts.to));
		if (pattern) {
			movementWhere.push(or(ilike(bucket.name, pattern), ilike(bucketTransaction.note, pattern))!);
		}
		const movementKeys = db
			.select({
				kind: sql<string>`'movement'`.as('kind'),
				id: bucketTransaction.id,
				at: sql<string>`${bucketTransaction.createdAt}`.as('at')
			})
			.from(bucketTransaction)
			.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
			.where(and(...movementWhere));

		const [rows, pc, mc] = await Promise.all([
			unionAll(purchaseKeys, movementKeys)
				.orderBy(sql`at desc, id desc`)
				.limit(limit + 1)
				.offset(offset),
			countPurchases,
			db
				.select({ n: count() })
				.from(bucketTransaction)
				.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
				.where(and(...movementWhere))
		]);
		keys = rows;
		total = (pc[0]?.n ?? 0) + (mc[0]?.n ?? 0);
	} else {
		const [rows, pc] = await Promise.all([
			purchaseKeys
				.orderBy(sql`at desc, id desc`)
				.limit(limit + 1)
				.offset(offset),
			countPurchases
		]);
		keys = rows;
		total = pc[0]?.n ?? 0;
	}

	const hasMore = keys.length > limit;
	const page = hasMore ? keys.slice(0, limit) : keys;

	const purchaseIds = page.filter((k) => k.kind === 'purchase').map((k) => k.id);
	const movementIds = page.filter((k) => k.kind === 'movement').map((k) => k.id);

	const [purchases, movements] = await Promise.all([
		listPurchases(db, scope, now, { ids: purchaseIds }),
		listBucketMovements(db, movementIds)
	]);

	const byId = new Map<string, LedgerEntry>();
	for (const p of purchases) byId.set(p.id, { kind: 'purchase', ...p });
	for (const m of movements) byId.set(m.id, { kind: 'movement', ...m });

	// The union decided the order; hydration only filled in the detail.
	return {
		entries: page.map((k) => byId.get(k.id)).filter((e): e is LedgerEntry => !!e),
		hasMore,
		total
	};
}

async function listBucketMovements(db: Db, ids: string[]): Promise<BucketMovementItem[]> {
	if (ids.length === 0) return [];
	const rows = await db
		.select({
			id: bucketTransaction.id,
			at: bucketTransaction.createdAt,
			bucketId: bucketTransaction.bucketId,
			bucketName: bucket.name,
			bucketColor: bucket.color,
			type: bucketTransaction.type,
			amountMinor: bucketTransaction.amountMinor,
			currency: bucketTransaction.currency,
			note: bucketTransaction.note
		})
		.from(bucketTransaction)
		.innerJoin(bucket, eq(bucketTransaction.bucketId, bucket.id))
		.where(inArray(bucketTransaction.id, ids));
	return rows;
}
