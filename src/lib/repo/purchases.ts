import { and, desc, eq, ilike, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '$lib/db/types';
import {
	approvalEvent,
	category,
	merchant,
	purchase,
	purchaseApprover,
	purchaseImage,
	user,
	workspaceMember
} from '$lib/db/schema';
import { Money } from '$lib/domain/money/money';
import { eligibleApprovers } from '$lib/domain/approval/evaluate';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import type { Purchase, TransitionEvent } from '$lib/domain/purchase/purchase';
import { placeFromColumns, placeToColumns } from '$lib/domain/location/place';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';

/**
 * Every read takes (workspaceId, viewerId) and applies the seal filter in the
 * query. For a concealed viewer a sealed purchase does not exist — not in
 * lists, not in details, not in aggregates. This predicate is the single
 * enforcement point; add it to every new purchase query.
 */
export function visibleTo(viewerId: string, now: Date): SQL {
	return sealOpenTo(purchase, viewerId, now);
}

/**
 * The seal predicate, against any alias of the purchase table. Refund rows
 * borrow their parent's photo, and the parent has to pass this check on its own
 * — inheriting an image must not become a way to see a concealed purchase.
 */
function sealOpenTo(
	// AnyPgColumn, not `typeof purchase`: an alias bakes its own table name into
	// the column types, so the concrete table type won't accept one.
	t: { sealedFromMemberIds: AnyPgColumn; sealedUntil: AnyPgColumn },
	viewerId: string,
	now: Date
): SQL {
	return or(
		sql`not (${t.sealedFromMemberIds} @> array[${viewerId}]::uuid[])`,
		// The seal has opened — stated explicitly rather than as a bare lte, so
		// a malformed open-ended seal (conceal list set, sealed_until NULL) fails
		// closed by rule. As a bare lte it would evaluate to SQL NULL and hide
		// from the concealed viewer by accident instead.
		// lte, not raw sql: it binds through the column's timestamptz mapping.
		// Interpolating the Date directly sends Date.toString(), which Postgres
		// cannot parse — that broke every seal-filtered read once.
		and(isNotNull(t.sealedUntil), lte(t.sealedUntil, now))
	)!;
}

export type PurchaseRow = typeof purchase.$inferSelect;

export function mapPurchaseRow(row: PurchaseRow, approverMemberIds: string[]): Purchase {
	return toDomain(row, approverMemberIds);
}

function toDomain(row: PurchaseRow, approverMemberIds: string[]): Purchase {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		memberId: row.memberId,
		state: row.state,
		itemName: row.itemName,
		note: row.note,
		categoryId: row.categoryId,
		merchantId: row.merchantId,
		accountId: row.accountId,
		requestedAmount: Money.of(row.requestedAmountMinor, row.currency),
		approvedAmount:
			row.approvedAmountMinor === null ? null : Money.of(row.approvedAmountMinor, row.currency),
		finalAmount:
			row.finalAmountMinor === null ? null : Money.of(row.finalAmountMinor, row.currency),
		sealedUntil: row.sealedUntil,
		sealedFromMemberIds: row.sealedFromMemberIds,
		requestedAt: row.requestedAt,
		decidedAt: row.decidedAt,
		completedAt: row.completedAt,
		clearedAt: row.clearedAt,
		lastNudgedAt: row.lastNudgedAt,
		nudgeCount: row.nudgeCount,
		recurringRuleId: row.recurringRuleId,
		parentPurchaseId: row.parentPurchaseId,
		approverMemberIds,
		bucketId: row.bucketId ?? null,
		heldUntil: row.heldUntil,
		heldBy: row.heldBy,
		place: placeFromColumns(row)
	};
}

/** Load one purchase as a domain object, seal-filtered, locked FOR UPDATE when in a tx. */
export async function loadPurchase(
	db: Db,
	scope: { workspaceId: string; viewerId: string },
	purchaseId: string,
	opts: { forUpdate?: boolean; now: Date }
): Promise<Purchase | null> {
	let q = db
		.select()
		.from(purchase)
		.where(
			and(
				eq(purchase.id, purchaseId),
				eq(purchase.workspaceId, scope.workspaceId),
				visibleTo(scope.viewerId, opts.now)
			)
		)
		.limit(1)
		.$dynamic();
	if (opts.forUpdate) q = q.for('update');
	const rows = await q;
	if (!rows[0]) return null;

	/*
	 * Who may decide: the snapshot taken when this was requested, UNION whoever
	 * the requester's policy names today.
	 *
	 * The snapshot alone used to be the whole answer, which meant an approval
	 * routing change never reached a request already waiting — add a member and
	 * make them an approver, and they still couldn't act on the queue in front
	 * of them. Worse, disabling the only snapshotted approver left a pending
	 * request nobody at all could decide.
	 *
	 * It is a union, not a replacement, for two reasons. The snapshot is the
	 * audit record of who was originally asked, and `approval_event` is written
	 * against it — rewriting that would make history a moving target. And
	 * widening only means a policy edit can never *remove* someone's ability to
	 * answer a question already put to them.
	 *
	 * Self-approval is not guarded here. Policy is owner-only (a 403 in
	 * settings/members), and an owner can already exempt themselves outright or
	 * delete any entry, so a guard at this layer would defend a door that is
	 * already open while blocking the ordinary case this fixes.
	 */
	const [snapshot, live] = await Promise.all([
		db
			.select({ memberId: purchaseApprover.memberId })
			.from(purchaseApprover)
			.where(eq(purchaseApprover.purchaseId, purchaseId)),
		db
			.select({
				id: workspaceMember.id,
				policy: workspaceMember.approvalPolicy,
				status: workspaceMember.status
			})
			.from(workspaceMember)
			.where(eq(workspaceMember.workspaceId, scope.workspaceId))
	]);

	const activeIds = live.filter((m) => m.status === 'active').map((m) => m.id);
	const requesterPolicy = live.find((m) => m.id === rows[0].memberId)?.policy as
		ApprovalPolicy | undefined;
	const eligible = requesterPolicy ? eligibleApprovers(requesterPolicy, activeIds) : [];

	/*
	 * Both halves are filtered to active members. A disabled member cannot reach
	 * the app at all — membership is resolved through a query that requires
	 * `status = 'active'` — so carrying them here changes no permission, it only
	 * makes "Waiting on Charlie" say someone is considering a request when they
	 * have in fact left. The snapshot *row* is untouched; this is the live answer
	 * to "who can decide now", and the audit record stays whole in the table.
	 */
	const snapshotActive = snapshot.map((a) => a.memberId).filter((id) => activeIds.includes(id));

	const approverIds = [...new Set([...snapshotActive, ...eligible])];
	return toDomain(rows[0], approverIds);
}

/**
 * Insert a freshly created purchase plus its approver snapshot and first event.
 *
 * Writes three tables and does not open its own transaction — pass a `tx`. A
 * bare `Db` here can leave a purchase with no approvers or no opening event.
 */
export async function insertPurchase(
	db: Db,
	deps: { ids: IdGenerator; clock: Clock },
	p: Purchase,
	firstEvent: TransitionEvent
): Promise<void> {
	const now = deps.clock.now();
	await db.insert(purchase).values({
		id: p.id,
		workspaceId: p.workspaceId,
		memberId: p.memberId,
		state: p.state,
		itemName: p.itemName,
		note: p.note,
		categoryId: p.categoryId,
		merchantId: p.merchantId,
		accountId: p.accountId,
		requestedAmountMinor: p.requestedAmount.minor,
		approvedAmountMinor: p.approvedAmount?.minor ?? null,
		finalAmountMinor: p.finalAmount?.minor ?? null,
		currency: p.requestedAmount.currency,
		sealedUntil: p.sealedUntil,
		sealedFromMemberIds: p.sealedFromMemberIds,
		requestedAt: p.requestedAt,
		decidedAt: p.decidedAt,
		completedAt: p.completedAt,
		clearedAt: p.clearedAt,
		lastNudgedAt: p.lastNudgedAt,
		nudgeCount: p.nudgeCount,
		recurringRuleId: p.recurringRuleId,
		parentPurchaseId: p.parentPurchaseId,
		bucketId: p.bucketId,
		heldUntil: p.heldUntil,
		heldBy: p.heldBy,
		...placeToColumns(p.place),
		createdAt: now,
		updatedAt: now
	});
	if (p.approverMemberIds.length > 0) {
		await db.insert(purchaseApprover).values(
			p.approverMemberIds.map((memberId) => ({
				purchaseId: p.id,
				memberId,
				isRequired: false
			}))
		);
	}
	await insertEvent(db, deps.ids, p.id, firstEvent);
}

/** Persist a domain transition: updated snapshot + append-only event. */
export async function applyTransition(
	db: Db,
	ids: IdGenerator,
	p: Purchase,
	ev: TransitionEvent
): Promise<void> {
	await db
		.update(purchase)
		.set({
			state: p.state,
			itemName: p.itemName,
			note: p.note,
			categoryId: p.categoryId,
			requestedAmountMinor: p.requestedAmount.minor,
			approvedAmountMinor: p.approvedAmount?.minor ?? null,
			finalAmountMinor: p.finalAmount?.minor ?? null,
			sealedUntil: p.sealedUntil,
			sealedFromMemberIds: p.sealedFromMemberIds,
			requestedAt: p.requestedAt,
			decidedAt: p.decidedAt,
			completedAt: p.completedAt,
			lastNudgedAt: p.lastNudgedAt,
			nudgeCount: p.nudgeCount,
			bucketId: p.bucketId,
			heldUntil: p.heldUntil,
			heldBy: p.heldBy,
			updatedAt: ev.at
		})
		.where(eq(purchase.id, p.id));
	await insertEvent(db, ids, p.id, ev);
}

export async function appendEvent(
	db: Db,
	ids: IdGenerator,
	purchaseId: string,
	ev: TransitionEvent
) {
	await insertEvent(db, ids, purchaseId, ev);
}

async function insertEvent(db: Db, ids: IdGenerator, purchaseId: string, ev: TransitionEvent) {
	await db.insert(approvalEvent).values({
		id: ids.newId(),
		purchaseId,
		actorMemberId: ev.actorMemberId,
		fromState: ev.fromState,
		toState: ev.toState,
		reason: ev.reason,
		amountSnapshotMinor: ev.amountSnapshot?.minor ?? null,
		createdAt: ev.at
	});
}

export interface PurchaseListItem {
	id: string;
	itemName: string;
	note: string | null;
	merchantName: string | null;
	/** The name given to the pin, when there is one and no vendor named it. */
	placeLabel: string | null;
	state: PurchaseRow['state'];
	amountMinor: bigint;
	currency: string;
	requesterMemberId: string;
	requesterName: string;
	categoryName: string | null;
	categoryIcon: string | null;
	categoryColor: string | null;
	categoryId: string | null;
	thumbBlobId: string | null;
	requestedAt: Date | null;
	decidedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	canDecide: boolean;
	/** Seal still in force (viewer is necessarily not concealed, or they wouldn't see the row). */
	sealed: boolean;
	sealedUntil: Date | null;
	recurring: boolean;
	/** Child row reversing a completed purchase; its photo is the original's. */
	isRefund: boolean;
	/** Set while the purchase is asleep ("sleep on it"); when the pause lifts. */
	heldUntil: Date | null;
}

/** Workspace purchase feed, seal-filtered, pending first then newest. */
export async function listPurchases(
	db: Db,
	scope: { workspaceId: string; viewerId: string },
	now: Date,
	opts?: {
		search?: string;
		categoryId?: string;
		limit?: number;
		offset?: number;
		/** Hydrate exactly these, in no particular order — used by the ledger feed,
		 *  which decides ordering and paging across purchases and bucket moves. */
		ids?: string[];
	}
): Promise<PurchaseListItem[]> {
	if (opts?.ids && opts.ids.length === 0) return [];
	const conditions: SQL[] = [
		eq(purchase.workspaceId, scope.workspaceId),
		visibleTo(scope.viewerId, now)
	];
	if (opts?.ids) conditions.push(inArray(purchase.id, opts.ids));
	if (opts?.search) conditions.push(ilike(purchase.itemName, `%${opts.search}%`));
	if (opts?.categoryId) conditions.push(eq(purchase.categoryId, opts.categoryId));

	// A refund is a child row with no photo of its own; show the original's.
	const parentPurchase = alias(purchase, 'parent_purchase');
	const parentImage = alias(purchaseImage, 'parent_image');

	const rows = await db
		.select({
			p: purchase,
			requesterName: user.displayName,
			categoryName: category.name,
			categoryIcon: category.icon,
			categoryColor: category.color,
			merchantName: merchant.name,
			placeLabel: purchase.placeLabel,
			thumbBlobId: sql<
				string | null
			>`coalesce(${purchaseImage.thumbBlobId}, ${parentImage.thumbBlobId})`,
			/*
			 * Snapshot OR current policy — the same union `loadPurchase` builds, in
			 * SQL because this runs over a whole page of rows. The two must agree:
			 * this one decides whether the ledger offers a swipe action, and that
			 * one decides whether the action is allowed. If this were the wider of
			 * the two, the row would show Approve and the submit would 403.
			 *
			 * `workspaceMember` is already joined on `purchase.memberId`, so
			 * `approvalPolicy` here is the *requester's* policy — the one whose
			 * routing names who decides their spending.
			 *
			 * No active check on the viewer here, in either half: membership is
			 * resolved in hooks.server.ts through a query that filters
			 * `status = 'active'` (repo/workspaces.ts), so a viewer who reaches this
			 * is active already. That is also why `loadPurchase` can filter its
			 * snapshot half to active members without the two disagreeing — the only
			 * id this predicate ever tests is the viewer's own.
			 *
			 * coalesce because `->` yields NULL on a policy with no routing key,
			 * and `false OR NULL` is NULL, which would surface as a null canDecide
			 * rather than a plain no.
			 */
			canDecide: sql<boolean>`(
				exists (
					select 1 from ${purchaseApprover}
					where ${purchaseApprover.purchaseId} = ${purchase.id}
					and ${purchaseApprover.memberId} = ${scope.viewerId}
				)
				or coalesce(
					${workspaceMember.approvalPolicy} -> 'routing' -> 'approver_ids'
						@> to_jsonb(${scope.viewerId}::text),
					false
				)
			)`
		})
		.from(purchase)
		.innerJoin(workspaceMember, eq(purchase.memberId, workspaceMember.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.leftJoin(category, eq(purchase.categoryId, category.id))
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.leftJoin(
			purchaseImage,
			and(eq(purchaseImage.purchaseId, purchase.id), eq(purchaseImage.position, 0))
		)
		.leftJoin(
			parentPurchase,
			and(
				eq(purchase.parentPurchaseId, parentPurchase.id),
				sealOpenTo(parentPurchase, scope.viewerId, now)
			)
		)
		.leftJoin(
			parentImage,
			and(eq(parentImage.purchaseId, parentPurchase.id), eq(parentImage.position, 0))
		)
		.where(and(...conditions))
		.orderBy(
			desc(sql`${purchase.state} = 'pending_approval'`),
			desc(sql`coalesce(${purchase.completedAt}, ${purchase.requestedAt}, ${purchase.createdAt})`)
		)
		.limit(opts?.ids ? opts.ids.length : (opts?.limit ?? 20))
		.offset(opts?.ids ? 0 : (opts?.offset ?? 0));
	return rows.map((r) => ({
		id: r.p.id,
		itemName: r.p.itemName,
		note: r.p.note,
		merchantName: r.merchantName,
		placeLabel: r.p.placeLabel,
		state: r.p.state,
		amountMinor: r.p.finalAmountMinor ?? r.p.requestedAmountMinor,
		currency: r.p.currency,
		requesterMemberId: r.p.memberId,
		requesterName: r.requesterName,
		categoryName: r.categoryName,
		categoryIcon: r.categoryIcon,
		categoryColor: r.categoryColor,
		categoryId: r.p.categoryId,
		thumbBlobId: r.thumbBlobId,
		requestedAt: r.p.requestedAt,
		decidedAt: r.p.decidedAt,
		completedAt: r.p.completedAt,
		createdAt: r.p.createdAt,
		canDecide: r.canDecide,
		sealed:
			r.p.sealedFromMemberIds.length > 0 &&
			r.p.sealedUntil !== null &&
			r.p.sealedUntil.getTime() > now.getTime(),
		sealedUntil: r.p.sealedUntil,
		isRefund: r.p.parentPurchaseId !== null,
		recurring: r.p.recurringRuleId !== null,
		heldUntil: r.p.heldUntil
	}));
}

export interface PurchaseEventView {
	toState: PurchaseRow['state'];
	fromState: PurchaseRow['state'] | null;
	actorName: string | null;
	reason: string | null;
	amountMinor: bigint | null;
	at: Date;
}

export async function listEvents(db: Db, purchaseId: string): Promise<PurchaseEventView[]> {
	const rows = await db
		.select({
			e: approvalEvent,
			actorName: user.displayName
		})
		.from(approvalEvent)
		.leftJoin(workspaceMember, eq(approvalEvent.actorMemberId, workspaceMember.id))
		.leftJoin(user, eq(workspaceMember.userId, user.id))
		.where(eq(approvalEvent.purchaseId, purchaseId))
		.orderBy(approvalEvent.createdAt);
	return rows.map((r) => ({
		toState: r.e.toState,
		fromState: r.e.fromState,
		actorName: r.actorName,
		reason: r.e.reason,
		amountMinor: r.e.amountSnapshotMinor,
		at: r.e.createdAt
	}));
}

/** Display names for a set of member ids (approver chips on the detail page). */
export async function memberNames(db: Db, memberIds: string[]): Promise<Map<string, string>> {
	if (memberIds.length === 0) return new Map();
	const rows = await db
		.select({ id: workspaceMember.id, name: user.displayName })
		.from(workspaceMember)
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(inArray(workspaceMember.id, memberIds));
	return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The category this workspace last filed a merchant under.
 *
 * The basis of the deterministic half of the category suggestion: if you have
 * already told the app that Blue Bottle is Coffee, it should not need a language
 * model to work that out a second time. Only settled states count — a pending
 * request is a claim about the future, and a denied or cancelled one was
 * explicitly rejected, so neither is evidence of how you file this merchant.
 *
 * Most recent wins rather than most frequent: when a merchant genuinely changes
 * category for you, the correction should take effect immediately instead of
 * being outvoted by history.
 *
 * Seal-filtered to the viewer. It returns only a category id, but a category is
 * still something: if the only purchase at a merchant is one sealed from the
 * viewer, an unfiltered lookup would pre-fill that gift's category the moment
 * they typed the vendor, disclosing that a purchase exists there. Sealing's
 * promise is that a sealed purchase does not exist for a concealed member, so
 * this reads only what they can already see.
 */
export async function lastCategoryForMerchant(
	db: Db,
	workspaceId: string,
	normalizedMerchantName: string,
	viewerId: string,
	now: Date
): Promise<string | null> {
	const [row] = await db
		.select({ categoryId: purchase.categoryId })
		.from(purchase)
		.innerJoin(merchant, eq(purchase.merchantId, merchant.id))
		.innerJoin(category, eq(purchase.categoryId, category.id))
		.where(
			and(
				eq(purchase.workspaceId, workspaceId),
				eq(merchant.normalizedName, normalizedMerchantName),
				inArray(purchase.state, ['completed', 'approved']),
				eq(category.isArchived, false),
				visibleTo(viewerId, now)
			)
		)
		.orderBy(desc(purchase.createdAt))
		.limit(1);
	return row?.categoryId ?? null;
}
