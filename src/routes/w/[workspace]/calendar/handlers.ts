import type { WorkspaceContext } from '$lib/ports/context';
import type { LoadEvent } from '$lib/ports/handlers';
import { calendarSources } from '$lib/repo/calendar';
import { buildMonth } from '$lib/domain/calendar/month';
import { calDateInZone } from '$lib/domain/time/zoned';
import { daysInMonth } from '$lib/domain/recurrence/rrule';

/**
 * A month of what's coming.
 *
 * The month is a URL parameter rather than page state, so a particular month can
 * be linked, shared and reloaded — and so moving between months is an ordinary
 * navigation with the progress bar and back button that implies, rather than a
 * fetch this page would have to invent error handling for.
 */
function monthFromParams(url: URL, today: { y: number; m: number }): { y: number; m: number } {
	const raw = url.searchParams.get('m');
	const match = raw && /^(\d{4})-(\d{2})$/.exec(raw);
	if (!match) return today;
	const y = Number(match[1]);
	const m = Number(match[2]);
	// A month outside this range is a typed URL, not a person browsing; snap back
	// rather than expanding a decade of empty rules for them.
	if (m < 1 || m > 12 || y < today.y - 5 || y > today.y + 5) return today;
	return { y, m };
}

export async function load(ctx: WorkspaceContext, { params, url }: LoadEvent) {
	void params.workspace;
	const db = ctx.db;
	const ws = ctx.workspace;
	const now = ctx.deps.clock.now();
	const tz = ws.timezone;
	const today = calDateInZone(now, tz);
	const { y, m } = monthFromParams(url, today);

	// The window the repo reads dated things over — the month itself, in the
	// workspace's zone. Rules are expanded by the domain, not by the query.
	const from = new Date(Date.UTC(y, m - 1, 1) - 2 * 86_400_000);
	const to = new Date(Date.UTC(y, m - 1, daysInMonth(y, m)) + 2 * 86_400_000);

	const sources = await calendarSources(
		db,
		{ workspaceId: ws.id, viewerId: ctx.member.id, timezone: tz },
		from,
		to,
		now
	);
	const month = buildMonth(sources, y, m);

	const shift = (delta: number) => {
		const idx = (y * 12 + (m - 1) + delta) % 12;
		const yy = Math.floor((y * 12 + (m - 1) + delta) / 12);
		return `${yy}-${String(idx + 1).padStart(2, '0')}`;
	};

	return {
		currency: ws.currency,
		month: {
			y,
			m,
			label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
				month: 'long',
				year: 'numeric',
				timeZone: 'UTC'
			}),
			leadingBlanks: month.leadingBlanks,
			inMinor: month.inMinor,
			outMinor: month.outMinor,
			prev: shift(-1),
			next: shift(1)
		},
		isThisMonth: y === today.y && m === today.m,
		todayDay: y === today.y && m === today.m ? today.d : null,
		days: month.days.map((d) => ({
			day: d.date.d,
			weekday: d.weekday,
			inMinor: d.inMinor,
			outMinor: d.outMinor,
			entries: d.entries.map((e) => ({
				kind: e.kind,
				sourceId: e.sourceId,
				label: e.label,
				amountMinor: e.amountMinor,
				direction: e.direction,
				estimate: e.estimate
			}))
		}))
	};
}
