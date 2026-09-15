import { json } from '@sveltejs/kit';
import { roundToE3 } from '$lib/domain/location/coords';
import { getGeocoder } from '$lib/infra/geocode';
import { getEnv } from '$lib/server/env';
import { rateLimitOk } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

/**
 * Resolve a typed address to candidate places.
 *
 * Server-side so the browser never talks to the geocoder: address text is a
 * strong signal about where somebody is going, and this keeps it inside the
 * deployment's own outbound connection — which is also what keeps the app's
 * `connect-src` at 'self'.
 *
 * Always 200 with a list, never a 5xx. An empty list means "no answer", and the
 * form's fallback for that is the same as for a place that doesn't exist: keep
 * the device and the map-link routes, which need no provider at all.
 *
 * Coordinates are rounded on the way out, so the client is never handed a
 * precision it isn't allowed to store.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const empty = json({ places: [] });

	if (!locals.workspace!.locationEnabled) return empty;

	const env = getEnv();
	const geocoder = getGeocoder({ endpoint: env.GEOCODER_URL, email: env.GEOCODER_EMAIL });
	if (!geocoder.available) return empty;

	// Per member, and generous for a person typing: the adapter's own one-per-
	// second gate is what actually protects the provider, and this protects us
	// from a stuck client burning that quota.
	if (!rateLimitOk(`geosearch:${locals.member!.id}`, 20, 60_000)) return empty;

	const body = await request.json().catch(() => null);
	const query = typeof body?.query === 'string' ? body.query : '';
	if (!query.trim()) return empty;

	// The browser's own language list, so a search abroad reads in the reader's
	// words. It travels no further than the geocoder this deployment already uses.
	const results = await geocoder.search(query, 5, {
		language: request.headers.get('accept-language')
	});

	/*
	 * Deduped after rounding, not before.
	 *
	 * Nominatim happily returns the same place twice — a real search for "Ferry
	 * Building San Francisco" came back with two byte-identical rows — and
	 * rounding to ~110 m collapses more pairs on top of that. Two identical
	 * candidates are useless to choose between, and they also crashed the
	 * picker: the list is keyed on coordinate and label, so a duplicate key
	 * aborted the render and left it showing "Looking…" forever.
	 */
	const seen = new Set<string>();
	const places: { latE3: number; lngE3: number; label: string }[] = [];
	for (const r of results) {
		let e3;
		try {
			e3 = roundToE3(r.coords);
		} catch {
			// roundToE3 rejects anything that isn't a point on Earth. A provider that
			// returns one has simply given us one fewer candidate.
			continue;
		}
		const key = `${e3.latE3}:${e3.lngE3}:${r.label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		places.push({ ...e3, label: r.label });
	}

	return json({ places });
};
