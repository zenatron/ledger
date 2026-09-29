import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_ZOOM } from '$lib/domain/location/mercator';
import type { Env } from '$lib/server/env';

/** Logged once per process, not once per tile. */
let cacheWarned = false;

/**
 * On-disk cache for basemap tiles.
 *
 * Deliberately **not** the BlobStore, and not marginally:
 *
 *  - blobs are content-addressed by a hash of their bytes; tiles are addressed
 *    by `(z, x, y)`, so using it would mean a second index from coordinate to
 *    hash — a database table for map imagery;
 *  - the blob store's own doc comment says blobs are append-only and safe to
 *    back up beside the database dump. These are disposable third-party bytes;
 *    putting them there would carry hundreds of megabytes of somebody else's
 *    map into every backup;
 *  - it has no TTL and no eviction, by design. Tiles need both — upstream
 *    restyles, and the cache has to be boundable;
 *  - every blob serve goes through a seal check against a purchase row, and a
 *    tile has no purchase.
 *
 * What it does borrow is the write technique: temp file then rename, so a crash
 * mid-write can never leave a torn tile on disk.
 *
 * `TILE_CACHE_DIR` is safe to delete at any moment.
 */

const TTL_MS = 30 * 86_400_000;
const FETCH_TIMEOUT_MS = 6000;

/*
 * Limits on going *upstream*, not on serving tiles.
 *
 * The first version limited the route — every tile request, cache hits
 * included — and 20 seconds of zooming around one city hit it. That was
 * backwards twice over: a tile served off local disk costs the tile server
 * nothing, so throttling it protects nobody, and the areas you revisit are
 * exactly the ones already cached.
 *
 * So the ceiling sits here, on the fetch. `UPSTREAM_PER_MIN` is roughly ten
 * screenfuls of genuinely new ground a minute, which is far more than a person
 * exploring their own spending covers and still a hard stop on a runaway
 * client. `MAX_CONCURRENT` matters more for being a good citizen: a screenful
 * of misses would otherwise open thirty parallel connections at once, and
 * OSM's usage policy asks for a couple.
 */
const UPSTREAM_PER_MIN = 300;
const MAX_CONCURRENT = 4;

/**
 * Sliding-window budget. Exported and given its state so the rule can be tested
 * directly rather than by making three hundred real requests to somebody else's
 * server to find out whether it holds.
 *
 * Mutates `times`: expired entries are dropped and an accepted attempt is
 * recorded, so a caller keeps one array for the life of the process.
 */
export function takeSlot(times: number[], now: number, perMinute: number): boolean {
	while (times.length > 0 && now - times[0] > 60_000) times.shift();
	if (times.length >= perMinute) return false;
	times.push(now);
	return true;
}

const upstreamAt: number[] = [];
let inFlight = 0;

async function waitForConcurrencySlot(): Promise<boolean> {
	// Bounded wait: a caller that can't get a slot promptly is better off being
	// told "not now" than queueing behind a stalled fetch.
	for (let i = 0; i < 40 && inFlight >= MAX_CONCURRENT; i++) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return inFlight < MAX_CONCURRENT;
}

/** Bounded by MAX_ZOOM, the TTL, and this opportunistic sweep. No cron needed. */
const SWEEP_EVERY = 500;
let writesSinceSweep = 0;

function tilePath(dir: string, z: number, x: number, y: number): string {
	return join(dir, String(z), String(x), `${y}.png`);
}

/** True for a tile coordinate that exists in the world at that zoom. */
export function isValidTile(z: number, x: number, y: number): boolean {
	if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) return false;
	if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
	const n = 2 ** z;
	return x >= 0 && x < n && y >= 0 && y < n;
}

/**
 * Fetch a tile, from disk when we have a fresh one and from upstream otherwise.
 *
 * Returns null only when there is genuinely nothing to show. An expired copy is
 * preferred over nothing when upstream is unreachable: yesterday's streets are
 * still the right streets, and a blank map is a worse answer than a slightly
 * stale one.
 *
 * Never throws. The caller's failure path is "no basemap", which the map is
 * built to handle — it draws its graticule instead.
 */
export async function getTile(
	env: Env,
	z: number,
	x: number,
	y: number
): Promise<ArrayBuffer | null> {
	if (!env.MAP_TILE_URL || !isValidTile(z, x, y)) return null;

	const path = tilePath(env.TILE_CACHE_DIR, z, x, y);
	let stale: ArrayBuffer | null = null;
	try {
		const st = await stat(path);
		const buf = await readFile(path);
		// Sliced to the view's own bounds: Node hands back a Buffer over a pooled
		// allocation, and passing its whole backing store would serve bytes that
		// belong to some other read.
		const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		if (Date.now() - st.mtimeMs < TTL_MS) return bytes;
		stale = bytes;
	} catch {
		// Not cached yet.
	}

	// Past here we would be talking to somebody else's server, so this is where
	// the ceiling applies. Out of budget: yesterday's copy if we have one, and
	// otherwise nothing — the map leaves that square blank and carries on.
	if (!takeSlot(upstreamAt, Date.now(), UPSTREAM_PER_MIN)) return stale;
	if (!(await waitForConcurrencySlot())) return stale;

	inFlight++;
	try {
		/*
		 * z/x/y are integer-validated above, before they are interpolated. That
		 * check is what keeps this from being a fetch-anything primitive: the
		 * template is deployment-owned, and these are the only parts of the
		 * upstream URL that come from a request.
		 */
		const url = env.MAP_TILE_URL.replaceAll('{z}', String(z))
			.replaceAll('{x}', String(x))
			.replaceAll('{y}', String(y));

		const res = await fetch(url, {
			headers: {
				// OSM's tile policy requires an identifiable agent; anonymous clients
				// are blocked outright.
				'User-Agent': `ledger-self-hosted (${env.GEOCODER_EMAIL ?? 'no contact configured'})`,
				Accept: 'image/png,image/*'
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return stale;

		const bytes = await res.arrayBuffer();
		/*
		 * Caching is best effort and must never cost the tile. The write used to
		 * share the fetch's catch, so a cache directory the process couldn't write
		 * (a root-owned volume, a full disk) threw away a tile that had arrived
		 * fine, and the map drew its graticule instead — with nothing logged.
		 */
		try {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
			await writeFile(tmp, new Uint8Array(bytes));
			await rename(tmp, path);
			void maybeSweep(env.TILE_CACHE_DIR);
		} catch (e) {
			if (!cacheWarned) {
				cacheWarned = true;
				console.log(
					JSON.stringify({
						level: 'warn',
						msg: 'tiles: cache not writable, serving uncached',
						dir: env.TILE_CACHE_DIR,
						err: (e as Error).message
					})
				);
			}
		}
		return bytes;
	} catch {
		// Upstream down, timed out, or offline. If we have yesterday's copy, that
		// is the honest answer; otherwise the map falls back to its graticule.
		return stale;
	} finally {
		inFlight--;
	}
}

/**
 * Every few hundred writes, walk one random zoom directory and drop what has
 * expired. Cheap, self-limiting, and enough for a household — a scheduled job
 * for a disposable image cache would be over-engineering.
 */
async function maybeSweep(dir: string): Promise<void> {
	if (++writesSinceSweep < SWEEP_EVERY) return;
	writesSinceSweep = 0;
	try {
		const zooms = await readdir(dir);
		if (zooms.length === 0) return;
		const z = zooms[Math.floor(Math.random() * zooms.length)];
		const columns = await readdir(join(dir, z));
		if (columns.length === 0) return;
		const x = columns[Math.floor(Math.random() * columns.length)];
		const colDir = join(dir, z, x);
		const cutoff = Date.now() - TTL_MS;
		for (const file of await readdir(colDir)) {
			const p = join(colDir, file);
			const st = await stat(p).catch(() => null);
			if (st && st.mtimeMs < cutoff) await rm(p, { force: true });
		}
	} catch {
		// A sweep that fails changes nothing that matters.
	}
}
