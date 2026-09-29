/**
 * What `@electric-sql/pglite` resolves to in the production build.
 *
 * Every path into PGlite is demo-only and sits behind `__DEMO__`, which the
 * bundler deletes. But Vite emits a module's `new URL('./x.wasm',
 * import.meta.url)` assets while it *transforms* the module, before that dead
 * code is dropped — so the server build shipped 16.8 MB of Postgres-in-WASM
 * that no page ever loaded, and the service worker precached all of it onto
 * every phone. Aliasing the package to this file in non-demo builds means there
 * is nothing to emit. See vite.config.ts.
 */
export class PGlite {
	constructor() {
		throw new Error('PGlite is only available in the demo build');
	}
}

/** drizzle-orm/pglite imports this name; it is only read when a session runs. */
export const types = {};
