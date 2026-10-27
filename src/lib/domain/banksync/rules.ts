/**
 * Bank-line categorisation — pure.
 *
 * Two layers, tried in order for each new synced line:
 *  1. **Rules** the household wrote ("contains COSTCO → Groceries", "starts with
 *     AUTOPAY → ignore"). First match by priority wins.
 *  2. **Memory**: the cleaned descriptor is looked up as a merchant name, and
 *     whatever this workspace last filed that merchant under is suggested.
 *     (That lookup is I/O and lives in the application layer; this module only
 *     produces the key — `merchantKey`.)
 *
 * Plain-text matching only. A user-supplied regex run on every line of every
 * sync is a denial-of-service waiting to happen, and contains/starts-with
 * covers what bank descriptors need.
 */

export type RuleMatch = 'contains' | 'starts_with' | 'equals';
export type RuleDirection = 'out' | 'in' | 'any';
export type RuleAction = 'categorize' | 'ignore';

export interface Rule {
	id: string;
	priority: number;
	match: RuleMatch;
	/** Stored already normalised with `normalizePattern`. */
	pattern: string;
	direction: RuleDirection;
	minAmountMinor: bigint | null;
	maxAmountMinor: bigint | null;
	feedAccountId: string | null;
	action: RuleAction;
	categoryId: string | null;
	renameTo: string | null;
}

export interface RuleSubject {
	/** Signed: negative is money out. */
	amountMinor: bigint;
	description: string;
	feedAccountId: string;
}

/** Fold case and whitespace — the same folding for patterns and descriptors. */
export function normalizePattern(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Strip the processor noise banks wrap a merchant in, so "SQ *BLUE BOTTLE
 * COFFEE #123 SAN FRANCISCO CA" can find the merchant "Blue Bottle Coffee".
 * Deliberately conservative: it only removes things that are never the name.
 */
export function cleanDescriptor(raw: string): string {
	let s = raw.trim();
	// Processor prefixes: "SQ *", "TST* ", "PAYPAL *", "SP * ", "PY *", "IN *".
	s = s.replace(/^(sq|tst|paypal|sp|py|in|dd|pos|ach|debit|purchase|checkcard)\s*\*\s*/i, '');
	s = s.replace(/^(pos|debit card|visa|purchase|checkcard)\s+(purchase\s+)?/i, '');
	// Card-network dates and reference numbers: "10/24", "#1234", "XXXX1234".
	s = s.replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, ' ');
	s = s.replace(/#\s*\d+/g, ' ');
	s = s.replace(/\bx{2,}\d+\b/gi, ' ');
	s = s.replace(/\b\d{5,}\b/g, ' ');
	s = s.replace(/[*]+/g, ' ').replace(/\s+/g, ' ').trim();
	// A trailing two-letter state code. The city before it is left alone: the
	// memory lookup matches a known merchant as a *prefix*, so it doesn't matter.
	s = s.replace(/ [A-Z]{2}$/, '').trim();
	return s || raw.trim();
}

/** The merchant-name key used for the memory lookup. */
export function merchantKey(raw: string): string {
	return normalizePattern(cleanDescriptor(raw));
}

function abs(n: bigint): bigint {
	return n < 0n ? -n : n;
}

export function ruleFits(rule: Rule, line: RuleSubject): boolean {
	if (rule.feedAccountId && rule.feedAccountId !== line.feedAccountId) return false;
	if (rule.direction === 'out' && line.amountMinor >= 0n) return false;
	if (rule.direction === 'in' && line.amountMinor <= 0n) return false;
	const mag = abs(line.amountMinor);
	if (rule.minAmountMinor !== null && mag < rule.minAmountMinor) return false;
	if (rule.maxAmountMinor !== null && mag > rule.maxAmountMinor) return false;
	if (!rule.pattern) return false;
	const d = normalizePattern(line.description);
	switch (rule.match) {
		case 'contains':
			return d.includes(rule.pattern);
		case 'starts_with':
			return d.startsWith(rule.pattern) || merchantKey(line.description).startsWith(rule.pattern);
		case 'equals':
			return d === rule.pattern || merchantKey(line.description) === rule.pattern;
	}
}

/** The first fitting rule by priority (lower first), then by age as given. */
export function firstRule(rules: readonly Rule[], line: RuleSubject): Rule | null {
	const ordered = [...rules].sort((a, b) => a.priority - b.priority);
	return ordered.find((r) => ruleFits(r, line)) ?? null;
}
