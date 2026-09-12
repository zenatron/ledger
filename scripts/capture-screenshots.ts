/**
 * Captures the app screenshots — for the manifest's richer install UI and, as
 * the same subjects, the README's gallery. Run `bun run demo:build` first: the
 * script shoots the demo build against a throwaway local server, because the
 * demo's seeded household is the only subject that is both realistic and
 * reproducible (no live server, no real money, no flaky login).
 *
 *   bun run demo:build && bun scripts/capture-screenshots.ts
 *
 * Output: static/screenshots/*.png (manifest) and docs/screenshots/*.png
 * (README). Committed output, like the icons from gen-icons.ts — rerun on
 * redesign, not on every build.
 *
 * Two things the earlier version got wrong, both about size. The viewport was
 * 540×1170, which is wider and far taller than any iPhone, so the app laid
 * itself out at proportions no phone ever shows and every shot read as zoomed
 * out. And a page was shot wherever it happened to load, which put the fold in
 * the middle of a list on the pages whose point is further down. This one uses
 * a real iPhone viewport and says, per subject, where to look.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import postgres from 'postgres';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DEMO_DIR = `${ROOT}/build-demo`;
if (!existsSync(`${DEMO_DIR}/index.html`)) {
	console.error('No build-demo/ — run `bun run demo:build` first.');
	process.exit(1);
}

/**
 * iPhone 15 Pro's logical viewport. The number that matters is the 393: it is
 * what the app's breakpoints and type see, and it is why these read as a phone
 * rather than as a narrow desktop. Captured at 2x, which is retina-crisp in a
 * README without the file size of the panel's native 3x.
 */
const VIEWPORT = { width: 393, height: 852 };
/**
 * Retina. This belongs at the context level, not inside `viewport` — Playwright
 * silently ignores it there, which is why every screenshot this script has ever
 * produced was 1x despite asking for 2x.
 */
const SCALE = 2;
/** Screen corner radius, in CSS pixels, scaled with the shot. */
const CORNER_RADIUS = 44;
const WAIT_AFTER_LOAD_MS = 1200;
/** Lossless, and worth the extra seconds for bytes that are committed. */
const PNG_OPTS = { compressionLevel: 9, effort: 10 } as const;

/** Serve the static demo with an SPA fallback (every path hydrates index.html). */
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		const clean = decodeURIComponent(pathname).replace(/\.\./g, '');
		for (const candidate of [`${DEMO_DIR}${clean}`, `${DEMO_DIR}${clean}/index.html`]) {
			const file = Bun.file(candidate);
			if (await file.exists()) return new Response(file);
		}
		return new Response(Bun.file(`${DEMO_DIR}/index.html`));
	}
});
const origin = `http://localhost:${server.port}`;

const browser = await chromium.launch();
const context = await browser.newContext({
	viewport: VIEWPORT,
	deviceScaleFactor: SCALE,
	colorScheme: 'light',
	locale: 'en-US',
	timezoneId: 'UTC',
	isMobile: true,
	hasTouch: true,
	// The app's own CSP (style-src-elem 'self') would rightly drop the injected
	// <style> below; bypassing it changes no pixels the app itself renders.
	bypassCSP: true
});
const page = await context.newPage();

// The demo banner is a fact about the demo, not about the app; a screenshot
// that says "Demo" on it sells the demo. The scrollbar is a fact about
// headless Chromium — a phone has none, and one running down the edge of every
// shot is the tell that gives away that this isn't a phone. Injected
// per-navigation, since a style added to one document dies with it.
await page.addInitScript(() => {
	const add = () => {
		const style = document.createElement('style');
		style.textContent =
			'.demo-banner { display: none !important; } ::-webkit-scrollbar { display: none !important; }';
		document.head.append(style);
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
	else add();
});

// Establish the origin before the first shot: localStorage (theme) is set per
// subject below, and a blank document refuses it.
await page.goto(origin, { waitUntil: 'domcontentloaded' });

interface Shot {
	/** File stem, shared by the manifest copy and the README copy. */
	name: string;
	url: string;
	theme: 'light' | 'dark';
	/** What the install sheet calls it. Absent means README-only. */
	label?: string;
	/**
	 * Put this text on screen before shooting. The subject of a shot is often
	 * below the fold — settle-up sits under the category breakdown — and a
	 * screenshot of the scroll position a page happens to load at is a
	 * screenshot of nothing in particular.
	 */
	scrollTo?: string;
	/** Click this text first, for the panels that open on demand. */
	click?: string;
	/**
	 * Type into fields before shooting, by placeholder. An empty form is a
	 * screenshot of a form; a filled one is a screenshot of using the app.
	 */
	fill?: [placeholder: string, value: string][];
	/** Type this into the command palette and wait for the answer. */
	ask?: string;
	/**
	 * Set the workspace's accent to this hex before shooting. Server pass only,
	 * and it writes the real column: the accent is one stored value that every
	 * other token derives from in CSS, and the picker's tick reads that same
	 * value. Overriding the variable would recolor the chrome and leave the
	 * wrong swatch ticked, which is a picture of a state the app cannot be in.
	 */
	accent?: string;
}

/**
 * Deliberately more than the four this used to ship. Four covered the loop a
 * purchase goes through and nothing else, which left the planning half of the
 * app — buckets, recurring, income, budgets — invisible to anyone deciding
 * whether to run it.
 */
const SHOTS: Shot[] = [
	{
		name: 'ledger',
		url: '/w/demo/purchases',
		theme: 'light',
		label: 'The ledger with Safe to Spend'
	},
	{
		name: 'safe-to-spend',
		url: '/w/demo/purchases',
		theme: 'light',
		label: "What's actually free to spend",
		click: 'Safe to spend'
	},
	// approval.png is inserted here at runtime: its id comes from the seed.
	{
		name: 'new',
		url: '/w/demo/purchases/new',
		theme: 'dark',
		label: 'Log a purchase as it happens',
		fill: [
			['0', '42.80'],
			['What did you buy?', 'Dinner out'],
			['Who did you pay?', 'Trattoria Nove']
		]
	},
	{
		name: 'activity',
		url: '/w/demo/analytics',
		theme: 'dark',
		label: 'Where the money went'
	},
	{
		name: 'settle-up',
		url: '/w/demo/analytics',
		theme: 'light',
		label: 'Who owes whom',
		scrollTo: 'Settle up'
	},
	{
		name: 'buckets',
		url: '/w/demo/buckets',
		theme: 'light',
		label: 'Money set aside, on a schedule'
	},
	{
		name: 'recurring',
		url: '/w/demo/recurring',
		theme: 'dark',
		label: 'Bills that arrive on their own'
	},
	{
		name: 'income',
		url: '/w/demo/income',
		theme: 'light',
		label: 'What comes in',
		// Opened, or the bottom half of the shot is the empty space under a
		// collapsed section — and what is worth showing is that the two are split.
		click: 'Past income'
	},
	{
		name: 'statement',
		url: '/w/demo/statement',
		theme: 'dark',
		label: 'The month, read back to you'
	},
	{
		name: 'calendar',
		url: '/w/demo/calendar',
		theme: 'dark',
		label: 'What is coming, and when'
	}
	// The theme and accent shots live in the server pass: varying the accent
	// means writing the column it is stored in, and the demo's database is a
	// baked snapshot with one value in it.
];

/**
 * Pages the demo build has no server for, so they are shot against a running
 * dev instance instead: `bun scripts/capture-screenshots.ts --server <origin>`.
 *
 * Kept apart from the list above on purpose. The demo pass needs nothing but
 * this repo and reproduces byte for byte; this pass needs Postgres, a seeded
 * workspace and DEV_MODE. Folding them together would make the cheap, certain
 * half of the job depend on the expensive, environmental half.
 */
const SERVER_WS = process.env.CAPTURE_SERVER_WS ?? 'demo';
const SERVER_SHOTS: Shot[] = [
	{
		name: 'harmony',
		url: `/w/${SERVER_WS}/purchases`,
		theme: 'light',
		// The palette's own button, then a question its local parser answers with
		// no model configured — which is the honest demonstration, since that is
		// what every install does out of the box.
		click: 'Ask Harmony',
		ask: 'how much did I spend on groceries this month'
	},
	{
		name: 'assist',
		url: `/w/${SERVER_WS}/settings/intelligence`,
		theme: 'light',
		scrollTo: 'AI assistance'
	},
	{
		name: 'members',
		url: `/w/${SERVER_WS}/settings/members`,
		theme: 'light',
		click: 'Policy'
	},
	{
		name: 'map',
		url: `/w/${SERVER_WS}/analytics/map`,
		theme: 'dark'
	},
	/*
	 * Four screens, four accents, two of each theme. The point of the set is
	 * that the accent is a workspace's own and the whole app follows it, which
	 * one screenshot in one color cannot show.
	 */
	{
		name: 'appearance',
		url: `/w/${SERVER_WS}/settings/appearance`,
		theme: 'light',
		accent: '#FF375F' // Magenta
	},
	{
		name: 'categories',
		url: `/w/${SERVER_WS}/settings/categories`,
		theme: 'light',
		accent: '#0D9E3A' // Evergreen
	},
	{
		name: 'appearance-dark',
		url: `/w/${SERVER_WS}/settings/appearance`,
		theme: 'dark',
		accent: '#0A84FF' // Azure
	},
	{
		name: 'ledger-dark',
		url: `/w/${SERVER_WS}/purchases`,
		theme: 'dark',
		accent: '#1795A9' // Cerulean
	},
	{
		name: 'reconcile',
		url: `/w/${SERVER_WS}/reconcile`,
		theme: 'light'
	},
	{
		name: 'api',
		url: `/w/${SERVER_WS}/settings/api`,
		theme: 'dark'
	},
	{
		name: 'notifications',
		url: `/w/${SERVER_WS}/settings/notifications`,
		theme: 'light'
	}
];

/*
 * The accent lives in a column, so varying it means writing that column. Opened
 * lazily and only when a shot asks for one, because the demo pass has no
 * database to talk to and must not require one.
 */
let sql: ReturnType<typeof postgres> | null = null;
let originalAccent: string | null = null;

async function setAccent(hex: string) {
	const url = process.env.CAPTURE_DB_URL ?? process.env.DATABASE_URL;
	if (!url) {
		console.warn(`  accent ${hex} not applied: set CAPTURE_DB_URL to the app's database`);
		return;
	}
	sql ??= postgres(url, { max: 1 });
	if (originalAccent === null) {
		const [row] = await sql`select accent_color from workspace where slug = ${SERVER_WS}`;
		originalAccent = row?.accent_color ?? '';
	}
	await sql`update workspace set accent_color = ${hex} where slug = ${SERVER_WS}`;
}

/** Put back whatever the workspace had, so capturing is not a mutation. */
async function restoreAccent() {
	if (!sql || originalAccent === null) return;
	await sql`update workspace set accent_color = ${originalAccent} where slug = ${SERVER_WS}`;
	await sql.end();
}

async function settle(page: Page) {
	await page.waitForTimeout(WAIT_AFTER_LOAD_MS);
	// One more frame after any scrolling, so transitions have landed.
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/**
 * `networkidle` for the static demo, where it usefully waits out PGlite's boot.
 * Never for a live server: the app holds an SSE stream open, so the network is
 * never idle and the wait can only time out.
 */
async function shoot(shot: Shot, at: string = origin) {
	const waitUntil = at === origin ? 'networkidle' : 'domcontentloaded';
	if (shot.accent) await setAccent(shot.accent);
	await page.evaluate((t) => {
		if (t === 'dark') localStorage.setItem('theme', 'dark');
		else localStorage.removeItem('theme');
	}, shot.theme);
	await page.goto(`${at}${shot.url}`, { waitUntil });
	await settle(page);

	for (const [placeholder, value] of shot.fill ?? []) {
		const field = page.getByPlaceholder(placeholder, { exact: false }).first();
		if (await field.isVisible().catch(() => false)) {
			await field.fill(value);
		} else {
			console.warn(`  ${shot.name}: no field placeholdered "${placeholder}"`);
		}
	}
	if (shot.fill) {
		// Blur, so the last field is not left with a caret and a focus ring.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await settle(page);
	}

	if (shot.click) {
		// By visible text, then by accessible name: the palette's trigger is an
		// icon with an aria-label and no text of its own, so text alone misses it.
		let target = page.getByText(shot.click, { exact: false }).first();
		if (!(await target.isVisible().catch(() => false))) {
			target = page.getByRole('button', { name: shot.click }).first();
		}
		if (await target.isVisible().catch(() => false)) {
			await target.click();
			await settle(page);
		} else {
			console.warn(`  ${shot.name}: nothing matching "${shot.click}" to click`);
		}
	}
	if (shot.ask) {
		const field = page.getByPlaceholder('Ask', { exact: false }).first();
		if (await field.isVisible().catch(() => false)) {
			await field.fill(shot.ask);
			await page.keyboard.press('Enter');
			// The local parser is synchronous, but a model-backed answer is not;
			// wait for either to land rather than for a fixed beat.
			await page
				.getByText(/spent|Nothing|couldn|sorry/i)
				.first()
				.waitFor({ timeout: 15_000 })
				.catch(() => console.warn(`  ${shot.name}: no answer appeared`));
			// The caret sits at the end of a long query, which scrolls the field so
			// the shot shows its tail. Put it back to the start.
			await field.evaluate((el: HTMLInputElement) => {
				el.scrollLeft = 0;
				el.blur();
			});
			await settle(page);
		} else {
			console.warn(`  ${shot.name}: the palette did not open`);
		}
	}
	if (shot.scrollTo) {
		const target = page.getByText(shot.scrollTo, { exact: false }).first();
		if (await target.isVisible().catch(() => false)) {
			// Into the upper third rather than dead centre: the thing you scrolled
			// for wants the space below it to show what it says.
			await target.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
			await page.evaluate(() => window.scrollBy(0, -80));
			await settle(page);
		} else {
			console.warn(`  ${shot.name}: nothing matching "${shot.scrollTo}" to scroll to`);
		}
	}

	/*
	 * Re-encoded rather than written straight from Playwright, which emits a
	 * fast, fat PNG: at level 9 these are less than half the size, losslessly,
	 * and twenty of them live in the repo forever.
	 */
	const raw = await page.screenshot();
	// The manifest copy exists only for the shots the install sheet names. The
	// rest are README-only, and shipping them in static/ would put half a
	// megabyte of unreferenced PNG into every deploy.
	if (shot.label) {
		await sharp(raw).png(PNG_OPTS).toFile(`${ROOT}/static/screenshots/${shot.name}.png`);
	}

	/*
	 * The README copy gets the phone's corners; the manifest copy does not.
	 * An install sheet renders these inside its own frame and wants real,
	 * full-bleed pixels at the size the manifest declares — rounding them there
	 * would punch transparent notches into somebody else's chrome. A README is
	 * a page, and a square-cornered screenshot on a page looks like a crop.
	 */
	// Measured, not computed: mobile emulation does not always hand back
	// width×dpr, and a mask even a pixel off is rejected outright.
	const shrunk = sharp(raw);
	const { width: w = 0, height: h = 0 } = await shrunk.metadata();
	const r = Math.round(CORNER_RADIUS * (w / VIEWPORT.width));
	const mask = Buffer.from(
		`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
	);
	await shrunk
		.composite([{ input: mask, blend: 'dest-in' }])
		.png(PNG_OPTS)
		.toFile(`${ROOT}/docs/screenshots/${shot.name}.png`);

	console.log('wrote', shot.name);
}

await mkdir(`${ROOT}/static/screenshots`, { recursive: true });
await mkdir(`${ROOT}/docs/screenshots`, { recursive: true });
// Stale files from an earlier, differently-named set would otherwise sit in the
// repo forever, referenced by nothing and quietly out of date.
/*
 * Orphans only. Everything this script still shoots is overwritten in place,
 * so a demo-only run leaves the server shots alone — clearing them up front
 * would delete images this run has no intention of replacing.
 */
const all = [...SHOTS, ...SERVER_SHOTS];
const inDocs = new Set(all.map((s) => `${s.name}.png`));
const inStatic = new Set(all.filter((s) => s.label).map((s) => `${s.name}.png`));
// approval is named at runtime, from the seed, and is in the manifest.
inDocs.add('approval.png');
inStatic.add('approval.png');
for (const [dir, keep] of [
	[`${ROOT}/static/screenshots`, inStatic],
	[`${ROOT}/docs/screenshots`, inDocs]
] as const) {
	for (const f of await readdir(dir)) {
		if (f.endsWith('.png') && !keep.has(f)) {
			await rm(`${dir}/${f}`);
			console.log('removed stale', f);
		}
	}
}

// The ledger first: it is both a subject and the place where the app is warm,
// so the pending-approval lookup below can use the page's own origin.
await shoot(SHOTS[0]);

// A pending purchase for the approval shot. The demo's own data endpoint is
// the honest source — scraping the DOM would couple this script to markup.
const pendingId = await page.evaluate(async () => {
	const res = await fetch('/w/demo/purchases/data?limit=200');
	if (!res.ok) return null;
	const json = (await res.json()) as {
		entries: { id: string; state: string; canDecide: boolean }[];
	};
	const hit = json.entries.find((e) => e.state === 'pending_approval' && e.canDecide);
	return hit?.id ?? null;
});

const captured: Shot[] = [SHOTS[0]];
if (pendingId) {
	const approval: Shot = {
		name: 'approval',
		url: `/w/demo/purchases/${pendingId}`,
		theme: 'light',
		label: 'An approval, one thumb away'
	};
	await shoot(approval);
	captured.push(approval);
} else {
	console.warn('no pending approval in the demo seed — skipped approval.png');
}
for (const shot of SHOTS.slice(1)) {
	await shoot(shot);
	captured.push(shot);
}

/*
 * The server pass. Skipped unless asked for, and loud about it: these images
 * stay in the repo whether or not they were refreshed, so a silent skip is how
 * a screenshot goes quietly out of date.
 */
const serverArg = process.argv.indexOf('--server');
const serverOrigin = serverArg >= 0 ? process.argv[serverArg + 1] : process.env.CAPTURE_SERVER;
if (serverOrigin) {
	const reachable = await fetch(serverOrigin)
		.then((r) => r.ok || r.status < 500)
		.catch(() => false);
	if (!reachable) {
		console.error(`\ncannot reach ${serverOrigin} — server shots not refreshed`);
	} else {
		console.log(`\nserver pass against ${serverOrigin}`);
		for (const shot of SERVER_SHOTS) {
			await shoot(shot, serverOrigin);
			captured.push(shot);
		}
	}
} else {
	console.warn(
		`\nskipped ${SERVER_SHOTS.length} server-only shots (${SERVER_SHOTS.map((s) => s.name).join(', ')}).` +
			'\nThey need a running instance: bun scripts/capture-screenshots.ts --server http://localhost:5173'
	);
}

await restoreAccent();
await browser.close();
server.stop(true);

/*
 * The manifest's screenshot list is generated from the same array that drove
 * the capture, so a shot cannot be added here and forgotten there — the two
 * used to be edited by hand and had already drifted on `sizes`.
 */
const paper = '#F4EEE1';
const espresso = '#201c17';
const shotSize = await sharp(`${ROOT}/static/screenshots/${captured[0].name}.png`).metadata();
const entries = captured
	.filter((s) => s.label)
	.map((s) => ({
		src: `/screenshots/${s.name}.png`,
		sizes: `${shotSize.width}x${shotSize.height}`,
		type: 'image/png',
		form_factor: 'narrow',
		label: s.label,
		theme_color: s.theme === 'dark' ? espresso : paper,
		background_color: s.theme === 'dark' ? espresso : paper
	}));

const manifestPath = `${ROOT}/static/manifest.webmanifest`;
const manifest = JSON.parse(await Bun.file(manifestPath).text());
// A partial run (no --server, or the seed had no pending approval) must not
// shrink the manifest: the shots it skipped stay committed on disk and in the
// store listing. Fresh entries replace their old versions in place; entries
// this run never took are kept as they were.
const freshBySrc = new Map(entries.map((e) => [e.src, e]));
const previous: Array<{ src: string }> = manifest.screenshots ?? [];
const untouched = new Set(previous.map((e) => e.src).filter((src) => !freshBySrc.has(src)));
const merged = [
	...previous.filter((e) => !untouched.has(e.src)).map((e) => freshBySrc.get(e.src) ?? e),
	...entries.filter((e) => !previous.some((p) => p.src === e.src))
];
manifest.screenshots = merged;
await Bun.write(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
console.log(
	`updated manifest with ${merged.length} screenshots` +
		(untouched.size ? ` (kept ${untouched.size} not captured this run)` : '')
);
