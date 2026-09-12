/**
 * Parse a spoken or typed sentence into the fields of a purchase — "23 bucks on
 * lunch at chipotle yesterday" → amount 23, item "lunch", merchant "Chipotle",
 * yesterday, logged.
 *
 * The rule that matters: the *money and the date are extracted deterministically
 * here and never by a model*. A misheard "$230" for "$23" must come from you, not
 * from a language model's guess — the same reason Safe to Spend is pure integer
 * arithmetic. A model may later refine the fuzzy leftovers (a cleaner item name,
 * a category), but the number and the day are decided by these rules alone.
 *
 * Pure and tested. Everything it returns lands in the form as editable fields;
 * nothing is ever submitted from here.
 */

import { compareDates, daysInMonth, type CalDate } from '../recurrence/rrule';

export interface ParsedPurchase {
	/** Decimal amount string (e.g. "23.50"), or null. Caller converts to minor. */
	amount: string | null;
	/** Days before today the purchase happened: 0 today, -1 yesterday, … */
	dateOffsetDays: number;
	/** Human label for the date, or null when none was said. */
	dateLabel: string | null;
	/** Whether it reads as already spent (log) or a request to make (ask first). */
	intent: 'log' | 'request';
	/** The item, with amount/date/merchant/filler stripped. May be empty. */
	itemName: string;
	/** Merchant named with "at"/"from", or null. */
	merchantName: string | null;
}

const REQUEST_CUES =
	/\b(can i|should i|shall i|may i|thinking of|want to buy|would like to|need approval|ask (?:first|about)|is it ok|do you think)\b/i;

/** Extract the first plausible money amount as a decimal string. */
function extractAmount(text: string): { amount: string | null; span: [number, number] | null } {
	// 1) An explicit currency marker is the strongest signal: $23, £4.50, €10.
	const sym = /(?:[$£€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(text);
	if (sym)
		return { amount: sym[1].replace(/,/g, ''), span: [sym.index, sym.index + sym[0].length] };

	// 2) A number followed by a money word: "23 dollars", "5 bucks".
	const word = /\b(\d+(?:\.\d{1,2})?)\s?(dollars?|bucks?|quid|euros?|pounds?)\b/i.exec(text);
	if (word) return { amount: word[1], span: [word.index, word.index + word[0].length] };

	// 3) A bare decimal reads as money far more than as anything else: "4.50".
	const dec = /\b(\d+\.\d{1,2})\b/.exec(text);
	if (dec) return { amount: dec[1], span: [dec.index, dec.index + dec[0].length] };

	// 4) A bare integer, but never one that is really a date ("3 days ago",
	//    "the 3rd", "2 weeks"). Skip integers glued to time words.
	const re = /\b(\d{1,6})\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12).toLowerCase();
		const before = text.slice(Math.max(0, m.index - 4), m.index).toLowerCase();
		if (/^\s*(days?|weeks?|months?|years?|hours?|min)/.test(after)) continue; // "3 days ago"
		if (/(the\s+)$/.test(before) && /^(st|nd|rd|th)/.test(after)) continue; // "the 3rd"
		return { amount: m[1], span: [m.index, m.index + m[0].length] };
	}
	return { amount: null, span: null };
}

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12
};

/**
 * Resolve a calendar date the person named into an offset from today. A purchase
 * is something that already happened, so an unqualified "the 3rd" or "Jan 12"
 * means the most recent one at or before today — never a future date, which
 * would be a different kind of claim entirely. A date spoken *with* a year is
 * different: the year pins it, so it resolves to exactly that day, wherever it
 * sits relative to today (a future one resolves to nothing, not to a guess).
 *
 * Returns null when the date can't exist (the 31st of a 30-day month), rather
 * than clamping. Clamping would silently record a different day than was said.
 */
function offsetToRecent(
	today: CalDate,
	month: number | null,
	day: number,
	year: number | null
): number | null {
	let y = today.y;
	let m = month ?? today.m;
	if (day < 1) return null;

	if (year !== null) {
		// The year pins the day exactly, wherever it sits (a future one resolves
		// to nothing rather than to a guess). Callers drop implausible years
		// before this point.
		if (day > daysInMonth(year, m)) return null;
		const offset = compareDates({ y: year, m, d: day }, today);
		return offset > 0 ? null : offset;
	}

	if (month === null) {
		// Day-of-month only: this month if it has already passed, else last month.
		if (day > today.d) {
			m -= 1;
			if (m === 0) {
				m = 12;
				y -= 1;
			}
		}
	} else if (compareDates({ y, m, d: day }, today) > 0) {
		y -= 1;
	}

	if (day > daysInMonth(y, m)) return null;
	return compareDates({ y, m, d: day }, today);
}

/**
 * Extract a date. Only unambiguous, common phrases — never a guess.
 *
 * Relative phrases need no reference point. Absolute ones ("on the 3rd",
 * "Jan 12") do, so they resolve only when the caller passes `today`; without it
 * they are left alone and the sentence dates to today as before.
 *
 * Deliberately absent: bare numeric dates like "12/03". There is no way to tell
 * 3 December from 12 March without a locale this app never asks for, and a wrong
 * guess backdates money by months. Slash forms are read only when one component
 * settles it (25/12 can only be December), and ISO "2026-01-12" is read because
 * it is unambiguous by construction.
 */
function extractDate(
	text: string,
	today?: CalDate
): {
	offset: number;
	label: string | null;
	span: [number, number] | null;
} {
	const t = text.toLowerCase();
	const patterns: { re: RegExp; offset: (m: RegExpExecArray) => number; label: string }[] = [
		{ re: /\bthe day before yesterday\b/, offset: () => -2, label: 'the day before yesterday' },
		{ re: /\byesterday\b/, offset: () => -1, label: 'yesterday' },
		{ re: /\btoday\b/, offset: () => 0, label: 'today' },
		{ re: /\b(\d{1,3})\s+days?\s+ago\b/, offset: (m) => -Number(m[1]), label: 'days ago' },
		{ re: /\b(\d{1,2})\s+weeks?\s+ago\b/, offset: (m) => -7 * Number(m[1]), label: 'weeks ago' }
	];
	for (const p of patterns) {
		const m = p.re.exec(t);
		if (m) {
			const label = p.label.includes('ago') ? m[0] : p.label;
			return { offset: p.offset(m), label, span: [m.index, m.index + m[0].length] };
		}
	}

	if (!today) return { offset: 0, label: null, span: null };

	const months = Object.keys(MONTHS).join('|');
	// Each entry yields [month|null, day, year|null]; a null month means
	// day-of-month only, a null year means "most recent at or before today".
	const YEAR = `(?:,?\\s+(\\d{4}))?`;
	const absolute: {
		re: RegExp;
		parts: (m: RegExpExecArray) => [number | null, number, number | null];
	}[] = [
		// ISO: 2026-01-12 — the year pins the day exactly
		{
			re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
			parts: (m) => [Number(m[2]), Number(m[3]), Number(m[1])]
		},
		// "Jan 12", "January 12th", "Jan 12, 2024"
		{
			re: new RegExp(`\\b(?:on\\s+)?(${months})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${YEAR}\\b`),
			parts: (m) => [MONTHS[m[1]], Number(m[2]), m[3] ? Number(m[3]) : null]
		},
		// "12 Jan", "12th of January", "12 Jan 2024"
		{
			re: new RegExp(
				`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\.?${YEAR}\\b`
			),
			parts: (m) => [MONTHS[m[2]], Number(m[1]), m[3] ? Number(m[3]) : null]
		},
		// Slashes, only where one component can't be a month.
		{
			re: /\b(\d{1,2})\/(\d{1,2})\b/,
			parts: (m) => {
				const a = Number(m[1]);
				const b = Number(m[2]);
				if (a > 12 && b <= 12) return [b, a, null];
				if (b > 12 && a <= 12) return [a, b, null];
				return [null, -1, null];
			}
		},
		// "on the 3rd", "the 21st"
		{
			re: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/,
			parts: (m) => [null, Number(m[1]), null]
		}
	];

	for (const p of absolute) {
		const m = p.re.exec(t);
		if (!m) continue;
		const [month, day, stated] = p.parts(m);
		let year = stated;
		let matched = m[0];
		if (year !== null && (year < 1970 || year > today.y + 1)) {
			// Not a plausible year — a stray 4-digit number is likelier an
			// amount than a date. Drop it from the match, span included, and
			// read the day unqualified, as it always was.
			year = null;
			matched = matched.replace(/,?\s+\d{4}$/, '');
		}
		const offset = offsetToRecent(today, month, day, year);
		if (offset === null) continue;
		return {
			offset,
			label: matched.replace(/^on\s+/, ''),
			span: [m.index, m.index + matched.length]
		};
	}

	return { offset: 0, label: null, span: null };
}

/**
 * Words that are capitalised often enough at the head of a sentence that seeing
 * a capital tells us nothing about them being a name.
 */
const NOT_A_MERCHANT =
	/^(?:i|a|an|the|my|our|we|it|this|that|just|bought|spent|paid|got|grabbed|picked|log|logged|add|added|buy|purchase|purchased|lunch|dinner|breakfast|coffee|groceries|gas|food|stuff|things?)$/i;

/**
 * Extract the merchant.
 *
 * Three shapes, strongest first. The first is explicit — "at Chipotle", "from
 * Amazon" — and works however the person capitalised things, because the
 * preposition is doing the work.
 *
 * The other two lean on the person's own capitals as the signal that a word is a
 * name: "Costco run, 84 bucks" and "lunch, Chipotle, 12". That means a sentence
 * typed entirely in lower case gives up its merchant, which is the right way to
 * fail here — the module's whole stance is that a missed field is a small
 * annoyance the person fixes in the form, while a confidently wrong one is a
 * wrong record. "coffee, black, 4" must not decide it shopped at Black.
 */
function extractMerchant(text: string): { merchant: string | null; span: [number, number] | null } {
	// A name: one to three capitalised words, allowing &, ', . and - inside.
	const NAME = "[A-Z][\\w&'.\\-]*(?:\\s+[A-Z][\\w&'.\\-]*){0,2}";

	const byPreposition =
		/\b(?:at|from)\s+([A-Za-z0-9&'.\- ]+?)(?=\s+(?:yesterday|today|for|on|and|,|\d)|$)/i.exec(text);
	if (byPreposition) {
		const merchant = titleCase(byPreposition[1].trim());
		if (merchant)
			return {
				merchant,
				span: [byPreposition.index, byPreposition.index + byPreposition[0].length]
			};
	}

	// "Costco run", "Target trip" — the cue word marks the capital as a store.
	const byErrand = new RegExp(`\\b(${NAME})\\s+(?:run|trip|haul)\\b`).exec(text);
	if (byErrand && !NOT_A_MERCHANT.test(byErrand[1])) {
		return {
			merchant: titleCase(byErrand[1]),
			span: [byErrand.index, byErrand.index + byErrand[1].length]
		};
	}

	// "lunch, Chipotle, 12" — a capitalised run set off by a comma.
	const byComma = new RegExp(`,\\s*(${NAME})\\s*(?=,|$)`).exec(text);
	if (byComma && !NOT_A_MERCHANT.test(byComma[1])) {
		const at = byComma.index + byComma[0].indexOf(byComma[1]);
		return { merchant: titleCase(byComma[1]), span: [at, at + byComma[1].length] };
	}

	return { merchant: null, span: null };
}

/**
 * Capitalise each word's first letter, but leave a word alone when the person
 * already put a capital inside it. Brands style themselves — "iPhone", "eBay" —
 * and a blanket \b\w uppercase both destroyed that and turned "mcdonald's" into
 * "Mcdonald'S", because \b matches after the apostrophe too.
 */
function titleCase(s: string): string {
	return s
		.split(/(\s+)/)
		.map((w) => (/[A-Z]/.test(w.slice(1)) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join('');
}

/**
 * Blank out a span with spaces of *equal length*, so the spans of the other
 * extractions (all computed against the original string) stay valid no matter
 * the order we blank in. Collapsing to a single space would shift every later
 * index left and strand fragments in the residual.
 */
function blank(text: string, span: [number, number] | null): string {
	if (!span) return text;
	return text.slice(0, span[0]) + ' '.repeat(span[1] - span[0]) + text.slice(span[1]);
}

const FILLER =
	/^(?:i\s+)?(?:just\s+)?(?:bought|spent|paid(?:\s+for)?|got|grabbed|picked up|log|logged|add|added|buy|purchase[d]?|for|on|a|an|the|some|of|money|dollars?|bucks?)\b/i;

/**
 * @param today The person's calendar date in their own timezone, used only to
 * resolve absolute dates ("the 3rd") into an offset. Omit it and those phrases
 * are ignored; relative ones work either way.
 */
export function parsePurchaseText(text: string, today?: CalDate): ParsedPurchase {
	const original = text.trim();
	const intent: ParsedPurchase['intent'] = REQUEST_CUES.test(original) ? 'request' : 'log';

	/*
	 * Date first, and the amount reads the sentence with the date already blanked
	 * out. Dates are full of bare numbers that are not money: "Jan 12" has no
	 * currency marker and no money word, so the amount's last-resort integer rule
	 * would happily bill it as $12. Taking the date out of the running first
	 * removes the whole class of collision instead of guarding one phrase at a
	 * time — the guards inside extractAmount stay as a second line of defence for
	 * the date shapes we don't parse.
	 */
	const date = extractDate(original, today);
	const amt = extractAmount(blank(original, date.span));
	const merch = extractMerchant(original);

	// Strip everything structured, leaving the item as the residual text.
	let residual = original;
	residual = blank(residual, amt.span);
	residual = blank(residual, date.span);
	residual = blank(residual, merch.span);
	residual = residual
		.replace(REQUEST_CUES, ' ')
		.replace(/[$£€]/g, ' ')
		.replace(/\s+/g, ' ')
		// Lifting a field out of the middle of a comma-separated sentence leaves
		// the commas that framed it — "lunch, Chipotle, 12" blanks down to
		// "lunch, ,". Close the empty slots up before the item is read off.
		.replace(/\s*,(?:\s*,)*\s*/g, ', ')
		.replace(/^[\s,]+|[\s,]+$/g, '')
		.trim();

	// Peel leading filler words ("i bought a", "spent on", …) one at a time.
	let prev: string;
	do {
		prev = residual;
		residual = residual.replace(FILLER, '').trim();
	} while (residual !== prev && residual.length > 0);

	// Then peel trailing prepositions left dangling where a stripped amount or
	// date used to be ("book for" ← "book for 15 dollars").
	do {
		prev = residual;
		residual = residual.replace(/\s*\b(?:for|on|at|and|of|the|a|an|to|with|some)\s*$/i, '').trim();
	} while (residual !== prev && residual.length > 0);

	return {
		amount: amt.amount,
		dateOffsetDays: date.offset,
		dateLabel: date.label,
		intent,
		itemName: residual,
		merchantName: merch.merchant
	};
}
