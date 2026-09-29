import { building } from '$app/environment';
import {
	error,
	redirect,
	type Handle,
	type HandleServerError,
	type ServerInit
} from '@sveltejs/kit';
import { closeDb, getDb } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { getEnv } from '$lib/server/env';
import {
	SESSION_COOKIE,
	clearSessionCookie,
	createSession,
	setActiveWorkspace,
	setSessionCookie,
	validateSession
} from '$lib/server/auth/session';
import { findWorkspaceForMember } from '$lib/repo/workspaces';
import { rateLimitOk } from '$lib/server/rate-limit';
import { audit } from '$lib/server/audit';
import { unsealDuePurchases } from '$lib/application/unseal-due';
import { releaseDueHolds } from '$lib/application/release-holds';
import { nudgeStaleRequests } from '$lib/application/nudge-stale';
import { sendDueSummaries } from '$lib/application/summary-digest';
import { sendSafeToSpendAlerts } from '$lib/application/safe-to-spend-alerts';
import { materializeDueRules } from '$lib/application/recurring';
import { checkBudgetAlerts } from '$lib/application/budget-alerts';
import { materializeBucketAccruals } from '$lib/application/buckets';
import { sweepExpiredShares } from '$lib/repo/shares';
import { deleteExpiredSessions } from '$lib/server/auth/session';
import { systemClock } from '$lib/infra/time/system-clock';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { isMalformedInputError } from '$lib/server/db/errors';
import { serverDeps } from '$lib/server/deps';
import { openSecret } from '$lib/server/secrets';
import { getNotifier } from '$lib/server/notify';
import { user } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const init: ServerInit = async () => {
	if (building) return;
	const env = getEnv(); // fail fast on bad configuration
	await runMigrations(env.DATABASE_URL, env.MIGRATIONS_DIR);
	console.log(JSON.stringify({ level: 'info', msg: 'boot: migrations up to date' }));

	// ntfy links are absolute — it's a third-party app with no origin of its own —
	// so a stale PUBLIC_ORIGIN sends people to localhost from their phone. Web push
	// resolves paths in the service worker and is immune, but say so either way:
	// the default is localhost, which makes this easy to ship by accident.
	if (
		!env.DEV_MODE &&
		/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(env.PUBLIC_ORIGIN)
	) {
		console.log(
			JSON.stringify({
				level: 'warn',
				msg: 'boot: PUBLIC_ORIGIN points at localhost — ntfy notification links will not open off-device',
				origin: env.PUBLIC_ORIGIN
			})
		);
	}

	// A sweep that outruns its interval must not stack: overlapping runs race each
	// other over the same due rows and each one holds a pool connection.
	let sweeping = false;
	const sweep = async () => {
		if (sweeping) {
			console.log(JSON.stringify({ level: 'warn', msg: 'sweep: skipped, previous still running' }));
			return;
		}
		sweeping = true;
		try {
			await runSweep();
		} finally {
			sweeping = false;
		}
	};

	/*
	 * Each job is independent: one failing must not stop the rest, and each
	 * reports only when it did something. A table rather than nine copies of
	 * the same try/catch, so a new job can't be added without its logging.
	 */
	const jobs: { name: string; done: string; run: () => Promise<number> }[] = [
		{
			name: 'unseal',
			done: 'seals opened',
			run: () => unsealDuePurchases(getDb(), serverDeps())
		},
		{
			name: 'recurring',
			done: 'recurring generated',
			run: () => materializeDueRules(getDb(), serverDeps())
		},
		{ name: 'nudge', done: 'nudges sent', run: () => nudgeStaleRequests(getDb(), serverDeps()) },
		{ name: 'holds', done: 'holds ready', run: () => releaseDueHolds(getDb(), serverDeps()) },
		{
			name: 'budget alerts',
			done: 'budget alerts sent',
			run: () => checkBudgetAlerts(getDb(), serverDeps())
		},
		{
			name: 'safe-to-spend alerts',
			done: 'safe-to-spend alerts sent',
			run: () => sendSafeToSpendAlerts(getDb(), serverDeps())
		},
		{
			name: 'summaries',
			done: 'summaries sent',
			run: () => sendDueSummaries(getDb(), serverDeps())
		},
		{
			name: 'bucket accrual',
			done: 'bucket accruals',
			run: () => materializeBucketAccruals(getDb(), serverDeps())
		},
		{
			name: 'share cleanup',
			done: 'shares expired',
			run: () => sweepExpiredShares(getDb(), serverDeps().clock.now())
		},
		{
			name: 'session cleanup',
			done: 'sessions expired',
			run: () => deleteExpiredSessions(getDb())
		}
	];

	const runSweep = async () => {
		for (const job of jobs) {
			try {
				const count = await job.run();
				if (count > 0) {
					console.log(JSON.stringify({ level: 'info', msg: `sweep: ${job.done}`, count }));
				}
			} catch (e) {
				console.log(
					JSON.stringify({
						level: 'error',
						msg: `sweep: ${job.name} failed`,
						err: (e as Error).message
					})
				);
			}
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => void sweep().finally(schedule), SWEEP_INTERVAL_MS);
	};
	// The first sweep runs in the background, not before the server answers. It
	// sends notifications to third-party hosts, and a slow push service used to
	// hold the whole app — healthcheck included — behind it on every boot.
	void sweep().finally(schedule);

	// Without this the pending timer keeps the process alive past SIGTERM and
	// the container waits out Docker's 10s kill timeout on every deploy. The
	// pool is drained too, so in-flight queries finish rather than being cut.
	const shutdown = () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		// Deliveries run after their request has answered and read the database
		// as they go, so they finish before the pool is closed under them.
		void getNotifier()
			.settled()
			.finally(() => closeDb());
	};
	process.once('SIGTERM', shutdown);
	process.once('SIGINT', shutdown);
};

const WORKSPACE_PATH = /^\/w\/([^/]+)(?:\/|$)/;
/** A last path segment with an extension (`icon.png`, `export.csv`) — the shape
 *  extension-keyed proxy caches store without regard to cookies. */
const FILE_LIKE_PATH = /\.[A-Za-z0-9]+$/;
/** Session+device pairs already logged as mismatched, so a hijacked session
 *  writes one row rather than one per request. Per process, bounded. */
const mismatchSeen = new Set<string>();

/**
 * Single authorization layer: resolves session → user → (for /w/ routes)
 * workspace membership onto locals. Routes never re-derive any of this.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Abuse damping: auth endpoints per IP, image uploads per session.
	if (event.url.pathname.startsWith('/auth/')) {
		if (!rateLimitOk(`auth:${event.getClientAddress()}`, 10, 60_000)) {
			error(429, 'Too many attempts — wait a minute');
		}
	}
	if (event.request.method === 'POST' && event.url.search.includes('/addImage')) {
		const key = `upload:${event.cookies.get('sid') ?? event.getClientAddress()}`;
		if (!rateLimitOk(key, 30, 3_600_000)) {
			error(429, 'Too many uploads — try again later');
		}
	}
	// The OS share-target posts full photos here with no app markup involved,
	// so nothing else damps it. Blob storage is append-only with no GC — a
	// scripted member could otherwise fill the disk a photo at a time.
	if (event.request.method === 'POST' && event.url.pathname === '/share') {
		if (
			!rateLimitOk(`share:${event.cookies.get('sid') ?? event.getClientAddress()}`, 10, 3_600_000)
		) {
			error(429, 'Too many shares — try again later');
		}
	}

	event.locals.user = null;
	event.locals.session = null;
	event.locals.workspace = null;
	event.locals.member = null;
	// The composition root: bind the ports to their server adapters once, here,
	// so no route module has to name a concrete implementation.
	event.locals.db = getDb();
	event.locals.deps = serverDeps();

	const sid = event.cookies.get(SESSION_COOKIE);
	if (sid) {
		// Shape-check before the lookup: ids are base64url from randomBytes(32),
		// so anything else is junk and shouldn't cost a database round trip.
		const wellFormed = sid.length <= 128 && /^[A-Za-z0-9_-]+$/.test(sid);
		const hit = wellFormed ? await validateSession(getDb(), sid) : null;
		// The session cookie is written as rarely as possible, and never on a URL
		// that looks like a file. A shared cache in front of the app (Nginx Proxy
		// Manager's "Cache Assets" is the one that bit us) stores .png/.js/.ico
		// responses per URL, Set-Cookie included, and replays them to everyone:
		// iOS asks for /apple-touch-icon.png on its own, so a signed-in 404 there
		// handed one person's sid to the next phone, and a cleared one logged
		// every phone out. Ordinary requests carry no Set-Cookie at all now.
		const cookieSafe = !FILE_LIKE_PATH.test(event.url.pathname);
		if (hit) {
			event.locals.user = hit.user;
			event.locals.session = hit.session;
			// Keep the cookie's expiry in step with sliding renewal — only when it
			// actually moved, which is at most once per half-TTL.
			if (hit.renewed && cookieSafe) {
				// The cookie keeps the token; the row id is only its hash.
				setSessionCookie(event.cookies, sid, hit.session.expiresAt);
			}
			// A session presented by a different device than it was issued to is
			// what a stolen cookie looks like. Recorded, not refused: a browser
			// update changes the user agent too, and locking people out on that
			// would be worse than a line in the log. Once per session and device.
			const ua = event.request.headers.get('user-agent');
			if (hit.session.userAgent && ua && ua !== hit.session.userAgent) {
				const key = `${hit.session.id}\n${ua}`;
				if (!mismatchSeen.has(key)) {
					if (mismatchSeen.size >= 10_000) mismatchSeen.clear();
					mismatchSeen.add(key);
					await audit(event, {
						action: 'session.device_mismatch',
						workspaceId: null,
						detail: { path: event.url.pathname }
					});
				}
			}
		} else if (cookieSafe) {
			clearSessionCookie(event.cookies);
		}
	}

	// Dev mode bypass: auto-create user + session when Pocket ID isn't running.
	const env = getEnv();
	if (env.DEV_MODE && !event.locals.user) {
		const devSub = 'dev-user';
		const now = systemClock.now();
		const [existing] = await getDb()
			.select()
			.from(user)
			.where(eq(user.oidcSubject, devSub))
			.limit(1);
		let devUser;
		if (existing) {
			devUser = existing;
			await getDb().update(user).set({ lastLoginAt: now }).where(eq(user.id, existing.id));
		} else {
			[devUser] = await getDb()
				.insert(user)
				.values({
					id: uuidv7.newId(),
					oidcSubject: devSub,
					email: env.DEV_USER_EMAIL,
					displayName: env.DEV_USER_NAME,
					createdAt: now,
					lastLoginAt: now
				})
				.returning();
		}
		const { session: sess, token } = await createSession(getDb(), devUser.id, {
			userAgent: event.request.headers.get('user-agent'),
			ip: event.getClientAddress()
		});
		event.locals.user = devUser;
		event.locals.session = sess;
		setSessionCookie(event.cookies, token, sess.expiresAt);
		// If on the landing page, redirect to welcome so the user can set up.
		if (event.url.pathname === '/') redirect(303, '/welcome');
	}

	const match = WORKSPACE_PATH.exec(event.url.pathname);
	if (match) {
		if (!event.locals.user) redirect(303, '/');
		const ctx = await findWorkspaceForMember(getDb(), match[1], event.locals.user.id);
		// 404, not 403: don't reveal which workspace slugs exist.
		if (!ctx) error(404, 'Not found');
		// Stored encrypted when SECRETS_KEY is set; opened once, here, so no
		// route ever sees ciphertext or has to know it could.
		event.locals.workspace = { ...ctx.workspace, aiApiKey: openSecret(ctx.workspace.aiApiKey) };
		event.locals.member = ctx.member;
		if (event.locals.session && event.locals.session.activeWorkspaceId !== ctx.workspace.id) {
			await setActiveWorkspace(getDb(), event.locals.session.id, ctx.workspace.id);
		}
	}

	const response = await resolve(event);
	for (const [name, value] of SECURITY_HEADERS) {
		if (response.headers.has(name)) continue;
		try {
			response.headers.set(name, value);
		} catch {
			// A Response passed through from fetch() has immutable headers; it is
			// someone else's bytes (a map tile) and carries its own.
		}
	}
	return response;
};

/**
 * Headers every response carries, alongside the CSP SvelteKit sets.
 *
 * - nosniff: blobs are served by id with a declared type; a browser must not
 *   second-guess it into something executable.
 * - Referrer-Policy same-origin: URLs here name workspaces and purchases, and
 *   none of that should ride along to the one outside link a note contains.
 * - Permissions-Policy: the camera (receipts, barcodes) and location (places)
 *   are the app's own to ask for; nothing embedded may, and the rest is off.
 */
const SECURITY_HEADERS: [string, string][] = [
	['X-Content-Type-Options', 'nosniff'],
	['Referrer-Policy', 'same-origin'],
	['Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()'],
	['Cross-Origin-Opener-Policy', 'same-origin']
];

/**
 * Anything a route didn't handle, logged as one JSON line like the rest of the
 * server's output, with an id the error page shows so a report can be matched
 * to its line. The message sent to the browser is generic: a stack or a SQL
 * statement is for the operator, not for whoever hit the error.
 *
 * A malformed id that got past the handler bindings is still the caller's
 * input, not a fault, so it is logged at warn and not as an error.
 */
export const handleError: HandleServerError = ({ error: err, event, status, message }) => {
	const id = uuidv7.newId();
	const malformed = isMalformedInputError(err);
	console.log(
		JSON.stringify({
			level: malformed || status < 500 ? 'warn' : 'error',
			msg: malformed ? 'request: malformed input' : 'request: unhandled error',
			errorId: id,
			status,
			method: event.request.method,
			route: event.route.id,
			err: err instanceof Error ? err.message : String(err),
			stack: !malformed && err instanceof Error ? err.stack : undefined
		})
	);
	return { message: malformed ? 'Not found' : message, errorId: id };
};
