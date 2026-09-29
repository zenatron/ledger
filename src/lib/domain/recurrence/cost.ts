import { parseRRule, type Recurrence } from './rrule';

/**
 * What standing charges cost, on a common scale.
 *
 * A household's recurring spending arrives on every cadence at once — rent
 * monthly, a gym weekly, a domain yearly — and none of those numbers can sit
 * next to another until they are put on the same clock. Everything here is
 * normalized to a year first (the one period every cadence divides into), then
 * shown per month.
 *
 * Display figures, not invoices: the average year is 365.25 days, so a weekly
 * charge's "per month" is what it averages to, not what any one month bills.
 */

/**
 * A rule's yearly cost in minor units. Weekly rules fire once per listed
 * weekday, so a Mon+Thu rule counts twice a week.
 */
export function annualMinor(amountMinor: bigint, rec: Recurrence): number {
	const a = Number(amountMinor);
	const iv = rec.interval || 1;
	switch (rec.freq) {
		case 'daily':
			return (a * 365.25) / iv;
		case 'weekly':
			return (a * (rec.byDay?.length || 1) * 365.25) / (7 * iv);
		case 'monthly':
			return (a * 12) / iv;
		case 'yearly':
			return a / iv;
	}
}

export interface CostedRule {
	categoryId: string | null;
	status: 'active' | 'paused' | 'ended';
	amountMinor: bigint;
	rrule: string;
}

export interface Cost {
	/** Active rules counted. */
	count: number;
	monthlyMinor: bigint;
	yearlyMinor: bigint;
}

export interface CategoryCost extends Cost {
	/** Null for rules filed under no category — shown as "Other". */
	categoryId: string | null;
}

/**
 * Active rules' cost, per category and in total.
 *
 * The total is the *sum of the categories*, each rounded once, rather than a
 * separate rounding of the grand annual figure. The two can differ by a cent,
 * and the view lays the categories out as parts of the total — a ribbon whose
 * pieces fill it, rows that add up to the headline. So the headline is built
 * from its parts, and they always agree.
 *
 * Paused rules cost nothing while paused, and ended ones nothing at all, so
 * both are left out, as the Plan page's totals always have. A rule whose
 * schedule can't be read is left out rather than guessed at.
 *
 * Categories come back largest first, with the uncategorized remainder last
 * whatever its size: "Other" is the residue, not a category to rank.
 */
export function costByCategory(rules: CostedRule[]): { total: Cost; categories: CategoryCost[] } {
	const annual = new Map<string | null, { count: number; annual: number }>();
	for (const r of rules) {
		if (r.status !== 'active') continue;
		let yearly: number;
		try {
			yearly = annualMinor(r.amountMinor, parseRRule(r.rrule));
		} catch {
			continue;
		}
		const slot = annual.get(r.categoryId) ?? { count: 0, annual: 0 };
		slot.count += 1;
		slot.annual += yearly;
		annual.set(r.categoryId, slot);
	}

	const categories: CategoryCost[] = [...annual].map(([categoryId, s]) => ({
		categoryId,
		count: s.count,
		monthlyMinor: BigInt(Math.round(s.annual / 12)),
		yearlyMinor: BigInt(Math.round(s.annual))
	}));
	categories.sort((a, b) => {
		if ((a.categoryId === null) !== (b.categoryId === null)) return a.categoryId === null ? 1 : -1;
		return a.monthlyMinor === b.monthlyMinor ? 0 : a.monthlyMinor > b.monthlyMinor ? -1 : 1;
	});

	const total = categories.reduce<Cost>(
		(t, c) => ({
			count: t.count + c.count,
			monthlyMinor: t.monthlyMinor + c.monthlyMinor,
			yearlyMinor: t.yearlyMinor + c.yearlyMinor
		}),
		{ count: 0, monthlyMinor: 0n, yearlyMinor: 0n }
	);
	return { total, categories };
}
