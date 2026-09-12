import { error } from '@sveltejs/kit';

/**
 * The CSRF check for JSON POSTs. SvelteKit's form-action origin check covers
 * only form content types, and a `request.json()` body ignores Content-Type,
 * so every fetch endpoint states its own rule: the Origin header must name the
 * origin the request itself arrived at. Behind the documented topology the two
 * are the same — adapter-node rewrites request.url to the configured ORIGIN.
 *
 * Deliberately neutral (no `$lib/server` imports): the settings-switch
 * handlers this guards are the same ones the demo build runs in the browser,
 * and a server-only import there trips the build guard.
 *
 * A missing Origin means the request never came from a browser page — curl,
 * the demo's intercepted fetch — and SameSite=Lax already keeps those
 * cookieless, so there is nothing to check. The header check is the second
 * line, and the only one if that cookie attribute is ever relaxed.
 */
export function assertSameOrigin(request: Request): void {
	const origin = request.headers.get('origin');
	if (!origin) return;
	if (origin !== new URL(request.url).origin) {
		error(403, 'Cross-origin request rejected');
	}
}
