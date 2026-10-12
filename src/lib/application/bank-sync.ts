/**
 * Bank sync: SimpleFIN transactions into reconciliation, with the plain cases
 * answered on the household's behalf.
 *
 * Synced transactions become statement lines, in a rolling import per ledger
 * account per month, and go through the same matcher and seal rules a file
 * does (`proposeMatches`). Two answers are then given without asking, because
 * the evidence for them is as good as it gets and somebody turned bank sync on
 * to stop doing them by hand:
 *
 * 1. **Clearing.** A line whose match the matcher reached on amount, date *and*
 *    description is confirmed: the purchase gets `cleared_at` and the card it
 *    was on. Amount-and-date-only matches stay proposals, as they are for a
 *    file. This is the one place a match is confirmed without a person, and it
 *    is limited to a bank feed on purpose: a feed's lines are the bank's own
 *    records, never transcribed, so the line side of the evidence cannot be
 *    wrong.
 * 2. **Completing.** A charge that plainly pays for an approved request
 *    (`matchApproved`) completes it with the charged amount, as the requester —
 *    the same domain transition their own tap would run, so a charge over the
 *    re-approval threshold goes back to the approver rather than through.
 *
 * Everything else lands as an unanswered line in Reconcile, where "Log this"
 * already turns a line into a purchase through the normal approval flow.
 * Nothing here creates a purchase, and every automatic answer can be undone
 * from the review screen like any other.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, max, min, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	account,
	bankConnection,
	purchase,
	statementImport,
	statementLine,
	workspace,
	workspaceMember
} from '$lib/db/schema';
import { SimplefinError, type FeedTransaction } from '$lib/domain/bankfeed/simplefin';
import { matchApproved } from '$lib/domain/reconcile/match-approved';
import { Money } from '$lib/domain/money/money';
import { proposeMatches } from '$lib/application/reconcile';
import { completePurchase } from '$lib/application/purchases';
import { createAccount, accountLabel } from '$lib/repo/accounts';
import {
	connectionsDue,
	deleteConnection,
	getConnection,
	getFeedAccount,
	knownExternalIds,
	listFeedAccounts,
	recordSyncResult,
	setFeedAccountLink,
	upsertFeedAccounts,
	type BankConnectionRow
} from '$lib/repo/bank-feeds';
import { approvedCandidates, countUnsettled, refreshMatchedCount } from '$lib/repo/statements';
import type { BankFeed } from '$lib/ports/bank-feed';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { Notifier } from '$lib/ports/notifier';

export class BankSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BankSyncError';
	}
}

/** How credentials are sealed at rest. The server passes `secrets.ts`. */
export interface SecretBox {
	seal(plain: string): string | null;
	open(stored: string): string | null;
}

interface Deps {
	clock: Clock;
	ids: IdGenerator;
	notifier: Notifier;
	feed: BankFeed;
	secrets: SecretBox;
}

interface Scope {
	workspaceId: string;
	memberId: string;
}

const DAY_MS = 86_400_000;
/** First sync reaches this far back. */
const FIRST_SYNC_DAYS = 30;
/** Each later sync re-reads this much before the last one: banks post late. */
const OVERLAP_DAYS = 10;
/** SimpleFIN Bridge serves at most this much history per request. */
const MAX_WINDOW_DAYS = 60;
/** The sweep's pace. SimpleFIN Bridge asks clients to stay well under 24 a day. */
export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
/** "Sync now" cannot be pressed faster than this. */
export const MANUAL_SYNC_MIN_MS = 5 * 60 * 1000;

function sha256(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

/**
 * Claim a setup token and store the connection, with every account the bridge
 * reports listed but none linked: what syncs is chosen afterwards, per account.
 */
export async function connectSimplefin(
	db: Db,
	deps: Omit<Deps, 'notifier'>,
	scope: Scope,
	setupToken: string
): Promise<{ connectionId: string }> {
	const accessUrl = await deps.feed.claim(setupToken).catch(rethrow);
	const sealed = deps.secrets.seal(accessUrl);
	// The caller checks SECRETS_KEY first; this is the backstop. A seal that
	// hands back the plain value means there was no key to seal with.
	if (!sealed || sealed === accessUrl) {
		throw new BankSyncError('Bank sync needs SECRETS_KEY set on the server.');
	}
	const set = await deps.feed.accounts(accessUrl, { balancesOnly: true }).catch(rethrow);
	const orgs = [...new Set(set.accounts.map((a) => a.orgName).filter((o): o is string => !!o))];

	const id = deps.ids.newId();
	await db.insert(bankConnection).values({
		id,
		workspaceId: scope.workspaceId,
		memberId: scope.memberId,
		label: orgs.join(', ') || 'SimpleFIN',
		accessUrl: sealed,
		status: 'ok',
		lastError: set.errors.join(' ') || null,
		lastAttemptAt: null,
		lastSyncedAt: null,
		createdAt: deps.clock.now()
	});
	await upsertFeedAccounts(db, deps.ids, { id, workspaceId: scope.workspaceId }, set.accounts);
	return { connectionId: id };
}

/**
 * Point a reported account at a ledger card, at a new one made for it, or at
 * nothing. Linking is what makes an account sync.
 */
export async function linkFeedAccount(
	db: Db,
	deps: { clock: Clock; ids: IdGenerator },
	scope: Scope,
	feedAccountId: string,
	target: { accountId: string } | { create: true } | null
): Promise<void> {
	const fa = await getFeedAccount(db, scope.workspaceId, feedAccountId);
	if (!fa) throw new BankSyncError('That bank account is no longer listed.');
	if (target === null) {
		await setFeedAccountLink(db, scope.workspaceId, feedAccountId, null);
		return;
	}
	const [ws] = await db
		.select({ currency: workspace.currency })
		.from(workspace)
		.where(eq(workspace.id, scope.workspaceId))
		.limit(1);
	if (fa.currency !== ws.currency) {
		throw new BankSyncError(
			`That account is in ${fa.currency} and this ledger is in ${ws.currency}, so its transactions can't be matched.`
		);
	}

	let accountId: string;
	if ('create' in target) {
		const name = [fa.orgName, fa.name].filter(Boolean).join(' ');
		const kind = /card|visa|master|amex|credit/i.test(name) ? 'card' : 'bank';
		accountId = await createAccount(db, deps, scope.workspaceId, { name, kind });
	} else {
		const [row] = await db
			.select({ id: account.id })
			.from(account)
			.where(
				and(
					eq(account.workspaceId, scope.workspaceId),
					eq(account.id, target.accountId),
					eq(account.isArchived, false)
				)
			)
			.limit(1);
		if (!row) throw new BankSyncError('That card is not in this workspace.');
		accountId = row.id;
	}
	await setFeedAccountLink(db, scope.workspaceId, feedAccountId, accountId);
}

export async function disconnect(db: Db, scope: Scope, connectionId: string): Promise<void> {
	await deleteConnection(db, scope.workspaceId, connectionId);
}

export interface SyncResult {
	added: number;
	cleared: number;
	completed: number;
	/** Lines left for a person: unanswered, or a proposal waiting on a tap. */
	toReview: number;
}

/**
 * Sync one connection now. Failures are recorded on the connection, where the
 * settings page shows them, and rethrown as a `BankSyncError` for the caller
 * that pressed the button.
 */
export async function syncConnection(
	db: Db,
	deps: Deps,
	workspaceId: string,
	connectionId: string
): Promise<SyncResult> {
	const conn = await getConnection(db, workspaceId, connectionId);
	if (!conn) throw new BankSyncError('That connection no longer exists.');
	const now = deps.clock.now();
	try {
		const { result, warning } = await runSync(db, deps, conn, now);
		await recordSyncResult(db, conn.id, now, { ok: true, warning });
		return result;
	} catch (e) {
		const message =
			e instanceof BankSyncError || e instanceof SimplefinError
				? e.message
				: 'Sync failed unexpectedly. The server log has the details.';
		if (!(e instanceof BankSyncError || e instanceof SimplefinError)) {
			console.log(
				JSON.stringify({
					level: 'error',
					msg: 'bank sync failed',
					connectionId: conn.id,
					error: e instanceof Error ? e.message : String(e)
				})
			);
		}
		await recordSyncResult(db, conn.id, now, { ok: false, error: message });
		throw new BankSyncError(message);
	}
}

/** The sweep's entry: every connection not tried for a while. Returns lines added. */
export async function syncDueConnections(db: Db, deps: Deps): Promise<number> {
	const due = await connectionsDue(db, new Date(deps.clock.now().getTime() - SYNC_EVERY_MS));
	let added = 0;
	for (const conn of due) {
		try {
			added += (await syncConnection(db, deps, conn.workspaceId, conn.id)).added;
		} catch {
			// Recorded on the connection; one bank's trouble must not stop the rest.
		}
	}
	return added;
}

async function runSync(
	db: Db,
	deps: Deps,
	conn: BankConnectionRow,
	now: Date
): Promise<{ result: SyncResult; warning: string | null }> {
	const [member] = await db
		.select({ status: workspaceMember.status })
		.from(workspaceMember)
		.where(eq(workspaceMember.id, conn.memberId))
		.limit(1);
	if (member?.status !== 'active') {
		throw new BankSyncError(
			'The person who connected this bank is no longer an active member. Connect it again.'
		);
	}
	const accessUrl = deps.secrets.open(conn.accessUrl);
	if (!accessUrl) {
		throw new BankSyncError(
			'The stored connection could not be decrypted (has SECRETS_KEY changed?). Connect it again.'
		);
	}

	const since = conn.lastSyncedAt
		? conn.lastSyncedAt.getTime() - OVERLAP_DAYS * DAY_MS
		: now.getTime() - FIRST_SYNC_DAYS * DAY_MS;
	const start = new Date(Math.max(since, now.getTime() - MAX_WINDOW_DAYS * DAY_MS));
	const set = await deps.feed.accounts(accessUrl, { start, end: now });
	await upsertFeedAccounts(db, deps.ids, conn, set.accounts);

	const [ws] = await db
		.select({ currency: workspace.currency })
		.from(workspace)
		.where(eq(workspace.id, conn.workspaceId))
		.limit(1);
	const links = await listFeedAccounts(db, conn.id);
	const activeAccounts = new Set(
		(
			await db
				.select({ id: account.id })
				.from(account)
				.where(and(eq(account.workspaceId, conn.workspaceId), eq(account.isArchived, false)))
		).map((a) => a.id)
	);

	const total: SyncResult = { added: 0, cleared: 0, completed: 0, toReview: 0 };
	const scope = { workspaceId: conn.workspaceId, memberId: conn.memberId };
	for (const reported of set.accounts) {
		const link = links.find((l) => l.externalId === reported.externalId);
		if (!link?.accountId || !activeAccounts.has(link.accountId)) continue;
		if (reported.currency !== ws.currency) continue;
		const r = await ingest(db, deps, scope, {
			accountId: link.accountId,
			feedAccountExternalId: reported.externalId,
			currency: ws.currency,
			transactions: reported.transactions,
			now
		});
		total.added += r.added;
		total.cleared += r.cleared;
		total.completed += r.completed;
		total.toReview += r.toReview;
	}
	return { result: total, warning: set.errors.join(' ') || null };
}

/** 'YYYY-MM' of a posted day. Lines sit at noon UTC on their calendar date. */
function monthOf(d: Date): string {
	return d.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en', {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	});
}

/** The rolling import for one ledger account and month, created on first use. */
async function feedImport(
	db: Db,
	deps: { clock: Clock; ids: IdGenerator },
	scope: Scope,
	accountId: string,
	currency: string,
	month: string
): Promise<string> {
	const key = `feed:${accountId}:${month}`;
	const [existing] = await db
		.select({ id: statementImport.id })
		.from(statementImport)
		.where(
			and(eq(statementImport.workspaceId, scope.workspaceId), eq(statementImport.contentHash, key))
		)
		.limit(1);
	if (existing) return existing.id;

	const [acct] = await db
		.select({ name: account.name, last4: account.last4 })
		.from(account)
		.where(eq(account.id, accountId))
		.limit(1);
	const id = deps.ids.newId();
	await db.insert(statementImport).values({
		id,
		workspaceId: scope.workspaceId,
		memberId: scope.memberId,
		filename: `${acct ? accountLabel(acct) : 'Bank'} · ${monthLabel(month)}`,
		accountId,
		format: 'feed',
		currency,
		blobId: null,
		periodStart: null,
		periodEnd: null,
		lineCount: 0,
		matchedCount: 0,
		status: 'reviewing',
		modelRead: false,
		contentHash: key,
		createdAt: deps.clock.now()
	});
	return id;
}

/** Bring an import's totals and status in line with its lines. */
async function refreshImport(db: Db, importId: string): Promise<void> {
	const [agg] = await db
		.select({
			n: sql<number>`count(*)`.mapWith(Number),
			first: min(statementLine.postedAt),
			last: max(statementLine.postedAt)
		})
		.from(statementLine)
		.where(eq(statementLine.importId, importId));
	const unsettled = await countUnsettled(db, importId);
	await db
		.update(statementImport)
		.set({
			lineCount: agg?.n ?? 0,
			periodStart: agg?.first ?? null,
			periodEnd: agg?.last ?? null,
			// New questions reopen a closed month; an all-answered one stays as it was.
			...(unsettled > 0 ? { status: 'reviewing' } : {})
		})
		.where(eq(statementImport.id, importId));
	await refreshMatchedCount(db, importId);
}

async function ingest(
	db: Db,
	deps: Deps,
	scope: Scope,
	input: {
		accountId: string;
		feedAccountExternalId: string;
		currency: string;
		transactions: FeedTransaction[];
		now: Date;
	}
): Promise<SyncResult> {
	const result: SyncResult = { added: 0, cleared: 0, completed: 0, toReview: 0 };
	// Keyed on the bridge's account id, not our row's: reconnecting the same
	// bank makes new rows, and must not bring every transaction in a second time.
	const extId = (t: FeedTransaction) => `sfin:${input.feedAccountExternalId}:${t.id}`;
	const known = await knownExternalIds(db, scope.workspaceId, input.transactions.map(extId));
	const fresh = input.transactions.filter((t) => !known.has(extId(t)));
	if (fresh.length === 0) return result;

	const { proposals, privateLines } = await proposeMatches(
		db,
		scope,
		fresh,
		input.accountId,
		input.now
	);

	// Unanswered spending lines get a second look against approved requests.
	const open = fresh
		.map((line, i) => ({ line, i }))
		.filter(({ i }) => proposals[i].state !== 'matched' && !privateLines.has(i));
	const approved = await approvedCandidates(
		db,
		{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
		input.now
	);
	const paysFor = matchApproved(
		open.map((o) => o.line),
		approved,
		{ accountId: input.accountId }
	);
	const toComplete = new Map<number, (typeof approved)[number]>();
	for (const [j, hit] of paysFor) {
		toComplete.set(
			open[j].i,
			approved.find((a) => a.id === hit.purchaseId)!
		);
	}

	const importIds = new Map<string, string>();
	for (const month of new Set(fresh.map((t) => monthOf(t.postedAt)))) {
		importIds.set(month, await feedImport(db, deps, scope, input.accountId, input.currency, month));
	}

	const lineIds: string[] = fresh.map(() => deps.ids.newId());
	const inserted = new Set<string>();
	await db.transaction(async (tx) => {
		const values = fresh.map((t, i) => {
			const p = proposals[i];
			const isPrivate = privateLines.has(i);
			const autoClear =
				!isPrivate && p.state === 'matched' && p.reason === 'amount, date and description';
			const pending = toComplete.get(i);
			return {
				id: lineIds[i],
				importId: importIds.get(monthOf(t.postedAt))!,
				workspaceId: scope.workspaceId,
				postedAt: t.postedAt,
				amountMinor: t.amountMinor,
				currency: t.currency,
				rawDescription: t.rawDescription,
				normalizedDescription: t.normalizedDescription,
				externalId: extId(t),
				matchState: isPrivate ? ('private' as const) : autoClear ? ('confirmed' as const) : p.state,
				matchedPurchaseId: isPrivate ? null : p.purchaseId,
				matchReason: isPrivate ? null : autoClear ? `${p.reason}; cleared by bank sync` : p.reason,
				// An approved request this line pays for rides as the top suggestion
				// until it is completed below, so a crash in between leaves the
				// answer one tap away rather than lost.
				suggestedPurchaseIds: isPrivate
					? []
					: pending
						? [pending.id]
						: p.suggestions.map((s) => s.purchaseId),
				dedupHash: sha256(extId(t))
			};
		});
		for (let i = 0; i < values.length; i += 500) {
			// A concurrent sync of the same window may have written some of these
			// already; the unique index on external_id makes that a no-op.
			const rows = await tx
				.insert(statementLine)
				.values(values.slice(i, i + 500))
				.onConflictDoNothing()
				.returning({ id: statementLine.id });
			for (const r of rows) inserted.add(r.id);
		}

		for (const v of values) {
			if (!inserted.has(v.id) || v.matchState !== 'confirmed' || !v.matchedPurchaseId) continue;
			const marked = await tx
				.update(purchase)
				.set({ clearedAt: input.now, updatedAt: input.now, accountId: input.accountId })
				.where(
					and(
						eq(purchase.id, v.matchedPurchaseId),
						eq(purchase.workspaceId, scope.workspaceId),
						// Single-claim, as in confirmMatch: never clear what another line has.
						isNull(purchase.clearedAt)
					)
				)
				.returning({ id: purchase.id });
			if (marked.length > 0) {
				result.cleared++;
			} else {
				await tx
					.update(statementLine)
					.set({ matchState: 'matched', matchReason: v.matchReason?.replace(/; cleared.*$/, '') })
					.where(eq(statementLine.id, v.id));
			}
		}
	});
	result.added = inserted.size;

	for (const [i, cand] of toComplete) {
		if (!inserted.has(lineIds[i])) continue;
		const line = fresh[i];
		try {
			await completePurchase(
				db,
				deps,
				{ workspaceId: scope.workspaceId, memberId: cand.memberId },
				cand.id,
				{ amount: Money.of(-line.amountMinor, line.currency), at: line.postedAt }
			);
		} catch {
			// The request moved on (cancelled, edited, completed by hand) between
			// the read and now. The suggestion on the line still offers it.
			continue;
		}
		const [after] = await db
			.select({ state: purchase.state })
			.from(purchase)
			.where(eq(purchase.id, cand.id))
			.limit(1);
		if (after?.state === 'completed') {
			await db.transaction(async (tx) => {
				await tx
					.update(statementLine)
					.set({
						matchState: 'confirmed',
						matchedPurchaseId: cand.id,
						matchReason: 'paid for an approved request; completed by bank sync',
						suggestedPurchaseIds: []
					})
					.where(eq(statementLine.id, lineIds[i]));
				await tx
					.update(purchase)
					.set({ clearedAt: input.now, updatedAt: input.now, accountId: input.accountId })
					.where(and(eq(purchase.id, cand.id), isNull(purchase.clearedAt)));
			});
			result.completed++;
		} else {
			// Over the re-approval threshold: back with the approver, and the line
			// waits on them like any other proposal.
			await db
				.update(statementLine)
				.set({
					matchState: 'matched',
					matchedPurchaseId: cand.id,
					matchReason: 'paid for an approved request; over the approved amount, back for approval',
					suggestedPurchaseIds: []
				})
				.where(eq(statementLine.id, lineIds[i]));
		}
	}

	for (const importId of new Set(importIds.values())) await refreshImport(db, importId);

	if (inserted.size === 0) return result;
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(statementLine)
		.where(
			and(
				inArray(statementLine.id, [...inserted]),
				inArray(statementLine.matchState, ['unmatched', 'matched'])
			)
		);
	result.toReview = n;
	return result;
}

function rethrow(e: unknown): never {
	if (e instanceof SimplefinError) throw new BankSyncError(e.message);
	throw e;
}
