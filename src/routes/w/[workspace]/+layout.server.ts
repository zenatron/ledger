import { getDb } from '$lib/server/db';
import { listWorkspacesForUser } from '$lib/repo/workspaces';
import { decisionQueueIds } from '$lib/repo/purchases';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, params }) => {
	// hooks.server.ts guarantees user/workspace/member on /w/ routes.
	const { user, workspace, member } = locals;
	const [memberships, decisions] = await Promise.all([
		listWorkspacesForUser(getDb(), user!.id),
		// The tab badge. Re-read whenever the page reloads, which live refresh
		// does on every change — so it moves as requests arrive and are answered.
		decisionQueueIds(getDb(), { workspaceId: workspace!.id, viewerId: member!.id }, new Date())
	]);
	return {
		user: {
			id: user!.id,
			displayName: user!.displayName,
			avatarBlobId: user!.avatarBlobId,
			avatarSource: user!.avatarSource
		},
		workspace: {
			id: workspace!.id,
			// From params, not locals: reading the route param is what tells
			// SvelteKit this load depends on the workspace in the URL. A load that
			// touches only `locals` declares no such dependency, so switching
			// workspace client-side reuses the previous one's cached data — the
			// whole page shows the old workspace until a full reload. Same value
			// either way (hooks resolves the workspace from this slug).
			slug: params.workspace,
			name: workspace!.name,
			currency: workspace!.currency,
			timezone: workspace!.timezone,
			accentColor: workspace!.accentColor,
			// Drives whether "Ask Harmony" accepts a free-text question: with a model
			// configured the palette can answer anything, so unrecognized input is
			// submittable; without one it stays a deterministic parser and only acts
			// on grammar it knows.
			assistEnabled: workspace!.aiMode !== 'off'
		},
		member: { id: member!.id, role: member!.role },
		decisionCount: decisions.length,
		workspaces: memberships.map((m) => ({
			slug: m.workspace.slug,
			name: m.workspace.name,
			accentColor: m.workspace.accentColor
		}))
	};
};
