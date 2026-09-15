/**
 * The guardrail that turns "an LLM said something" into "a suggestion we're
 * willing to show". The whole trust posture of the assist layer lives here.
 *
 * A model is a fuzzy reducer, never an approver. So its output is never taken
 * on faith: whatever it returns is forced back through the deterministic set of
 * choices the caller already owned. If the model names a choice we offered, we
 * accept that choice; if it invents, hedges, or wanders, we accept nothing. A
 * hallucination can only ever become *no suggestion* — never a wrong one, and
 * never an action.
 *
 * Pure and exhaustively tested, because this is the seam an untrusted component
 * meets the trusted core.
 */

export interface Choice {
	/** Stable identifier the caller acts on (a category id, a merchant id, …). */
	id: string;
	/** Human label the model is likely to echo back. */
	label: string;
}

/** Words that mean "I decline" — treated as an honest abstention, not a match. */
const ABSTENTIONS = new Set([
	'',
	'none',
	'no',
	'na',
	'n/a',
	'null',
	'unknown',
	'unsure',
	'other',
	'nothing',
	'skip'
]);

/** ASCII control characters a model or a bank descriptor might smuggle in. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');
/** Punctuation/quotes/brackets a model tends to wrap an answer in. */
const WRAPPERS = /^["'`{}[\]().,:;\s]+|["'`{}[\]().,:;\s]+$/g;

function normalize(s: string): string {
	return s.toLowerCase().trim().replace(WRAPPERS, '').replace(/\s+/g, ' ');
}

/**
 * A choice may be labelled with its full path — "Food > Groceries" — so the
 * model can tell nested options apart. Having been shown the path, a model will
 * often answer with just the leaf, which is a correct answer in a different
 * shape rather than a miss. `leafOf` recovers it; the caller still requires the
 * leaf to be unique before accepting, so nothing is guessed between two.
 */
function leafOf(label: string): string {
	const i = label.lastIndexOf('>');
	return i === -1 ? label : label.slice(i + 1);
}

/**
 * Reduce a model's raw answer to at most one of `choices`, or null.
 *
 * Accepts, in order of confidence: an exact id, an exact label, then a raw
 * string that contains exactly one choice's label as a whole substring. Anything
 * ambiguous (zero or several) or abstaining yields null — the caller then falls
 * back to whatever it would have done without a model at all.
 */
export function constrainToChoice(raw: string, choices: Choice[]): string | null {
	const norm = normalize(raw);
	if (ABSTENTIONS.has(norm)) return null;

	const byId = new Map(choices.map((c) => [normalize(c.id), c.id]));
	const byLabel = new Map(choices.map((c) => [normalize(c.label), c.id]));

	// Exact identifier or label — the model echoed a real option.
	if (byId.has(norm)) return byId.get(norm)!;
	if (byLabel.has(norm)) return byLabel.get(norm)!;

	// The leaf of a path label, when it belongs to exactly one option.
	const leafHits = choices.filter((c) => normalize(leafOf(c.label)) === norm);
	if (leafHits.length === 1) return leafHits[0].id;

	// The model wrapped the answer in a sentence ("It's Groceries."). Accept only
	// if exactly one choice appears as a whole-word substring — never guess between
	// two, and never let a label that is a fragment of another win by accident.
	const hits = choices.filter((c) => {
		const forms = [normalize(c.label), normalize(leafOf(c.label))].filter(Boolean);
		return forms.some((f) => new RegExp(`(^|\\W)${escapeRegExp(f)}(\\W|$)`).test(norm));
	});
	if (hits.length === 1) return hits[0].id;

	return null;
}

/**
 * Clean a free-form label suggestion (e.g. a merchant name derived from a bank
 * descriptor) into something safe to show, or null. Not a choice from a set, so
 * the defense is different: cap length, strip control characters and wrapping
 * punctuation, collapse whitespace, and reject abstentions or anything that
 * decays to empty. Still a suggestion, never applied without a human.
 */
export function sanitizeLabel(raw: string, maxLen = 60): string | null {
	// Take only the first line — a chatty model may add explanation below.
	const firstLine = raw.split(/[\r\n]/)[0] ?? '';
	const cleaned = firstLine
		.replace(CONTROL_CHARS, ' ')
		.replace(WRAPPERS, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return null;
	if (ABSTENTIONS.has(cleaned.toLowerCase())) return null;
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
