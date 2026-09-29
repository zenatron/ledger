/**
 * Whether a string has the shape of a UUID.
 *
 * Every id in this schema is a `uuid` column, and Postgres rejects anything
 * else at the cast with an error rather than matching nothing — so an id that
 * arrives from outside (a URL, a form field, a query parameter) has to be
 * shape-checked before it reaches a query, or a typo becomes a 500. Checking
 * shape, not version: ids are uuidv7 today, but seeds and older rows need not be.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_RE.test(value);
}

/** The value if it is a UUID, otherwise null — for optional ids off a form or URL. */
export function uuidOrNull(value: unknown): string | null {
	return isUuid(value) ? value : null;
}
