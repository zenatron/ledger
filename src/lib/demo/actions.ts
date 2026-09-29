import { isActionFailure, isRedirect, type ActionResult } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getDemoContext } from './context';
import type { WorkspaceContext } from '$lib/ports/context';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DemoAction = (ctx: WorkspaceContext, event: any) => any;

const registry = new Map<string, Record<string, DemoAction>>();

/** `/w/[workspace]/purchases/[id=uuid]` -> a matcher and the names it captures.
 *  A `=matcher` suffix names SvelteKit's param matcher, not the param, so it is
 *  dropped here: the server has already refused anything the matcher would. */
function toPattern(routeId: string) {
	const names: string[] = [];
	const source = routeId
		.replace(/[.*+?^${}()|\\]/g, '\\$&')
		.replace(/\[([^\]=]+)(?:=[^\]]+)?\]/g, (_m, name: string) => {
			names.push(name);
			return '([^/]+)';
		});
	return { re: new RegExp(`^${source}/?$`), names };
}

/**
 * Which route owns this path, and what its params are.
 *
 * Resolved from the *form's* action, not from the page the form is on. A form
 * may target another route entirely — the ledger's inline Approve posts to
 * `/w/<slug>/purchases/<id>?/approve` while sitting on `/w/<slug>/purchases` —
 * and keying on the current page silently looked up the wrong route's actions.
 *
 * Routes with fewer dynamic segments are tried first, so a literal like
 * `purchases/new` wins over `purchases/[id]`.
 */
function resolveRoute(pathname: string) {
	const ids = [...registry.keys()].sort(
		(a, b) => a.split('[').length - b.split('[').length || b.length - a.length
	);
	for (const id of ids) {
		const { re, names } = toPattern(id);
		const m = re.exec(pathname);
		if (!m) continue;
		const params: Record<string, string> = {};
		names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
		return { id, actions: registry.get(id)!, params };
	}
	return null;
}

/**
 * Called by each generated `+page.ts` at module load, so a form submitted on
 * that route can find its handlers without the form knowing anything about
 * routing. Keyed by SvelteKit's route id, which is what `page.route.id` gives
 * us at submit time.
 */
export function registerDemoActions(routeId: string, actions: Record<string, DemoAction>): void {
	registry.set(routeId, actions);
}

/**
 * Run a form action in the tab, and answer in the shape the server would have.
 *
 * `use:submit` normally POSTs to `?/name` and gets an ActionResult back. There
 * is nothing to POST to here, so this calls the very same action function the
 * server binds and maps its outcome onto the same three cases: a returned
 * object is a success, `fail()` is a failure, and `redirect()` throws and comes
 * back as a redirect. Everything downstream — toasts, `form.error`, pending
 * state — is then identical to the server path, which is why none of the 67
 * forms in the app needed touching.
 */
export async function runDemoAction(action: URL, formData: FormData): Promise<ActionResult> {
	const hit = resolveRoute(action.pathname);
	if (!hit) {
		return {
			type: 'error',
			status: 404,
			error: new Error(`demo: no actions registered for ${action.pathname}`)
		};
	}
	const { actions, params } = hit;

	// SvelteKit names the action in the query string: `?/create`. A bare `?/`
	// (or nothing at all) means the default action.
	const named = action.search.startsWith('?/') ? action.search.slice(2) : '';
	const name = named || 'default';
	const fn = actions[name];
	if (!fn) {
		return {
			type: 'error',
			status: 404,
			error: new Error(`demo: ${hit.id} has no action "${name}"`)
		};
	}

	try {
		// The workspace comes from the action's own path, so a form posted from
		// one workspace cannot write into another.
		const ctx = await getDemoContext(base, params.workspace);
		const request = new Request(action, { method: 'POST', body: formData });
		// Params come from matching the action's own path, so an action on a
		// dynamic route gets its `params.id` however it was reached.
		const data = await fn(ctx, { request, params, url: action });

		if (isActionFailure(data)) {
			return {
				type: 'failure',
				status: data.status,
				data: data.data as Record<string, unknown> | undefined
			};
		}
		return { type: 'success', status: 200, data: data ?? undefined };
	} catch (e) {
		if (isRedirect(e))
			return { type: 'redirect', status: e.status, location: withBase(e.location) };
		return { type: 'error', status: 500, error: e };
	}
}

/**
 * Handlers redirect to server paths, because on the server that is what they
 * are: `deleteWorkspace` sends you to `/`. A demo served from a subpath
 * (DEMO_BASE) has to carry that prefix, and no handler knows about it. Nothing
 * to do when the demo sits at the root, which is how it is deployed.
 */
function withBase(location: string): string {
	if (!base || !location.startsWith('/') || location.startsWith(`${base}/`)) return location;
	return `${base}${location}`;
}
