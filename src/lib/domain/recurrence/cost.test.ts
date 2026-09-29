import { describe, expect, it } from 'vitest';
import { costByCategory, type CostedRule } from './cost';

const MONTHLY = 'DTSTART=2026-01-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1';
const YEARLY = 'DTSTART=2026-03-10;FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=10';
const TWICE_WEEKLY = 'DTSTART=2026-01-05;FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH';

const rule = (
	categoryId: string | null,
	amountMinor: bigint,
	rrule = MONTHLY,
	status: CostedRule['status'] = 'active'
): CostedRule => ({
	categoryId,
	amountMinor,
	rrule,
	status
});

describe('costByCategory', () => {
	it('puts every cadence on a monthly and a yearly scale', () => {
		const { categories } = costByCategory([
			rule('subs', 1500n), // $15/mo
			rule('subs', 12000n, YEARLY), // $120/yr = $10/mo
			rule('fitness', 1000n, TWICE_WEEKLY) // $10 twice a week
		]);
		const subs = categories.find((c) => c.categoryId === 'subs')!;
		expect(subs).toMatchObject({ count: 2, monthlyMinor: 2500n, yearlyMinor: 30000n });
		const fitness = categories.find((c) => c.categoryId === 'fitness')!;
		// 2 × 365.25 / 7 × $10 = $1,043.57 a year.
		expect(fitness.yearlyMinor).toBe(104357n);
	});

	it('builds the total from its parts, so the parts always add up to it', () => {
		// Three thirds of a cent that would each round down on their own.
		const { total, categories } = costByCategory([
			rule('a', 1001n, TWICE_WEEKLY),
			rule('b', 1001n, TWICE_WEEKLY),
			rule('c', 1001n, TWICE_WEEKLY)
		]);
		expect(total.monthlyMinor).toBe(categories.reduce((s, c) => s + c.monthlyMinor, 0n));
		expect(total.yearlyMinor).toBe(categories.reduce((s, c) => s + c.yearlyMinor, 0n));
		expect(total.count).toBe(3);
	});

	it('counts only what is running, and skips what it cannot read', () => {
		const { total } = costByCategory([
			rule('a', 1000n),
			rule('a', 5000n, MONTHLY, 'paused'),
			rule('a', 5000n, MONTHLY, 'ended'),
			rule('a', 5000n, 'FREQ=MONTHLY') // no DTSTART: unparseable
		]);
		expect(total).toEqual({ count: 1, monthlyMinor: 1000n, yearlyMinor: 12000n });
	});

	it('ranks largest first, and keeps the uncategorized remainder last', () => {
		const { categories } = costByCategory([
			rule(null, 90000n),
			rule('small', 500n),
			rule('big', 200000n)
		]);
		expect(categories.map((c) => c.categoryId)).toEqual(['big', 'small', null]);
	});
});
