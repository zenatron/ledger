import { defineConfig } from '@playwright/test';

/**
 * E2E for the security-critical flows: approval, sealing, and places — a
 * location is the most sensitive thing this app stores, so the seal has to hold
 * on every surface a pin can reach.
 * Requires the local postgres from `docker compose up -d db`.
 */
export default defineConfig({
	testDir: 'e2e',
	// Each spec drives two or three full OIDC round trips against a cold vite dev
	// server, which compiles routes on first hit. 60s ran out mid-test and the
	// failure surfaced as whatever step the clock happened to stop on.
	timeout: 180_000,
	// The fake IdP's "current user" is global state — no parallel workers.
	workers: 1,
	use: {
		baseURL: 'http://localhost:5174',
		// Headless Chromium stops producing animation frames when it considers the
		// window backgrounded or occluded — which it often does on a loaded dev
		// machine. Playwright's actionability check waits for two stable frames, so
		// with rAF stalled every click hangs until the test times out, reported as
		// "waiting for element to be visible, enabled and stable".
		launchOptions: {
			args: [
				'--disable-renderer-backgrounding',
				'--disable-backgrounding-occluded-windows',
				'--disable-features=CalculateNativeWinOcclusion'
			]
		}
	},
	webServer: [
		{
			command: 'bun scripts/dev-oidc.ts',
			port: 9443,
			reuseExistingServer: true
		},
		{
			command: 'bun run dev -- --port 5174 --strictPort',
			port: 5174,
			reuseExistingServer: false,
			env: {
				// Explicitly off: bun loads .env, where dev sets DEV_MODE=true. That
				// auto-logs-in a single fixed user, so every identity the fake IdP
				// switches to became the same person and the multi-user flows these
				// tests exist to cover silently collapsed.
				DEV_MODE: 'false',
				// Overridable so the suite can run while another project's postgres
				// owns 5432 (start one on another port and point this at it).
				DATABASE_URL:
					process.env.E2E_DATABASE_URL ?? 'postgres://root:mysecretpassword@localhost:5432/local',
				POCKET_ID_ISSUER: 'http://localhost:9443',
				POCKET_ID_CLIENT_ID: 'budget-e2e',
				POCKET_ID_CLIENT_SECRET: 'e2e-secret',
				OIDC_REDIRECT_URI: 'http://localhost:5174/auth/callback',
				PUBLIC_ORIGIN: 'http://localhost:5174',
				// Set to any URL to turn the geocoder capability on (typed-address
				// search); the specs that need candidates intercept /places/search in
				// the browser, so no provider is ever contacted. Absent = unchanged.
				...(process.env.E2E_GEOCODER_URL ? { GEOCODER_URL: process.env.E2E_GEOCODER_URL } : {})
			}
		}
	]
});
