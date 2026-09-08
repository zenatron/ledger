/**
 * The behavior of a "Where" field, shared by the two surfaces that have one:
 * the new-purchase form and the ledger's inline editor. The two render it in
 * different visual languages — a boxed form row and a borderless ledger line —
 * so what lives here is everything *around* the markup: the three honest
 * routes to a pin (a link read offline, a name the geocoder resolves, the
 * device on an explicit tap), the candidate picker, and the errors that name
 * a way round instead of a dead end.
 *
 * Nothing here runs on its own. Resolving is paste / blur / Enter, never per
 * keystroke — a URL holds a valid coordinate long before it is finished
 * typing, and resolving mid-word swaps the row out from under the caret.
 */

import { parseCoordsText, roundToE3 } from './coords';
import { isMapsUrl, parseMapsLink, parseMapsPlaceName } from './maps-link';
import { isPlusCodeRefusal, parsePlusCode } from './plus-code';
import { shortenPlaceLabel, type PurchasePlace } from './place';

/** One row of the geocoder's answer, already rounded by the server. */
export interface PlaceCandidate {
	latE3: number;
	lngE3: number;
	label: string;
}

export interface PlaceField {
	/** The resolved pin, or null — the thing the form's hidden inputs carry. */
	readonly place: PurchasePlace | null;
	/** Unresolved text in the field; empty once a pin resolves. */
	query: string;
	/** The last thing that went wrong, phrased with a way round it. */
	readonly error: string | null;
	readonly candidates: PlaceCandidate[];
	readonly searching: boolean;
	readonly locating: boolean;
	/** Resolve on paste. Returns true when it consumed the clipboard text. */
	onPaste(e: ClipboardEvent): boolean;
	/** Resolve on blur / Enter / a guarded Save. */
	commit(): void;
	/** True when a Save must be held back: the text has not become a pin. */
	unresolved(): boolean;
	locate(): Promise<void>;
	pickCandidate(c: PlaceCandidate): void;
	/** Remove the pin (an explicit act, not a side-effect of emptying text). */
	clear(): void;
	/** Reset to a starting pin — the ledger editor reopens with the saved one. */
	seed(p: PurchasePlace | null): void;
}

/**
 * Getters, not values: the page outlives a change of workspace without
 * remounting, and a captured `slug` would search — and pin — against the wrong
 * one's endpoint.
 */
export function createPlaceField(opts: {
	slug: () => string;
	geocoderEnabled: () => boolean;
}): PlaceField {
	let place = $state<PurchasePlace | null>(null);
	let query = $state('');
	let error = $state<string | null>(null);
	let candidates = $state<PlaceCandidate[]>([]);
	let searching = $state(false);
	let locating = $state(false);
	/** The question the last finished search asked, and when it was answered. */
	let askedTerm = '';
	let askedAt = 0;

	function settled(p: PurchasePlace | null) {
		place = p;
		query = '';
		error = null;
		candidates = [];
	}

	/** Coordinates straight out of the URL, offline — or false. */
	function resolveLink(text: string): boolean {
		const hit = parseMapsLink(text);
		if (!hit) return false;
		settled({ ...roundToE3(hit), label: null, source: 'link' });
		return true;
	}

	/**
	 * A coordinate pair typed or pasted directly — or false.
	 *
	 * Recorded as `link` rather than a source of its own: the meaningful
	 * distinction the sources draw is how much the pin is trusted, and this is
	 * exactly a link's provenance — a number the person supplied, read offline,
	 * never checked against anything. A fifth enum value would be a schema
	 * migration to record a difference nothing acts on.
	 */
	function resolveCoords(text: string): boolean {
		const hit = parseCoordsText(text);
		if (!hit) return false;
		settled({ ...roundToE3(hit), label: null, source: 'link' });
		return true;
	}

	/*
	 * Typed addresses and coordinate-less links, when a geocoder is configured.
	 *
	 * Never per keystroke. Nominatim's usage policy forbids autocomplete-style
	 * querying outright and will ban the deployment's IP for it, so a search
	 * only happens on a paste, an Enter, or leaving the field — a deliberate
	 * act, not a side-effect of typing.
	 */
	async function search(q: string) {
		const term = q.trim();
		if (term.length < 3) return;
		/*
		 * One at a time. Tapping Save blurs the field and *then* runs the submit
		 * guard, so a single tap called commit twice within milliseconds — and the
		 * adapter's one-request-per-second gate answered the second with nothing.
		 * That empty answer is indistinguishable from "no such place": it wiped
		 * the first search's candidates and left "Nothing found" over an address
		 * the geocoder had just resolved. The in-flight search is already asking
		 * this question; let it answer.
		 */
		if (searching) return;
		/*
		 * And not again for the text that was just answered. Blur paths — tapping
		 * into another field while the list is showing, the guarded Save — commit
		 * the same text a paste or an Enter resolved moments ago, and the
		 * adapter's one-request-per-second gate answers the repeat with nothing:
		 * "Nothing found" wiped over a list that was right. Editing the text
		 * changes the term, and a changed term searches as normal.
		 */
		if (term === askedTerm && Date.now() - askedAt < 10_000) return;
		searching = true;
		candidates = [];
		try {
			const res = await fetch(`/w/${opts.slug()}/places/search`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query: term })
			});
			// The endpoint never 5xxs; a non-ok here is ours, and the answer is the same.
			const body = res.ok ? await res.json() : { places: [] };
			const found: PlaceCandidate[] = body.places ?? [];
			candidates = found;
			if (found.length === 0) {
				error = `Nothing found for "${term}". Paste a link from a maps app, or use where you are.`;
			}
		} catch {
			// The browser being offline. Same answer: no candidates, and the
			// other two routes still work.
			error = 'Could not search for that right now.';
		} finally {
			searching = false;
			askedTerm = term;
			askedAt = Date.now();
		}
	}

	/**
	 * A map link that names a place but carries no coordinates — an Apple
	 * place-card share, a Google short link. Offline there is nothing to read;
	 * with a geocoder, the name is an honest query.
	 */
	function deadEnd(text: string) {
		const name = parseMapsPlaceName(text);
		if (name && opts.geocoderEnabled()) {
			void search(name);
			return;
		}
		error = name
			? 'That link names a place but not where it is. Drop a pin on the spot in your maps app and share that; it will have the coordinates.'
			: 'That link hides its location behind a shortener. Open it in your maps app, then share the place or pin directly.';
	}

	/**
	 * A Plus Code, decoded offline — or false, having said why if the text was
	 * recognisably one.
	 *
	 * The refusals get their own sentences because each has a different way
	 * round: a shortened code needs the full one, and a padded code needs a
	 * longer one. Collapsing them into "nothing found" would send someone to a
	 * geocoder that has no more idea what "QWJP+2X" means than we do.
	 */
	function resolvePlusCode(text: string): 'pinned' | 'explained' | 'no' {
		const out = parsePlusCode(text);
		if (!isPlusCodeRefusal(out)) {
			settled({ ...roundToE3(out.coords), label: null, source: 'link' });
			return 'pinned';
		}
		if (out === 'shortened') {
			error =
				'That Plus Code is the short form, which only means something next to a town name. Open it in your maps app and copy the full code, the one with eight characters before the +.';
			return 'explained';
		}
		if (out === 'too-coarse') {
			error =
				'That Plus Code covers too wide an area to pin; it names a region rather than a place. A longer code, without the zeros, points at a building.';
			return 'explained';
		}
		return 'no';
	}

	function commit() {
		const text = query.trim();
		if (!text) return;
		if (resolveLink(text)) return;
		// Before the geocoder, and before the "no location in it" error: a
		// coordinate pair is already the answer, so asking a provider to look one
		// up would spend a request to be told what the text says.
		if (resolveCoords(text)) return;
		// Also before the geocoder: a Plus Code is arithmetic too, and Nominatim
		// cannot read one at all — sending it there returns "nothing found" for
		// text that was a perfectly good location all along.
		if (resolvePlusCode(text) !== 'no') return;
		if (isMapsUrl(text)) {
			deadEnd(text);
			return;
		}
		if (opts.geocoderEnabled()) {
			void search(text);
			return;
		}
		error =
			"That doesn't have a location in it. Paste a link from a maps app, type a coordinate pair or a Plus Code, or use where you are.";
	}

	return {
		get place() {
			return place;
		},
		get query() {
			return query;
		},
		set query(v: string) {
			query = v;
		},
		get error() {
			return error;
		},
		get candidates() {
			return candidates;
		},
		get searching() {
			return searching;
		},
		get locating() {
			return locating;
		},

		onPaste(e: ClipboardEvent) {
			const text = e.clipboardData?.getData('text') ?? '';
			// Resolve from the clipboard directly rather than waiting for the
			// value to settle, so the pin appears on the paste itself.
			if (resolveLink(text) || resolveCoords(text)) {
				e.preventDefault();
				return true;
			}
			const plus = resolvePlusCode(text);
			if (plus === 'pinned') {
				e.preventDefault();
				return true;
			}
			/*
			 * A Plus Code we recognised but can't pin has already said why. The text
			 * is deliberately left to land in the field — the way round both refusals
			 * is to edit the code, and swallowing the paste would take away the thing
			 * being corrected. Same reasoning as the coordinate-less map link below.
			 */
			if (plus === 'explained') return false;
			if (!isMapsUrl(text)) return false;
			/*
			 * Silence here reads as broken — the whole paste appeared to do
			 * nothing. Say now why it isn't resolving, so the paste itself is
			 * the feedback. The text is left in the field (no preventDefault)
			 * so blur and Enter re-judge it, and the error stays the same one.
			 */
			if (parseMapsPlaceName(text) && opts.geocoderEnabled()) {
				e.preventDefault();
				deadEnd(text);
				return true;
			}
			deadEnd(text);
			return false;
		},

		commit,

		unresolved() {
			return query.trim() !== '' && place === null;
		},

		async locate() {
			if (!navigator.geolocation) {
				error = 'This device has no location to share. Paste a map link instead?';
				return;
			}
			locating = true;
			error = null;
			try {
				const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
					navigator.geolocation.getCurrentPosition(resolve, reject, {
						// Deliberately low. Everything finer than ~110 m is discarded
						// by roundToE3 anyway, and asking for high accuracy wakes the
						// GPS and costs seconds to produce a number we throw away.
						enableHighAccuracy: false,
						timeout: 8000,
						maximumAge: 300_000
					})
				);
				// A 2 km fix is a cell tower, not a shop. Pinning it would record a
				// confident lie, so say so and offer the honest route instead.
				if (pos.coords.accuracy > 2000) {
					error = `Your location is only accurate to about ${Math.round(
						pos.coords.accuracy / 1000
					)} km here. Paste a map link instead?`;
					return;
				}
				// Rounded here, before it is ever in the DOM: the precise fix never
				// enters a form field, never crosses the wire, never reaches a log.
				settled({
					...roundToE3({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
					label: null,
					source: 'device'
				});
			} catch (e) {
				// Same shape as the barcode scanner's camera decline: name what
				// happened and point at the way round it, never a dead end.
				const denied =
					typeof e === 'object' &&
					e !== null &&
					'code' in e &&
					(e as GeolocationPositionError).code === 1;
				error = denied
					? 'Location access was declined. You can paste a map link instead.'
					: 'Could not get your location on this device.';
			} finally {
				locating = false;
			}
		},

		pickCandidate(c: PlaceCandidate) {
			// Already rounded by the server. The label is shortened on the way in:
			// the picker shows the full postal chain because that is what tells two
			// candidates apart, but the row that ends up on the purchase wants the
			// name, not the county and the postcode.
			settled({
				latE3: c.latE3,
				lngE3: c.lngE3,
				label: shortenPlaceLabel(c.label),
				source: 'geocode'
			});
		},

		clear() {
			settled(null);
		},

		seed(p: PurchasePlace | null) {
			settled(p);
		}
	};
}
