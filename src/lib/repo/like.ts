/**
 * An ILIKE pattern that matches `text` anywhere, literally.
 *
 * `%` and `_` are wildcards to ILIKE, and a backslash escapes them, so a search
 * for "50%" used to match every row with a 50 in it, and "a_b" matched "axb".
 * Postgres's default escape character is the backslash, so escaping all three
 * is enough; no ESCAPE clause is needed.
 */
export function containsPattern(text: string): string {
	return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
