import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGeocoder } from './index';
import { nominatimGeocoder } from './nominatim-geocoder';
import { isPublicNominatim } from './public';

/** Typed so `mock.calls` carries the fetch arguments the assertions read. */
const OK = (rows: unknown) =>
	vi.fn(
		async (...args: [input: RequestInfo | URL, init?: RequestInit]) =>
			new Response(JSON.stringify(rows), {
				status: 200,
				headers: { 'x-args': String(args.length) }
			})
	);

const SF_ROW = { lat: '37.7749', lon: '-122.4194', display_name: 'Ferry Building, San Francisco' };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('isPublicNominatim', () => {
	it('knows the public instance by host, and nothing else', () => {
		expect(isPublicNominatim('https://nominatim.openstreetmap.org')).toBe(true);
		expect(isPublicNominatim('https://nominatim.openstreetmap.org/')).toBe(true);
		expect(isPublicNominatim('http://geocoder:8080')).toBe(false);
		expect(isPublicNominatim('https://nominatim.openstreetmap.org.evil.example')).toBe(false);
		expect(isPublicNominatim('')).toBe(false);
		expect(isPublicNominatim(undefined)).toBe(false);
	});
});

describe('getGeocoder', () => {
	it('falls back to the null adapter for an incomplete config', () => {
		for (const endpoint of [null, undefined, '']) {
			const g = getGeocoder({ endpoint });
			expect(g.available).toBe(false);
			expect(g.describe().kind).toBe('off');
		}
	});

	it('answers nothing, and reaches no network, when off', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		await expect(getGeocoder({ endpoint: null }).search('Ferry Building')).resolves.toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('builds a real adapter from a complete config', () => {
		const g = getGeocoder({ endpoint: 'https://nominatim.example' });
		expect(g.available).toBe(true);
		expect(g.describe()).toEqual({
			kind: 'nominatim',
			endpoint: 'https://nominatim.example',
			hosted: false
		});
		expect(getGeocoder({ endpoint: 'https://nominatim.openstreetmap.org' }).describe().hosted).toBe(
			true
		);
	});

	it('returns the same adapter for the same config', () => {
		// Not an optimisation: the adapter's one-per-second gate lives in a
		// closure, and the search endpoint calls this once per HTTP request. A
		// fresh adapter each time gave every request its own allowance, which is
		// the same as having no gate.
		const a = getGeocoder({ endpoint: 'https://memo.example', email: 'x@y.z' });
		const b = getGeocoder({ endpoint: 'https://memo.example', email: 'x@y.z' });
		expect(a).toBe(b);
		expect(getGeocoder({ endpoint: 'https://other.example' })).not.toBe(a);
	});
});

describe('nominatimGeocoder', () => {
	const make = () => nominatimGeocoder({ endpoint: 'https://nominatim.example', email: 'a@b.c' });

	it('maps rows to results', async () => {
		vi.stubGlobal('fetch', OK([SF_ROW]));
		const [hit] = await make().search('Ferry Building');
		expect(hit.label).toBe('Ferry Building, San Francisco');
		expect(hit.coords.lat).toBeCloseTo(37.7749, 6);
		expect(hit.coords.lng).toBeCloseTo(-122.4194, 6);
	});

	it('identifies itself, because anonymous clients are blocked', async () => {
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		await make().search('Ferry Building');
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers['User-Agent']).toContain('a@b.c');
	});

	it('refuses to ask about text too short to be a place', async () => {
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		expect(await make().search('ab')).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it('holds to one request per second, whatever the caller does', async () => {
		// The consequence of getting this wrong is the deployment's IP being
		// banned, which outlives the request that caused it — so the adapter
		// enforces it rather than trusting the caller's debounce.
		vi.useFakeTimers();
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		const g = make();
		await g.search('Ferry Building');
		const second = g.search('Union Square');
		await vi.advanceTimersByTimeAsync(999);
		expect(spy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await second;
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('queues a search that arrives inside the interval, rather than answering it with nothing', async () => {
		// Dropping it reached the form as "Nothing found" for an address that exists.
		vi.useFakeTimers();
		vi.stubGlobal('fetch', OK([SF_ROW]));
		const g = make();
		await g.search('Ferry Building');
		const second = g.search('Union Square');
		await vi.advanceTimersByTimeAsync(1000);
		expect(await second).toHaveLength(1);
	});

	it('gives up on a queue deeper than one search, and sends no burst', async () => {
		vi.useFakeTimers();
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		const g = make();
		await g.search('Ferry Building');
		const second = g.search('Union Square');
		expect(await g.search('Golden Gate Park')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1000);
		await second;
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('answers a repeated question from the cache, ignoring case and spacing', async () => {
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		const g = make();
		const first = await g.search('Ferry Building');
		// Straight after: were this not cached, the gate would make it wait.
		expect(await g.search('  ferry   BUILDING ')).toEqual(first);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('does not cache a failure', async () => {
		vi.useFakeTimers();
		const g = make();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
		);
		expect(await g.search('Ferry Building')).toEqual([]);
		vi.stubGlobal('fetch', OK([SF_ROW]));
		const retry = g.search('Ferry Building');
		await vi.advanceTimersByTimeAsync(1000);
		expect(await retry).toHaveLength(1);
	});

	it('treats every failure as no answer, and never throws', async () => {
		const g = make();
		for (const stub of [
			vi.fn(async () => new Response('', { status: 429 })),
			vi.fn(async () => new Response('', { status: 500 })),
			vi.fn(async () => new Response('not json', { status: 200 })),
			vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 200 })),
			vi.fn(async () => {
				throw new Error('offline');
			})
		]) {
			vi.stubGlobal('fetch', stub);
			// A fresh adapter each time, so the per-second gate isn't what's returning [].
			const fresh = nominatimGeocoder({ endpoint: 'https://nominatim.example' });
			await expect(fresh.search('Ferry Building')).resolves.toEqual([]);
		}
		expect(g.available).toBe(true);
	});

	it('drops rows that are not a point on Earth', async () => {
		vi.stubGlobal(
			'fetch',
			OK([
				{ lat: '91.5', lon: '0', display_name: 'Impossible' },
				{ lat: 'not-a-number', lon: '0', display_name: 'Also impossible' },
				{ lat: '0', lon: '0', display_name: '' },
				SF_ROW
			])
		);
		const out = await make().search('anything');
		expect(out).toHaveLength(1);
		expect(out[0].label).toBe('Ferry Building, San Francisco');
	});

	it('never asks for more than a sane number of rows', async () => {
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		await make().search('Ferry Building', 500);
		const url = new URL(String(spy.mock.calls[0][0]));
		expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(10);
	});

	it('sends an Accept that Apache content negotiation can satisfy', async () => {
		/*
		 * The mediagis image serves Nominatim as PHP behind Apache MultiViews. A
		 * bare `Accept: application/json` matches no variant of `search.php`, so
		 * Apache returns 406 before Nominatim runs — and this adapter reports every
		 * non-ok response as "no such place". A fully imported extract answered
		 * nothing at all for exactly this reason.
		 */
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		await make().search('Ferry Building');
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers.Accept).toContain('*/*');
	});

	it('keeps a base path, so an endpoint behind a proxy subpath still resolves', async () => {
		// `new URL('/search', base)` drops the base path, which sent every request
		// to the origin root — a 404, which this adapter reports as "no such place".
		const spy = OK([SF_ROW]);
		vi.stubGlobal('fetch', spy);
		await nominatimGeocoder({ endpoint: 'https://example.com/nominatim' }).search('Ferry Building');
		expect(String(spy.mock.calls[0][0])).toContain('/nominatim/search');
	});
});

describe('checkHealth', () => {
	const make = () => nominatimGeocoder({ endpoint: 'https://nominatim.example' });

	/** Nominatim's own /status shape: 0 is healthy, anything else is not. */
	const status = (body: unknown, init: ResponseInit = {}) =>
		new Response(JSON.stringify(body), { status: 200, ...init });

	it('reports off without touching the network when there is no endpoint', async () => {
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		const health = await getGeocoder({ endpoint: null }).checkHealth('anywhere');
		expect(health.state).toBe('off');
		expect(spy).not.toHaveBeenCalled();
	});

	it('reads a healthy status, and says how fresh the data is', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => status({ status: 0, message: 'OK', data_updated: '2026-08-01T00:00:00Z' }))
		);
		const health = await make().checkHealth();
		expect(health.state).toBe('ready');
		expect(health.dataUpdated).toBe('2026-08-01T00:00:00Z');
		expect(health.probe).toBeNull();
	});

	it('separates a database that is not serving yet from one that is', async () => {
		// The window a country-sized import spends here is hours long, and the
		// whole point of the probe is that it does not look like "broken".
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				status({ status: 700, message: 'Database connection failed' }, { status: 500 })
			)
		);
		const health = await make().checkHealth();
		expect(health.state).toBe('starting');
		expect(health.detail).toContain('Database connection failed');
	});

	it('blames the web server, not the import, for a 4xx', async () => {
		// A 406 from Apache's content negotiation reported as "the database isn't
		// ready" sends an operator to watch an import that finished hours ago.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not acceptable', { status: 406 }))
		);
		const health = await make().checkHealth();
		expect(health.state).toBe('starting');
		expect(health.detail).toContain('406');
		expect(health.detail).toContain('web server');
		expect(health.detail).not.toContain('database');
	});

	it('reports nothing answering as unreachable, and names the import as a cause', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			})
		);
		const health = await make().checkHealth();
		expect(health.state).toBe('unreachable');
		expect(health.detail).toContain('import');
	});

	it('tells "up but this place is not in the extract" apart from "up"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/status')
					? status({ status: 0, message: 'OK' })
					: status([] as unknown[])
			)
		);
		const health = await make().checkHealth('495 Flatbush Ave, Hartford CT');
		expect(health.state).toBe('ready');
		expect(health.probe).toEqual({
			query: '495 Flatbush Ave, Hartford CT',
			found: 0,
			first: null
		});
		expect(health.detail).toContain("doesn't cover");
	});

	it('confirms a place the extract does have', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/status') ? status({ status: 0, message: 'OK' }) : status([SF_ROW])
			)
		);
		const health = await make().checkHealth('Ferry Building');
		expect(health.probe?.found).toBe(1);
		expect(health.probe?.first).toBe('Ferry Building, San Francisco');
	});

	it('talks to a hosted provider without mentioning imports or extracts', async () => {
		const hosted = nominatimGeocoder({
			endpoint: 'https://nominatim.openstreetmap.org',
			email: 'a@b.c'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			})
		);
		expect((await hosted.checkHealth()).detail).not.toMatch(/import|extract/);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/status')
					? status({ status: 0, message: 'OK' })
					: status([] as unknown[])
			)
		);
		expect((await hosted.checkHealth('nowhere at all')).detail).not.toMatch(/import|extract/);
	});

	it('is not silenced by the one-per-second gate the search box lives under', async () => {
		// A diagnostic that reported "unreachable" because its own app rate-limited
		// it would be the exact confusion it exists to end.
		const spy = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes('/status') ? status({ status: 0, message: 'OK' }) : status([SF_ROW])
		);
		vi.stubGlobal('fetch', spy);
		const g = make();
		await g.search('Ferry Building');
		const health = await g.checkHealth('Ferry Building');
		expect(health.probe?.found).toBe(1);
	});
});
