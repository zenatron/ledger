/**
 * Deterministic matching of bank-statement lines to recorded purchases.
 *
 * Pure TS, no I/O — the same discipline as the rest of `src/lib/domain`. It is
 * given already-parsed lines (see `parse-csv.ts`) and an already seal-filtered
 * candidate set, and returns a *proposal* per line. It never mutates anything.
 *
 * Two rules govern the whole module:
 *
 * 1. **A match is a proposal, never a conclusion.** Nothing here produces the
 *    `confirmed` state; the strongest verdict it can reach is `matched`, which
 *    the review screen shows as a suggestion for a person to accept. This is the
 *    same stance as the category assist on the new-purchase screen: suggest,
 *    never apply. Reconciliation touches what the ledger claims is true about
 *    money, so a heuristic must not be the last word.
 *
 * 2. **Ambiguity is reported, not resolved.** Two identical £4.20 coffees on the
 *    same day are genuinely indistinguishable from one bank line. Guessing one
 *    would be right half the time and silently wrong the other half, so an
 *    ambiguous line stays `unmatched` and carries its candidates for the person
 *    to pick from.
 */

import type { RawStatementLine } from './parse-csv';

/** A recorded purchase a statement line might correspond to. */
export interface MatchCandidate {
	id: string;
	/** Signed minor units as recorded. Compared on magnitude — see `sameAmount`. */
	amountMinor: bigint;
	/** When the money actually moved. Candidates without one can't be dated. */
	completedAt: Date;
	itemName: string;
	merchantName: string | null;
	/**
	 * The card this purchase is known to have been paid on, or null for the
	 * great majority that have never been told. See `eligibleFor`.
	 */
	accountId?: string | null;
	/**
	 * Asked for but not yet marked bought (approved, pending, held). Never
	 * auto-matched — only offered — and `completedAt` holds when it was asked.
	 */
	open?: boolean;
}

export type MatchState = 'unmatched' | 'matched';

export interface MatchProposal {
	/** Index into the `lines` array this proposal is for. */
	lineIndex: number;
	state: MatchState;
	/** Set only when `state === 'matched'`. */
	purchaseId: string | null;
	/** Short human phrase for why, shown verbatim on the review row. */
	reason: string | null;
	/**
	 * Ranked alternatives for an ambiguous or unmatched line, best first. Empty
	 * when there was nothing in range at all. The review screen turns these into
	 * a one-tap "did you mean" list.
	 */
	suggestions: { purchaseId: string; reason: string }[];
}

export interface MatchOptions {
	/**
	 * The card this statement belongs to, when it is known.
	 *
	 * Undefined or null keeps the original behaviour — every purchase in the
	 * window is in the running — which is what a household with one card wants
	 * and what every import made before accounts existed did.
	 *
	 * Set it and the rule is deliberately lopsided: a purchase already known to
	 * be on a *different* card is excluded, but a purchase with no card recorded
	 * stays eligible. Almost every purchase starts with no card, so excluding
	 * those would reconcile nothing at all. What this buys is that once you have
	 * reconciled a purchase onto one card, another card's statement can no longer
	 * claim it — which is exactly the failure mode of importing three cards over
	 * the same month.
	 */
	accountId?: string | null;
	/**
	 * How far a bank line may sit from the purchase date and still be the same
	 * event. Three days by default: card transactions commonly post one to three
	 * days after they're made, and weekends stretch that.
	 */
	toleranceDays?: number;
	/** How long after an ask its charge may still arrive. Default 45 days. */
	openWindowDays?: number;
}

const DAY_MS = 86_400_000;

/**
 * Bank lines are signed by direction (a debit is negative on most exports, and
 * `invertAmount` in the parser flips the ones where it isn't), while a purchase
 * records magnitude. Comparing absolute values sidesteps a whole class of
 * sign-convention bugs; direction is already handled by the caller filtering to
 * spending lines.
 */
function sameAmount(a: bigint, b: bigint): boolean {
	const abs = (n: bigint) => (n < 0n ? -n : n);
	return abs(a) === abs(b);
}

/**
 * Close enough to offer, never to claim: tax, tip, shipping and FX move a
 * charge off the logged figure. 10% (at least one unit) for an open request on
 * amount alone, 25% when the description also names the merchant.
 */
function nearAmount(line: bigint, purchase: bigint, described: boolean): boolean {
	const abs = (n: bigint) => (n < 0n ? -n : n);
	const a = abs(line);
	const b = abs(purchase);
	const diff = a > b ? a - b : b - a;
	const pct = described ? 25n : 10n;
	const allowed = (b * pct) / 100n > 100n ? (b * pct) / 100n : 100n;
	return diff <= allowed;
}

function daysApart(a: Date, b: Date): number {
	return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

/**
 * Tokens from a purchase worth looking for in a bank description. Short tokens
 * are dropped: "of", "co" and the like match nearly every descriptor a bank
 * emits, so they'd manufacture confidence rather than add it.
 */
function tokensOf(c: MatchCandidate): string[] {
	return [c.merchantName ?? '', c.itemName]
		.join(' ')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 4);
}

/**
 * Does the bank's description corroborate this candidate? Bank descriptors are
 * mangled ("SQ *BLUE BOTTLE 8837", "AMZN Mktp GB*2H41K") but they almost always
 * still contain the merchant's name somewhere, so substring containment on a
 * normalised description is both cheap and surprisingly reliable.
 */
function describes(line: RawStatementLine, c: MatchCandidate): boolean {
	const hay = line.normalizedDescription;
	return tokensOf(c).some((t) => hay.includes(t));
}

interface Scored {
	candidate: MatchCandidate;
	/**
	 * Higher is better. 2 = amount, date and description; 1 = amount and date;
	 * 0 = only worth offering (a close amount, or a purchase not yet bought).
	 * Nothing scoring 0 is ever auto-matched.
	 */
	score: number;
	distance: number;
	reason: string;
}

function reasonFor(score: number, c: MatchCandidate, exact: boolean): string {
	if (c.open) return exact ? 'asked for, not yet marked bought' : 'asked for, close amount';
	if (score === 2) return 'amount, date and description';
	if (score === 1) return 'amount and date';
	return 'close amount';
}

/**
 * Propose a match for every line.
 *
 * Assignment is greedy over a globally sorted list of (line, candidate) pairs:
 * strongest evidence first, then closest in time, then a stable tiebreak on
 * index. A purchase can be claimed by at most one line and a line takes at most
 * one purchase, so importing a statement twice, or importing one that overlaps
 * another, can never double-count a purchase as reconciled.
 *
 * The global sort matters. Assigning line-by-line lets an early, weakly-evidenced
 * line take a purchase that a later line matches exactly — order of rows in the
 * CSV would then change the outcome, which for a reconciliation tool is not
 * acceptable. Sorting all pairs first makes the result depend only on the
 * evidence.
 */
export function matchLines(
	lines: RawStatementLine[],
	candidates: MatchCandidate[],
	options: MatchOptions = {}
): MatchProposal[] {
	const tolerance = options.toleranceDays ?? 3;
	const openWindow = options.openWindowDays ?? 45;
	const statementAccount = options.accountId ?? null;

	/**
	 * A purchase pinned to a different card cannot be this line. A purchase with
	 * no card recorded still can — see the note on `MatchOptions.accountId`.
	 */
	const eligibleFor = (c: MatchCandidate): boolean =>
		!statementAccount || !c.accountId || c.accountId === statementAccount;

	// Per line, everything within amount+date range, scored.
	const scored: Scored[][] = lines.map((line) => {
		const out: Scored[] = [];
		for (const c of candidates) {
			if (!eligibleFor(c)) continue;
			const described = describes(line, c);
			const exact = sameAmount(line.amountMinor, c.amountMinor);
			if (!exact) {
				// A close amount alone is everywhere in a busy month — real data
				// offered a coin-flip shortlist on nearly every line. Only offer one
				// when something else vouches for it: the bank names the merchant,
				// or it's a request still waiting to be marked bought.
				if (!c.open && !described) continue;
				if (!nearAmount(line.amountMinor, c.amountMinor, described)) continue;
			}
			const distance = daysApart(line.postedAt, c.completedAt);
			if (c.open) {
				// The charge comes after the ask: a little before (clock skew, a
				// card pre-auth), up to the open window after.
				const after = (line.postedAt.getTime() - c.completedAt.getTime()) / DAY_MS;
				if (after < -tolerance || after > openWindow) continue;
			} else if (distance > tolerance) continue;
			const score = c.open || !exact ? 0 : described ? 2 : 1;
			out.push({ candidate: c, score, distance, reason: reasonFor(score, c, exact) });
		}
		// Best first: strongest evidence, then nearest in time, then name for a
		// stable order when two candidates are otherwise identical.
		out.sort(
			(a, b) =>
				b.score - a.score || a.distance - b.distance || a.candidate.id.localeCompare(b.candidate.id)
		);
		return out;
	});

	const proposals: MatchProposal[] = lines.map((_, lineIndex) => ({
		lineIndex,
		state: 'unmatched',
		purchaseId: null,
		reason: null,
		suggestions: []
	}));

	/*
	 * A line is only auto-matched when its best candidate is unambiguously best.
	 * "Unambiguous" means either it's the only one in range, or it is the only
	 * one carrying description evidence. Two candidates that agree on amount and
	 * date and say nothing else are a coin flip, and this module does not flip
	 * coins — those fall through to `suggestions` for a person to decide.
	 */
	const eligible: { lineIndex: number; best: Scored }[] = [];
	for (let i = 0; i < lines.length; i++) {
		// Only exact, settled candidates can be claimed; a close or open one is
		// offered alongside but never makes the call — nor blocks it.
		const s = scored[i].filter((x) => x.score > 0);
		if (s.length === 0) continue;
		const best = s[0];
		const runnerUp = s[1];
		const decisive = !runnerUp || (best.score === 2 && runnerUp.score < 2);
		if (decisive) eligible.push({ lineIndex: i, best });
	}

	// Strongest evidence wins the contested purchase, whatever order the rows
	// arrived in.
	eligible.sort(
		(a, b) =>
			b.best.score - a.best.score || a.best.distance - b.best.distance || a.lineIndex - b.lineIndex
	);

	const claimed = new Set<string>();
	for (const { lineIndex, best } of eligible) {
		if (claimed.has(best.candidate.id)) continue;
		claimed.add(best.candidate.id);
		proposals[lineIndex] = {
			lineIndex,
			state: 'matched',
			purchaseId: best.candidate.id,
			reason: best.reason,
			suggestions: []
		};
	}

	// Whatever is still unmatched — ambiguous, or beaten to its purchase — keeps
	// its ranked candidates, minus any already spoken for.
	for (let i = 0; i < lines.length; i++) {
		if (proposals[i].state === 'matched') continue;
		proposals[i].suggestions = scored[i]
			.filter((s) => !claimed.has(s.candidate.id))
			.slice(0, 5)
			.map((s) => ({ purchaseId: s.candidate.id, reason: s.reason }));
	}

	return proposals;
}
