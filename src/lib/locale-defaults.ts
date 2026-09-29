/**
 * Sensible first answers for a new workspace, read off the browser.
 *
 * The form used to default to USD and to the browser's timezone *if* that
 * zone's exact spelling was in the list — and when it wasn't (`UTC`, or an
 * alias like `Asia/Calcutta` for `Asia/Kolkata`), no option was selected and
 * the browser quietly submitted the first one: Africa/Abidjan. Both are easy
 * to miss on a form you fill in once, and both are expensive to get wrong,
 * because every period boundary and every amount hangs off them.
 */

/** Any zone the runtime can actually use, whether or not it's in the list. */
export function isUsableTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * The options to show, with the browser's own zone guaranteed among them —
 * added if the list spells it differently or omits it — so it can be selected.
 */
export function timeZoneOptions(list: string[], browserTz: string): string[] {
	if (!browserTz || list.includes(browserTz) || !isUsableTimeZone(browserTz)) return list;
	return [browserTz, ...list];
}

/*
 * Region → currency for where people are likeliest to run this. Not exhaustive
 * and not meant to be: an unlisted region falls back to USD exactly as before,
 * and the picker is right there.
 */
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const CURRENCY_BY_REGION: Record<string, string> = {
	US: 'USD',
	CA: 'CAD',
	MX: 'MXN',
	BR: 'BRL',
	AR: 'ARS',
	CL: 'CLP',
	CO: 'COP',
	GB: 'GBP',
	IE: 'EUR',
	CH: 'CHF',
	NO: 'NOK',
	SE: 'SEK',
	DK: 'DKK',
	IS: 'ISK',
	PL: 'PLN',
	CZ: 'CZK',
	HU: 'HUF',
	RO: 'RON',
	BG: 'BGN',
	UA: 'UAH',
	TR: 'TRY',
	IL: 'ILS',
	AE: 'AED',
	SA: 'SAR',
	EG: 'EGP',
	ZA: 'ZAR',
	NG: 'NGN',
	KE: 'KES',
	IN: 'INR',
	PK: 'PKR',
	BD: 'BDT',
	LK: 'LKR',
	NP: 'NPR',
	CN: 'CNY',
	HK: 'HKD',
	TW: 'TWD',
	JP: 'JPY',
	KR: 'KRW',
	SG: 'SGD',
	MY: 'MYR',
	TH: 'THB',
	VN: 'VND',
	ID: 'IDR',
	PH: 'PHP',
	AU: 'AUD',
	NZ: 'NZD',
	...Object.fromEntries(EURO.map((r) => [r, 'EUR']))
};

/** The currency for the browser's region, if it is one we know and offer. */
export function defaultCurrency(languages: readonly string[], offered: string[]): string {
	for (const tag of languages) {
		let region: string | undefined;
		try {
			region = new Intl.Locale(tag).maximize().region;
		} catch {
			continue;
		}
		const code = region ? CURRENCY_BY_REGION[region] : undefined;
		if (code && offered.includes(code)) return code;
	}
	return 'USD';
}
