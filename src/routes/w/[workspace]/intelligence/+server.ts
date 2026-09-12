import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { bucketFlowsInPeriod } from '$lib/repo/buckets';
import { Money } from '$lib/domain/money/money';
import { periodTotal, categoryBreakdown, memberBreakdown } from '$lib/repo/analytics';
import { incomeInPeriod } from '$lib/repo/income';
import { safeToSpend } from '$lib/repo/forecast';
import { narrateSafeToSpend } from '$lib/domain/forecast/safe-to-spend';
import { mentionedMonthPeriod } from '$lib/domain/intelligence/briefing-scope';
import {
	monthPeriod,
	yearPeriod,
	weekPeriod,
	previousMonthPeriod,
	monthLabel,
	type Period
} from '$lib/domain/analytics/period';
import { systemClock } from '$lib/infra/time/system-clock';
import { calDateInZone } from '$lib/domain/time/zoned';
import { parse, periodPhrase, type TimePeriod } from '$lib/intelligence/parser';
import { answerAsk, askOutcomeToWire, ASK_FALLBACK } from '$lib/application/ask';
import { formatPct } from '$lib/format';
import { getLlmAssist } from '$lib/infra/llm';
import { briefingField } from '$lib/infra/llm/prompt';
import type { WorkspaceRow } from '$lib/repo/workspaces';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/** Amounts cross the wire as bigint minor units; JSON.stringify can't do those. */
function jsonSafe(data: unknown) {
	return new Response(
		JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
		{ headers: { 'content-type': 'application/json' } }
	);
}

const DAY_MS = 86_400_000;

function timeToPeriod(tp: TimePeriod, now: Date, tz: string, weekStartDay: number): Period {
	if (tp.type === 'week') {
		// Stepped from today so "this week" is the week containing it, on the
		// workspace's own week-start convention — the same one the analytics
		// screens page by.
		const base = calDateInZone(new Date(now.getTime() + (tp.weekOffset ?? 0) * 7 * DAY_MS), tz);
		return weekPeriod(base, weekStartDay);
	}
	const date = tp.month ? { y: tp.year, m: tp.month, d: 1 } : { y: tp.year, m: 7, d: 1 };
	return tp.type === 'year' ? yearPeriod(date) : monthPeriod(date);
}

// Standalone endpoint: SvelteKit's form-action CSRF check doesn't cover it, and
// this one both reads workspace data and can create buckets.
/**
 * A compact, factual snapshot of the workspace's money, computed entirely by the
 * deterministic core. It is the *only* ground the LLM is allowed to answer from:
 * every figure here is real and seal-scoped to the viewer, so the model narrates
 * truth rather than guessing. Kept short on purpose — a small model reasons more
 * reliably over a tight briefing, and it's cheaper to send.
 *
 * The window is this month (with last month for comparison), plus — when the
 * question named a different month the parser didn't recognize — a focus month
 * the briefing is *also* built around. That third month is the whole of the
 * "wider window": the model still never answers outside figures the core
 * computed, it just gets the figures for the month actually being asked about.
 *
 * Figures are ours; names are the household's. See briefingField.
 */
async function buildBriefing(
	db: ReturnType<typeof getDb>,
	scope: { workspaceId: string; viewerId: string; timezone: string },
	ws: WorkspaceRow,
	now: Date,
	today: { y: number; m: number; d: number },
	focus: { period: Period; label: string } | null
): Promise<string> {
	const currency = ws.currency;
	const fmt = (m: bigint) => Money.of(m, currency).format();
	const thisMonth: Period = monthPeriod(today);
	const lastMonth: Period = previousMonthPeriod(today);
	const isFocusCurrent =
		focus !== null &&
		focus.period.from.y === thisMonth.from.y &&
		focus.period.from.m === thisMonth.from.m;

	const [thisSpent, lastSpent, cats, members, income, bucket, sts, focusData] = await Promise.all([
		periodTotal(db, scope, thisMonth, now),
		periodTotal(db, scope, lastMonth, now),
		categoryBreakdown(db, scope, thisMonth, now),
		memberBreakdown(db, scope, thisMonth, now),
		incomeInPeriod(db, ws.id, thisMonth, scope.timezone, today),
		bucketFlowsInPeriod(db, ws.id, thisMonth, scope.timezone),
		safeToSpend(db, scope, now),
		// The question's own month, when it named one: totals, categories, members.
		focus && !isFocusCurrent
			? Promise.all([
					periodTotal(db, scope, focus.period, now),
					categoryBreakdown(db, scope, focus.period, now),
					memberBreakdown(db, scope, focus.period, now)
				])
			: null
	]);

	// Money into buckets, and the funded part of what came back out. Never a
	// single signed figure: see domain/bucket/flows.
	const savings = bucket.setAsideMinor;
	const net = income - thisSpent - savings + bucket.releasedMinor;
	const topCats = cats
		.slice(0, 6)
		.map((c) => `${briefingField(c.name)} ${fmt(c.totalMinor)}`)
		.join(', ');
	const memberLine = members.map((m) => `${briefingField(m.name)} ${fmt(m.totalMinor)}`).join(', ');
	const isoToday = `${today.y}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`;

	const lines = [
		`Workspace: ${briefingField(ws.name)}. Currency: ${currency}. Today: ${isoToday}.`,
		`This month (${monthLabel(today)}): spent ${fmt(thisSpent)}, income ${fmt(income)}, set aside in savings ${fmt(savings)}, net ${fmt(net)}.`,
		`Safe to Spend right now (free cash left this month): ${fmt(sts.freeMinor)}; status ${sts.status}.`,
		`Last month (${monthLabel(lastMonth.from)}): spent ${fmt(lastSpent)}.`,
		topCats
			? `Spending by category this month: ${topCats}.`
			: 'No categorized spending this month yet.',
		members.length > 1 ? `Spending by member this month: ${memberLine}.` : null
	];

	if (focusData) {
		const [fSpent, fCats, fMembers] = focusData;
		const fTop = fCats
			.slice(0, 6)
			.map((c) => `${briefingField(c.name)} ${fmt(c.totalMinor)}`)
			.join(', ');
		lines.push(
			`The month asked about (${focus!.label}): spent ${fmt(fSpent)}.`,
			fTop
				? `Spending by category in ${focus!.label}: ${fTop}.`
				: `No categorized spending in ${focus!.label}.`,
			fMembers.length > 1
				? `Spending by member in ${focus!.label}: ${fMembers.map((m) => `${briefingField(m.name)} ${fmt(m.totalMinor)}`).join(', ')}.`
				: null
		);
	}

	return lines.filter(Boolean).join('\n');
}

export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Malformed request body');
	}

	const query = (body as { query?: unknown } | null)?.query;
	if (!query || typeof query !== 'string') {
		return jsonSafe({ intent: 'unknown', raw: '' });
	}

	const db = getDb();
	const ws = locals.workspace!;
	const scope = {
		workspaceId: ws.id,
		viewerId: locals.member!.id,
		timezone: ws.timezone
	};
	const currency = ws.currency;
	const now = systemClock.now();
	const today = calDateInZone(now, scope.timezone);
	// "This month" and friends resolve on the workspace's wall clock, not the
	// server's — otherwise a UTC server mis-answers a UTC+13 workspace for the
	// first 13 hours after a month turns.
	const parsed = parse(query, now, scope.timezone);

	// The optional model. Absent by default, in which case every path below is
	// exactly what it would have been with no model at all.
	const assist = getLlmAssist({
		aiMode: ws.aiMode,
		aiEndpoint: ws.aiEndpoint,
		aiModel: ws.aiModel,
		aiApiKey: ws.aiApiKey
	});

	/*
	 * Everything except the four data-backed intents is decided in
	 * `application/ask`: deterministic parser first, then a constrained model
	 * command, then the out-of-scope refusal, then narration. A null back means
	 * this is one of those data intents, answered from the repositories below.
	 * The briefing is a thunk so it is only built on the one path that needs it.
	 *
	 * The wider window: when a question names a month the deterministic parser
	 * didn't recognize (so it lands on narration), the briefing is built around
	 * that month too and the scope guard is told about it — the model answers
	 * from real figures for the month asked about instead of refusing.
	 */
	const mentioned = mentionedMonthPeriod(query, today);
	const lastMonthForCover = previousMonthPeriod(today);
	const isCoveredByDefault =
		mentioned &&
		((mentioned.y === today.y && mentioned.m === today.m) ||
			(mentioned.y === lastMonthForCover.from.y && mentioned.m === lastMonthForCover.from.m));
	const focus =
		mentioned && !isCoveredByDefault
			? {
					period: monthPeriod({ y: mentioned.y, m: mentioned.m, d: 1 }),
					label: `${mentioned.mention.charAt(0).toUpperCase()}${mentioned.mention.slice(1)}`
				}
			: null;
	const coveredMonths = focus ? [{ y: mentioned!.y, m: mentioned!.m }] : undefined;

	const outcome = await answerAsk(
		{
			assist,
			briefing: () => buildBriefing(db, scope, ws, now, today, focus),
			currency,
			today,
			coveredMonths
		},
		{ query, parsed }
	);
	if (outcome) return jsonSafe(askOutcomeToWire(outcome));

	if (parsed.intent === 'safe_to_spend') {
		const sts = await safeToSpend(db, scope, now);
		const read = narrateSafeToSpend(sts, (m) => Money.of(m, currency).format());
		return jsonSafe({
			intent: parsed.intent,
			answer: `${read.text} Free to spend: ${Money.of(sts.freeMinor, currency).format()}.`,
			highlight: Number(sts.freeMinor)
		});
	}

	if (parsed.intent === 'spending_query') {
		const period = timeToPeriod(parsed.period, now, scope.timezone, ws.weekStartDay);
		const total = await periodTotal(db, scope, period, now);
		const categories = await categoryBreakdown(db, scope, period, now);
		const members = await memberBreakdown(db, scope, period, now);
		const income = await incomeInPeriod(db, ws.id, period, scope.timezone, today);
		let answer: string;
		let detail: unknown[] = [];
		let highlight: number | null = null;

		if (parsed.category) {
			const matched = categories.filter((c) =>
				c.name.toLowerCase().includes(parsed.category!.toLowerCase())
			);
			if (matched.length > 0) {
				const catTotal = matched.reduce((s, c) => s + c.totalMinor, 0n);
				answer = `${Money.of(catTotal, currency).format()} spent on ${matched.map((c) => c.name).join(', ')} ${periodPhrase(parsed.period)}`;
				detail = matched.map((c) => ({ label: c.name, amountMinor: c.totalMinor.toString() }));
				highlight = Number(catTotal);
			} else {
				answer = `No spending found for "${parsed.category}" ${periodPhrase(parsed.period)}`;
			}
		} else if (parsed.member) {
			const matched = members.filter((m) =>
				m.name.toLowerCase().includes(parsed.member!.toLowerCase())
			);
			if (matched.length > 0) {
				const mTotal = matched.reduce((s, m) => s + m.totalMinor, 0n);
				answer = `${matched[0].name} spent ${Money.of(mTotal, currency).format()} ${periodPhrase(parsed.period)}`;
				highlight = Number(mTotal);
			} else {
				answer = `No spending found for "${parsed.member}" ${periodPhrase(parsed.period)}`;
			}
		} else {
			answer = `Total spending in ${parsed.period.label}: ${Money.of(total, currency).format()}`;
			if (income > 0n) {
				const pct = Number((total * 1000n) / income) / 10;
				answer += ` (${formatPct(pct)} of income)`;
			}
			detail = categories
				.slice(0, 5)
				.map((c) => ({ label: c.name, amountMinor: c.totalMinor.toString() }));
		}

		return jsonSafe({ intent: parsed.intent, answer, detail, highlight });
	}

	if (parsed.intent === 'net_position') {
		const period = timeToPeriod(parsed.period, now, scope.timezone, ws.weekStartDay);
		const total = await periodTotal(db, scope, period, now);
		const income = await incomeInPeriod(db, ws.id, period, scope.timezone, today);
		const bucket = await bucketFlowsInPeriod(db, ws.id, period, scope.timezone);
		const savings = bucket.setAsideMinor;
		const net = income - total - savings + bucket.releasedMinor;
		const pct = income > 0n ? Number((net * 1000n) / income) / 10 : 0;

		let answer = `In ${parsed.period.label}: `;
		answer += `${Money.of(income, currency).format()} in, `;
		answer += `${Money.of(total, currency).format()} out`;
		if (savings > 0n) answer += `, ${Money.of(savings, currency).format()} saved`;
		answer += `. Net: ${Money.of(net, currency).format()}`;
		if (income > 0n) answer += ` (${formatPct(pct)} free)`;

		return jsonSafe({ intent: parsed.intent, answer });
	}

	if (parsed.intent === 'incomplete') {
		return jsonSafe({
			intent: parsed.intent,
			answer: `That needs ${parsed.missing.join(' and ')}.`
		});
	}

	// `answerAsk` covers every remaining intent, so this is unreachable — but the
	// three branches above are the only thing telling TypeScript so, and the
	// deterministic reply is the right thing to send if that ever stops holding.
	return jsonSafe({ intent: 'unknown', raw: query, answer: ASK_FALLBACK });
};
