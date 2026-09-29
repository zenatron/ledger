import { calDateInZone, compareCalDates, formatCalDate } from '$lib/domain/time/zoned';
import { addDays } from '$lib/domain/recurrence/rrule';

/**
 * The ledger's Recent list, cut into days.
 *
 * A flat list of forty rows gave no sense of when anything happened without
 * reading every date, and "what did we spend on Saturday" meant adding up
 * rows in your head. So the list reads like a statement: a dated rule, the
 * day's spending against it, then that day's rows.
 *
 * Days are the *workspace's*, not the device's — the same calendar analytics
 * uses, so a purchase at 11pm in the household's evening is on that day's line
 * whatever timezone the phone reading it is in.
 */

export interface DayRow {
	id: string;
	at: string;
	kind: 'purchase' | 'movement';
	/** Purchases only. */
	state?: string;
	amountMinor: bigint;
}

export interface Day<T> {
	/** YYYY-MM-DD in the workspace zone — stable, so it keys the list. */
	key: string;
	label: string;
	/** Money that settled that day: completed purchases less refunds. Movements
	 *  and requests don't count — the same basis as the analytics totals. */
	spentMinor: bigint;
	rows: T[];
}

const SETTLED = new Set(['completed', 'refunded']);

export function groupByDay<T extends DayRow>(
	rows: T[],
	opts: { timezone: string; now: Date; locale?: string }
): Day<T>[] {
	const today = calDateInZone(opts.now, opts.timezone);
	const yesterday = addDays(today, -1);
	const days: Day<T>[] = [];
	for (const row of rows) {
		const date = calDateInZone(new Date(row.at), opts.timezone);
		const key = formatCalDate(date);
		let day = days.at(-1);
		// Rows arrive newest first, so a day's rows are contiguous; a new key is
		// always a new day. (Were they not, a day would simply appear twice.)
		if (!day || day.key !== key) {
			day = { key, label: dayLabel(date, today, yesterday, opts.locale), spentMinor: 0n, rows: [] };
			days.push(day);
		}
		day.rows.push(row);
		if (row.kind === 'purchase' && row.state && SETTLED.has(row.state)) {
			day.spentMinor += row.amountMinor;
		}
	}
	return days;
}

function dayLabel(
	date: { y: number; m: number; d: number },
	today: { y: number; m: number; d: number },
	yesterday: { y: number; m: number; d: number },
	locale?: string
): string {
	if (compareCalDates(date, today) === 0) return 'Today';
	if (compareCalDates(date, yesterday) === 0) return 'Yesterday';
	// Formatted from the calendar date at UTC noon, so the device's own zone
	// can't shift it onto a neighbouring day.
	const at = new Date(Date.UTC(date.y, date.m - 1, date.d, 12));
	return at.toLocaleDateString(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(date.y !== today.y ? { year: 'numeric' } : {}),
		timeZone: 'UTC'
	});
}
