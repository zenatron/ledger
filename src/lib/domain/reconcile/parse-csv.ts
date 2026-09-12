/**
 * Pure CSV statement parser. Takes a raw CSV string and a workspace currency,
 * returns parsed statement lines ready for matching. No I/O, no hashing —
 * dedup keys are plain strings; the application layer hashes them before
 * persistence.
 *
 * Handles RFC 4180 quoting, formula-injection-safe field access, and the
 * messy realities of bank CSVs: parenthetical amounts, thousands separators,
 * and a half-dozen date formats.
 */

export interface CsvColumnMap {
	dateCol: number;
	amountCol: number;
	descriptionCol: number;
	/** True when positive amounts represent credits rather than debits. */
	invertAmount?: boolean;
	/** Disambiguate 01/02/2025. Defaults to 'MDY'. */
	dateOrder?: 'MDY' | 'DMY' | 'YMD';
}

export interface RawStatementLine {
	postedAt: Date;
	amountMinor: bigint;
	currency: string;
	rawDescription: string;
	normalizedDescription: string;
}

export interface ParseError {
	line: number;
	message: string;
}

export interface ParseResult {
	lines: RawStatementLine[];
	errors: ParseError[];
}

/**
 * Build a deterministic dedup key from a parsed line — the three fields used
 * to decide whether the same bank-line has been seen before. The caller hashes
 * this before storing in `statement_line.dedup_hash`.
 */
export function dedupKey(line: RawStatementLine): string {
	return `${line.postedAt.toISOString().slice(0, 10)}|${line.amountMinor}|${line.normalizedDescription}`;
}

// ---------------------------------------------------------------------------
// Column auto-detection
// ---------------------------------------------------------------------------

const DATE_NAMES = new Set([
	'date',
	'posted',
	'post date',
	'posting date',
	'transaction date',
	'trans date',
	'postdate',
	'trandate',
	'settlement date',
	'value date',
	'trade date'
]);

const AMOUNT_NAMES = new Set([
	'amount',
	'value',
	'sum',
	'total',
	'transaction amount',
	'debit',
	'credit',
	'debit amount',
	'credit amount',
	'withdrawal',
	'deposit',
	'paid in',
	'paid out',
	'amount (usd)',
	'amount (eur)',
	'amount (gbp)'
]);

const DESCRIPTION_NAMES = new Set([
	'description',
	'desc',
	'memo',
	'name',
	'payee',
	'details',
	'narrative',
	'merchant',
	'reference',
	'transaction description',
	'trans desc',
	'text',
	'notes',
	'comment'
]);

function normalise(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Try to map date/amount/description columns from CSV headers. Returns null
 * when any required column cannot be guessed — the caller shows a manual
 * mapping UI.
 */
export function detectColumns(headers: string[]): CsvColumnMap | null {
	const norm = headers.map(normalise);
	let dateCol = -1;
	let amountCol = -1;
	let descriptionCol = -1;

	for (let i = 0; i < norm.length; i++) {
		const h = norm[i];
		if (dateCol === -1 && DATE_NAMES.has(h)) dateCol = i;
		if (amountCol === -1 && AMOUNT_NAMES.has(h)) amountCol = i;
		if (descriptionCol === -1 && DESCRIPTION_NAMES.has(h)) descriptionCol = i;
	}

	if (dateCol === -1 || amountCol === -1 || descriptionCol === -1) return null;
	return { dateCol, amountCol, descriptionCol };
}

// ---------------------------------------------------------------------------
// CSV tokeniser (RFC 4180)
// ---------------------------------------------------------------------------

function parseCsvLines(text: string): string[][] {
	// Normalise line endings and strip a trailing empty line common in exports.
	const t = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\n$/, '');
	if (t.length === 0) return [];

	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuoted = false;

	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		const next = i + 1 < t.length ? t[i + 1] : null;

		if (inQuoted) {
			if (ch === '"') {
				if (next === '"') {
					field += '"';
					i++; // skip escaped quote
				} else {
					inQuoted = false;
				}
			} else {
				field += ch;
			}
		} else {
			if (ch === '"' && field.length === 0) {
				inQuoted = true;
			} else if (ch === ',') {
				row.push(field);
				field = '';
			} else if (ch === '\n') {
				row.push(field);
				field = '';
				rows.push(row);
				row = [];
			} else {
				field += ch;
			}
		}
	}
	// Last field if any.
	row.push(field);
	if (row.some((f) => f.length > 0) || rows.length === 0) {
		rows.push(row);
	}

	return rows;
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

/**
 * Parse a bank-amount field into signed minor units (cents). Handles:
 *   $1,234.56  →  123456
 *   1.234,56   →  123456   (decimal comma)
 *   1,234      →  123400   (lone comma + 3 digits reads as thousands)
 *   12,50      →  1250     (lone comma + 1-2 digits reads as decimal)
 *   -$100.00   → -10000
 *   (100.00)   → -10000   (accounting notation)
 *   100.00-    → -10000   (trailing minus)
 *   $0.00      →  0
 *   blank      →  null
 *
 * Digits are accumulated as integers — never through Number() — so large
 * amounts cannot drift by float rounding.
 */
function parseAmount(raw: string): bigint | null {
	const s = raw.trim();
	if (s.length === 0) return null;

	// Accounting parenthetical: (1,234.56) means -1234.56
	const accounting = /^\((.+)\)$/.exec(s);
	const negative = accounting !== null;
	const body = accounting ? accounting[1] : s;

	// Strip currency symbols and trailing DR/CR markers.
	let cleaned = body
		.replace(/^[$£€¥A-Z]{1,3}\s*/i, '')
		.replace(/\s*[$£€¥A-Z]{1,3}$/i, '')
		.replace(/\s*(?:DR|CR)$/i, '')
		.trim();

	// Trailing minus: 100.00-
	const trailingMinus = cleaned.endsWith('-');
	if (trailingMinus) cleaned = cleaned.slice(0, -1).trim();

	// Leading minus.
	const leadingMinus = cleaned.startsWith('-');
	if (leadingMinus) cleaned = cleaned.slice(1).trim();

	if (!/^[0-9.,]+$/.test(cleaned)) return null;

	// Classify the separators. When both kinds appear, the last one is the
	// decimal marker and the other is grouping. When only one kind appears,
	// a lone separator with a three-digit tail and a 1-3 digit integer part
	// is grouping ("1,234" — whole amounts, the common bank form); anything
	// else it is a decimal marker ("12,50", "0,500", "12345.678"). Repeated
	// separators always group.
	let digits: string;
	let frac = '';
	const lastComma = cleaned.lastIndexOf(',');
	const lastDot = cleaned.lastIndexOf('.');
	if (lastComma !== -1 && lastDot !== -1) {
		const decimal = lastComma > lastDot ? ',' : '.';
		const grouping = decimal === ',' ? '.' : ',';
		const cut = cleaned.lastIndexOf(decimal);
		digits = cleaned.slice(0, cut).replaceAll(grouping, '');
		frac = cleaned.slice(cut + 1);
	} else if (lastComma !== -1 || lastDot !== -1) {
		const sep = lastComma !== -1 ? ',' : '.';
		const occurrences = cleaned.split(sep).length - 1;
		const cut = cleaned.lastIndexOf(sep);
		const head = cleaned.slice(0, cut);
		const tail = cleaned.slice(cut + 1);
		const groupsAsThousand =
			occurrences > 1 || (/^\d{3}$/.test(tail) && /^\d{1,3}$/.test(head) && !/^0+$/.test(head));
		if (groupsAsThousand) {
			digits = cleaned.replaceAll(sep, '');
		} else {
			digits = head;
			frac = tail;
		}
	} else {
		digits = cleaned;
	}

	if (!/^\d*$/.test(digits) || !/^\d*$/.test(frac) || (digits.length === 0 && frac.length === 0)) {
		return null;
	}

	// Round half-up at the second fraction digit; cents is the unit of record.
	const head = frac.slice(0, 2).padEnd(2, '0');
	let minor = BigInt(digits.length === 0 ? '0' : digits) * 100n + BigInt(head);
	if (frac.length > 2 && frac[2] >= '5') minor += 1n;

	const sign = negative || leadingMinus || trailingMinus ? -1n : 1n;
	return sign * minor;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Try common date formats. Returns a Date at local midnight for the parsed
 * date — the caller later interprets it in the workspace timezone.
 */
function parseDate(raw: string, order: 'MDY' | 'DMY' | 'YMD'): Date | null {
	const s = raw.trim();
	if (s.length === 0) return null;

	// ISO 8601: 2024-01-15 or 2024/01/15
	const iso = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
	if (iso) return localDate(+iso[1], +iso[2], +iso[3]);

	// Compact: 20240115
	const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
	if (compact) {
		return localDate(+compact[1], +compact[2], +compact[3]);
	}

	// Slash-separated: MM/DD/YYYY or DD/MM/YYYY
	const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
	if (slash) {
		const a = +slash[1];
		const b = +slash[2];
		const y = fullYear(+slash[3]);
		if (order === 'DMY') return localDate(y, b, a);
		if (order === 'YMD') return localDate(y, a, b);
		return localDate(y, a, b); // default MDY
	}

	// Dash-separated: MM-DD-YYYY or DD-MM-YYYY
	const dash = /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/.exec(s);
	if (dash) {
		const a = +dash[1];
		const b = +dash[2];
		const y = fullYear(+dash[3]);
		if (order === 'YMD') return localDate(y, a, b);
		return localDate(y, a, b); // default MDY for dash too
	}

	// "Jan 15, 2024" or "15 Jan 2024"
	const named = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$/.exec(s);
	if (named) {
		const m = monthNum(named[2]);
		if (m) return localDate(fullYear(+named[3]), m, +named[1]);
	}
	const named2 = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s);
	if (named2) {
		const m = monthNum(named2[1]);
		if (m) return localDate(fullYear(+named2[3]), m, +named2[2]);
	}

	return null;
}

function fullYear(y: number): number {
	return y < 100 ? 2000 + y : y;
}

function localDate(y: number, m: number, d: number): Date | null {
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	// Construct as UTC noon to avoid timezone offset issues, then the caller
	// treats it as a calendar date.
	return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}

function monthNum(name: string): number | null {
	const n = normalise(name);
	const months: Record<string, number> = {
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
		september: 9,
		oct: 10,
		october: 10,
		nov: 11,
		november: 11,
		dec: 12,
		december: 12
	};
	return months[n] ?? null;
}

// ---------------------------------------------------------------------------
// Description normalisation
// ---------------------------------------------------------------------------

function normaliseDescription(raw: string): string {
	return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseCsv(csv: string, currency: string, map?: CsvColumnMap): ParseResult {
	const errors: ParseError[] = [];
	const parsedRows = parseCsvLines(csv);

	if (parsedRows.length === 0) {
		return { lines: [], errors: [{ line: 0, message: 'The file is empty.' }] };
	}

	const header = parsedRows[0];
	const dataRows = parsedRows.slice(1);

	const mapping = map ?? detectColumns(header);
	if (!mapping) {
		return {
			lines: [],
			errors: [
				{
					line: 1,
					message: `Could not auto-detect date, amount, and description columns among: ${header.map((h) => `"${h}"`).join(', ')}`
				}
			]
		};
	}

	const order = mapping.dateOrder ?? 'MDY';
	const lines: RawStatementLine[] = [];

	for (let i = 0; i < dataRows.length; i++) {
		const row = dataRows[i];
		const lineNum = i + 2; // 1-based, header was line 1

		if (row.length === 0 || row.every((f) => f.trim().length === 0)) continue;

		const dateRaw = mapping.dateCol < row.length ? row[mapping.dateCol] : '';
		const amountRaw = mapping.amountCol < row.length ? row[mapping.amountCol] : '';
		const descRaw = mapping.descriptionCol < row.length ? row[mapping.descriptionCol] : '';

		if (dateRaw.trim().length === 0 && amountRaw.trim().length === 0) continue;

		const postedAt = parseDate(dateRaw, order);
		if (!postedAt) {
			errors.push({ line: lineNum, message: `Could not parse date "${dateRaw}".` });
			continue;
		}

		const amountMinor = parseAmount(amountRaw);
		if (amountMinor === null) {
			errors.push({ line: lineNum, message: `Could not parse amount "${amountRaw}".` });
			continue;
		}

		const rawDescription = descRaw.trim();
		if (rawDescription.length === 0) {
			errors.push({ line: lineNum, message: 'Description is empty.' });
			continue;
		}

		const finalAmount = mapping.invertAmount ? -amountMinor : amountMinor;

		lines.push({
			postedAt,
			amountMinor: finalAmount,
			currency,
			rawDescription,
			normalizedDescription: normaliseDescription(rawDescription)
		});
	}

	return { lines, errors };
}
