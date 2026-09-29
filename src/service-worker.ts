/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
import { resolveDeepLink, type DeepLinkPayload } from '$lib/deep-link';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `assets-${version}`;

/*
 * What is precached on install — which is to say, downloaded onto every phone
 * the moment the app is installed or updated, whether it is ever used or not.
 *
 * It used to be every file the build emitted: 22 MB, most of it for things a
 * given household may never touch. Left out, and fetched normally when (if)
 * they are used:
 *  - WASM and its data: the barcode decoder, an alpha feature that is off by
 *    default, and Safari's fallback at that.
 *  - The PDF reader's worker (2.2 MB), for bill and statement import.
 *  - The marketing screenshots, which only the manifest's install sheet shows.
 * The app shell, fonts, icons and every route's code stay, which is what
 * offline actually needs.
 */
const ON_DEMAND = [/\.wasm$/, /\.data$/, /pdf\.worker/, /^\/screenshots\//];
const ASSETS = new Set([...build, ...files].filter((p) => !ON_DEMAND.some((re) => re.test(p))));

/*
 * The styled offline shell. It lives in static/ so it ships as an ordinary
 * file (and so it's already in `files` above), but it's named explicitly here
 * because it's the one asset the fetch handler reaches for by path rather than
 * by request.
 */
const OFFLINE_URL = '/offline.html';

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll([...ASSETS]))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE && k !== `pages-${version}`).map((k) => caches.delete(k))
				)
			)
			.then(() => sw.clients.claim())
	);
});

const PAGES = `pages-${version}`;

// Immutable build assets from cache. Navigations are network-first with the
// last successful copy as an offline fallback — read-only offline by design
// (iOS has no Background Sync, so there is no write queue to build).
sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== sw.location.origin) return;

	/*
	 * Basemap tiles go straight to the network and the HTTP cache, never into
	 * ours. They are same-origin only because the server proxies them, but they
	 * are third-party imagery in unbounded quantity: one pan session is hundreds
	 * of images, which would evict the app shell that makes this thing work
	 * offline at all. The route already sets its own long Cache-Control, and the
	 * map degrades to a plotted graticule when a tile doesn't arrive.
	 */
	if (url.pathname.includes('/tiles/')) return;

	if (ASSETS.has(url.pathname)) {
		event.respondWith(
			caches.open(CACHE).then(async (cache) => {
				const hit = await cache.match(event.request);
				return hit ?? fetch(event.request);
			})
		);
		return;
	}

	if (event.request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				const cache = await caches.open(PAGES);
				try {
					const fresh = await fetch(event.request);
					if (fresh.ok) void cache.put(event.request, fresh.clone()).then(() => trim(cache));
					return fresh;
				} catch {
					const cached = await cache.match(event.request);
					if (cached) return cached;
					// Never visited this URL before going offline. Serve the app's own
					// offline shell rather than a string literal — that fallback rendered
					// in the UA's default serif on white, the one screen that looked like
					// a browser error instead of like Ledger.
					const shell = await caches.match(OFFLINE_URL);
					return (
						shell ??
						new Response('<h1>Offline</h1><p>Reconnect to see your workspace.</p>', {
							status: 503,
							headers: { 'Content-Type': 'text/html' }
						})
					);
				}
			})()
		);
	}
});

/*
 * Whose pages these are.
 *
 * The navigation cache holds whole rendered pages — amounts, names, notes —
 * and it used to outlive the person who loaded them. On a shared iPad, signing
 * out and handing it over left the last person's ledger one lost connection
 * away from the next one, sealed gifts included, because the offline fallback
 * serves whatever is cached for the URL. So the app tells the worker who is
 * signed in (or that nobody is), and a change of person empties the cache
 * before anything else is served from it.
 */
const OWNER_KEY = '/__page-owner';

async function setPageOwner(id: string | null): Promise<void> {
	const cache = await caches.open(PAGES);
	const current = await (await cache.match(OWNER_KEY))?.text();
	if (current === (id ?? '')) return;
	await caches.delete(PAGES);
	if (id) await (await caches.open(PAGES)).put(OWNER_KEY, new Response(id));
}

/** Pages visited, newest last; the oldest go once there are more than this. */
const MAX_PAGES = 60;

async function trim(cache: Cache): Promise<void> {
	const keys = (await cache.keys()).filter((k) => new URL(k.url).pathname !== OWNER_KEY);
	for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(k);
}

sw.addEventListener('message', (event) => {
	const data = event.data as { type?: string; id?: string | null } | null;
	if (data?.type === 'page-owner') event.waitUntil(setPageOwner(data.id ?? null));
});

interface PushPayload extends DeepLinkPayload {
	title?: string;
	body?: string;
	tag?: string;
}

sw.addEventListener('push', (event) => {
	let payload: PushPayload;
	try {
		payload = event.data?.json() ?? {};
	} catch {
		payload = { body: event.data?.text() };
	}
	event.waitUntil(
		sw.registration.showNotification(payload.title ?? 'Ledger', {
			body: payload.body,
			tag: payload.tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			data: { url: resolveDeepLink(payload, sw.location.origin) }
		})
	);
});

// Notifications are deep links, not action surfaces (iOS action support is thin).
sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	// Same-origin by construction: stored as a path, resolved here.
	const url = new URL(event.notification.data?.url ?? '/', sw.location.origin).href;
	event.waitUntil(
		sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if (client.url.startsWith(sw.location.origin)) {
					client.navigate(url);
					return client.focus();
				}
			}
			return sw.clients.openWindow(url);
		})
	);
});
