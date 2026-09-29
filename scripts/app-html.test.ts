import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The page template opens with a doctype, enforced.
 *
 * SvelteKit writes app.html out verbatim, so it is the only place a doctype
 * can come from. One was dropped in a tidy-up and nothing noticed for two
 * months: every page rendered in quirks mode, where percentage heights, table
 * font inheritance and inline line-height all follow pre-standards rules that
 * Tailwind's preflight does not expect. It looks almost right, which is why it
 * has to be checked rather than remembered.
 *
 * A lint, not a unit test — see input-font-size.test.ts for why it lives here.
 */

const ROOT = new URL('..', import.meta.url).pathname;

describe('HTML templates', () => {
	for (const file of ['src/app.html', 'static/offline.html']) {
		it(`${file} starts with <!doctype html>`, () => {
			const html = readFileSync(`${ROOT}/${file}`, 'utf8');
			expect(html.trimStart().slice(0, 15).toLowerCase()).toBe('<!doctype html>');
		});
	}
});
