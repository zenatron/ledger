/**
 * Postgres SQLSTATE 22P02, `invalid_text_representation`: a value that could
 * not be cast to its column's type — in practice, an id from outside that isn't
 * a UUID. It is always the caller's input at fault and never partial: the
 * statement fails before any row is touched.
 *
 * Drizzle wraps the driver's error, so the code may sit on the error itself or
 * on its `cause`. Walked a few levels rather than one, since both postgres-js
 * and PGlite are in play and neither promises the depth.
 */
export function isMalformedInputError(e: unknown): boolean {
	let cur: unknown = e;
	for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
		if ((cur as { code?: unknown }).code === '22P02') return true;
		cur = (cur as { cause?: unknown }).cause;
	}
	return false;
}
