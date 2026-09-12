import type { WorkspaceContext } from '$lib/ports/context';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { workspaceMember } from '$lib/db/schema';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * Like /settings/flag but for per-member boolean prefs — things that are a
 * personal display choice, not a workspace-wide setting. Whitelisted, same as
 * the workspace flag endpoint, so arbitrary columns can't be reached.
 */
export async function POST(ctx: WorkspaceContext, { request }: { request: Request }) {
	assertSameOrigin(request);
	const body = await request.json().catch(() => null);
	const flag = body?.flag;
	const value = body?.value === true;

	const updates: Partial<typeof workspaceMember.$inferInsert> = {};
	if (flag === 'includeLedgerMovements') updates.includeLedgerMovements = value;
	else if (flag === 'showRunwayMonths') updates.showRunwayMonths = value;
	else error(400, 'Unknown setting');

	await ctx.db.update(workspaceMember).set(updates).where(eq(workspaceMember.id, ctx.member.id));
	return json({ ok: true });
}
