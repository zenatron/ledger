/**
 * Timezone edge: convert between calendar dates in an IANA timezone and UTC
 * instants, using only Intl (pure ECMAScript, no deps). This is the ONLY place
 * local↔UTC conversion happens; recurrence and analytics math stays on plain
 * calendar dates.
 */

import type { CalDate } from '$lib/domain/recurrence/rrule';

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let dtf = dtfCache.get(timeZone);
	if (!dtf) {
		dtf = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		dtfCache.set(timeZone, dtf);
	}
	return dtf;
}

function wallClockAsUtc(instantMs: number, timeZone: string): number {
	const parts: Record<string, number> = {};
	for (const { type, value } of formatter(timeZone).formatToParts(new Date(instantMs))) {
		if (type !== 'literal') parts[type] = Number(value);
	}
	// Intl renders midnight as hour 24 in some engines.
	const hour = parts.hour === 24 ? 0 : parts.hour;
	return Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
}

/** Offset (minutes east of UTC) in effect at the given instant. */
function tzOffsetMinutes(instantMs: number, timeZone: string): number {
	return (wallClockAsUtc(instantMs, timeZone) - instantMs) / 60_000;
}

/** The instant when the wall clock in `timeZone` shows the given local time. */
export function zonedTimeToUtc(
	date: CalDate,
	hour: number,
	minute: number,
	timeZone: string
): Date {
	const guess = Date.UTC(date.y, date.m - 1, date.d, hour, minute);
	let ts = guess - tzOffsetMinutes(guess, timeZone) * 60_000;
	// Second pass fixes guesses that landed on the wrong side of a DST jump.
	const offset = tzOffsetMinutes(ts, timeZone);
	ts = guess - offset * 60_000;
	return new Date(ts);
}

/** The calendar date the given instant falls on in `timeZone`. */
export function calDateInZone(instant: Date, timeZone: string): CalDate {
	const wall = new Date(wallClockAsUtc(instant.getTime(), timeZone));
	return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate() };
}

/**
 * A `YYYY-MM-DD` string off a date input, as a calendar date — or null when it
 * isn't a real one. Round-tripped through Date.UTC so "2026-02-30" is refused
 * rather than rolling into March.
 *
 * Deliberately returns a calendar date, never an instant: `new Date('…T12:00')`
 * reads the wall clock of whatever machine runs it, which in a container is UTC
 * and not the workspace's. Turning the date into an instant is the caller's
 * job, through `zonedTimeToUtc`, in the workspace zone.
 */
export function parseCalDate(raw: string | null | undefined): CalDate | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw ?? '');
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const probe = new Date(Date.UTC(y, mo - 1, d));
	if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
		return null;
	}
	return { y, m: mo, d };
}

/** `a` before, equal to, or after `b`: negative, zero, positive. */
export function compareCalDates(a: CalDate, b: CalDate): number {
	return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** `{y, m, d}` → `YYYY-MM-DD`. */
export function formatCalDate(d: CalDate): string {
	return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
}
