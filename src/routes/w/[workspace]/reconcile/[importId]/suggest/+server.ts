import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getImport, getLine, matchCandidates } from '$lib/repo/statements';
import { suggestMatch } from '$lib/application/suggest-match';
import { getLlmAssist } from '$lib/infra/llm';
import { systemClock } from '$lib/infra/time/system-clock';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * "Help me find this" for one unmatched statement line.
 *
 * A separate endpoint rather than a form action, because this **writes
 * nothing**. It reads a line, reads the candidates the person is about to be
 * shown anyway, and answers with at most one of their ids so the picker can
 * open with that row already highlighted. The link itself still happens through
 * the existing `?/link` action, by a person, on the next tap.
 *
 * Everything reachable from here is seal-filtered by the repository, so the
 * model is never shown a purchase the person asking couldn't see for themselves.
 */

const DAY_MS = 86_400_000;

/**
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so a hand-rolled request body would otherwise surface as a 500. Checked here
 * so a bad id reads as "no such line", which is what it is.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same reasoning as the intelligence endpoint: SvelteKit's form-action CSRF
// check doesn't cover a standalone handler, and this one reads workspace data.
export const POST: RequestHandler = async ({ locals, params, request }) => {
	assertSameOrigin(request);

	const body = await request.json().catch(() => null);
	const lineId = (body as { lineId?: unknown } | null)?.lineId;
	if (typeof lineId !== 'string' || !UUID_RE.test(lineId))
		error(404, 'That line no longer exists.');
	if (!UUID_RE.test(params.importId)) error(404, 'That import no longer exists.');

	const db = getDb();
	const ws = locals.workspace!;
	const now = systemClock.now();
	const scope = { workspaceId: ws.id, viewerId: locals.member!.id };

	const imp = await getImport(db, ws.id, params.importId);
	if (!imp) error(404, 'That import no longer exists.');

	const line = await getLine(db, ws.id, lineId);
	if (!line || line.importId !== imp.id) error(404, 'That line no longer exists.');
	// Only a line with nothing on it. A matched or confirmed line already has an
	// answer, and a `private` one is deliberately not ours to explain.
	if (line.matchState !== 'unmatched') return json({ purchaseId: null });

	const assist = getLlmAssist({
		aiMode: ws.aiMode,
		aiEndpoint: ws.aiEndpoint,
		aiModel: ws.aiModel,
		aiApiKey: ws.aiApiKey
	});
	if (!assist.available) return json({ purchaseId: null });

	// The same window the manual picker offers, so the model can only ever
	// highlight a row the person could have scrolled to themselves.
	const from = new Date((imp.periodStart ?? now).getTime() - 7 * DAY_MS);
	const to = new Date((imp.periodEnd ?? now).getTime() + 7 * DAY_MS);
	const candidates = await matchCandidates(db, scope, from, to, now);

	const purchaseId = await suggestMatch(
		assist,
		{
			rawDescription: line.rawDescription,
			amountMinor: line.amountMinor,
			postedAt: line.postedAt,
			currency: line.currency
		},
		candidates
	);

	return json({ purchaseId });
};
