/**
 * Statement reconciliation: import a bank CSV, propose matches, let a person
 * confirm them.
 *
 * The point of this feature is to answer "is the ledger actually right?" — so
 * it is deliberately conservative about saying yes on your behalf. Importing
 * never creates, edits or deletes a purchase, and never moves an amount. The
 * only thing confirming a match writes is `purchase.cleared_at`: a mark meaning
 * "this appeared on a statement", which is reversible and carries no money.
 *
 * One deliberate exception, added with care: a person can turn an unmatched
 * line into a purchase (`createPurchaseFromLine`). It goes through the same
 * `submitPurchase` every hand-logged purchase does — approval policy, audit
 * event, notifications, all of it — and it refuses outright on an import whose
 * rows were read off a *picture* (`modelRead`): that would be the first path
 * putting a model-derived amount straight into the ledger, which is exactly
 * what the column was carried to prevent.
 *
 * Parsing lives in `domain/reconcile/parse-csv`, matching in
 * `domain/reconcile/match`; both are pure. This module is the I/O half.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { purchase, statementImport, statementLine } from '$lib/db/schema';
import {
	dedupKey,
	parseCsv,
	type CsvColumnMap,
	type RawStatementLine
} from '$lib/domain/reconcile/parse-csv';
import { matchLines, type MatchProposal } from '$lib/domain/reconcile/match';
import { Money } from '$lib/domain/money/money';
import { submitPurchase } from '$lib/application/purchases';
import {
	confirmedLineFor,
	countUnsettled,
	findImportByHash,
	getImport,
	getLine,
	matchCandidates,
	refreshMatchedCount,
	sealedCandidateKeys
} from '$lib/repo/statements';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { Notifier } from '$lib/ports/notifier';

export class ReconcileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReconcileError';
	}
}

interface Deps {
	clock: Clock;
	ids: IdGenerator;
}

export interface Scope {
	workspaceId: string;
	/** The acting member's workspace_member id — also the seal-filter viewer. */
	memberId: string;
}

/** Generous enough for a year of transactions, small enough to parse inline. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_LINES = 5000;

/** How far a bank line may sit from the purchase date. See match.ts. */
const TOLERANCE_DAYS = 3;
const DAY_MS = 86_400_000;

function sha256(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

export interface ImportResult {
	importId: string;
	lineCount: number;
	matchedCount: number;
	/** Parse failures, by CSV line number. Reported, never silently dropped. */
	errors: { line: number; message: string }[];
}

/**
 * Propose a match for each line against what the importer may see, then mark
 * the lines that only a concealed purchase explains as `private`.
 *
 * Shared by file imports and bank sync: wherever lines come from, the same
 * evidence rules and the same seal rules decide what they are matched to.
 */
export async function proposeMatches(
	db: Db,
	scope: Scope,
	lines: RawStatementLine[],
	accountId: string | null,
	now: Date
): Promise<{ proposals: MatchProposal[]; privateLines: Set<number> }> {
	if (lines.length === 0) return { proposals: [], privateLines: new Set() };
	const times = lines.map((l) => l.postedAt.getTime());

	// Widen the candidate window by the tolerance at both ends: a purchase made
	// two days before the statement's first line can still be the line that
	// opens it.
	const from = new Date(Math.min(...times) - TOLERANCE_DAYS * DAY_MS);
	const to = new Date(Math.max(...times) + TOLERANCE_DAYS * DAY_MS);

	const viewerScope = { workspaceId: scope.workspaceId, viewerId: scope.memberId };
	const [candidates, sealedKeys] = await Promise.all([
		matchCandidates(db, viewerScope, from, to, now),
		sealedCandidateKeys(db, viewerScope, from, to, now)
	]);

	const proposals = matchLines(lines, candidates, {
		toleranceDays: TOLERANCE_DAYS,
		accountId
	});

	/*
	 * Seal-aware second pass.
	 *
	 * Matching above ran only over purchases the importer can see, which is the
	 * right default — but it leaves a line for a concealed purchase looking
	 * unexplained, and the natural response to an unexplained line is to log it,
	 * creating a duplicate of a purchase you're not allowed to know about. The
	 * schema anticipates this with a `private` state: "accounted for, not shown".
	 *
	 * What this reveals is bounded: that *some* hidden purchase exists at an
	 * amount and date the importer is already reading off their own bank
	 * statement. It reveals no item, no merchant, no member, and the line carries
	 * no purchase id, so nothing can be followed. That is a smaller disclosure
	 * than the alternative, where the importer reconstructs the same fact by
	 * noticing a line they cannot account for.
	 */
	const sealedRemaining = sealedKeys.map((k) => ({ ...k, used: false }));
	const privateLines = new Set<number>();
	for (const p of proposals) {
		if (p.state === 'matched') continue;
		const line = lines[p.lineIndex];
		const abs = (n: bigint) => (n < 0n ? -n : n);
		const hit = sealedRemaining.find(
			(k) =>
				!k.used &&
				abs(k.amountMinor) === abs(line.amountMinor) &&
				Math.abs(k.completedAt.getTime() - line.postedAt.getTime()) <= TOLERANCE_DAYS * DAY_MS
		);
		if (hit) {
			hit.used = true;
			privateLines.add(p.lineIndex);
		}
	}

	return { proposals, privateLines };
}

/**
 * Parse a CSV and store it with its proposed matches.
 *
 * Runs in one transaction: a half-imported statement is worse than none, since
 * the review screen would then show a partial picture of a period and invite
 * someone to "explain" the gap by logging purchases that already exist.
 */
export async function importStatement(
	db: Db,
	deps: Deps,
	scope: Scope,
	input: {
		filename: string;
		csv: string;
		currency: string;
		map?: CsvColumnMap;
		/** The card this statement is for, when the person named one. */
		accountId?: string | null;
		/**
		 * How the rows were obtained. A PDF arrives here already reduced to the
		 * same three columns — the extraction happens in the browser so the file
		 * never leaves the device — so the only difference this makes is what gets
		 * recorded about where the import came from.
		 */
		format?: 'csv' | 'pdf';
		/**
		 * True when the rows were transcribed off a *picture* of a statement by a
		 * model, rather than read off text. Recorded on the import so the review
		 * screen can say so on every line — see the column's note in schema.ts for
		 * the second, not-yet-needed reason it is carried.
		 */
		modelRead?: boolean;
	}
): Promise<ImportResult> {
	if (input.csv.length > MAX_CSV_BYTES) {
		throw new ReconcileError('That file is too large to import.');
	}

	const contentHash = sha256(input.csv);
	const already = await findImportByHash(db, scope.workspaceId, contentHash);
	if (already) {
		// Re-importing the same file would create a second set of lines competing
		// for the same purchases, and the first import's confirmations would look
		// like they had been undone.
		throw new ReconcileError('This exact file has already been imported.');
	}

	const { lines, errors } = parseCsv(input.csv, input.currency, input.map);
	if (lines.length === 0) {
		throw new ReconcileError(errors[0]?.message ?? 'No transactions could be read from that file.');
	}
	if (lines.length > MAX_LINES) {
		throw new ReconcileError(`That file has more than ${MAX_LINES} transactions.`);
	}

	const now = deps.clock.now();
	const times = lines.map((l) => l.postedAt.getTime());
	const periodStart = new Date(Math.min(...times));
	const periodEnd = new Date(Math.max(...times));

	const { proposals, privateLines } = await proposeMatches(
		db,
		scope,
		lines,
		input.accountId ?? null,
		now
	);

	const importId = deps.ids.newId();
	const matchedCount = proposals.filter((p) => p.state === 'matched').length;

	await db.transaction(async (tx) => {
		await tx.insert(statementImport).values({
			id: importId,
			workspaceId: scope.workspaceId,
			memberId: scope.memberId,
			filename: input.filename,
			accountId: input.accountId ?? null,
			format: input.format ?? 'csv',
			currency: input.currency,
			blobId: null,
			periodStart,
			periodEnd,
			lineCount: lines.length,
			matchedCount,
			status: 'reviewing',
			modelRead: input.modelRead === true,
			contentHash,
			createdAt: now
		});

		/*
		 * `dedup_hash` is unique per (import, hash), so a statement that genuinely
		 * repeats a line — same day, same amount, same descriptor, which happens
		 * with two identical coffees — would collide. Suffixing repeats keeps both
		 * rows: the person bought two coffees and the statement should show two.
		 */
		const seen = new Map<string, number>();
		const values = lines.map((l, i) => {
			const key = dedupKey(l);
			const n = seen.get(key) ?? 0;
			seen.set(key, n + 1);
			const p = proposals[i];
			const isPrivate = privateLines.has(i);
			return {
				id: deps.ids.newId(),
				importId,
				workspaceId: scope.workspaceId,
				postedAt: l.postedAt,
				amountMinor: l.amountMinor,
				currency: l.currency,
				rawDescription: l.rawDescription,
				normalizedDescription: l.normalizedDescription,
				externalId: null,
				matchState: isPrivate ? ('private' as const) : p.state,
				matchedPurchaseId: p.purchaseId,
				matchReason: isPrivate ? null : p.reason,
				// The ranking the matcher already produced. Dropped for a `private`
				// line by the same rule as `matchReason`: that state says "accounted
				// for" without saying by what, and a shortlist would say by what.
				suggestedPurchaseIds: isPrivate ? [] : p.suggestions.map((s) => s.purchaseId),
				dedupHash: sha256(n === 0 ? key : `${key}#${n}`)
			};
		});

		// Chunked: a year of transactions in one INSERT can exceed the driver's
		// bind-parameter limit.
		for (let i = 0; i < values.length; i += 500) {
			await tx.insert(statementLine).values(values.slice(i, i + 500));
		}
	});

	return { importId, lineCount: lines.length, matchedCount, errors };
}

/**
 * Accept a proposed match. This is the only place `cleared_at` is set, and it
 * is always a person's decision — matching itself never reaches this state.
 */
export async function confirmMatch(
	db: Db,
	deps: Deps,
	scope: Scope,
	lineId: string
): Promise<void> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');
	if (!line.matchedPurchaseId) throw new ReconcileError('That line has nothing to confirm.');

	// Two statements covering overlapping periods can both propose this purchase.
	// Only one may claim it: `cleared_at` is a single mark, and letting a second
	// line confirm it would mean undoing either one silently un-cleared a
	// purchase the other still shows as cleared.
	const other = await confirmedLineFor(db, scope.workspaceId, line.matchedPurchaseId, lineId);
	if (other) {
		throw new ReconcileError('That purchase is already reconciled against another statement.');
	}

	const now = deps.clock.now();
	const accountId = await importAccountId(db, line.importId);
	await db.transaction(async (tx) => {
		await tx
			.update(statementLine)
			.set({ matchState: 'confirmed' })
			.where(eq(statementLine.id, lineId));
		await tx
			.update(purchase)
			// Confirming is the moment we learn which card this was paid on: it
			// appeared on that card's statement and a person agreed. Recorded here so
			// the ledger gains card attribution as a by-product of reconciling,
			// rather than asking anyone to tag purchases by hand.
			.set({ clearedAt: now, updatedAt: now, ...(accountId ? { accountId } : {}) })
			.where(
				and(eq(purchase.id, line.matchedPurchaseId!), eq(purchase.workspaceId, scope.workspaceId))
			);
	});
	await refreshMatchedCount(db, line.importId);
}

/** The card an import belongs to, or null when it was imported without one. */
async function importAccountId(db: Db, importId: string): Promise<string | null> {
	const [row] = await db
		.select({ accountId: statementImport.accountId })
		.from(statementImport)
		.where(eq(statementImport.id, importId))
		.limit(1);
	return row?.accountId ?? null;
}

/**
 * Undo a match — whether proposed or confirmed. Clears the mark on the purchase
 * so it becomes available to match again; nothing about the purchase itself
 * changes, which is what makes this safe to do freely.
 */
export async function unlinkMatch(db: Db, deps: Deps, scope: Scope, lineId: string): Promise<void> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');

	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		await tx
			.update(statementLine)
			.set({ matchState: 'unmatched', matchedPurchaseId: null, matchReason: null })
			.where(eq(statementLine.id, lineId));
		if (line.matchedPurchaseId) {
			await tx
				.update(purchase)
				.set({ clearedAt: null, updatedAt: now })
				.where(
					and(eq(purchase.id, line.matchedPurchaseId), eq(purchase.workspaceId, scope.workspaceId))
				);
		}
	});
	await refreshMatchedCount(db, line.importId);
	// Undoing a decision is a question again; a closed statement reopens.
	await reopenIfClosed(db, line.importId);
}

/**
 * Attach a line to a purchase the person picked themselves — the answer to an
 * ambiguous line, and the escape hatch whenever the matcher was simply wrong.
 * Confirmed immediately: a human chose it, which is a stronger signal than
 * anything the matcher produces.
 */
export async function linkManually(
	db: Db,
	deps: Deps,
	scope: Scope,
	lineId: string,
	purchaseId: string
): Promise<void> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');

	const now = deps.clock.now();
	const accountId = await importAccountId(db, line.importId);

	// Re-read the purchase through the seal filter rather than trusting the id
	// from the form: a posted id must never become a way to mark, and thereby
	// confirm the existence of, a purchase concealed from the person posting it.
	const candidates = await matchCandidates(
		db,
		{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
		new Date(line.postedAt.getTime() - 366 * DAY_MS),
		new Date(line.postedAt.getTime() + 366 * DAY_MS),
		now
	);
	if (!candidates.some((c) => c.id === purchaseId)) {
		throw new ReconcileError('That purchase is not available to match.');
	}

	// Same single-claim rule as confirmMatch. `matchCandidates` already excludes
	// purchases carrying `cleared_at`, so this catches the narrower race where
	// another line confirmed between that read and this write.
	const other = await confirmedLineFor(db, scope.workspaceId, purchaseId, lineId);
	if (other) {
		throw new ReconcileError('That purchase is already reconciled against another statement.');
	}

	await db.transaction(async (tx) => {
		// Release whatever this line held before, so re-pointing a line doesn't
		// leave the old purchase marked as cleared by a line that no longer says so.
		if (line.matchedPurchaseId && line.matchedPurchaseId !== purchaseId) {
			await tx
				.update(purchase)
				.set({ clearedAt: null, updatedAt: now })
				.where(eq(purchase.id, line.matchedPurchaseId));
		}
		await tx
			.update(statementLine)
			.set({
				matchState: 'confirmed',
				matchedPurchaseId: purchaseId,
				matchReason: 'linked by hand'
			})
			.where(eq(statementLine.id, lineId));
		await tx
			.update(purchase)
			// Same card attribution as confirmMatch — a hand-picked link is if
			// anything a stronger statement about which card this was on.
			.set({ clearedAt: now, updatedAt: now, ...(accountId ? { accountId } : {}) })
			.where(eq(purchase.id, purchaseId));
	});
	await refreshMatchedCount(db, line.importId);
}

/**
 * Set a line aside: a bank fee, a transfer, anything that was never a purchase
 * in this ledger. Ignoring is a real answer to "what is this line?", and
 * without it a statement can never reach the end of its review.
 */
export async function ignoreLine(db: Db, deps: Deps, scope: Scope, lineId: string): Promise<void> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');

	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		if (line.matchedPurchaseId) {
			await tx
				.update(purchase)
				.set({ clearedAt: null, updatedAt: now })
				.where(eq(purchase.id, line.matchedPurchaseId));
		}
		await tx
			.update(statementLine)
			.set({ matchState: 'ignored', matchedPurchaseId: null, matchReason: null })
			.where(eq(statementLine.id, lineId));
	});
	await refreshMatchedCount(db, line.importId);
}

/** Put an ignored line back into review. */
export async function unignoreLine(
	db: Db,
	_deps: Deps,
	scope: Scope,
	lineId: string
): Promise<void> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');
	await db
		.update(statementLine)
		.set({ matchState: 'unmatched' })
		.where(eq(statementLine.id, lineId));
	await refreshMatchedCount(db, line.importId);
	// A line back in review means the statement has questions again.
	await reopenIfClosed(db, line.importId);
}

/**
 * Turn an unmatched line into a purchase, through the same door every
 * hand-logged purchase goes through.
 *
 * The line is the *evidence*, never the authority: the person pressing the
 * button is. When the actor's approval policy lets a log stand on its own,
 * the purchase completes and the line confirms with it (cleared_at lands, the
 * import's card is attributed). When the policy wants a decision first, the
 * purchase waits and so does the line — matched to what it created, cleared
 * only when someone approves and confirms, exactly like any other proposal.
 *
 * Refuses a model-read import, per the guard that column was carried for.
 */
export async function createPurchaseFromLine(
	db: Db,
	deps: Deps & { notifier: Notifier },
	scope: Scope,
	lineId: string,
	input: { itemName?: string | null; categoryId?: string | null } = {}
): Promise<{ purchaseId: string; state: 'completed' | 'pending_approval' }> {
	const line = await getLine(db, scope.workspaceId, lineId);
	if (!line) throw new ReconcileError('That statement line no longer exists.');

	const imp = await getImport(db, scope.workspaceId, line.importId);
	if (!imp) throw new ReconcileError('That import no longer exists.');
	if (imp.modelRead) {
		throw new ReconcileError(
			'This statement was read from a picture, so its lines can be matched but not turned into purchases. Log the purchase by hand and link it instead.'
		);
	}
	// A matched line already has a purchase proposed; a private one is already
	// accounted for by something concealed; ignored was answered "not a
	// purchase". Only a line still waiting for its answer can become one.
	if (line.matchState !== 'unmatched') {
		throw new ReconcileError('Only an unanswered line can become a purchase.');
	}
	if (line.amountMinor >= 0n) {
		throw new ReconcileError('That line is money in, not a purchase.');
	}

	const name = (input.itemName ?? line.rawDescription).trim();
	if (!name) throw new ReconcileError('Give the purchase a name first.');

	// submitPurchase owns its transaction; the line update below is a second
	// one. Splitting beats duplicating the whole purchase pipeline here, and
	// the seam is safe: a crash between the two leaves a purchase with no line
	// pointing at it, which the review screen shows as an unanswered line with
	// a new candidate to link — recoverable by hand, never a wrong number.
	const { purchaseId } = await submitPurchase(db, deps, scope, {
		itemName: name,
		amount: Money.of(-line.amountMinor, line.currency),
		categoryId: input.categoryId ?? null,
		note: null,
		intent: 'log',
		spentAt: line.postedAt,
		accountId: imp.accountId
	});

	const [created] = await db
		.select({ state: purchase.state })
		.from(purchase)
		.where(eq(purchase.id, purchaseId))
		.limit(1);
	const now = deps.clock.now();

	if (created?.state === 'completed') {
		await db.transaction(async (tx) => {
			await tx
				.update(statementLine)
				.set({
					matchState: 'confirmed',
					matchedPurchaseId: purchaseId,
					matchReason: 'created from statement'
				})
				.where(eq(statementLine.id, lineId));
			await tx
				.update(purchase)
				// The line IS the statement evidence, so the mark lands now — with
				// the card attribution it arrived on, via submitPurchase's accountId.
				.set({ clearedAt: now, updatedAt: now })
				.where(eq(purchase.id, purchaseId));
		});
	} else {
		await db
			.update(statementLine)
			.set({
				matchState: 'matched',
				matchedPurchaseId: purchaseId,
				matchReason: 'created from statement; awaiting approval'
			})
			.where(eq(statementLine.id, lineId));
	}
	await refreshMatchedCount(db, line.importId);

	return { purchaseId, state: created?.state === 'completed' ? 'completed' : 'pending_approval' };
}

/**
 * Close a statement: every line answered (confirmed, private, or ignored).
 * Closing is bookkeeping, not a lock — reopening is one tap, and anything that
 * puts a line back in review reopens the import on its own.
 */
export async function closeImport(
	db: Db,
	_deps: Deps,
	scope: Scope,
	importId: string
): Promise<void> {
	const imp = await getImport(db, scope.workspaceId, importId);
	if (!imp) throw new ReconcileError('That import no longer exists.');

	const unsettled = await countUnsettled(db, importId);
	if (unsettled > 0) {
		throw new ReconcileError(
			`${unsettled} line${unsettled === 1 ? ' still needs' : 's still need'} an answer before this statement can be closed.`
		);
	}
	await db
		.update(statementImport)
		.set({ status: 'reconciled' })
		.where(eq(statementImport.id, importId));
}

/** Reopen a closed statement. */
export async function reopenImport(
	db: Db,
	_deps: Deps,
	scope: Scope,
	importId: string
): Promise<void> {
	const imp = await getImport(db, scope.workspaceId, importId);
	if (!imp) throw new ReconcileError('That import no longer exists.');
	await db
		.update(statementImport)
		.set({ status: 'reviewing' })
		.where(eq(statementImport.id, importId));
}

/** A closed statement must not silently contain lines back in review. */
async function reopenIfClosed(db: Db, importId: string): Promise<void> {
	await db
		.update(statementImport)
		.set({ status: 'reviewing' })
		.where(and(eq(statementImport.id, importId), eq(statementImport.status, 'reconciled')));
}

/**
 * Delete an import and its lines, releasing every purchase it had marked.
 * Reconciliation should be undoable in one act — otherwise a bad column mapping
 * leaves a mess someone has to unpick line by line.
 */
export async function deleteImport(
	db: Db,
	deps: Deps,
	scope: Scope,
	importId: string
): Promise<void> {
	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		const lines = await tx
			.select({ purchaseId: statementLine.matchedPurchaseId })
			.from(statementLine)
			.where(
				and(eq(statementLine.importId, importId), eq(statementLine.workspaceId, scope.workspaceId))
			);
		const ids = lines.map((l) => l.purchaseId).filter((id): id is string => !!id);
		for (const id of ids) {
			await tx
				.update(purchase)
				.set({ clearedAt: null, updatedAt: now })
				.where(and(eq(purchase.id, id), eq(purchase.workspaceId, scope.workspaceId)));
		}
		await tx.delete(statementLine).where(eq(statementLine.importId, importId));
		await tx
			.delete(statementImport)
			.where(
				and(eq(statementImport.id, importId), eq(statementImport.workspaceId, scope.workspaceId))
			);
	});
}
