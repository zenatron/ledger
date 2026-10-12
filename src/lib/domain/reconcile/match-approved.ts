/**
 * Which approved-but-unfinished purchase is this bank line the payment for?
 *
 * An approved request is money somebody is about to spend. When the charge
 * lands on a synced account, that charge *is* the "I bought it, here's what it
 * cost" the requester would otherwise come back and type. This finds the cases
 * where the answer is plain enough to act on without asking.
 *
 * Stricter than `matchLines`, because acting is a bigger step than proposing:
 *
 * - **The description must corroborate.** Amount alone is not evidence here —
 *   the final price is allowed to differ from the approved one (tax, a tip, a
 *   different size), so the amount is a range, and a range plus a date is a
 *   coin flip. The bank descriptor has to name the merchant or the item.
 * - **Exactly one candidate, and exactly one line.** A line with two plausible
 *   purchases, or a purchase two lines could be, is left for a person.
 * - **The amount is bounded.** Up to `maxOveragePct` above what was approved.
 *   Anything over the workspace's re-approval threshold still goes back to the
 *   approver — completing goes through the same domain transition a person's
 *   tap does — this bound only limits what is plausibly the same purchase.
 *
 * Pure, like the rest of `domain/reconcile`.
 */

import { describes } from './match';
import type { RawStatementLine } from './parse-csv';

export interface ApprovedCandidate {
	id: string;
	/** Positive minor units — what the approver said yes to. */
	approvedAmountMinor: bigint;
	/** When it was approved: a purchase cannot be paid long before that. */
	approvedAt: Date;
	itemName: string;
	merchantName: string | null;
	accountId?: string | null;
}

export interface ApprovedMatchOptions {
	accountId?: string | null;
	/** How far above the approved amount the charge may be. Default 25. */
	maxOveragePct?: number;
	/** Days after approval a charge may still land. Default 60. */
	windowDays?: number;
	/** Days *before* approval a charge may post — approval after paying happens. Default 3. */
	leadDays?: number;
}

const DAY_MS = 86_400_000;

/** Line index → the purchase it pays for. Lines with no plain answer are absent. */
export function matchApproved(
	lines: RawStatementLine[],
	candidates: ApprovedCandidate[],
	options: ApprovedMatchOptions = {}
): Map<number, { purchaseId: string; reason: string }> {
	const maxOver = BigInt(options.maxOveragePct ?? 25);
	const windowMs = (options.windowDays ?? 60) * DAY_MS;
	const leadMs = (options.leadDays ?? 3) * DAY_MS;
	const statementAccount = options.accountId ?? null;

	const byLine = new Map<number, ApprovedCandidate>();
	const linesFor = new Map<string, number[]>();

	lines.forEach((line, i) => {
		// Money out only: a credit is never the payment for something.
		if (line.amountMinor >= 0n) return;
		const paid = -line.amountMinor;
		const hits = candidates.filter((c) => {
			if (statementAccount && c.accountId && c.accountId !== statementAccount) return false;
			if (paid * 100n > c.approvedAmountMinor * (100n + maxOver)) return false;
			const t = line.postedAt.getTime() - c.approvedAt.getTime();
			if (t < -leadMs || t > windowMs) return false;
			return describes(line, c);
		});
		if (hits.length !== 1) return;
		byLine.set(i, hits[0]);
		const claimed = linesFor.get(hits[0].id) ?? [];
		claimed.push(i);
		linesFor.set(hits[0].id, claimed);
	});

	const out = new Map<number, { purchaseId: string; reason: string }>();
	for (const [i, c] of byLine) {
		if ((linesFor.get(c.id) ?? []).length !== 1) continue;
		out.set(i, { purchaseId: c.id, reason: 'paid for an approved request' });
	}
	return out;
}
