import type { WorkspaceContext } from '$lib/ports/context';
import type { LoadEvent } from '$lib/ports/handlers';
import { and, eq } from 'drizzle-orm';
import { toDiscretionMode } from '$lib/domain/visibility/discretion';
import { purchase } from '$lib/db/schema';
import { listLedger } from '$lib/repo/ledger';
import { listPurchases } from '$lib/repo/purchases';
import { safeToSpend, forecastMonths } from '$lib/repo/forecast';
import { toLedgerView } from '$lib/ledger-view';
import { listCategories, listMembers } from '$lib/repo/workspaces';
import { ledgerOptsFromUrl } from '$lib/ledger-query';

const LIMIT = 200;

export async function load(ctx: WorkspaceContext, { url, params }: LoadEvent) {
	// Also depend on the workspace param so a switch always re-runs this load,
	// independent of how finely SvelteKit tracks url/params. See +layout.server.ts.
	void params.workspace;
	const now = ctx.deps.clock.now();
	const db = ctx.db;
	const ws = ctx.workspace;
	// Filters are a URL concern, not client state: they change what the server
	// pages over, and they make the view shareable and restorable.
	const opts = ledgerOptsFromUrl(url.searchParams, ws.timezone);
	const scope = { workspaceId: ws.id, viewerId: ctx.member.id };

	/*
	 * Only the page's frame is awaited: the categories and members the filter
	 * sheet needs, the display preferences, the currency. Everything slow is
	 * returned as an un-awaited promise, which SvelteKit streams — the shell
	 * paints at once and the page holds a skeleton for each piece until it
	 * lands, instead of the whole response (and with it, the whole screen)
	 * waiting on the slowest query.
	 */
	const [categories, membersAll] = await Promise.all([
		listCategories(db, ws.id),
		listMembers(db, ws.id)
	]);

	const viewCtx = {
		now,
		staleAfterHours: ws.staleAfterHours,
		viewerId: ctx.member.id
	};

	// The paged feed — the Recent list, its true total, and the place label the
	// bbox filter chip reads off the rows the filter actually returned (read
	// here rather than passed along the link, so the chip can never name a
	// place the list isn't showing).
	const feed = (async () => {
		const f = await listLedger(db, scope, now, { ...opts, limit: LIMIT });
		const entries = f.entries.map((e) => toLedgerView(e, viewCtx));
		let placeLabel: string | null = null;
		if (opts.bbox) {
			const names = [
				...new Set(
					entries
						.map((e) => (e.kind === 'purchase' ? (e.merchantName ?? e.placeLabel) : null))
						.filter((n): n is string => !!n)
				)
			];
			placeLabel =
				names.length === 1 ? names[0] : names.length > 1 ? `${names.length} places` : 'On the map';
		}
		return { entries, hasMore: f.hasMore, total: f.total, placeLabel };
	})();

	/*
	 * Your own approved-but-unconfirmed purchases — the "confirm what you paid"
	 * to-do. An approved purchase is one that's been greenlit but has no final
	 * amount recorded yet (a recurring charge with "same amount" off, or a normal
	 * request after approval). Only the requester can complete it, so it's scoped
	 * to memberId = you.
	 *
	 * Fetched on its own rather than filtered out of the paged feed: these can be
	 * months old (a backfilled bill), so they'd otherwise sort into a later page
	 * and be exactly the thing this section exists to stop getting lost.
	 */
	const awaiting = (async () => {
		const awaitingIds = await db
			.select({ id: purchase.id })
			.from(purchase)
			.where(
				and(
					eq(purchase.workspaceId, ws.id),
					eq(purchase.state, 'approved'),
					eq(purchase.memberId, ctx.member.id)
				)
			);
		if (awaitingIds.length === 0) return [];
		return (
			(await listPurchases(db, scope, now, { ids: awaitingIds.map((r) => r.id) }))
				.map((pp) => toLedgerView({ kind: 'purchase' as const, ...pp }, viewCtx))
				// Oldest first: clear the backlog in the order it built up.
				.sort((a, b) => a.at.localeCompare(b.at))
		);
	})();

	// "Sleep on it": everything paused in the workspace, its own to-do.
	const sleeping = (async () => {
		const sleepingIds = await db
			.select({ id: purchase.id })
			.from(purchase)
			.where(and(eq(purchase.workspaceId, ws.id), eq(purchase.state, 'held')));
		if (sleepingIds.length === 0) return [];
		return (
			(await listPurchases(db, scope, now, { ids: sleepingIds.map((r) => r.id) }))
				.map((pp) => toLedgerView({ kind: 'purchase' as const, ...pp }, viewCtx))
				// Soonest to wake first — the ones nearest a decision lead.
				.sort((a, b) => {
					const ax = a.kind === 'purchase' ? (a.heldUntil ?? '') : '';
					const bx = b.kind === 'purchase' ? (b.heldUntil ?? '') : '';
					return ax.localeCompare(bx);
				})
		);
	})();

	return {
		feed,
		awaiting,
		sleeping,
		// Harmony's number: Safe to Spend this month, seal-scoped to the viewer —
		// and the months after this one, a quiet forward look under the headline.
		forecast: safeToSpend(
			db,
			{ workspaceId: ws.id, viewerId: ctx.member.id, timezone: ws.timezone },
			now
		),
		runway: forecastMonths(
			db,
			{ workspaceId: ws.id, viewerId: ctx.member.id, timezone: ws.timezone },
			now,
			3
		),
		categories,
		members: membersAll
			.filter((m) => m.member.status === 'active')
			.map((m) => ({ id: m.member.id, name: m.user.displayName })),
		includeMovements: opts.includeMovements ?? ctx.member.includeLedgerMovements,
		// How much of the headline this member wants legible on arrival. Server-side
		// so a masked number never renders before the client can hide it.
		safeToSpendDisplay: toDiscretionMode(ctx.member.safeToSpendDisplay),
		// Whether the breakdown projects the months after this one. A reading
		// preference, set in Harmony settings alongside the display mode.
		showRunwayMonths: ctx.member.showRunwayMonths,
		currency: ws.currency
	};
}
