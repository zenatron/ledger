/**
 * The ask palette's decision flow, lifted out of its route so it can be tested.
 *
 * The route it came from carried real judgement — which of four paths a question
 * takes, and in which order — inside a handler that also did auth, rate limiting,
 * database reads and JSON encoding. None of that was reachable from a unit test,
 * because vitest only collects `src/lib/**`. The judgement now lives here and the
 * route keeps the I/O.
 *
 * The order below is the whole design, and it is deliberate:
 *
 * 1. **The deterministic parser wins outright.** If our own grammar understood
 *    the sentence, the model is never consulted. It cannot overrule us.
 * 2. **Only a genuinely unrecognised command reaches `parseCommand`,** and what
 *    comes back is re-validated field by field here — the name is sanitised, the
 *    amount goes through `Money`, the day is clamped — before it is *proposed*.
 *    Nothing on this path writes; the caller confirms first.
 * 3. **Out-of-briefing questions refuse before any model call.** This is a fact
 *    about our data, not a hoped-for property of a small model, so it must not
 *    depend on one being reachable.
 * 4. **Only then may the model narrate,** over a briefing of figures the core
 *    computed. If it declines, times out, or is absent, the deterministic reply
 *    stands.
 *
 * Consequently every branch except 4 behaves identically with the assist off,
 * which is the property the tests pin down.
 *
 * The intents the *parser itself* answers with data — `spending_query`,
 * `net_position`, `incomplete` — are not handled here. They need repository
 * reads, they are disjoint from the intents above (a `ParsedIntent` is exactly
 * one of them), so no ordering is lost by leaving them with the route.
 */

import { Money } from '$lib/domain/money/money';
import { previousMonthPeriod } from '$lib/domain/analytics/period';
import { outOfBriefingScope } from '$lib/domain/intelligence/briefing-scope';
import type { LlmAssist, NavigateTarget, ParsedAction } from '$lib/ports/llm-assist';
import type { ParsedIntent } from '$lib/intelligence/parser';

/**
 * What the palette should do about a question. A closed set: every member is
 * either a *proposal* the person confirms, a sentence, or a refusal. There is no
 * member that acts.
 */
export type AskOutcome =
	| {
			/** An action prepared for confirmation. Nothing has been written. */
			kind: 'proposal';
			intent: string;
			answer: string;
			/** Free text handed to the add screen to prefill, when that's the action. */
			describe?: string;
			propose?: unknown;
	  }
	| { kind: 'navigate'; target: NavigateTarget; answer: string }
	| { kind: 'answer'; answer: string }
	| { kind: 'refusal'; answer: string; raw: string };

export interface AskDeps {
	assist: LlmAssist;
	/**
	 * Built on demand, not passed in built. The briefing costs seven repository
	 * reads, and three of the four paths above return without ever needing it —
	 * a proposal, a refusal, and the assist being off. Making it a thunk keeps
	 * that cost where the decision to spend it is made.
	 */
	briefing: () => Promise<string>;
	currency: string;
	/** Today in the workspace's zone; fixes the briefing's month window. */
	today: { y: number; m: number; d: number };
	/**
	 * The months the briefing actually carries, for the scope guard. This month
	 * and last month by default; the route adds a question's named focus month
	 * when it built the briefing around one, which is what widens the window.
	 */
	coveredMonths?: { y: number; m: number }[];
}

export interface AskInput {
	query: string;
	parsed: ParsedIntent;
}

/** The deterministic reply when nothing — parser, model, or briefing — landed. */
export const ASK_FALLBACK =
	'I couldn\'t understand that. Try a question like "how much did I spend on groceries last month?" or a command like "create a travel bucket of 500/mo".';

function stripControlChars(s: string): string {
	return s
		.split('')
		.filter((c) => {
			const code = c.charCodeAt(0);
			return code > 0x1f && code !== 0x7f;
		})
		.join('');
}

/** Strip control characters, collapse whitespace, and cap length for a label. */
export function safeName(raw: string, maxLen = 120): string | null {
	const cleaned = stripControlChars(raw).replace(/\s+/g, ' ').trim();
	if (!cleaned) return null;
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

/** -1 means "last day of the month"; otherwise clamp to 1-31. */
export function normalizeDay(d: number): number {
	if (d === -1) return -1;
	return Math.min(Math.max(d, 1), 31);
}

export function moneyFromNumber(amount: number, currency: string): Money | null {
	if (!Number.isFinite(amount) || amount <= 0) return null;
	try {
		return Money.fromDecimal(String(amount), currency);
	} catch {
		return null;
	}
}

/**
 * Turn a closed action into something to confirm. Every field the model could
 * have influenced is re-derived here from validated primitives, so a proposal
 * never carries a value straight through from a model answer.
 */
export function buildActionOutcome(
	action: ParsedAction,
	currency: string,
	query: string
): AskOutcome | null {
	if (action.intent === 'log_purchase') {
		return {
			kind: 'proposal',
			intent: 'log_purchase',
			answer: 'I’ll open the add screen with what you said. You can edit before saving.',
			describe: query
		};
	}

	if (action.intent === 'navigate') {
		return { kind: 'navigate', target: action.target, answer: `Open ${action.target}` };
	}

	if (action.intent === 'create_bucket') {
		const name = safeName(action.name);
		const amount = moneyFromNumber(action.amount, currency);
		if (!name) {
			return { kind: 'proposal', intent: 'create_bucket', answer: 'I need a name for the bucket.' };
		}
		if (!amount) {
			return {
				kind: 'proposal',
				intent: 'create_bucket',
				answer: 'I need a positive amount for the bucket.'
			};
		}
		const day = normalizeDay(action.dayOfMonth);
		return {
			kind: 'proposal',
			intent: 'propose',
			answer: `Create bucket “${name}”: ${amount.format()}/mo on ${day === -1 ? 'the last day' : `day ${day}`}`,
			propose: {
				intent: 'create_bucket',
				name,
				amount: action.amount,
				amountMinor: amount.minor.toString(),
				dayOfMonth: day,
				currency
			}
		};
	}

	if (action.intent === 'create_income') {
		const source = safeName(action.source);
		const amount = moneyFromNumber(action.amount, currency);
		if (!source) {
			return {
				kind: 'proposal',
				intent: 'create_income',
				answer: 'I need a source for the income.'
			};
		}
		if (!amount) {
			return {
				kind: 'proposal',
				intent: 'create_income',
				answer: 'I need a positive amount for the income.'
			};
		}
		const day = normalizeDay(action.dayOfMonth);
		const cadence = action.monthly ? 'monthly' : 'once';
		return {
			kind: 'proposal',
			intent: 'propose',
			answer: `Add income “${source}”: ${amount.format()} ${cadence}${action.monthly ? `, ${day === -1 ? 'last day' : `day ${day}`}` : ''}`,
			propose: {
				intent: 'create_income',
				source,
				amount: action.amount,
				amountMinor: amount.minor.toString(),
				monthly: action.monthly,
				dayOfMonth: day,
				currency
			}
		};
	}

	if (action.intent === 'set_budget') {
		const amount = moneyFromNumber(action.amount, currency);
		if (!amount) {
			return {
				kind: 'proposal',
				intent: 'set_budget',
				answer: 'I need a positive amount for the budget.'
			};
		}
		const category = safeName(action.category, 60);
		const period = action.period === 'week' ? 'weekly' : 'monthly';
		return {
			kind: 'proposal',
			intent: 'propose',
			answer: `Set ${category ?? 'the overall'} budget to ${amount.format()} ${period}`,
			propose: {
				intent: 'set_budget',
				category: category ?? 'everything',
				amount: action.amount,
				amountMinor: amount.minor.toString(),
				period: action.period,
				currency
			}
		};
	}

	return null;
}

/**
 * Convert the deterministic parser's output into the same closed action shape
 * the LLM uses, so both paths share the same proposal/confirmation flow.
 */
export function deterministicAction(parsed: ParsedIntent): ParsedAction | null {
	switch (parsed.intent) {
		case 'create_bucket':
			return {
				intent: 'create_bucket',
				name: parsed.name,
				amount: parsed.amount,
				dayOfMonth: parsed.dayOfMonth
			};
		case 'create_income':
			return {
				intent: 'create_income',
				source: parsed.source,
				amount: parsed.amount,
				monthly: parsed.cadence === 'monthly',
				dayOfMonth: parsed.dayOfMonth
			};
		case 'set_budget':
			return {
				intent: 'set_budget',
				category: parsed.category,
				amount: parsed.amount,
				period: parsed.period
			};
		case 'navigate':
			return { intent: 'navigate', target: parsed.target };
		case 'log_purchase':
			return { intent: 'log_purchase' };
		default:
			return null;
	}
}

/**
 * Does this question fall outside the two months the briefing covers? Returns
 * the refusal to send, or null to carry on.
 */
const MONTH_WORDS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

function briefingRefusal(query: string, deps: AskDeps): AskOutcome | null {
	const { today } = deps;
	const lastMonth = previousMonthPeriod(today);
	// The covered window is this month and last month, plus the question's own
	// focus month when the route built the briefing around one — that third
	// month is the whole of the "wider window".
	const months = [
		{ y: today.y, m: today.m },
		{ y: lastMonth.from.y, m: lastMonth.from.m },
		...(deps.coveredMonths ?? []).filter(
			(m) =>
				!(m.y === today.y && m.m === today.m) &&
				!(m.y === lastMonth.from.y && m.m === lastMonth.from.m)
		)
	];
	const outOfScope = outOfBriefingScope(query, { months, today: { y: today.y, m: today.m } });
	if (!outOfScope) return null;

	// Name what is covered honestly: two months reads as a pair, a third is
	// appended — "this month, last month and March 2025".
	const extras = months
		.slice(2)
		.map((m) => `${MONTH_WORDS[m.m - 1]} ${m.y}`)
		.join(', ');
	const covered = extras ? `this month, last month and ${extras}` : 'this month and last month';
	return {
		kind: 'refusal',
		raw: query,
		answer:
			`I can only answer for ${covered}, so I can't answer that for ${outOfScope.mention}. ` +
			(outOfScope.suggest === 'ledger'
				? 'The Ledger tab has it day by day.'
				: 'The Analytics tab goes back further.')
	};
}

/**
 * Decide what to do about an ask the route's own data branches don't cover.
 * Returns null when `parsed` is one of those data intents, which is the route's
 * signal to answer it from the repositories itself.
 */
export async function answerAsk(deps: AskDeps, input: AskInput): Promise<AskOutcome | null> {
	const { assist, currency } = deps;
	const { query, parsed } = input;

	// 1. Our own grammar first. The model never gets to overrule a sentence we
	//    already understood.
	const action = deterministicAction(parsed);
	if (action) {
		const outcome = buildActionOutcome(action, currency, query);
		if (outcome) return outcome;
	}

	// The data intents belong to the route.
	if (
		parsed.intent === 'spending_query' ||
		parsed.intent === 'safe_to_spend' ||
		parsed.intent === 'net_position' ||
		parsed.intent === 'incomplete'
	) {
		return null;
	}

	// 2. Stumped, so let the model try for a safe, constructive action. Garbage
	//    or `unknown` falls straight through to the refusal checks below.
	if (parsed.intent === 'unknown' && assist.available) {
		const guessed = await assist.parseCommand({ query });
		if (guessed && guessed.intent !== 'unknown') {
			const outcome = buildActionOutcome(guessed, currency, query);
			if (outcome) return outcome;
		}
	}

	// 3. Out of the briefing's window: refuse without asking the model, so the
	//    answer is the same whether it is on, off, or timing out.
	const refusal = briefingRefusal(query, deps);
	if (refusal) return refusal;

	// 4. In scope. Narrate over figures the core computed — never invented ones.
	if (assist.available) {
		const answer = await assist.answerQuestion({ query, briefing: await deps.briefing() });
		if (answer) return { kind: 'answer', answer };
	}

	return { kind: 'refusal', raw: query, answer: ASK_FALLBACK };
}

/**
 * The wire shape the palette client already expects. Kept as an explicit
 * translation rather than sending `AskOutcome` directly, so the union above can
 * be reshaped without breaking a deployed client.
 */
export function askOutcomeToWire(outcome: AskOutcome): Record<string, unknown> {
	switch (outcome.kind) {
		case 'proposal':
			return {
				intent: outcome.intent,
				answer: outcome.answer,
				...(outcome.describe !== undefined ? { describe: outcome.describe } : {}),
				...(outcome.propose !== undefined ? { propose: outcome.propose } : {})
			};
		case 'navigate':
			return {
				intent: 'navigate',
				answer: outcome.answer,
				propose: { intent: 'navigate', target: outcome.target, label: outcome.target }
			};
		case 'answer':
			return { intent: 'answer', answer: outcome.answer };
		case 'refusal':
			return { intent: 'unknown', raw: outcome.raw, answer: outcome.answer };
	}
}
