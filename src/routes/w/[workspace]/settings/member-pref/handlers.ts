import type { WorkspaceContext } from '$lib/ports/context';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { isDiscretionMode } from '$lib/domain/visibility/discretion';
import { workspaceMember } from '$lib/db/schema';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * The member-flag endpoint's sibling for prefs that aren't booleans — same
 * shape, same whitelist discipline: both the key and its value are checked
 * against the domain before anything reaches a column.
 */
export async function POST(ctx: WorkspaceContext, { request }: { request: Request }) {
	assertSameOrigin(request);
	const body = await request.json().catch(() => null);
	const pref = body?.pref;
	const value = body?.value;

	const updates: Partial<typeof workspaceMember.$inferInsert> = {};
	if (pref === 'safeToSpendDisplay') {
		if (!isDiscretionMode(value)) error(400, 'Unknown display mode');
		updates.safeToSpendDisplay = value;
	} else error(400, 'Unknown setting');

	await ctx.db.update(workspaceMember).set(updates).where(eq(workspaceMember.id, ctx.member.id));
	return json({ ok: true });
}
