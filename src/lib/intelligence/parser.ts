/**
 * Rule-based natural language parser for budget queries and commands.
 * No AI — just token matching, entity extraction, and pattern routing.
 */
import { calDateInZone } from '$lib/domain/time/zoned';

export interface SpendingQuery {
	intent: 'spending_query';
	category?: string;
	member?: string;
	period: TimePeriod;
}

export interface NetQuery {
	intent: 'net_position';
	period: TimePeriod;
}

export interface CreateBucketCommand {
	intent: 'create_bucket';
	name: string;
	amount: number;
	dayOfMonth: number;
}

export interface CreateIncomeCommand {
	intent: 'create_income';
	source: string;
	amount: number;
	cadence: 'once' | 'monthly';
	dayOfMonth: number;
}

export interface NavigateCommand {
	intent: 'navigate';
	target: 'analytics' | 'buckets' | 'recurring' | 'income' | 'purchases' | 'settings';
}

/** Set (or replace) a budget from the palette: "set groceries budget to 400". */
export interface SetBudgetCommand {
	intent: 'set_budget';
	/** Category name as typed; "everything"/"overall" means the overall cap. */
	category: string;
	amount: number;
	period: 'month' | 'week';
}

/** "How much can I spend?" — answered from Safe to Spend, no model involved. */
export interface SafeToSpendQuery {
	intent: 'safe_to_spend';
}

/**
 * A command we routed but couldn't complete. Distinct from `unknown`: we know
 * what the user is trying to do, so the UI can say what's missing instead of
 * shrugging.
 */
export interface IncompleteResult {
	intent: 'incomplete';
	of: 'create_bucket' | 'create_income';
	missing: string[];
	raw: string;
}

export interface UnknownResult {
	intent: 'unknown';
	raw: string;
}

/**
 * "log 23 for lunch at chipotle", "bought coffee for $4". The palette doesn't
 * parse the fields itself — it hands the raw sentence to the Add screen, which
 * runs the same deterministic purchase parser the form uses, so the two doors
 * behave identically.
 */
export interface LogPurchaseCommand {
	intent: 'log_purchase';
	text: string;
}

export type ParsedIntent =
	| SpendingQuery
	| NetQuery
	| CreateBucketCommand
	| CreateIncomeCommand
	| SetBudgetCommand
	| SafeToSpendQuery
	| NavigateCommand
	| LogPurchaseCommand
	| IncompleteResult
	| UnknownResult;

export interface TimePeriod {
	/** 'week' carries `weekOffset` (0 this, −1 last); the workspace's week-start
	 *  convention is applied by the caller, who knows it. */
	type: 'month' | 'year' | 'week';
	month?: number;
	year: number;
	weekOffset?: number;
	label: string;
}

/**
 * A period label as a phrase you can drop into a sentence.
 *
 * Labels come in two shapes and only one of them takes a preposition. "August
 * 2026" needs one; "this month" already is one, and answers were reading
 * "$741.36 spent on Groceries in this month". Relative labels start with a
 * determiner, which is the whole of the test.
 */
export function periodPhrase(period: TimePeriod): string {
	return /^(this|last)\b/.test(period.label) ? period.label : `in ${period.label}`;
}

const MONTHS: Record<string, number> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12
};

function resolvePeriod(input: string, now: Date, zone?: string): TimePeriod {
	// "Now" in the workspace's zone, not the server's: a UTC server answering
	// "this month" for a UTC+13 workspace must not spend the first 13 hours of
	// a month answering with the previous one. Weeks are excluded — the caller
	// re-derives those from the workspace's own week-start day.
	const today = zone ? calDateInZone(now, zone) : null;
	const currentYear = today ? today.y : now.getFullYear();
	const currentMonth = today ? today.m : now.getMonth() + 1;

	const lower = input.toLowerCase().trim();

	// "last june", "last december"
	const lastMatch = lower.match(/\blast\s+(\w+)\b/);
	if (lastMatch && MONTHS[lastMatch[1]]) {
		const m = MONTHS[lastMatch[1]];
		const y = currentMonth <= m ? currentYear - 1 : currentYear;
		return { type: 'month', month: m, year: y, label: `${lastMatch[1]} ${y}` };
	}

	// "june 2024", "march 2025"
	const namedMatch = lower.match(/\b(\w+)\s+(\d{4})\b/);
	if (namedMatch && MONTHS[namedMatch[1]]) {
		const m = MONTHS[namedMatch[1]];
		const y = parseInt(namedMatch[2]);
		return { type: 'month', month: m, year: y, label: `${namedMatch[1]} ${y}` };
	}

	// "in june", "during july", "for august" — bare month reference
	const inMonthMatch = lower.match(/\b(?:in|during|for|this\s+past)\s+(\w+)\b/);
	if (inMonthMatch && MONTHS[inMonthMatch[1]]) {
		const m = MONTHS[inMonthMatch[1]];
		const y = m <= currentMonth ? currentYear : currentYear - 1;
		return { type: 'month', month: m, year: y, label: `${inMonthMatch[1]} ${y}` };
	}

	// Standalone month name: "june", "december"
	const bareMonthMatch = lower.match(
		/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/
	);
	if (bareMonthMatch && MONTHS[bareMonthMatch[1]]) {
		const m = MONTHS[bareMonthMatch[1]];
		const y = m <= currentMonth ? currentYear : currentYear - 1;
		return { type: 'month', month: m, year: y, label: `${bareMonthMatch[1]} ${y}` };
	}

	// "in 2024", "year 2024"
	const yearMatch = lower.match(/\b(?:in\s+)?(\d{4})\b/);
	if (yearMatch) {
		const y = parseInt(yearMatch[1]);
		return { type: 'year', year: y, label: `${y}` };
	}

	// "this month"
	if (/\bthis\s+month\b/.test(lower)) {
		return { type: 'month', month: currentMonth, year: currentYear, label: 'this month' };
	}

	// "last month"
	if (/\blast\s+month\b/.test(lower)) {
		const m = currentMonth === 1 ? 12 : currentMonth - 1;
		const y = currentMonth === 1 ? currentYear - 1 : currentYear;
		return { type: 'month', month: m, year: y, label: 'last month' };
	}

	// "this week" / "last week" — resolved to real bounds by the caller, which
	// knows the workspace's week-start day; here they are just offsets.
	if (/\bthis\s+week\b/.test(lower)) {
		return { type: 'week', year: currentYear, weekOffset: 0, label: 'this week' };
	}
	if (/\blast\s+week\b/.test(lower)) {
		return { type: 'week', year: currentYear, weekOffset: -1, label: 'last week' };
	}

	// "this year"
	if (/\bthis\s+year\b/.test(lower)) {
		return { type: 'year', year: currentYear, label: `${currentYear}` };
	}

	// "last year"
	if (/\blast\s+year\b/.test(lower)) {
		return { type: 'year', year: currentYear - 1, label: `${currentYear - 1}` };
	}

	// Default: this month
	return { type: 'month', month: currentMonth, year: currentYear, label: 'this month' };
}

function extractAmount(lower: string): { amount: number; monthly: boolean } | null {
	// "$500", "500/mo", "500 per month", "$500 monthly"
	const amtMatch = lower.match(/\$?(\d+(?:\.\d{1,2})?)\s*(?:\/mo|per\s+month|monthly|a\s+month)/);
	if (amtMatch) {
		return { amount: parseFloat(amtMatch[1]), monthly: true };
	}
	const plainMatch = lower.match(/\$?(\d+(?:\.\d{1,2})?)/);
	if (plainMatch) {
		return { amount: parseFloat(plainMatch[1]), monthly: false };
	}
	return null;
}

/** Articles and modifiers that are never the name of anything. */
const FILLER_WORDS = new Set(['a', 'an', 'the', 'my', 'new', 'another', 'some', 'recurring']);

/** Ordinal words people actually type for a day-of-month. */
const ORDINAL_WORDS: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	tenth: 10,
	fifteenth: 15,
	twentieth: 20,
	'twenty-fifth': 25
};

function extractDayOfMonth(lower: string): number {
	// "on the 1st", "every 15th", "day 5", "first day", "last day"
	if (/\blast\s+day\b/.test(lower) || /\bthe\s+last\b/.test(lower)) return -1;

	// Word ordinals: "on the first", "every fifteenth". Checked before the
	// numeric patterns because "the first" has no digits to match at all.
	const word = lower.match(
		/\b(?:on|every|the)\s+(?:the\s+)?(first|second|third|fourth|fifth|tenth|fifteenth|twentieth|twenty-fifth)\b/
	);
	if (word) return ORDINAL_WORDS[word[1]];
	if (/\bfirst\s+day\b/.test(lower)) return 1;

	// Anchored first. The prefix used to be optional, which made this match the
	// first number anywhere in the string — always the amount ("500/mo on the
	// 15th" → 500 → out of range → silently the 1st).
	const anchored = lower.match(/\b(?:on\s+the|every|day)\s+(\d+)(?:st|nd|rd|th)?\b/);
	if (anchored) {
		const d = parseInt(anchored[1]);
		// 29-31 are real schedules (clampDay shortens February); out of range
		// falls through to the default below.
		if (d >= 1 && d <= 31) return d;
	}

	// Bare ordinal ("the 15th"): only ordinals, so an amount can't be mistaken
	// for a day.
	const ordinal = lower.match(/\b(\d+)(?:st|nd|rd|th)\b/);
	if (ordinal) {
		const d = parseInt(ordinal[1]);
		if (d >= 1 && d <= 31) return d;
	}
	return 1;
}

const NAV_TARGETS: Record<string, NavigateCommand['target']> = {
	analytics: 'analytics',
	activity: 'analytics',
	chart: 'analytics',
	graph: 'analytics',
	stats: 'analytics',
	buckets: 'buckets',
	bucket: 'buckets',
	savings: 'buckets',
	recurring: 'recurring',
	subscriptions: 'recurring',
	bills: 'recurring',
	income: 'income',
	salary: 'income',
	purchases: 'purchases',
	wallet: 'purchases',
	spending: 'purchases',
	purchase: 'purchases',
	settings: 'settings',
	setting: 'settings'
};

/**
 * `now` is a parameter, not `new Date()` inside: every relative period ("last
 * month", "this year") is resolved against it, so tests can pin a date instead
 * of changing answers every month. `zone` (an IANA name) shifts that reading to
 * a workspace's wall clock; the browser palette omits it because the device's
 * own zone is the right one there.
 */
export function parse(input: string, now: Date = new Date(), zone?: string): ParsedIntent {
	const lower = input.toLowerCase().trim();
	if (!lower) return { intent: 'unknown', raw: input };

	// Navigate: "show me analytics", "go to buckets", "open settings"
	const navMatch = lower.match(
		/\b(?:show\s+me\s+|go\s+to\s+|open\s+|take\s+me\s+to\s+|navigate\s+to\s+)\s*(\w+)/
	);
	if (navMatch && NAV_TARGETS[navMatch[1]]) {
		return { intent: 'navigate', target: NAV_TARGETS[navMatch[1]] };
	}
	if (NAV_TARGETS[lower]) {
		return { intent: 'navigate', target: NAV_TARGETS[lower] };
	}

	// Create bucket: "create a travel bucket of 500/mo on the 1st"
	if (
		/\b(?:create|add|make|new)\s+(?:a\s+|an\s+)?.*?(?:bucket|savings\s+bucket|virtual\s+account)/.test(
			lower
		)
	) {
		const amt = extractAmount(lower);
		if (amt && amt.monthly) {
			// Extract name: everything between "bucket" or "create" and "of"/"for"
			let name = '';
			const nameMatch = lower.match(
				/(?:create|add|make|new)\s+(?:a\s+)?(?:new\s+)?(?:bucket\s+)?(?:called\s+|named\s+|for\s+)?(.+?)\s+(?:of|for|at|with)\s/
			);
			if (nameMatch) {
				name = nameMatch[1].replace(/bucket|savings/gi, '').trim();
			}
			if (!name) {
				// Try: "create a name bucket of 500/mo"
				const altMatch = lower.match(/(?:create|add|make|new)\s+(?:a\s+)?(.+?)\s+bucket/);
				if (altMatch) name = altMatch[1].trim();
			}
			const dayOfMonth = extractDayOfMonth(lower);
			return {
				intent: 'create_bucket',
				name: name || 'New bucket',
				amount: amt.amount,
				dayOfMonth
			};
		}
		// Routed but unusable — say which part is missing rather than "unknown".
		return {
			intent: 'incomplete',
			of: 'create_bucket',
			missing: amt ? ['cadence'] : ['amount'],
			raw: input
		};
	}

	// Create income: "add income of 4800 per month on the first", "new salary
	// 3200/mo", or a bare "income from freelance of 900 per month" — the noun
	// plus a "from" source reads as a command even without a verb.
	const INCOME_NOUN = /\b(?:income|salary|paycheck|pay\s?check|wage|earnings)\b/;
	if (
		INCOME_NOUN.test(lower) &&
		(/\b(?:create|add|make|new|record|log)\b/.test(lower) ||
			/\b(?:income|salary|paycheck|wage|earnings)\s+from\b/.test(lower))
	) {
		const amt = extractAmount(lower);
		if (!amt) {
			return { intent: 'incomplete', of: 'create_income', missing: ['amount'], raw: input };
		}
		// "every month", "per month", "/mo", "monthly" all mean recurring. A bare
		// amount is a one-off entry, which is a real thing to want.
		const recurring = amt.monthly || /\b(?:every\s+month|each\s+month|recurring)\b/.test(lower);

		// Name: "income from freelance", "salary called acme", else the noun itself.
		let source = '';
		const named = lower.match(
			/\b(?:income|salary|paycheck|wage|earnings)\s+(?:from|called|named|for)\s+([a-z0-9' -]+?)(?:\s+(?:of|at|worth|is|,)\b|\s*$)/
		);
		if (named) source = named[1].trim();
		if (!source) {
			const before = lower.match(
				/\b(?:create|add|make|new|record|log)\s+(?:a\s+|an\s+|my\s+)?(?:new\s+)?([a-z0-9' -]+?)\s+(?:income|salary|paycheck|wage|earnings)\b/
			);
			if (before) source = before[1].trim();
		}
		// "create a new income" leaves the articles behind as the "name".
		if (FILLER_WORDS.has(source)) source = '';
		if (/\bsalary\b/.test(lower) && !source) source = 'Salary';

		return {
			intent: 'create_income',
			source: source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Income',
			amount: amt.amount,
			cadence: recurring ? 'monthly' : 'once',
			dayOfMonth: extractDayOfMonth(lower)
		};
	}

	// Log a purchase: "bought coffee for $4", "log 23 for lunch at chipotle",
	// "spent 50 on groceries". Conservative on purpose so it never steals a
	// spending question: it needs a logging verb up front, an actual number, and
	// must not read as a question. Income and buckets are already handled above.
	if (
		/^(?:log|record|buy|bought|spent|paid|got|grabbed|picked up|purchased?|add)\b/.test(lower) &&
		!/^(?:how|what|when|where|why|who|did|do|does|is|are|can|should|show)\b/.test(lower) &&
		/\d/.test(lower)
	) {
		return { intent: 'log_purchase', text: input.trim() };
	}

	// Set a budget: "set groceries budget to 400", "budget 100 a week for food",
	// "cap everything at 2000". The category is resolved against the workspace's
	// real categories by the execute endpoint, not here — typing shouldn't have
	// to spell a category the way the settings page writes it.
	{
		const budgetMatch =
			lower.match(
				/\b(?:set|make|put|cap)\s+(?:the\s+|a\s+|our\s+)?(.{1,40}?)\s+budget\s+(?:to|at|of)\s+\$?(\d+(?:\.\d{1,2})?)\s*(\/mo|per\s+month|monthly|a\s+month|\/wk|per\s+week|weekly|a\s+week)?/
			) ??
			lower.match(
				/\bbudget\s+\$?(\d+(?:\.\d{1,2})?)\s*(\/mo|per\s+month|monthly|a\s+month|\/wk|per\s+week|weekly|a\s+week)?\s+for\s+(.{1,40}?)(?:\s*$|\?)/
			) ??
			lower.match(
				/\b(?:cap|set)\s+(everything|overall|everything\s+budget)\s+(?:to|at)\s+\$?(\d+(?:\.\d{1,2})?)\s*(\/mo|per\s+month|monthly|a\s+month|\/wk|per\s+week|weekly|a\s+week)?/
			);
		if (budgetMatch) {
			// The three patterns capture in different orders; normalize.
			const isBudgetFirst = /^budget/.test(budgetMatch[0]);
			const isCapEverything = /^(?:cap|set)\s+(everything|overall)/.test(budgetMatch[0]);
			const amountStr = isBudgetFirst ? budgetMatch[1] : budgetMatch[2];
			const cadence = (isBudgetFirst ? budgetMatch[2] : budgetMatch[3]) ?? '';
			const amount = parseFloat(amountStr);
			if (Number.isFinite(amount)) {
				let category = (
					isBudgetFirst ? budgetMatch[3] : isCapEverything ? 'everything' : budgetMatch[1]
				)
					.replace(/\b(?:the|my|our|monthly|weekly)\b/g, '')
					.trim();
				if (!category || /^(?:month|week)$/.test(category)) category = 'everything';
				return {
					intent: 'set_budget',
					category,
					amount,
					period: /wk|week/.test(cadence) ? 'week' : 'month'
				};
			}
		}
	}

	// Safe to Spend: "how much can I spend", "what's free to spend". Answered
	// from the engine itself — the one money question that should never wait on
	// a model or a briefing.
	if (
		/\b(?:how\s+much\s+(?:can|could|should)\s+(?:i|we)\s+spend|what(?:'s| is)\s+(?:free|safe)\s+to\s+spend|safe\s+to\s+spend|free\s+cash)\b/.test(
			lower
		)
	) {
		return { intent: 'safe_to_spend' };
	}

	// Net position / savings rate: "what's my net", "savings rate", "how much am i saving"
	if (
		/\b(?:net\s+position|savings?\s+rate|how\s+much\s+am\s+i\s+saving|what(?:'s| is) my net|net worth)\b/.test(
			lower
		)
	) {
		const period = resolvePeriod(lower, now, zone);
		return { intent: 'net_position', period };
	}

	// Spending query: "how much did I spend on X", "what did I spend on Y last month"
	if (/\b(?:how\s+much|what|show\s+me|spend(?:ing)?|spent)\b/.test(lower)) {
		const period = resolvePeriod(lower, now, zone);

		// Check for member: "how much did alice spend"
		const memberMatch = lower.match(
			/(?:how\s+much\s+did|what\s+did|spend(?:ing)?\s+by|spent\s+by)\s+(\w+)\b/
		);
		if (memberMatch && !['i', 'me', 'my', 'we', 'us'].includes(memberMatch[1])) {
			return { intent: 'spending_query', member: memberMatch[1], period };
		}

		// Check for category: extract words between "on" and time reference
		let category: string | undefined;

		// "spend on entertainment" or "spent on groceries"
		const onMatch = lower.match(/\b(?:on)\s+(.+?)(?:\s+(?:in|last|this|for|during|at)\b|\s*$)/);
		if (onMatch) {
			const raw = onMatch[1].replace(/\?|how\s+much|what|show\s+me|the\b/g, '').trim();
			if (raw && !/\b(?:i|me|my|we|us|all|everything)\b/.test(raw)) {
				category = raw;
			}
		}

		// "how much did i spend" without specific category → total spending
		if (!category && /\b(?:how\s+much\s+did)\b/.test(lower)) {
			return { intent: 'spending_query', period };
		}

		return { intent: 'spending_query', category, period };
	}

	return { intent: 'unknown', raw: input };
}

export const EXAMPLE_PROMPTS = [
	'how much did I spend on groceries last month?',
	'how much can I spend?',
	'set groceries budget to 400',
	'what did alice spend this week?',
	'create a travel bucket of 500/mo on the 15th',
	'add income of 4800 per month on the first',
	"what's my net position?",
	'show me activity'
];

/* ---------------------------------------------------------------------------
 * Live understanding
 *
 * `parse` is pure and synchronous, so the UI can run it on every keystroke and
 * show what it currently understands — no round trip, no debounce. This turns a
 * guess-the-magic-words box into something you can steer while typing.
 * ------------------------------------------------------------------------- */

export interface Slot {
	label: string;
	value: string;
}

export interface Understanding {
	/** Intent as parsed; 'incomplete' and 'unknown' are both non-actionable. */
	intent: ParsedIntent['intent'];
	/** Human-readable name of what we think this is. */
	label: string;
	/** The entities we pulled out, for display as chips. */
	slots: Slot[];
	/** Plain-language description of what's missing, when incomplete. */
	missing: string[];
	/** Completions to offer when we can't act on the input as typed. */
	suggestions: string[];
	/** Whether pressing Enter would do something useful. */
	ready: boolean;
}

const DAY_LABEL = (d: number) => (d === -1 ? 'last day' : `day ${d}`);

const MISSING_HELP: Record<string, string> = {
	amount: 'an amount. Try "of 500"',
	cadence: 'how often. Try "per month"'
};

/** Suggestions offered when nothing matched, ordered by how often they're wanted. */
const FALLBACK_SUGGESTIONS = [
	'how much did I spend last month?',
	'add income of 4800 per month on the first',
	'create a travel bucket of 500/mo on the 1st',
	"what's my net position?"
];

export function understand(input: string, now: Date = new Date()): Understanding {
	const raw = input.trim();
	if (!raw) {
		return {
			intent: 'unknown',
			label: '',
			slots: [],
			missing: [],
			suggestions: [],
			ready: false
		};
	}

	const parsed = parse(input, now);

	switch (parsed.intent) {
		case 'spending_query': {
			const slots: Slot[] = [{ label: 'Period', value: parsed.period.label }];
			if (parsed.category) slots.push({ label: 'Category', value: parsed.category });
			if (parsed.member) slots.push({ label: 'Person', value: parsed.member });
			return {
				intent: parsed.intent,
				label: 'Spending',
				slots,
				missing: [],
				suggestions: [],
				ready: true
			};
		}

		case 'net_position':
			return {
				intent: parsed.intent,
				label: 'Net position',
				slots: [{ label: 'Period', value: parsed.period.label }],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'create_bucket':
			return {
				intent: parsed.intent,
				label: 'New bucket',
				slots: [
					{ label: 'Name', value: parsed.name },
					{ label: 'Monthly', value: String(parsed.amount) },
					{ label: 'On', value: DAY_LABEL(parsed.dayOfMonth) }
				],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'create_income':
			return {
				intent: parsed.intent,
				label: 'New income',
				slots: [
					{ label: 'Source', value: parsed.source },
					{ label: 'Amount', value: String(parsed.amount) },
					{
						label: 'Repeats',
						value:
							parsed.cadence === 'monthly' ? `monthly, ${DAY_LABEL(parsed.dayOfMonth)}` : 'once'
					}
				],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'navigate':
			return {
				intent: parsed.intent,
				label: 'Open',
				slots: [{ label: 'Page', value: parsed.target }],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'set_budget':
			return {
				intent: parsed.intent,
				label: 'Set budget',
				slots: [
					{ label: 'Category', value: parsed.category },
					{ label: 'Amount', value: String(parsed.amount) },
					{ label: 'Cadence', value: parsed.period === 'week' ? 'weekly' : 'monthly' }
				],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'safe_to_spend':
			return {
				intent: parsed.intent,
				label: 'Safe to Spend',
				slots: [],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'log_purchase':
			return {
				intent: parsed.intent,
				label: 'Log purchase',
				slots: [{ label: 'From', value: 'your words' }],
				missing: [],
				suggestions: [],
				ready: true
			};

		case 'incomplete': {
			// We know the shape; offer the user's own words back, completed.
			const base = raw.replace(/\s+$/, '');
			const suggestions =
				parsed.of === 'create_income'
					? [`${base} of 4800 per month`, `${base} of 4800 per month on the first`]
					: [`${base} of 500 per month`, `${base} of 500 per month on the 1st`];
			return {
				intent: parsed.intent,
				label: parsed.of === 'create_income' ? 'New income' : 'New bucket',
				slots: [],
				missing: parsed.missing.map((m) => MISSING_HELP[m] ?? m),
				suggestions,
				ready: false
			};
		}

		default:
			return {
				intent: 'unknown',
				label: '',
				slots: [],
				missing: [],
				suggestions: FALLBACK_SUGGESTIONS,
				ready: false
			};
	}
}
