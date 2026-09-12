import { Money, formatMinorUnits, minorUnitDigits } from '$lib/domain/money/money';

/** Client-safe money formatting for bigint minor units (no float round-trip). */
export function formatMinor(minor: bigint, currency: string, locale?: string): string {
	const nf = new Intl.NumberFormat(locale, { style: 'currency', currency });
	return nf.format(formatMinorUnits(minor, minorUnitDigits(currency)) as unknown as number);
}

/**
 * The same formatted amount, split into its currency symbol and its digits, so
 * a caller pressed for width can put the symbol somewhere else — a card whose
 * label reads "EARNED $" buys back a character's worth of room for the number
 * without abbreviating or rounding it.
 *
 * Built on formatToParts rather than trimming the leading character off
 * formatMinor: that keeps the locale's own grouping, decimals and symbol
 * placement, including currencies that put the symbol after the digits and
 * those that separate it with a non-breaking space.
 */
export function splitCurrencyMinor(
	minor: bigint,
	currency: string,
	locale?: string
): { symbol: string; digits: string } {
	const nf = new Intl.NumberFormat(locale, { style: 'currency', currency });
	const parts = nf.formatToParts(
		formatMinorUnits(minor, minorUnitDigits(currency)) as unknown as number
	);
	let symbol = '';
	const digits = parts
		.filter((p) => {
			if (p.type !== 'currency') return true;
			symbol = p.value;
			return false;
		})
		.map((p) => p.value)
		.join('')
		.trim();
	return { symbol, digits };
}

/**
 * Whether an amount is wide enough to want the split above: ten million either
 * way, magnitude not sign.
 *
 * Worth knowing that a minus costs a glyph, so a negative is a decade wider
 * than the positive that trips this — "-$9,999,999.99" is as wide as
 * "$18,734,922.56" and sits just under the line. That gap is deliberate: it
 * belongs to whatever gives the three-across cards more room, not to a
 * threshold that would read as arbitrary everywhere else.
 */
export function tooWideForSymbol(minor: bigint, currency: string): boolean {
	const abs = minor < 0n ? -minor : minor;
	return abs >= 10_000_000n * 10n ** BigInt(minorUnitDigits(currency));
}

/**
 * Read a half-typed amount field into minor units, or null if it isn't a number
 * yet. For UI that reacts as you type (a warning, a preview) — the server still
 * parses the submitted string itself, and is the only thing that may reject it.
 */
export function tryParseMinor(input: string, currency: string): bigint | null {
	try {
		return Money.fromDecimal(input, currency).minor;
	} catch {
		return null;
	}
}

/**
 * The decimal-string form an `<input use:money>` expects: plain digits, one
 * dot, the currency's fraction digits, no grouping and no symbol. Forms must
 * preseed with this rather than stripping formatMinor's output — the formatted
 * string follows the device locale, and on comma-decimal locales stripping
 * non-digits silently re-values the amount ($1.234,56 becomes 1.23).
 */
export function minorToDecimalInput(minor: bigint | number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return (Number(minor) / 10 ** digits).toFixed(digits);
}
