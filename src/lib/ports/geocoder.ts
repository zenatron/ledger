import type { Coords } from '$lib/domain/location/coords';

/**
 * The port a typed address is resolved through.
 *
 * Optional in the same way the LLM assist is optional: the null adapter is the
 * default, and with it the whole places feature still works — the device's own
 * location and a pasted map link both resolve without ever reaching this port,
 * because a map URL already contains its answer and reading it is arithmetic.
 * A geocoder only adds "type an address and get a pin".
 *
 * **Nothing here ever throws.** Off, unreachable, rate-limited, timed out, or
 * returning nonsense all resolve to an empty result, and the caller falls back
 * to exactly what it would have done with no geocoder at all. This mirrors the
 * contract on `LlmAssist` and exists for the same reason: an optional
 * dependency that can fail loudly is not optional.
 *
 * It is also deliberately **server-side only**. Address text is a strong signal
 * about where somebody is going, so it leaves the deployment through the
 * server's own outbound connection or not at all — which is what keeps the
 * app's `connect-src` at 'self'.
 */

export interface GeocodeResult {
	/** Coordinates as the provider gave them; the caller still rounds to E3. */
	coords: Coords;
	/** A human-readable name for the place, for the picker and the pin's label. */
	label: string;
}

export interface GeocodeOptions {
	/**
	 * The reader's `Accept-Language`, passed through so a place abroad comes
	 * back named in words they read ("Munich, Germany") rather than the local
	 * script. Untrusted header text; the adapter decides what survives.
	 */
	language?: string | null;
}

export interface GeocoderProvider {
	kind: 'off' | 'nominatim';
	endpoint: string | null;
	/** Someone else's instance (the public one), so there is no import or
	 *  extract of ours to talk about when it finds nothing. */
	hosted: boolean;
}

/**
 * What a live probe of the provider found.
 *
 * This exists because every failure in this layer is, by the contract above,
 * silent: off, unreachable, still importing, and "that place isn't in the
 * imported extract" all reach the user as the same empty list. That is right
 * for someone recording a purchase and useless for someone who just spent an
 * afternoon importing a 12&nbsp;GB extract and wants to know whether it took.
 * The probe is the one place allowed to tell them apart, and it only ever runs
 * when an owner asks for it.
 *
 * `state` is deliberately coarser than the ways this can fail — what an
 * operator does next is the same for a container that isn't running and one
 * that's three hours into an import, because from here they are the same
 * silence. `detail` is what carries the distinction.
 */
export type GeocoderHealth = {
	/**
	 * - `off` — no endpoint configured; nothing was contacted.
	 * - `unreachable` — nothing answered. Not yet running, still importing, or
	 *   wrong host: all indistinguishable from outside.
	 * - `starting` — something answered, but its database isn't serving yet.
	 * - `ready` — the provider reports itself healthy.
	 */
	state: 'off' | 'unreachable' | 'starting' | 'ready';
	/** One human sentence, safe to render as-is. */
	detail: string;
	/** How fresh the imported data is, when the provider says. */
	dataUpdated: string | null;
	/** The result of the probe query, when one was asked for. */
	probe: { query: string; found: number; first: string | null } | null;
};

export interface Geocoder {
	/** False when the layer is off or misconfigured — callers gate on this. */
	readonly available: boolean;

	/** For the settings screen: what this instance is pointed at. */
	describe(): GeocoderProvider;

	/**
	 * Resolve free text to at most `limit` candidate places, best first.
	 *
	 * Returns `[]` for anything it cannot answer, including every failure mode.
	 * Callers must treat an empty array as "no answer", never as "no such place".
	 */
	search(query: string, limit?: number, opts?: GeocodeOptions): Promise<GeocodeResult[]>;

	/**
	 * Ask the provider how it is, for the settings screen. Owner-initiated only.
	 *
	 * Like everything else here it never throws — a probe that can crash the
	 * page it diagnoses is worse than no probe. An optional `probeQuery` also
	 * asks "and do you know this place?", which is the only honest way to tell a
	 * running geocoder from one whose extract covers somewhere else.
	 */
	checkHealth(probeQuery?: string): Promise<GeocoderHealth>;
}

/**
 * The default. Answers nothing, fails at nothing, and reaches no network — a
 * deployment that never sets `GEOCODER_URL` runs entirely on this.
 */
export const nullGeocoder: Geocoder = {
	available: false,
	describe: () => ({ kind: 'off', endpoint: null, hosted: false }),
	search: async () => [],
	checkHealth: async () => ({
		state: 'off',
		detail: 'No address search configured. Set GEOCODER_URL to a Nominatim-compatible endpoint.',
		dataUpdated: null,
		probe: null
	})
};
