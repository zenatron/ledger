import { error, fail, isActionFailure, isRedirect } from '@sveltejs/kit';
import { publishChange } from '$lib/infra/events/bus';
import type { WorkspaceContext } from '$lib/ports/context';
import { isMalformedInputError } from '$lib/server/db/errors';

/**
 * Bind a workspace route's neutral handlers to the server's request context.
 *
 * `hooks.server.ts` has already resolved session → user → membership and put
 * the composed ports on locals, so this is a projection, not a lookup. The
 * non-null assertions are safe for exactly that reason: SvelteKit only reaches
 * a `/w/[workspace]` route after the hook has set all four, or 404'd.
 */
export function wsContext(locals: App.Locals): WorkspaceContext {
	return {
		db: locals.db,
		deps: locals.deps,
		user: locals.user!,
		workspace: locals.workspace!,
		member: locals.member!
	};
}

/** A ctx-taking handler, seen as SvelteKit sees it once the ctx is bound. */
type Bound<F> = F extends (ctx: WorkspaceContext, event: infer E) => infer R
	? (event: E) => R
	: never;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (ctx: WorkspaceContext, event: any) => any;

/**
 * `export const GET = bindEndpoint(h.GET)`
 *
 * The same binding as a page's, for `+server.ts`. Endpoints answer with a
 * Response rather than data, but they are otherwise the same shape — and the
 * demo needs them just as much, since a handful of the app's interactions
 * (ledger paging, the settings switches) are plain fetches rather than forms.
 */
export function bindEndpoint<F extends Handler>(fn: F): Bound<F> {
	return bindLoad(fn);
}

/*
 * An id off a URL or a form that isn't one.
 *
 * Every id column is a Postgres `uuid`, and a value that isn't shaped like one
 * is refused at the cast rather than matching nothing — so a mistyped link, a
 * stale bookmark, or a hand-edited form field surfaced as a 500 with a stack
 * trace. Caught once, here, rather than at the thirty-odd places an id comes
 * in: nothing was written (the statement failed before touching a row), so a
 * load answers the truth, "not found", and an action says the thing it was
 * pointed at doesn't exist.
 */

/** `export const load = bindLoad(h.load)` */
export function bindLoad<F extends Handler>(fn: F): Bound<F> {
	return (async (event: Parameters<F>[1]) => {
		try {
			return await fn(wsContext(event.locals), event);
		} catch (e) {
			if (isMalformedInputError(e)) error(404, 'Not found');
			throw e;
		}
	}) as Bound<F>;
}

function bindAction<F extends Handler>(fn: F, announce: boolean): Bound<F> {
	return (async (event: Parameters<F>[1]) => {
		const workspaceId = (event.locals as App.Locals).workspace?.id;
		try {
			const result = await fn(wsContext(event.locals), event);
			if (announce && workspaceId && !isActionFailure(result)) publishChange(workspaceId);
			return result;
		} catch (e) {
			if (isMalformedInputError(e)) return fail(400, { error: "That doesn't exist any more." });
			// A redirect is how an action says it succeeded and moved on.
			if (announce && workspaceId && isRedirect(e)) publishChange(workspaceId);
			throw e;
		}
	}) as Bound<F>;
}

/**
 * `export const actions = bindActions(h.actions)`
 *
 * The mapped return type is what keeps `ActionData` inference alive — a plain
 * `Record<string, Function>` here would erase each action's return type and
 * quietly turn `form?.error` into `any` in every component.
 */
export function bindActions<A extends Record<string, Handler>>(
	actions: A,
	/**
	 * Tell every open page in the workspace that something changed once an
	 * action succeeds, so a partner's Plan or Buckets screen refreshes the way
	 * the ledger already does for purchases. Only for routes whose writes carry
	 * no seal: purchase actions announce themselves, through the seal filter.
	 */
	opts: { announce?: boolean } = {}
): { [K in keyof A]: Bound<A[K]> } {
	const out = {} as { [K in keyof A]: Bound<A[K]> };
	for (const key of Object.keys(actions) as (keyof A)[]) {
		out[key] = bindAction(actions[key], opts.announce ?? false) as Bound<
			A[keyof A]
		> as (typeof out)[keyof A];
	}
	return out;
}
