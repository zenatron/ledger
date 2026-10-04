/**
 * One reading of the ledger's query string.
 *
 * The page load and the "Show more" endpoint have to agree exactly — the second
 * page of a filtered list is only coherent if it was filtered the same way as
 * the first. They parsed the URL separately before, and the endpoint quietly
 * knew about fewer filters than the page did.
 */

import { periodBoundsUtc } from '$lib/domain/analytics/period';
import { addDays, type CalDate } from '$lib/domain/recurrence/rrule';
import { NO_CATEGORY, parseBboxParam } from '$lib/ledger-filters';
import type { LedgerBasis, LedgerOpts } from '$lib/repo/ledger';
import { uuidOrNull } from '$lib/uuid';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-06-01" -> CalDate, or null if it isn't one. */
function parseDate(raw: string | null): CalDate | null {
	if (!raw || !DATE_RE.test(raw)) return null;
	const [y, m, d] = raw.split('-').map(Number);
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	return { y, m, d };
}

export function ledgerOptsFromUrl(params: URLSearchParams, timezone: string): LedgerOpts {
	const rawCategory = params.get('category') ?? '';
	const uncategorized = rawCategory === NO_CATEGORY;

	/*
	 * Calendar dates become instants here, in the workspace timezone — the repo
	 * takes instants only, and this is the layer that knows the zone. `to` is
	 * inclusive in the URL because that is how a person reads "Jun 1 – Jun 30",
	 * and exclusive in the query because a half-open bound is the only one that
	 * doesn't double-count midnight.
	 */
	const fromDate = parseDate(params.get('from'));
	const toDate = parseDate(params.get('to'));
	const bounds =
		fromDate || toDate
			? periodBoundsUtc(
					{
						from: fromDate ?? { y: 1970, m: 1, d: 1 },
						toExclusive: toDate ? addDays(toDate, 1) : { y: 9999, m: 1, d: 1 }
					},
					timezone
				)
			: null;

	// Only ever 'spend' when asked for explicitly, which is what the analytics
	// drill-through links do. A hand-picked range means "everything that happened
	// in it", so it keeps the default.
	const basis: LedgerBasis = params.get('basis') === 'spend' ? 'spend' : 'activity';

	/*
	 * A geographic window, from the map or a "By place" row.
	 *
	 * A bucket movement has no place — nobody stood anywhere to set money aside —
	 * so a bbox forces movements off. Without that, tapping a bubble worth $412
	 * would land on a list padded with accruals that have nothing to do with it,
	 * and the rows would not add up to the figure that was tapped.
	 */
	const bbox = parseBboxParam(params.get('bbox'));

	/*
	 * Ids are shape-checked and a bad one is dropped rather than refused: a
	 * filter pointing at nothing is a stale link, and the useful answer to it is
	 * the unfiltered ledger, not an error page. The search is capped for the
	 * same reason the form caps what you can type into it.
	 */
	return {
		search: params.get('q')?.slice(0, 200) || undefined,
		categoryId: uncategorized ? undefined : (uuidOrNull(rawCategory) ?? undefined),
		uncategorized,
		memberId: uuidOrNull(params.get('member')) ?? undefined,
		accountId: uuidOrNull(params.get('account')) ?? undefined,
		recurringOnly: params.get('recurring') === '1',
		from: bounds?.from,
		to: bounds?.to,
		basis,
		bbox: bbox ?? undefined,
		includeMovements: bbox ? false : movementsParam(params.get('movements'))
	};
}

/**
 * `movements=1` and `movements=0` are an explicit choice (the toggle, a shared
 * link); absent means "no opinion", so the member's saved preference decides.
 *
 * Absent used to read as off. The saved preference was then never consulted,
 * and the page made up for it on mount by navigating again with `movements=1`
 * from localStorage, which painted the ledger without bucket rows and then
 * popped them in a beat later on every visit to the tab.
 */
function movementsParam(raw: string | null): boolean | undefined {
	if (raw === '1') return true;
	if (raw === '0') return false;
	return undefined;
}
