import { describe, expect, it } from 'vitest';
import {
	RecurrenceError,
	describeRecurrence,
	formatRRule,
	nextOccurrence,
	parseRRule,
	type CalDate
} from './rrule';
import { calDateInZone, zonedTimeToUtc } from '../time/zoned';

const d = (y: number, m: number, day: number): CalDate => ({ y, m, d: day });

describe('parseRRule / formatRRule', () => {
	it('round-trips a monthly rule', () => {
		const text = 'DTSTART=2026-07-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1';
		expect(formatRRule(parseRRule(text))).toBe(text);
	});

	it('parses weekly with BYDAY', () => {
		const rec = parseRRule('DTSTART=2026-07-07;FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH');
		expect(rec.byDay).toEqual([1, 4]);
		expect(rec.interval).toBe(2);
	});

	it('rejects unsupported or malformed input', () => {
		expect(() => parseRRule('FREQ=MONTHLY')).toThrow(RecurrenceError); // no DTSTART
		expect(() => parseRRule('DTSTART=2026-07-01;FREQ=HOURLY')).toThrow(RecurrenceError);
		expect(() => parseRRule('DTSTART=2026-07-01;FREQ=DAILY;COUNT=5')).toThrow(RecurrenceError);
		expect(() => parseRRule('DTSTART=2026-07-01;FREQ=DAILY;UNTIL=2027-01-01')).toThrow(
			RecurrenceError
		);
		expect(() => parseRRule('DTSTART=2026-02-30;FREQ=DAILY')).toThrow(RecurrenceError);
		expect(() => parseRRule('DTSTART=2026-07-01;FREQ=MONTHLY;BYMONTHDAY=32')).toThrow(
			RecurrenceError
		);
		expect(() => parseRRule('DTSTART=2026-07-01;FREQ=DAILY;BYDAY=MO')).toThrow(RecurrenceError);
	});
});

describe('nextOccurrence — daily', () => {
	const rec = parseRRule('DTSTART=2026-07-01;FREQ=DAILY;INTERVAL=3');

	it('steps by interval from the anchor', () => {
		expect(nextOccurrence(rec, d(2026, 7, 1))).toEqual(d(2026, 7, 4));
		expect(nextOccurrence(rec, d(2026, 7, 3))).toEqual(d(2026, 7, 4));
		expect(nextOccurrence(rec, d(2026, 7, 4))).toEqual(d(2026, 7, 7));
	});

	it('before the start, the start is next', () => {
		expect(nextOccurrence(rec, d(2026, 6, 1))).toEqual(d(2026, 7, 1));
	});
});

describe('nextOccurrence — weekly', () => {
	it('multiple days per week', () => {
		// 2026-07-07 is a Tuesday; MO,TH anchored to that week.
		const rec = parseRRule('DTSTART=2026-07-07;FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH');
		expect(nextOccurrence(rec, d(2026, 7, 7))).toEqual(d(2026, 7, 9)); // Thu same week
		expect(nextOccurrence(rec, d(2026, 7, 9))).toEqual(d(2026, 7, 13)); // Mon next week
	});

	it('every 2 weeks keeps the anchor week grid', () => {
		const rec = parseRRule('DTSTART=2026-07-07;FREQ=WEEKLY;INTERVAL=2;BYDAY=TU');
		expect(nextOccurrence(rec, d(2026, 7, 7))).toEqual(d(2026, 7, 21));
		expect(nextOccurrence(rec, d(2026, 7, 21))).toEqual(d(2026, 8, 4));
		// mid-off-week lands on the next on-week Tuesday
		expect(nextOccurrence(rec, d(2026, 7, 14))).toEqual(d(2026, 7, 21));
	});

	it('defaults BYDAY to the start weekday', () => {
		const rec = parseRRule('DTSTART=2026-07-07;FREQ=WEEKLY');
		expect(nextOccurrence(rec, d(2026, 7, 7))).toEqual(d(2026, 7, 14));
	});
});

describe('nextOccurrence — monthly', () => {
	it('fixed day of month', () => {
		const rec = parseRRule('DTSTART=2026-07-01;FREQ=MONTHLY;BYMONTHDAY=1');
		expect(nextOccurrence(rec, d(2026, 7, 1))).toEqual(d(2026, 8, 1));
		expect(nextOccurrence(rec, d(2026, 7, 15))).toEqual(d(2026, 8, 1));
		expect(nextOccurrence(rec, d(2026, 6, 30))).toEqual(d(2026, 7, 1));
	});

	it('last day of month (-1) tracks month length', () => {
		const rec = parseRRule('DTSTART=2026-01-31;FREQ=MONTHLY;BYMONTHDAY=-1');
		expect(nextOccurrence(rec, d(2026, 1, 31))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(rec, d(2026, 2, 28))).toEqual(d(2026, 3, 31));
		// 2028 is a leap year
		expect(nextOccurrence(rec, d(2028, 1, 31))).toEqual(d(2028, 2, 29));
	});

	it('no BYMONTHDAY falls back to the start day, 29th-31st included', () => {
		// The fallback is "same day as DTSTART" — not a pre-clamped 28. A rule
		// starting on the 31st bills on the 31st (February clamps), which is
		// what describeRecurrence promises.
		const on31st = parseRRule('DTSTART=2026-01-31;FREQ=MONTHLY');
		expect(nextOccurrence(on31st, d(2026, 1, 31))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(on31st, d(2026, 2, 28))).toEqual(d(2026, 3, 31));
		expect(nextOccurrence(on31st, d(2026, 3, 31))).toEqual(d(2026, 4, 30));
		expect(nextOccurrence(on31st, d(2026, 4, 30))).toEqual(d(2026, 5, 31));

		const on30th = parseRRule('DTSTART=2026-01-30;FREQ=MONTHLY');
		expect(nextOccurrence(on30th, d(2026, 1, 30))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(on30th, d(2026, 2, 28))).toEqual(d(2026, 3, 30));

		const on29th = parseRRule('DTSTART=2026-01-29;FREQ=MONTHLY');
		expect(nextOccurrence(on29th, d(2026, 1, 29))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(on29th, d(2026, 2, 28))).toEqual(d(2026, 3, 29));
	});

	it('no BYMONTHDAY yearly keeps the start day and month', () => {
		const rec = parseRRule('DTSTART=2024-02-29;FREQ=YEARLY');
		expect(nextOccurrence(rec, d(2024, 2, 29))).toEqual(d(2025, 2, 28));
		expect(nextOccurrence(rec, d(2025, 2, 28))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(rec, d(2027, 2, 28))).toEqual(d(2028, 2, 29));
	});

	it('day 30 lands on the 30th, clamping only where the month is shorter', () => {
		const rec = parseRRule('DTSTART=2026-01-30;FREQ=MONTHLY;BYMONTHDAY=30');
		// 31-day months keep the 30th (not the last day) — the whole point.
		expect(nextOccurrence(rec, d(2026, 2, 28))).toEqual(d(2026, 3, 30));
		// February clamps to its last day…
		expect(nextOccurrence(rec, d(2026, 1, 30))).toEqual(d(2026, 2, 28));
		// …and doesn't drift: the clamp is recomputed per month, not carried.
		expect(nextOccurrence(rec, d(2026, 2, 28))).toEqual(d(2026, 3, 30));
	});

	it('day 31 clamps per month without drifting', () => {
		const rec = parseRRule('DTSTART=2026-01-31;FREQ=MONTHLY;BYMONTHDAY=31');
		expect(nextOccurrence(rec, d(2026, 1, 31))).toEqual(d(2026, 2, 28));
		expect(nextOccurrence(rec, d(2026, 2, 28))).toEqual(d(2026, 3, 31));
		expect(nextOccurrence(rec, d(2026, 3, 31))).toEqual(d(2026, 4, 30));
	});

	it('every 3 months', () => {
		const rec = parseRRule('DTSTART=2026-01-15;FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15');
		expect(nextOccurrence(rec, d(2026, 1, 15))).toEqual(d(2026, 4, 15));
		expect(nextOccurrence(rec, d(2026, 5, 1))).toEqual(d(2026, 7, 15));
	});
});

describe('nextOccurrence — yearly', () => {
	it('anniversary', () => {
		const rec = parseRRule('DTSTART=2026-03-10;FREQ=YEARLY');
		expect(nextOccurrence(rec, d(2026, 3, 10))).toEqual(d(2027, 3, 10));
		expect(nextOccurrence(rec, d(2027, 1, 1))).toEqual(d(2027, 3, 10));
	});

	it('explicit month/day', () => {
		const rec = parseRRule('DTSTART=2026-01-01;FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25');
		expect(nextOccurrence(rec, d(2026, 1, 1))).toEqual(d(2026, 12, 25));
		expect(nextOccurrence(rec, d(2026, 12, 25))).toEqual(d(2027, 12, 25));
	});
});

describe('describeRecurrence', () => {
	it('reads like a human wrote it', () => {
		expect(describeRecurrence(parseRRule('DTSTART=2026-07-01;FREQ=MONTHLY;BYMONTHDAY=1'))).toBe(
			'Every month on the 1st'
		);
		expect(describeRecurrence(parseRRule('DTSTART=2026-07-01;FREQ=MONTHLY;BYMONTHDAY=-1'))).toBe(
			'Every month on the last day'
		);
		expect(
			describeRecurrence(parseRRule('DTSTART=2026-07-07;FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'))
		).toBe('Every 2 weeks on Mon and Thu');
		expect(describeRecurrence(parseRRule('DTSTART=2026-07-02;FREQ=DAILY'))).toBe('Every day');
	});
});

describe('zoned time conversion', () => {
	it('converts local 9:00 to the right UTC instant across DST', () => {
		// EDT (UTC-4) in July, EST (UTC-5) in January.
		expect(zonedTimeToUtc(d(2026, 7, 1), 9, 0, 'America/New_York').toISOString()).toBe(
			'2026-07-01T13:00:00.000Z'
		);
		expect(zonedTimeToUtc(d(2026, 1, 15), 9, 0, 'America/New_York').toISOString()).toBe(
			'2026-01-15T14:00:00.000Z'
		);
		expect(zonedTimeToUtc(d(2026, 7, 1), 9, 0, 'UTC').toISOString()).toBe(
			'2026-07-01T09:00:00.000Z'
		);
		expect(zonedTimeToUtc(d(2026, 7, 1), 9, 0, 'Asia/Tokyo').toISOString()).toBe(
			'2026-07-01T00:00:00.000Z'
		);
	});

	it('maps instants back to workspace-local calendar dates', () => {
		// 03:00 UTC on the 2nd is still the evening of the 1st in New York.
		expect(calDateInZone(new Date('2026-07-02T03:00:00Z'), 'America/New_York')).toEqual(
			d(2026, 7, 1)
		);
		expect(calDateInZone(new Date('2026-07-02T03:00:00Z'), 'Asia/Tokyo')).toEqual(d(2026, 7, 2));
	});

	it('round-trips date → instant → date', () => {
		for (const tz of ['America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'UTC']) {
			const date = d(2026, 11, 1); // day US DST ends
			expect(calDateInZone(zonedTimeToUtc(date, 9, 0, tz), tz)).toEqual(date);
		}
	});
});
