import { describe, expect, it } from 'vitest';
import { groupByDay } from './ledger-days';

const NOW = new Date('2026-09-29T15:00:00Z'); // 11am in New York
const tz = 'America/New_York';

const row = (id: string, at: string, amountMinor: bigint, state = 'completed') => ({
	id,
	at,
	kind: 'purchase' as const,
	state,
	amountMinor
});

describe('groupByDay', () => {
	it("cuts the list on the workspace's calendar, not UTC's", () => {
		const days = groupByDay(
			[
				row('a', '2026-09-29T13:00:00Z', 500n),
				// 10pm on the 28th in New York, already the 29th in UTC.
				row('b', '2026-09-29T02:00:00Z', 1200n),
				row('c', '2026-09-20T16:00:00Z', 300n)
			],
			{ timezone: tz, now: NOW, locale: 'en-US' }
		);
		expect(days.map((d) => [d.key, d.label, d.rows.map((r) => r.id)])).toEqual([
			['2026-09-29', 'Today', ['a']],
			['2026-09-28', 'Yesterday', ['b']],
			['2026-09-20', 'Sun, Sep 20', ['c']]
		]);
	});

	it('totals only money that settled, netting refunds', () => {
		const [day] = groupByDay(
			[
				row('a', '2026-09-29T13:00:00Z', 5000n),
				row('b', '2026-09-29T13:10:00Z', -1500n, 'refunded'),
				row('c', '2026-09-29T13:20:00Z', 9999n, 'pending_approval'),
				row('d', '2026-09-29T13:30:00Z', 800n, 'denied'),
				{ id: 'm', at: '2026-09-29T14:00:00Z', kind: 'movement' as const, amountMinor: -4000n }
			],
			{ timezone: tz, now: NOW }
		);
		expect(day.spentMinor).toBe(3500n);
	});

	it('names the year only when it is not this one', () => {
		const [day] = groupByDay([row('a', '2025-12-31T17:00:00Z', 100n)], {
			timezone: tz,
			now: NOW,
			locale: 'en-US'
		});
		expect(day.label).toBe('Wed, Dec 31, 2025');
	});
});
