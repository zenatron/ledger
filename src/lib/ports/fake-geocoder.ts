import type { Geocoder } from './geocoder';

/**
 * A stand-in for the geocoder, for tests.
 *
 * Defaults to "present but answers nothing" — the case a misconfigured or
 * rate-limited provider actually produces, and the one callers most often get
 * wrong by assuming a result. A test overrides only `search` when it is about
 * a result.
 *
 * Lives beside the port, like `fakeAssist`. Nothing in the app imports it, so
 * it never ships.
 */
export function fakeGeocoder(over: Partial<Geocoder> = {}): Geocoder {
	return {
		available: true,
		describe: () => ({ kind: 'nominatim', endpoint: 'http://fake', hosted: false }),
		search: async () => [],
		checkHealth: async () => ({
			state: 'ready',
			detail: 'fake',
			dataUpdated: null,
			probe: null
		}),
		...over
	};
}
