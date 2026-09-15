import { isValidCoords } from '$lib/domain/location/coords';
import type { Geocoder, GeocodeResult, GeocoderHealth } from '$lib/ports/geocoder';
import { isPublicNominatim } from './public';

/**
 * Nominatim-compatible forward geocoding.
 *
 * Two things this adapter takes seriously, both from the public instance's
 * usage policy: an identifiable `User-Agent` (anonymous clients are blocked
 * outright), and **at most one request per second**. The second is enforced
 * here rather than left to callers, because the consequence of getting it wrong
 * is the whole deployment's IP being banned — a failure mode that outlives the
 * request that caused it. The caller *also* debounces, and the two are
 * belt-and-braces on purpose.
 *
 * Nothing here throws. Every failure resolves to `[]`, per the port's contract.
 */

const MIN_INTERVAL_MS = 1000;
/*
 * How long a search will queue for its turn before giving up. Dropping a search
 * that arrived inside the interval — which is what this used to do — answers
 * it with `[]`, and the form shows that as "Nothing found" for an address that
 * exists. Two members searching at once, or a blur and a Save in quick
 * succession, were enough. A second and a half covers one search ahead; a
 * queue deeper than that is a client misbehaving, and still gets nothing.
 */
const MAX_WAIT_MS = 1500;
const TIMEOUT_MS = 5000;
/*
 * The public instance's policy asks clients to cache, and a household asks the
 * same few questions — the same shop, the same office — over and over. A day
 * is long enough to spare the provider and short enough that a place that
 * moves or gets renamed is picked up without anyone having to know there is a
 * cache. Only real answers are kept: a failure cached would be an outage that
 * outlives the outage.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
/*
 * The health probe gets longer. A geocoder that takes four seconds to answer is
 * a broken search box but a *working* geocoder, and reporting it as unreachable
 * would send an operator hunting for a container that is running fine.
 */
const HEALTH_TIMEOUT_MS = 10_000;

interface NominatimRow {
	lat?: string;
	lon?: string;
	display_name?: string;
	name?: string;
}

/**
 * Join a path onto the configured endpoint, keeping any base path it carries.
 *
 * `new URL('/search', base)` throws that base path away, so an endpoint behind
 * a reverse proxy at `https://example.com/nominatim` had every request land on
 * `https://example.com/search` — a 404, which this adapter's contract turns
 * into an empty list, which the form shows as "nothing found". Exactly the kind
 * of silent misconfiguration the health probe exists to surface, so it would be
 * strange to leave the adapter causing one.
 */
function apiUrl(endpoint: string, path: string): URL {
	const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
	return new URL(path, base);
}

export function nominatimGeocoder(cfg: { endpoint: string; email?: string }): Geocoder {
	/*
	 * Per-instance, and `getGeocoder` memoizes the instance so there is exactly
	 * one per process — that memo is what makes this gate real. Building a fresh
	 * adapter per HTTP request gave every request its own allowance, which is
	 * indistinguishable from having no gate at all.
	 */
	let nextAllowedAt = 0;
	const hosted = isPublicNominatim(cfg.endpoint);
	const cache = new Map<string, { at: number; results: GeocodeResult[] }>();

	/*
	 * The wildcard in this Accept header is not padding — it is the whole point.
	 *
	 * The mediagis image serves Nominatim through Apache with MultiViews, which
	 * maps `/search` onto `search.php` by content negotiation. A bare
	 * `Accept: application/json` matches no variant of a PHP script, so Apache
	 * answers 406 "no acceptable variant" before Nominatim runs at all — and this
	 * adapter's contract turns every non-ok response into an empty list, which
	 * the form shows as "nothing found". A correctly imported country-sized
	 * extract failed every single search for that reason, and nothing in the app
	 * could say so.
	 *
	 * The format is already pinned by the `format` query parameter, so the header
	 * was never doing the work it looked like it was doing. It stays, weighted,
	 * for endpoints that do negotiate properly.
	 */
	const headers = {
		'User-Agent': `ledger-self-hosted (${cfg.email ?? 'no contact configured'})`,
		Accept: 'application/json, */*;q=0.8'
	};

	/**
	 * The request itself, with no rate gate. Every caller here owns its own gating.
	 *
	 * `null` is "the provider gave no answer" and `[]` is "it answered: nothing",
	 * a distinction only the cache needs — it keeps the second and never the first.
	 */
	async function fetchSearch(
		q: string,
		limit: number,
		timeoutMs: number
	): Promise<GeocodeResult[] | null> {
		const url = apiUrl(cfg.endpoint, 'search');
		url.searchParams.set('q', q);
		url.searchParams.set('format', 'jsonv2');
		url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 10)));
		url.searchParams.set('addressdetails', '0');
		if (cfg.email) url.searchParams.set('email', cfg.email);

		const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
		// 429 included: a rate-limited provider has no answer, and the caller's
		// fallback is the same as for "no such place".
		if (!res.ok) return null;

		const body: unknown = await res.json();
		if (!Array.isArray(body)) return null;

		return body
			.slice(0, limit)
			.map((row: NominatimRow) => {
				const lat = Number(row?.lat);
				const lng = Number(row?.lon);
				const label = (row?.display_name ?? row?.name ?? '').trim();
				if (!label) return null;
				const coords = { lat, lng };
				// The provider is not trusted to return a point on Earth.
				return isValidCoords(coords) ? { coords, label } : null;
			})
			.filter((r): r is GeocodeResult => r !== null);
	}

	return {
		available: true,

		describe: () => ({ kind: 'nominatim', endpoint: cfg.endpoint, hosted }),

		async search(query, limit = 5): Promise<GeocodeResult[]> {
			const q = query.trim();
			// Two characters cannot identify a place, and asking wastes a request
			// against a quota that is not ours.
			if (q.length < 3) return [];

			// Case and spacing don't change the place; they shouldn't miss the cache.
			const key = `${limit}\0${q.toLowerCase().replace(/\s+/g, ' ')}`;
			const hit = cache.get(key);
			if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

			/*
			 * Take the next free slot, then wait for it. The slot is claimed before
			 * the wait, so searches that arrive together queue a second apart rather
			 * than all waking at the same moment and going out as a burst.
			 */
			const now = Date.now();
			const wait = Math.max(0, nextAllowedAt - now);
			if (wait > MAX_WAIT_MS) return [];
			nextAllowedAt = now + wait + MIN_INTERVAL_MS;
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

			try {
				const results = await fetchSearch(q, limit, TIMEOUT_MS);
				if (results === null) return [];
				cache.delete(key);
				cache.set(key, { at: Date.now(), results });
				// Map iteration is insertion order, so the first key is the oldest.
				if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
				return results;
			} catch {
				// Offline, timed out, DNS failure, malformed JSON — all the same
				// answer, which is no answer.
				return [];
			}
		},

		/*
		 * Deliberately outside the one-per-second gate.
		 *
		 * The gate protects a provider from a typing user. This runs on an owner
		 * clicking a button on a settings page, at most a couple of requests, and
		 * a diagnostic that reports "unreachable" because it was rate-limited by
		 * its own app would be worse than useless — it is the exact confusion the
		 * probe exists to end.
		 */
		async checkHealth(probeQuery?: string): Promise<GeocoderHealth> {
			const base: GeocoderHealth = {
				state: 'unreachable',
				detail: '',
				dataUpdated: null,
				probe: null
			};

			// Only the one field survives the block; scoping the parsed status inside
			// the `try` keeps its shape from leaking past the point it is understood.
			let dataUpdated: string | null;
			try {
				const url = apiUrl(cfg.endpoint, 'status');
				url.searchParams.set('format', 'json');
				const res = await fetch(url, {
					headers,
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
				});
				const body: unknown = await res.json().catch(() => null);
				const status: { status?: number; message?: string; data_updated?: string } | null =
					body && typeof body === 'object' ? body : null;

				/*
				 * A 4xx is the web server rejecting the request, not Nominatim
				 * answering it — a wrong path, or Apache's content negotiation
				 * refusing the request shape (406). Reporting that as "the database
				 * isn't ready" sent an operator to watch an import that had already
				 * finished hours earlier, which is the opposite of this panel's job.
				 * Only the server can distinguish these, so its own code is quoted.
				 */
				if (res.status >= 400 && res.status < 500) {
					return {
						...base,
						state: 'starting',
						detail: `${cfg.endpoint} is running, but rejected the request with HTTP ${res.status} before Nominatim saw it. That is the web server in front of it, not the data. Check that the URL points at the API root.`
					};
				}

				if (status?.status !== 0) {
					/*
					 * Something is listening but its database isn't serving. For a
					 * mediagis container this is the window after Apache comes up and
					 * before the import finishes, and Nominatim's own message (700
					 * "Database connection failed", 702 "Query failed") says more than
					 * anything we could invent.
					 */
					const why = status?.message ?? `HTTP ${res.status}`;
					return {
						...base,
						state: 'starting',
						detail: hosted
							? `${cfg.endpoint} answered, but says it isn't serving right now: ${why}. That is on their side; try again later.`
							: `${cfg.endpoint} answered, but its database isn't ready: ${why}. An import in progress looks exactly like this — watch the container's logs.`
					};
				}
				dataUpdated = typeof status.data_updated === 'string' ? status.data_updated : null;
			} catch {
				/*
				 * Refused, DNS failure, or timed out. Worth being explicit that this
				 * is *also* what a running import looks like: mediagis/nominatim does
				 * not start its web server until the import finishes, so hours of
				 * healthy work are indistinguishable from a container that never came
				 * up. Naming that is the whole point.
				 */
				return {
					...base,
					detail: hosted
						? `Nothing answered at ${cfg.endpoint}. Check that this server can reach the internet, and that the address is right.`
						: `Nothing answered at ${cfg.endpoint}. Either it isn't running, the address is wrong, or an import is still in progress: the web server doesn't start until an import finishes, which can take hours.`
				};
			}

			const ready: GeocoderHealth = {
				...base,
				state: 'ready',
				detail: `${cfg.endpoint} is up and serving.`,
				dataUpdated
			};

			const q = probeQuery?.trim() ?? '';
			if (q.length < 3) return ready;

			try {
				const rows = await fetchSearch(q, 3, HEALTH_TIMEOUT_MS);
				if (rows === null) throw new Error('no answer');
				return {
					...ready,
					probe: { query: q, found: rows.length, first: rows[0]?.label ?? null },
					detail:
						rows.length > 0
							? `${cfg.endpoint} is up, and this place is in its data.`
							: hosted
								? `${cfg.endpoint} is up, but found nothing for that. Try it the way a map would write it, with the street and the town.`
								: `${cfg.endpoint} is up and serving, but it has nothing for that. The extract it imported probably doesn't cover there, or the text isn't an address it can parse.`
				};
			} catch {
				return {
					...ready,
					detail: `${cfg.endpoint} reports itself healthy, but the test search failed to complete.`
				};
			}
		}
	};
}
