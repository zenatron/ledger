import type { WorkspaceContext } from '$lib/ports/context';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { workspace } from '$lib/db/schema';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * One tiny JSON endpoint behind every optimistic settings switch. It replaces
 * posting a form action over fetch, which leaned on SvelteKit's internal
 * action-response protocol and tripped up behind a proxy in production. A plain
 * JSON POST behaves identically in dev and prod, so a flipped switch always
 * lands — and because it is exempt from form-origin CSRF checks, it states its
 * own same-origin rule.
 *
 * Owner-only, and the flag is whitelisted — this value decides a workspace-wide
 * setting, so only the known boolean columns may be reached.
 */
export async function POST(ctx: WorkspaceContext, { request }: { request: Request }) {
	if (ctx.member.role !== 'owner') error(403, 'Only the owner can change this setting');

	assertSameOrigin(request);
	const body = await request.json().catch(() => null);
	const flag = body?.flag;
	const value = body?.value === true;

	const updates: Partial<typeof workspace.$inferInsert> = {};
	// `intelligenceEnabled` is deliberately absent: the column is read by nothing,
	// so accepting a write here would let a switch report a change it didn't make.
	if (flag === 'billImportEnabled') updates.billImportEnabled = value;
	else if (flag === 'bucketChargesSkipApproval') updates.bucketChargesSkipApproval = value;
	else if (flag === 'keepStatementFiles') updates.keepStatementFiles = value;
	else if (flag === 'safeToSpendAlertsEnabled') updates.safeToSpendAlertsEnabled = value;
	else if (flag === 'barcodeEnabled') {
		if (value && !ctx.deps.capabilities.barcode) {
			error(403, 'Barcode scanning requires BARCODE_LOOKUP_URL to be set in the environment');
		}
		updates.barcodeEnabled = value;
	} else if (flag === 'locationEnabled') {
		// Deliberately not gated on an environment variable, unlike barcode above.
		// Barcode scanning without a lookup URL does nothing; places without
		// MAP_TILE_URL or GEOCODER_URL still give you device capture, offline
		// map-link parsing, the "By place" breakdown and the whole map — those vars
		// only add streets and address search. Gating this would put the feature
		// out of reach of exactly the deployment that wants it most.
		updates.locationEnabled = value;
	} else if (flag === 'uniqueCategories') updates.uniqueCategories = value;
	else if (flag === 'settleUpEnabled') updates.settleUpEnabled = value;
	else error(400, 'Unknown setting');

	await ctx.db.update(workspace).set(updates).where(eq(workspace.id, ctx.workspace.id));
	return json({ ok: true });
}
