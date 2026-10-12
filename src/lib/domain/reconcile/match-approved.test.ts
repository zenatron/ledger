import { describe, it, expect } from 'vitest';
import { matchApproved, type ApprovedCandidate } from './match-approved';
import type { RawStatementLine } from './parse-csv';

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

function line(amountMinor: bigint, desc: string, d = 10): RawStatementLine {
	return {
		postedAt: day(d),
		amountMinor,
		currency: 'USD',
		rawDescription: desc,
		normalizedDescription: desc.toLowerCase()
	};
}

function cand(id: string, amount: bigint, item: string, merchant: string | null = null, d = 8) {
	return {
		id,
		approvedAmountMinor: amount,
		approvedAt: day(d),
		itemName: item,
		merchantName: merchant
	} satisfies ApprovedCandidate;
}

describe('matchApproved', () => {
	it('pairs a charge with the approved request it names', () => {
		const out = matchApproved(
			[line(-5249n, 'TARGET 00012345')],
			[cand('p1', 5000n, 'Bath towels', 'Target')]
		);
		expect(out.get(0)).toEqual({ purchaseId: 'p1', reason: 'paid for an approved request' });
	});

	it('needs the description to corroborate', () => {
		const out = matchApproved([line(-5000n, 'SQ *SOMEWHERE')], [cand('p1', 5000n, 'Bath towels')]);
		expect(out.size).toBe(0);
	});

	it('ignores credits', () => {
		expect(matchApproved([line(5000n, 'TARGET')], [cand('p1', 5000n, 'x', 'Target')]).size).toBe(0);
	});

	it('bounds the overage', () => {
		const c = [cand('p1', 4000n, 'x', 'Target')];
		expect(matchApproved([line(-5000n, 'TARGET')], c).size).toBe(1); // +25%
		expect(matchApproved([line(-5001n, 'TARGET')], c).size).toBe(0);
	});

	it('bounds the dates around approval', () => {
		const c = [cand('p1', 5000n, 'x', 'Target', 10)];
		expect(matchApproved([line(-5000n, 'TARGET', 7)], c).size).toBe(1);
		expect(matchApproved([line(-5000n, 'TARGET', 6)], c).size).toBe(0);
	});

	it('leaves a line with two plausible requests alone', () => {
		const out = matchApproved(
			[line(-5000n, 'TARGET')],
			[cand('p1', 5000n, 'Towels', 'Target'), cand('p2', 5500n, 'Lamp', 'Target')]
		);
		expect(out.size).toBe(0);
	});

	it('leaves a request two lines could pay for alone', () => {
		const out = matchApproved(
			[line(-5000n, 'TARGET', 10), line(-4900n, 'TARGET', 11)],
			[cand('p1', 5000n, 'Towels', 'Target')]
		);
		expect(out.size).toBe(0);
	});

	it('respects a card already pinned elsewhere', () => {
		const c = [{ ...cand('p1', 5000n, 'x', 'Target'), accountId: 'other' }];
		expect(matchApproved([line(-5000n, 'TARGET')], c, { accountId: 'mine' }).size).toBe(0);
	});
});
