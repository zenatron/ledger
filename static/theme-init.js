/*
 * Pre-paint theme application. Loaded as a same-origin, render-blocking script
 * in app.html <head> (an inline script would trip the app's strict CSP, which
 * has no unsafe-inline for good reason). Runs before first paint so there's no
 * flash. Theme is a per-device preference: default follows the OS, an explicit
 * choice lives in localStorage as data-theme. Kept in sync at runtime by
 * $lib/theme; the tokens themselves switch in CSS via color-scheme.
 *
 * Contrast works the same way, with one difference: it is resolved here rather
 * than in CSS. `data-contrast="more"` is set when the reader chose More, or left
 * it on System and the OS asks for more contrast — so the stylesheet carries one
 * token block instead of the same block twice (media query + attribute).
 */
(function () {
	try {
		var root = document.documentElement;
		var t = localStorage.getItem('theme'); // 'light' | 'dark' | null (system)
		if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
		var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
		var m = document.querySelector('meta[name="theme-color"]');
		if (m) m.setAttribute('content', dark ? '#201c17' : '#F4EEE1');

		var c = localStorage.getItem('contrast'); // 'more' | 'standard' | null (system)
		if (c === 'more' || (c !== 'standard' && matchMedia('(prefers-contrast: more)').matches)) {
			root.setAttribute('data-contrast', 'more');
		}
	} catch {
		/* localStorage/matchMedia unavailable — fall through to the light default */
	}
})();
