import type { ParamMatcher } from '@sveltejs/kit';
import { isUuid } from '$lib/uuid';

/**
 * `[id=uuid]`: a route segment that is only ever a row id.
 *
 * Without it a mistyped or truncated link reached the query as-is, and
 * Postgres refused the cast (`invalid input syntax for type uuid`) — a 500 and
 * a stack trace for what is simply a page that doesn't exist. A non-match here
 * is a plain 404 before any code runs.
 */
export const match: ParamMatcher = (param) => isUuid(param);
