import { describe, it, expect } from 'vitest';
import { settleUp } from './settlement';

const m = (id: string, income: bigint, paid: bigint) => ({
	memberId: id,
	name: id.toUpperCase(),
	incomeMinor: income,
	paidMinor: paid
});

describe('settleUp', () => {
	it('splits shared spending evenly and names the transfer that evens it out', () => {
		// $300 spent, all on one card: the other member owes their half back.
		const s = settleUp([m('alex', 500_00n, 300_00n), m('sam', 400_00n, 0n)], 'equal');
		expect(s.totalSpentMinor).toBe(300_00n);
		expect(s.shares.map((x) => x.fairShareMinor)).toEqual([150_00n, 150_00n]);
		expect(s.shares.find((x) => x.memberId === 'alex')?.owedMinor).toBe(-150_00n);
		expect(s.shares.find((x) => x.memberId === 'sam')?.owedMinor).toBe(150_00n);
		expect(s.transfers).toEqual([
			{ fromId: 'sam', fromName: 'SAM', toId: 'alex', toName: 'ALEX', amountMinor: 150_00n }
		]);
	});

	it('splits uneven totals exactly — no cent lost or invented', () => {
		// $100 across three people: 33.33, 33.33, 33.34.
		const s = settleUp([m('a', 0n, 100_00n), m('b', 0n, 0n), m('c', 0n, 0n)], 'equal');
		const fair = s.shares.map((x) => x.fairShareMinor).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
		expect(fair).toEqual([3333n, 3333n, 3334n]);
		// Shares sum exactly to the total, and owed sums exactly to zero — the
		// transfers can clear everyone without remainder.
		expect(s.shares.reduce((a, x) => a + x.fairShareMinor, 0n)).toBe(100_00n);
		expect(s.shares.reduce((a, x) => a + x.owedMinor, 0n)).toBe(0n);
	});

	it('splits a refund-heavy (negative) period so shares and transfers still balance', () => {
		// −$101 in refunds, all landed on one card. Truncating toward zero
		// would leave the shares summing above the total and transfers that
		// clear nobody; flooring keeps the invariant.
		const s = settleUp([m('a', 0n, -101n), m('b', 0n, 0n), m('c', 0n, 0n)], 'equal');
		expect(s.totalSpentMinor).toBe(-101n);
		expect(s.shares.reduce((a, x) => a + x.fairShareMinor, 0n)).toBe(-101n);
		expect(s.shares.reduce((a, x) => a + x.owedMinor, 0n)).toBe(0n);
		// Everyone else received a slice of the refund, so a collects it for
		// the household and pays each of them their share back.
		expect(s.transfers).toEqual([
			{ fromId: 'a', fromName: 'A', toId: 'b', toName: 'B', amountMinor: 34n },
			{ fromId: 'a', fromName: 'A', toId: 'c', toName: 'C', amountMinor: 34n }
		]);
	});

	it('ignores a negative income when income-weighting instead of wrecking the weights', () => {
		// A negative income must not drag the weight total to zero (RangeError)
		// or flip the split; it is simply not a weight.
		const s = settleUp([m('a', 500_00n, 100_00n), m('b', -900_00n, 0n)], 'income');
		expect(s.basis).toBe('income');
		expect(s.shares.reduce((a, x) => a + x.fairShareMinor, 0n)).toBe(100_00n);
		expect(s.shares.find((x) => x.memberId === 'b')?.fairShareMinor).toBe(0n);
	});

	it('weights shares by income when asked, and the bigger earner carries more', () => {
		// $300 spent, incomes $4500 and $1500: shares 225 / 75.
		const s = settleUp([m('alex', 450_00n, 0n), m('sam', 150_00n, 300_00n)], 'income');
		expect(s.basis).toBe('income');
		expect(s.shares.map((x) => x.fairShareMinor)).toEqual([225_00n, 75_00n]);
		// Sam overpaid their share; Alex owes the difference.
		expect(s.transfers[0]).toMatchObject({ fromId: 'alex', toId: 'sam', amountMinor: 225_00n });
	});

	it('gives a member with no income no share under income weighting — carried, not forgiven', () => {
		const s = settleUp([m('earner', 100_00n, 0n), m('kid', 0n, 200_00n)], 'income');
		expect(s.shares.find((x) => x.memberId === 'earner')?.fairShareMinor).toBe(200_00n);
		expect(s.shares.find((x) => x.memberId === 'kid')?.fairShareMinor).toBe(0n);
		// The kid fronted everything the earner owes them back for.
		expect(s.transfers[0]).toMatchObject({ fromId: 'earner', toId: 'kid', amountMinor: 200_00n });
	});

	it('falls back to an even split when nobody recorded income', () => {
		const s = settleUp([m('a', 0n, 60_00n), m('b', 0n, 40_00n)], 'income');
		expect(s.basis).toBe('equal');
		expect(s.shares.every((x) => x.fairShareMinor === 50_00n)).toBe(true);
	});

	it('settles a multi-sided imbalance with the fewest-style pairings, largest first', () => {
		// $200 spent, even shares of $50: A and B paid nothing, X paid $180,
		// Y paid $20. Debtors A(50), B(50), Y(30); X is owed the whole $130.
		const s = settleUp(
			[m('a', 0n, 0n), m('b', 0n, 0n), m('x', 0n, 180_00n), m('y', 0n, 20_00n)],
			'equal'
		);
		expect(s.transfers).toEqual([
			{ fromId: 'a', fromName: 'A', toId: 'x', toName: 'X', amountMinor: 50_00n },
			{ fromId: 'b', fromName: 'B', toId: 'x', toName: 'X', amountMinor: 50_00n },
			{ fromId: 'y', fromName: 'Y', toId: 'x', toName: 'X', amountMinor: 30_00n }
		]);
		// Every transfer clears in aggregate: outflow equals X's credit.
		const outflow = s.transfers.reduce((a, t) => a + t.amountMinor, 0n);
		expect(outflow).toBe(130_00n);
	});

	it('says nothing to transfer when everyone is already even', () => {
		const s = settleUp([m('a', 0n, 50_00n), m('b', 0n, 50_00n)], 'equal');
		expect(s.transfers).toEqual([]);
		expect(s.shares.every((x) => x.owedMinor === 0n)).toBe(true);
	});

	it('handles a single member and an empty household without inventing debts', () => {
		expect(settleUp([m('solo', 0n, 80_00n)], 'equal').transfers).toEqual([]);
		expect(settleUp([], 'equal').shares).toEqual([]);
	});
});
