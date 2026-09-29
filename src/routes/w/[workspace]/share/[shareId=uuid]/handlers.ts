import { error } from '@sveltejs/kit';
import type { WorkspaceContext } from '$lib/ports/context';
import { loadShare } from '$lib/repo/shares';

/**
 * Serves a staged share photo to the member who shared it — the one blob
 * route that is not gated on purchase attachment, because the whole point of
 * a share is that no purchase exists yet. Scoped to workspace + member, and
 * only within the share's one-hour window, so this is strictly narrower than
 * the purchase-gated route it sits beside.
 */
export async function GET(ctx: WorkspaceContext, { params }: { params: Record<string, string> }) {
	const share = await loadShare(
		ctx.db,
		{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
		params.shareId,
		ctx.deps.clock.now()
	);
	if (!share) error(404, 'Not found');

	const data = await ctx.deps.blobs.get(share.blobId);
	if (!data) error(404, 'Not found');

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': share.contentType,
			// One-hour staging: caching past it would outlive the sweep that
			// deletes the row (and the blob id with it).
			'Cache-Control': 'private, max-age=3600'
		}
	});
}
