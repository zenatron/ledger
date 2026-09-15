/**
 * What lands on each day of a month.
 *
 * Pure, like the rest of `domain`: it is handed rules and one-off dates and
 * returns a grid. No database, no clock, no timezone — the caller resolves
 * "today" in the workspace's zone and passes calendar dates in, exactly as the
 * forecast does.
 *
 * **The distinction this module exists to preserve is certain vs projected.**
 * Apple's wallet calendar shows transactions that have already happened, so it
 * can render every day with the same confidence. Ours mostly shows the future:
 * a bucket accrual on the 1st is a fact about a rule and will be that amount,
 * while a recurring purchase that asks you to confirm the price is a guess based
 * on what it cost last time. Those are different kinds of claim, and a grid that
 * drew them identically would be quietly lying on precisely the days someone is
 * planning around. So every entry carries `estimate`, and the view is expected
 * to show it.
 *
 * Amounts are magnitudes; `direction` says which way the money goes. Money set
 * aside into a bucket counts as `out` — it has left the spendable pile, which is
 * the question a calendar is being asked — but it is a different `kind` from a
 * bill, so a view can colour it differently without this module deciding how.
 */

import {
	addDays,
	compareDates,
	daysInMonth,
	isoWeekday,
	parseRRule,
	type CalDate
} from '$lib/domain/recurrence/rrule';
import { occurrencesInWindow } from '$lib/domain/forecast/safe-to-spend';

export type EntryKind = 'bill' | 'saving' | 'income' | 'decision';
export type Direction = 'in' | 'out' | 'none';

export interface CalendarEntry {
	kind: EntryKind;
	/** The rule or purchase this came from, so a view can link to it. */
	sourceId: string;
	label: string;
	/** Magnitude. `direction` carries the sign. */
	amountMinor: bigint;
	direction: Direction;
	/** True when the figure is projected rather than settled. */
	estimate: boolean;
	/** The member who owns the rule behind it, when there is one, so a view can offer that person its actions. */
	ownerMemberId?: string;
}

export interface CalendarDay {
	date: CalDate;
	/** 1 = Monday … 7 = Sunday, for laying the grid out. */
	weekday: number;
	entries: CalendarEntry[];
	inMinor: bigint;
	outMinor: bigint;
}

export interface CalendarMonth {
	year: number;
	month: number;
	days: CalendarDay[];
	/** Blank cells before the 1st, so a view can render a week grid directly. */
	leadingBlanks: number;
	inMinor: bigint;
	outMinor: bigint;
}

/** Something that repeats: a recurring purchase, a bucket accrual, an income template. */
export interface ScheduledSource {
	kind: EntryKind;
	sourceId: string;
	label: string;
	amountMinor: bigint;
	direction: Direction;
	rrule: string;
	/**
	 * The earliest date this rule may still produce — a rule's next unmaterialized
	 * occurrence. Occurrences before it have already happened and are history, not
	 * forecast, so the calendar must not draw them again.
	 */
	notBefore?: CalDate;
	estimate: boolean;
	ownerMemberId?: string;
}

/** Something that happens once on a known day: a held purchase due to wake, a one-off income. */
export interface DatedSource {
	kind: EntryKind;
	sourceId: string;
	label: string;
	amountMinor: bigint;
	direction: Direction;
	date: CalDate;
	estimate: boolean;
}

export interface CalendarInput {
	scheduled: ScheduledSource[];
	dated: DatedSource[];
}

function emptyDay(date: CalDate): CalendarDay {
	return { date, weekday: isoWeekday(date), entries: [], inMinor: 0n, outMinor: 0n };
}

function add(day: CalendarDay, entry: CalendarEntry): void {
	day.entries.push(entry);
	if (entry.direction === 'in') day.inMinor += entry.amountMinor;
	else if (entry.direction === 'out') day.outMinor += entry.amountMinor;
}

/**
 * Build one month's grid.
 *
 * A source whose rule cannot be parsed is skipped rather than thrown on — the
 * same choice the materialization sweep makes. One bad rule should cost its own
 * row, not the whole month.
 */
export function buildMonth(input: CalendarInput, year: number, month: number): CalendarMonth {
	const first: CalDate = { y: year, m: month, d: 1 };
	const length = daysInMonth(year, month);
	const toExclusive = addDays(first, length);

	const days = Array.from({ length }, (_, i) => emptyDay({ y: year, m: month, d: i + 1 }));
	const dayAt = (d: number) => days[d - 1];

	for (const s of input.scheduled) {
		let rec;
		try {
			rec = parseRRule(s.rrule);
		} catch {
			continue;
		}
		// Never earlier than the rule's own next occurrence: anything before that
		// has already been materialized and belongs to the ledger, not the forecast.
		const from = s.notBefore && compareDates(s.notBefore, first) > 0 ? s.notBefore : first;
		for (const occ of occurrencesInWindow(rec, from, toExclusive)) {
			add(dayAt(occ.d), {
				kind: s.kind,
				sourceId: s.sourceId,
				label: s.label,
				amountMinor: s.amountMinor,
				direction: s.direction,
				estimate: s.estimate,
				ownerMemberId: s.ownerMemberId
			});
		}
	}

	for (const d of input.dated) {
		if (d.date.y !== year || d.date.m !== month) continue;
		if (d.date.d < 1 || d.date.d > length) continue;
		add(dayAt(d.date.d), {
			kind: d.kind,
			sourceId: d.sourceId,
			label: d.label,
			amountMinor: d.amountMinor,
			direction: d.direction,
			estimate: d.estimate
		});
	}

	/*
	 * Order within a day: money in first, then what leaves, then decisions. It
	 * reads the way the day actually goes — the salary lands before the bills it
	 * pays — and it keeps a day's biggest number at the top where a glance finds
	 * it. Ties fall back to the label so the grid never reshuffles between loads.
	 */
	const rank: Record<Direction, number> = { in: 0, out: 1, none: 2 };
	for (const day of days) {
		day.entries.sort(
			(a, b) =>
				rank[a.direction] - rank[b.direction] ||
				(b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0) ||
				a.label.localeCompare(b.label)
		);
	}

	return {
		year,
		month,
		days,
		// isoWeekday is 1=Monday; the grid starts on Monday, so the 1st sits that
		// many cells in.
		leadingBlanks: isoWeekday(first) - 1,
		inMinor: days.reduce((n, d) => n + d.inMinor, 0n),
		outMinor: days.reduce((n, d) => n + d.outMinor, 0n)
	};
}
