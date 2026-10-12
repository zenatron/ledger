import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Domain and infra unit tests only — pure TS, no Svelte compilation needed.
// E2E flows are covered by Playwright separately.
//
// $lib is aliased because SvelteKit only resolves it during a Kit build, and a
// module under test that imports through it would otherwise be untestable —
// which is why money-format had no unit tests until now.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		// `scripts/` holds repo-wide invariants that are lints rather than unit
		// tests — they read the source tree instead of importing from it. They run
		// here because `npm test` is what actually gets run in this project.
		include: ['src/lib/**/*.test.ts', 'scripts/**/*.test.ts'],
		environment: 'node',
		// The database-backed tests build a fresh PGlite and replay every
		// migration per test, and the first in a file also compiles the WASM
		// engine. Under parallel load that setup alone ran past the 5s default,
		// so tests failed before their first assertion and passed when rerun
		// alone. The budget is for setup on a busy machine, not for slow logic.
		testTimeout: 20_000
	}
});
