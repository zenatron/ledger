/**
 * Recurrence rules — a deliberate subset of RFC 5545 RRULE covering what
 * bills and subscriptions actually are, stored as text like:
 *
 *   DTSTART=2026-07-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1
 *   DTSTART=2026-07-07;FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH
 *   DTSTART=2026-01-15;FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15
 *
 * All math is on plain calendar dates (year/month/day) — the workspace's
 * timezone only enters when a date is turned into an instant, at the edge.
 * COUNT/UNTIL are intentionally unsupported: a rule ends via its status.
 */

export interface CalDate {
	y: number;
	m: number; // 1-12
	d: number; // 1-31
}

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
	start: CalDate;
	freq: Freq;
	interval: number;
	/** Weekly only: ISO weekdays 1 (Mon) … 7 (Sun). Defaults to start's weekday. */
	byDay?: number[];
	/**
	 * Monthly/yearly: 1..31, or -1 for the last day of the month. A day past a
	 * given month's length lands on that month's last day (the 30th → Feb 28/29),
	 * which is how billing dates behave; the occurrence math clamps via clampDay.
	 */
	byMonthDay?: number;
	/** Yearly only: month 1..12. Defaults to start's month. */
	byMonth?: number;
}

export class RecurrenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RecurrenceError';
	}
}

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// --- calendar helpers (proleptic Gregorian via Date.UTC; no timezones) ---

export function daysInMonth(y: number, m: number): number {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toEpochDays(date: CalDate): number {
	return Date.UTC(date.y, date.m - 1, date.d) / 86_400_000;
}

function fromEpochDays(days: number): CalDate {
	const dt = new Date(days * 86_400_000);
	return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function addDays(date: CalDate, n: number): CalDate {
	return fromEpochDays(toEpochDays(date) + n);
}

export function compareDates(a: CalDate, b: CalDate): number {
	return toEpochDays(a) - toEpochDays(b);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: CalDate): number {
	const dow = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
	return dow === 0 ? 7 : dow;
}

function clampDay(y: number, m: number, day: number): number {
	const last = daysInMonth(y, m);
	return day === -1 ? last : Math.min(day, last);
}

// --- parse / format ---

export function parseRRule(text: string): Recurrence {
	const fields = new Map<string, string>();
	for (const part of text.trim().split(';')) {
		const [k, v] = part.split('=');
		if (!k || v === undefined) throw new RecurrenceError(`Malformed rule part: ${part}`);
		fields.set(k.toUpperCase(), v);
	}
	for (const key of fields.keys()) {
		if (!['DTSTART', 'FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH'].includes(key)) {
			throw new RecurrenceError(`Unsupported rule field: ${key}`);
		}
	}

	const dtstart = fields.get('DTSTART');
	if (!dtstart || !/^\d{4}-\d{2}-\d{2}$/.test(dtstart)) {
		throw new RecurrenceError('Rule needs DTSTART=YYYY-MM-DD');
	}
	const [y, m, d] = dtstart.split('-').map(Number);
	if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
		throw new RecurrenceError(`Invalid DTSTART date: ${dtstart}`);
	}
	const start: CalDate = { y, m, d };

	const freqRaw = fields.get('FREQ')?.toLowerCase();
	if (!freqRaw || !['daily', 'weekly', 'monthly', 'yearly'].includes(freqRaw)) {
		throw new RecurrenceError(`FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY`);
	}
	const freq = freqRaw as Freq;

	const interval = fields.has('INTERVAL') ? Number(fields.get('INTERVAL')) : 1;
	if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
		throw new RecurrenceError('INTERVAL must be 1–52');
	}

	const rec: Recurrence = { start, freq, interval };

	if (fields.has('BYDAY')) {
		if (freq !== 'weekly') throw new RecurrenceError('BYDAY only applies to FREQ=WEEKLY');
		const days = fields
			.get('BYDAY')!
			.split(',')
			.map((code) => DAY_CODES.indexOf(code.toUpperCase()) + 1);
		if (days.some((n) => n === 0) || days.length === 0) {
			throw new RecurrenceError('BYDAY must list weekdays like MO,TH');
		}
		rec.byDay = [...new Set(days)].sort((a, b) => a - b);
	}

	if (fields.has('BYMONTHDAY')) {
		if (freq !== 'monthly' && freq !== 'yearly') {
			throw new RecurrenceError('BYMONTHDAY only applies to MONTHLY or YEARLY');
		}
		const day = Number(fields.get('BYMONTHDAY'));
		// 1..31 or -1 (last day). Days longer than a given month clamp to its last
		// day at occurrence time (clampDay), so "the 30th" means the 30th where it
		// exists and the last day of February otherwise — how bills actually land.
		if (!Number.isInteger(day) || day === 0 || day > 31 || day < -1) {
			throw new RecurrenceError('BYMONTHDAY must be 1–31 or -1 (last day)');
		}
		rec.byMonthDay = day;
	}

	if (fields.has('BYMONTH')) {
		if (freq !== 'yearly') throw new RecurrenceError('BYMONTH only applies to YEARLY');
		const month = Number(fields.get('BYMONTH'));
		if (!Number.isInteger(month) || month < 1 || month > 12) {
			throw new RecurrenceError('BYMONTH must be 1–12');
		}
		rec.byMonth = month;
	}

	return rec;
}

export function formatRRule(rec: Recurrence): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const parts = [
		`DTSTART=${rec.start.y}-${pad(rec.start.m)}-${pad(rec.start.d)}`,
		`FREQ=${rec.freq.toUpperCase()}`,
		`INTERVAL=${rec.interval}`
	];
	if (rec.byDay) parts.push(`BYDAY=${rec.byDay.map((n) => DAY_CODES[n - 1]).join(',')}`);
	if (rec.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${rec.byMonthDay}`);
	if (rec.byMonth !== undefined) parts.push(`BYMONTH=${rec.byMonth}`);
	return parts.join(';');
}

/** Human copy for the UI: "Every 2 weeks on Mon and Thu". */
export function describeRecurrence(rec: Recurrence): string {
	const every = (unit: string) =>
		rec.interval === 1 ? `Every ${unit}` : `Every ${rec.interval} ${unit}s`;
	const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	switch (rec.freq) {
		case 'daily':
			return every('day');
		case 'weekly': {
			const days = (rec.byDay ?? [isoWeekday(rec.start)]).map((n) => dayNames[n - 1]);
			return `${every('week')} on ${days.join(' and ')}`;
		}
		case 'monthly': {
			const day = rec.byMonthDay ?? rec.start.d;
			return `${every('month')} on the ${day === -1 ? 'last day' : ordinal(day)}`;
		}
		case 'yearly': {
			const month = rec.byMonth ?? rec.start.m;
			const day = rec.byMonthDay ?? rec.start.d;
			const monthNames = [
				'Jan',
				'Feb',
				'Mar',
				'Apr',
				'May',
				'Jun',
				'Jul',
				'Aug',
				'Sep',
				'Oct',
				'Nov',
				'Dec'
			];
			return `${every('year')} on ${monthNames[month - 1]} ${day === -1 ? '(last day)' : day}`;
		}
	}
}

function ordinal(n: number): string {
	const suffix =
		n % 100 >= 11 && n % 100 <= 13
			? 'th'
			: n % 10 === 1
				? 'st'
				: n % 10 === 2
					? 'nd'
					: n % 10 === 3
						? 'rd'
						: 'th';
	return `${n}${suffix}`;
}

// --- next occurrence ---

/**
 * First occurrence strictly after `after` (and never before the rule's start).
 * Used both for scheduling the next materialization and for catch-up loops.
 */
export function nextOccurrence(rec: Recurrence, after: CalDate): CalDate {
	const startDays = toEpochDays(rec.start);
	const afterDays = Math.max(toEpochDays(after), startDays - 1);

	switch (rec.freq) {
		case 'daily': {
			const elapsed = afterDays - startDays;
			const k = elapsed < 0 ? 0 : Math.floor(elapsed / rec.interval) + 1;
			return fromEpochDays(startDays + k * rec.interval);
		}
		case 'weekly': {
			const byDay = rec.byDay ?? [isoWeekday(rec.start)];
			// Monday of the start's week anchors the interval grid.
			const startMonday = startDays - (isoWeekday(rec.start) - 1);
			// Walk forward day by day from the day after `after`; the horizon of
			// interval*7 + 7 days always contains the next hit.
			for (let day = afterDays + 1; day <= afterDays + rec.interval * 7 + 7; day++) {
				if (day < startDays) continue;
				const date = fromEpochDays(day);
				const monday = day - (isoWeekday(date) - 1);
				const weeks = Math.round((monday - startMonday) / 7);
				if (weeks % rec.interval === 0 && byDay.includes(isoWeekday(date))) return date;
			}
			throw new RecurrenceError('No next weekly occurrence found'); // unreachable
		}
		case 'monthly': {
			// No BYMONTHDAY means "same day as DTSTART" — the real day, not a
			// pre-clamped one. clampDay handles short months below; pre-clamping
			// here would bill a rule that starts on the 31st on the 28th forever.
			const day = rec.byMonthDay ?? rec.start.d;
			const startMonths = rec.start.y * 12 + (rec.start.m - 1);
			for (let k = 0; k < 1000; k++) {
				const months = startMonths + k * rec.interval;
				const y = Math.floor(months / 12);
				const m = (months % 12) + 1;
				const candidate = { y, m, d: clampDay(y, m, day) };
				if (compareDates(candidate, after) > 0 && compareDates(candidate, rec.start) >= 0) {
					return candidate;
				}
			}
			throw new RecurrenceError('No next monthly occurrence found'); // unreachable
		}
		case 'yearly': {
			const month = rec.byMonth ?? rec.start.m;
			const day = rec.byMonthDay ?? rec.start.d;
			for (let k = 0; k < 200; k++) {
				const y = rec.start.y + k * rec.interval;
				const candidate = { y, m: month, d: clampDay(y, month, day) };
				if (compareDates(candidate, after) > 0 && compareDates(candidate, rec.start) >= 0) {
					return candidate;
				}
			}
			throw new RecurrenceError('No next yearly occurrence found'); // unreachable
		}
	}
}
