/**
 * Statement imports and their lines.
 *
 * Follows the same rule as every other repository here: reads take
 * `workspaceId + viewerId`, and anything that can reach a purchase is
 * seal-filtered at the query, not at the caller. A reconciliation screen is
 * exactly the kind of place a seal would otherwise leak — it exists to list
 * money that moved — so the candidate query below carries `visibleTo` for the
 * same reason the ledger does.
 */

import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	category,
	merchant,
	purchase,
	statementImport,
	statementLine,
	user,
	workspaceMember
} from '$lib/db/schema';
import { visibleTo } from './purchases';
import type { MatchCandidate } from '$lib/domain/reconcile/match';
import type { ApprovedCandidate } from '$lib/domain/reconcile/match-approved';

export type StatementImportRow = typeof statementImport.$inferSelect;
export type StatementLineRow = typeof statementLine.$inferSelect;

export interface Scope {
	workspaceId: string;
	viewerId: string;
}

export interface ImportListItem {
	id: string;
	filename: string;
	createdAt: Date;
	lineCount: number;
	matchedCount: number;
	/** Lines a person has actually signed off. */
	confirmedCount: number;
	periodStart: Date | null;
	periodEnd: Date | null;
	currency: string;
	importedByName: string;
	/** Transcribed off a picture by a model. Surfaced everywhere it is listed. */
	modelRead: boolean;
	/** Every line answered and the import closed — review work, finished. */
	closed: boolean;
	/** Written by bank sync rather than uploaded; it grows as transactions post. */
	synced: boolean;
}

/** Newest first — you reconcile the statement you just pulled down. */
export async function listImports(db: Db, workspaceId: string): Promise<ImportListItem[]> {
	const rows = await db
		.select({
			imp: statementImport,
			importedByName: user.displayName,
			confirmedCount: sql<number>`(
				select count(*) from ${statementLine}
				where ${statementLine.importId} = ${statementImport.id}
				  and ${statementLine.matchState} = 'confirmed'
			)`.mapWith(Number)
		})
		.from(statementImport)
		.innerJoin(workspaceMember, eq(statementImport.memberId, workspaceMember.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(eq(statementImport.workspaceId, workspaceId))
		.orderBy(desc(statementImport.createdAt));

	return rows.map((r) => ({
		id: r.imp.id,
		filename: r.imp.filename,
		createdAt: r.imp.createdAt,
		lineCount: r.imp.lineCount,
		matchedCount: r.imp.matchedCount,
		confirmedCount: r.confirmedCount,
		periodStart: r.imp.periodStart,
		periodEnd: r.imp.periodEnd,
		currency: r.imp.currency,
		importedByName: r.importedByName,
		modelRead: r.imp.modelRead,
		closed: r.imp.status === 'reconciled',
		synced: r.imp.format === 'feed'
	}));
}

/** One import, scoped to the workspace so an id from elsewhere can't be read. */
export async function getImport(
	db: Db,
	workspaceId: string,
	importId: string
): Promise<StatementImportRow | null> {
	const [row] = await db
		.select()
		.from(statementImport)
		.where(and(eq(statementImport.workspaceId, workspaceId), eq(statementImport.id, importId)))
		.limit(1);
	return row ?? null;
}

/** True when this exact file has already been imported into this workspace. */
export async function findImportByHash(
	db: Db,
	workspaceId: string,
	contentHash: string
): Promise<StatementImportRow | null> {
	const [row] = await db
		.select()
		.from(statementImport)
		.where(
			and(
				eq(statementImport.workspaceId, workspaceId),
				eq(statementImport.contentHash, contentHash)
			)
		)
		.limit(1);
	return row ?? null;
}

export interface LinePurchaseView {
	id: string;
	itemName: string;
	merchantName: string | null;
	categoryIcon: string | null;
	completedAt: Date | null;
	amountMinor: bigint;
}

export interface LineView {
	id: string;
	postedAt: Date;
	amountMinor: bigint;
	currency: string;
	rawDescription: string;
	matchState: StatementLineRow['matchState'];
	matchReason: string | null;
	/**
	 * The matched purchase, when there is one the viewer may see. Null on a
	 * `private` line by construction — that state exists precisely to say
	 * "accounted for" without saying by what.
	 */
	purchase: LinePurchaseView | null;
	/**
	 * What the matcher ranked but wouldn't claim, best first, resolved through
	 * the same seal filter as `purchase`. An id that has since been sealed,
	 * cleared, or deleted simply drops out — the shortlist is a convenience, so
	 * a short one is fine and a wrong one is not.
	 */
	suggestions: LinePurchaseView[];
}

/** Every line of an import, oldest first — the order a statement is read in. */
export async function listLines(
	db: Db,
	scope: Scope,
	importId: string,
	now: Date
): Promise<LineView[]> {
	const rows = await db
		.select({
			line: statementLine,
			pId: purchase.id,
			pItemName: purchase.itemName,
			pCompletedAt: purchase.completedAt,
			pRequested: purchase.requestedAmountMinor,
			pFinal: purchase.finalAmountMinor,
			merchantName: merchant.name,
			categoryIcon: category.icon
		})
		.from(statementLine)
		// Left-joined *through the seal predicate*: a line matched to a purchase
		// the viewer may not see keeps its row (so the statement still balances)
		// but arrives with no purchase attached.
		.leftJoin(
			purchase,
			and(eq(statementLine.matchedPurchaseId, purchase.id), visibleTo(scope.viewerId, now))
		)
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.leftJoin(category, eq(purchase.categoryId, category.id))
		.where(
			and(eq(statementLine.importId, importId), eq(statementLine.workspaceId, scope.workspaceId))
		)
		.orderBy(asc(statementLine.postedAt), asc(statementLine.id));

	/*
	 * Resolve every line's shortlist in one further query rather than a join per
	 * line. It runs through `visibleTo` exactly like the join above, so a
	 * suggestion the viewer may not see never reaches them — the ids were ranked
	 * against what the *importer* could see, which is not necessarily this reader.
	 * A purchase that has since been cleared is dropped too: offering it again is
	 * how one ends up reconciled twice.
	 */
	const wanted = [...new Set(rows.flatMap((r) => r.line.suggestedPurchaseIds ?? []))];
	const byId = new Map<string, LinePurchaseView>();
	if (wanted.length > 0) {
		const suggested = await db
			.select({
				id: purchase.id,
				itemName: purchase.itemName,
				completedAt: purchase.completedAt,
				requested: purchase.requestedAmountMinor,
				final: purchase.finalAmountMinor,
				merchantName: merchant.name,
				categoryIcon: category.icon
			})
			.from(purchase)
			.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
			.leftJoin(category, eq(purchase.categoryId, category.id))
			.where(
				and(
					eq(purchase.workspaceId, scope.workspaceId),
					inArray(purchase.id, wanted),
					visibleTo(scope.viewerId, now),
					sql`${purchase.clearedAt} is null`
				)
			);
		for (const p of suggested) {
			byId.set(p.id, {
				id: p.id,
				itemName: p.itemName,
				merchantName: p.merchantName,
				categoryIcon: p.categoryIcon,
				completedAt: p.completedAt,
				amountMinor: p.final ?? p.requested
			});
		}
	}

	return rows.map((r) => ({
		id: r.line.id,
		postedAt: r.line.postedAt,
		amountMinor: r.line.amountMinor,
		currency: r.line.currency,
		rawDescription: r.line.rawDescription,
		matchState: r.line.matchState,
		matchReason: r.line.matchReason,
		purchase: r.pId
			? {
					id: r.pId,
					itemName: r.pItemName!,
					merchantName: r.merchantName,
					categoryIcon: r.categoryIcon,
					completedAt: r.pCompletedAt,
					amountMinor: r.pFinal ?? r.pRequested!
				}
			: null,
		// Only where a shortlist can still help: a matched or private line has an
		// answer already, and rank order is preserved from the matcher.
		suggestions:
			r.line.matchState === 'unmatched'
				? (r.line.suggestedPurchaseIds ?? [])
						.map((id) => byId.get(id))
						.filter((p): p is LinePurchaseView => !!p)
				: []
	}));
}

/**
 * Purchases a statement covering [from, to] might correspond to.
 *
 * Only settled spending: a pending request is money that hasn't moved, so it
 * cannot appear on a bank statement, and offering it as a match would invite
 * someone to mark an unapproved request as reconciled. Seal-filtered, so a
 * concealed purchase is never offered as a candidate to someone it's hidden
 * from — matching runs on what the importer can actually see.
 */
export async function matchCandidates(
	db: Db,
	scope: Scope,
	from: Date,
	to: Date,
	now: Date
): Promise<MatchCandidate[]> {
	const rows = await db
		.select({
			id: purchase.id,
			requested: purchase.requestedAmountMinor,
			final: purchase.finalAmountMinor,
			completedAt: purchase.completedAt,
			itemName: purchase.itemName,
			merchantName: merchant.name,
			accountId: purchase.accountId
		})
		.from(purchase)
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.where(
			and(
				eq(purchase.workspaceId, scope.workspaceId),
				visibleTo(scope.viewerId, now),
				inArray(purchase.state, ['completed', 'refunded']),
				isNotNull(purchase.completedAt),
				gte(purchase.completedAt, from),
				lte(purchase.completedAt, to),
				// Already reconciled against an earlier statement — offering it again
				// is how a purchase ends up double-counted as cleared.
				sql`${purchase.clearedAt} is null`
			)
		);

	return rows.map((r) => ({
		id: r.id,
		amountMinor: r.final ?? r.requested,
		completedAt: r.completedAt!,
		itemName: r.itemName,
		merchantName: r.merchantName,
		accountId: r.accountId
	}));
}

/**
 * Approved requests not yet bought: what a synced charge might be the payment
 * for. Seal-filtered like `matchCandidates`. Carries the requester, because
 * only they may complete a purchase and the sync completes it as them.
 */
export async function approvedCandidates(
	db: Db,
	scope: Scope,
	now: Date
): Promise<(ApprovedCandidate & { memberId: string })[]> {
	const rows = await db
		.select({
			id: purchase.id,
			memberId: purchase.memberId,
			approved: purchase.approvedAmountMinor,
			requested: purchase.requestedAmountMinor,
			decidedAt: purchase.decidedAt,
			createdAt: purchase.createdAt,
			itemName: purchase.itemName,
			merchantName: merchant.name,
			accountId: purchase.accountId
		})
		.from(purchase)
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.where(
			and(
				eq(purchase.workspaceId, scope.workspaceId),
				visibleTo(scope.viewerId, now),
				eq(purchase.state, 'approved'),
				sql`${purchase.clearedAt} is null`
			)
		);

	return rows.map((r) => ({
		id: r.id,
		memberId: r.memberId,
		approvedAmountMinor: r.approved ?? r.requested,
		approvedAt: r.decidedAt ?? r.createdAt,
		itemName: r.itemName,
		merchantName: r.merchantName,
		accountId: r.accountId
	}));
}

/**
 * Purchases in the window that the viewer *cannot* see, as a bare count of
 * (amount, date) pairs. Used to mark a line `private` rather than leaving it
 * looking unexplained — see the note in application/reconcile.ts about what
 * this does and does not reveal.
 */
export async function sealedCandidateKeys(
	db: Db,
	scope: Scope,
	from: Date,
	to: Date,
	now: Date
): Promise<{ amountMinor: bigint; completedAt: Date }[]> {
	const rows = await db
		.select({
			requested: purchase.requestedAmountMinor,
			final: purchase.finalAmountMinor,
			completedAt: purchase.completedAt
		})
		.from(purchase)
		.where(
			and(
				eq(purchase.workspaceId, scope.workspaceId),
				// The negation of the seal predicate: hidden from *this* viewer.
				sql`not (${visibleTo(scope.viewerId, now)})`,
				inArray(purchase.state, ['completed', 'refunded']),
				isNotNull(purchase.completedAt),
				gte(purchase.completedAt, from),
				lte(purchase.completedAt, to)
			)
		);

	return rows.map((r) => ({
		amountMinor: r.final ?? r.requested,
		completedAt: r.completedAt!
	}));
}

/**
 * Another line that has already confirmed this purchase, if there is one.
 *
 * Two imports covering overlapping periods can each *propose* the same purchase
 * — proposals are cheap and nothing is claimed until a person confirms. But two
 * lines both *confirmed* against one purchase is incoherent: `cleared_at` is a
 * single mark, so undoing either line would clear it while the other still
 * displayed "Cleared", and the ledger would quietly disagree with itself.
 * Confirming checks this first and refuses.
 */
export async function confirmedLineFor(
	db: Db,
	workspaceId: string,
	purchaseId: string,
	exceptLineId: string
): Promise<StatementLineRow | null> {
	const [row] = await db
		.select()
		.from(statementLine)
		.where(
			and(
				eq(statementLine.workspaceId, workspaceId),
				eq(statementLine.matchedPurchaseId, purchaseId),
				eq(statementLine.matchState, 'confirmed'),
				ne(statementLine.id, exceptLineId)
			)
		)
		.limit(1);
	return row ?? null;
}

/** One line, scoped so an id from another workspace can't be acted on. */
export async function getLine(
	db: Db,
	workspaceId: string,
	lineId: string
): Promise<StatementLineRow | null> {
	const [row] = await db
		.select()
		.from(statementLine)
		.where(and(eq(statementLine.workspaceId, workspaceId), eq(statementLine.id, lineId)))
		.limit(1);
	return row ?? null;
}

/** Recount an import's matched lines after the review screen changes one. */
export async function refreshMatchedCount(db: Db, importId: string): Promise<void> {
	const [row] = await db
		.select({ n: count() })
		.from(statementLine)
		.where(
			and(
				eq(statementLine.importId, importId),
				inArray(statementLine.matchState, ['matched', 'confirmed'])
			)
		);
	await db
		.update(statementImport)
		.set({ matchedCount: row?.n ?? 0 })
		.where(eq(statementImport.id, importId));
}

/**
 * Lines still waiting for a person: unmatched, or holding a proposal they
 * haven't accepted. Zero is the precondition for closing an import — confirmed,
 * private and ignored all count as answered.
 */
export async function countUnsettled(db: Db, importId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(statementLine)
		.where(
			and(
				eq(statementLine.importId, importId),
				inArray(statementLine.matchState, ['unmatched', 'matched'])
			)
		);
	return row?.n ?? 0;
}
