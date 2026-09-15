/**
 * Is this endpoint the OpenStreetMap Foundation's own Nominatim?
 *
 * The one hosted instance the app knows by name, because its usage policy is
 * the one the adapter is written against: an identifiable contact, one request
 * a second, results cached. Knowing it by host lets config validation insist on
 * the contact before the first request goes out, and lets the settings screen
 * stop talking about imports and extracts to someone who never ran one.
 */
export function isPublicNominatim(endpoint: string | null | undefined): boolean {
	if (!endpoint) return false;
	try {
		return new URL(endpoint).hostname === 'nominatim.openstreetmap.org';
	} catch {
		return false;
	}
}
