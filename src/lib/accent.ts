/**
 * Workspace accent colors. A workspace stores its own `accent_color`; when it
 * has none (workspaces created before the picker existed), we derive a stable
 * one from the slug so the same workspace always looks the same.
 *
 * Shared because the layout, the welcome page, and the settings picker must all
 * agree — a second copy of this list is a second theme.
 */
/*
 * These started as the iOS system colours — but those are tuned for a *dark*
 * background, and this app is light warm paper throughout. The bright ones
 * measured 1.2–1.8:1 against --paper, where the rest of the set sits around
 * 3:1, so green, turquoise, yellow and orange have been darkened to match the
 * cohort. Same hue, lower lightness. A yellow legible on cream is necessarily
 * an ochre, and an orange a burnt one: the old Tangerine (#FF9F0A) measured
 * 1.86:1 on paper, so every accent-coloured word in a Tangerine workspace was
 * close to invisible. #C9700A is 3.27:1, inside the cohort's 3.1–3.3.
 *
 * If you add one, check it against --paper before committing: on this
 * background, "vivid" and "invisible" are close neighbours.
 */
export const ACCENTS = [
	'#C9700A',
	'#FF375F',
	'#0D9E3A',
	'#0A84FF',
	'#BF5AF2',
	'#FF453A',
	'#1795A9',
	'#A0860C',
	'#B4472B',
	'#6E6A61'
] as const;

/**
 * Display names, in palette order. Presentation only — a workspace stores the
 * hex, never the name, so renaming one is a copy change and nothing more.
 */
export const ACCENT_NAMES: Record<string, string> = {
	'#C9700A': 'Tangerine',
	'#FF375F': 'Magenta',
	'#0D9E3A': 'Evergreen',
	'#0A84FF': 'Azure',
	'#BF5AF2': 'Lilac',
	'#FF453A': 'Crimson',
	'#1795A9': 'Cerulean',
	'#A0860C': 'Peanut',
	'#B4472B': 'Cinnamon',
	'#6E6A61': 'Graphite'
};

export function accentName(hex: string): string {
	return ACCENT_NAMES[hex.toUpperCase()] ?? hex;
}

/** Retired brights, mapped to their replacements — see scripts/restyle-accents.ts. */
export const RETIRED_ACCENTS: Record<string, string> = {
	'#30D158': '#0D9E3A',
	'#40C8E0': '#1795A9',
	'#FFD60A': '#A0860C',
	'#FF9F0A': '#C9700A'
};

export function accentFor(ws: { slug: string; accentColor?: string | null }): string {
	/*
	 * A stored retired bright renders as its replacement right away. The restyle
	 * script still rewrites the column (so the picker's own hex matches), but a
	 * self-hosted deployment that never runs it shouldn't keep a colour that was
	 * retired for being unreadable.
	 */
	if (ws.accentColor) return RETIRED_ACCENTS[ws.accentColor.toUpperCase()] ?? ws.accentColor;
	const hash = ws.slug.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
	return ACCENTS[hash % ACCENTS.length];
}
