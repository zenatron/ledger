import type { WorkspaceContext } from '$lib/ports/context';
import { listLedger } from '$lib/repo/ledger';
import { toLedgerView } from '$lib/ledger-view';
import { ledgerOptsFromUrl } from '$lib/ledger-query';

function jsonSafe(data: unknown) {
	return new Response(
		JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
		{ headers: { 'content-type': 'application/json' } }
	);
}

export async function GET(ctx: WorkspaceContext, { url }: { url: URL }) {
	const now = ctx.deps.clock.now();
	const db = ctx.db;
	const scope = { workspaceId: ctx.workspace.id, viewerId: ctx.member.id };
	const opts = ledgerOptsFromUrl(url.searchParams, ctx.workspace.timezone);
	const feed = await listLedger(db, scope, now, {
		...opts,
		// Page two must be filtered exactly like page one, which fell back to the
		// saved preference when the URL didn't say.
		includeMovements: opts.includeMovements ?? ctx.member.includeLedgerMovements,
		limit: 20,
		// Clamped: a negative OFFSET is a Postgres error, not an empty page.
		offset: Math.max(0, parseInt(url.searchParams.get('offset') ?? '0') || 0)
	});

	const viewCtx = {
		now,
		staleAfterHours: ctx.workspace.staleAfterHours,
		viewerId: ctx.member.id
	};
	return jsonSafe({
		entries: feed.entries.map((e) => toLedgerView(e, viewCtx)),
		hasMore: feed.hasMore,
		// Returned so a page fetched after a filter change can correct the header,
		// even though the total shouldn't move between pages of one query.
		total: feed.total
	});
}
