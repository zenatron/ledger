import type { WorkspaceContext } from '$lib/ports/context';
import type { LoadEvent } from '$lib/ports/handlers';
import { calDateInZone } from '$lib/domain/time/zoned';
import {
	monthLabel,
	monthPeriod,
	periodBoundsUtc,
	previousMonthPeriod
} from '$lib/domain/analytics/period';
import {
	budgetVsActual,
	categoryBreakdown,
	dailyTrend,
	memberBreakdown,
	periodCount,
	periodTotal
} from '$lib/repo/analytics';
import { incomeInPeriod } from '$lib/repo/income';
import { bucketFlowsInPeriod } from '$lib/repo/buckets';
import { listLedger } from '$lib/repo/ledger';
import { formatMinor } from '$lib/money-format';
import {
	narrateMonth,
	summarizeMonth,
	type MonthStatementFigures
} from '$lib/domain/statement/month-statement';

const EARLIEST = 2020;
const MONTH_ABBR = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];

export async function load(ctx: WorkspaceContext, { url, params }: LoadEvent) {
	// Depend on the workspace param so a switch always re-runs (see +layout.server.ts).
	void params.workspace;
	const db = ctx.db;
	const now = ctx.deps.clock.now();
	const ws = ctx.workspace;
	const scope = { workspaceId: ws.id, viewerId: ctx.member.id, timezone: ws.timezone };
	const today = calDateInZone(now, ws.timezone);
	const pad = (n: number) => String(n).padStart(2, '0');

	// Which month is being read. Default: the current month, "so far".
	let target = { y: today.y, m: today.m, d: 1 };
	const monthParam = url.searchParams.get('month');
	if (monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
		const [y, m] = monthParam.split('-').map(Number);
		target = { y, m, d: 1 };
	}

	const period = monthPeriod(target);
	const prevPeriod = previousMonthPeriod(target);
	const isPartial = target.y === today.y && target.m === today.m;
	const bounds = periodBoundsUtc(period, ws.timezone);

	const [
		spent,
		prevSpent,
		income,
		bucket,
		categories,
		members,
		txCount,
		trend,
		budgetLines,
		ledger
	] = await Promise.all([
		periodTotal(db, scope, period, now),
		periodTotal(db, scope, prevPeriod, now),
		incomeInPeriod(db, ws.id, period, ws.timezone, today),
		bucketFlowsInPeriod(db, ws.id, period, ws.timezone),
		categoryBreakdown(db, scope, period, now),
		memberBreakdown(db, scope, period, now),
		periodCount(db, scope, period, now),
		dailyTrend(db, scope, period, now),
		budgetVsActual(db, scope, period, now),
		listLedger(db, scope, now, {
			from: bounds.from,
			to: bounds.to,
			basis: 'spend',
			limit: 1000
		})
	]);

	// The single heaviest day, straight off the daily trend (no extra query).
	let biggestDay: { key: string; totalMinor: bigint } | null = null;
	for (const [key, total] of trend) {
		if (!biggestDay || total > biggestDay.totalMinor) biggestDay = { key, totalMinor: total };
	}

	// The overall plan ("Everything") is the truest single budget line, if set.
	const overall = budgetLines.find((l) => l.categoryId === null);
	const budget = overall
		? { limitMinor: overall.budgetMinor, actualMinor: overall.actualMinor }
		: null;

	const topCategory =
		categories.length > 0 && categories[0].totalMinor > 0n
			? { name: categories[0].name, totalMinor: categories[0].totalMinor }
			: null;

	const figures: MonthStatementFigures = {
		spentMinor: spent,
		prevSpentMinor: prevSpent,
		incomeMinor: income,
		savingsMinor: bucket.setAsideMinor,
		releasedMinor: bucket.releasedMinor,
		overdraftMinor: bucket.overdraftMinor,
		txCount,
		topCategory,
		biggestDay,
		budget,
		isPartial
	};

	const money = (m: bigint) => formatMinor(m, ws.currency);
	const summary = summarizeMonth(figures);
	const narration = narrateMonth(figures, money);

	const nm = target.m === 12 ? { y: target.y + 1, m: 1 } : { y: target.y, m: target.m + 1 };
	const pm = target.m === 1 ? { y: target.y - 1, m: 12 } : { y: target.y, m: target.m - 1 };
	const hasNext = target.y < today.y || (target.y === today.y && target.m < today.m);
	const hasPrev = target.y > EARLIEST || (target.y === EARLIEST && target.m > 1);

	// Inclusive range for links into the ledger, read the way a person does.
	const lastDay = new Date(
		Date.UTC(period.toExclusive.y, period.toExclusive.m - 1, 0)
	).getUTCDate();
	const rangeFrom = `${target.y}-${pad(target.m)}-01`;
	const rangeTo = `${target.y}-${pad(target.m)}-${pad(lastDay)}`;

	return {
		label: monthLabel(target),
		monthParam: `${target.y}-${pad(target.m)}`,
		isPartial,
		figures,
		summary,
		narration,
		categories: categories.map((c) => ({ ...c })),
		members: members.map((m) => ({ ...m })),
		transactions: ledger.entries
			.filter((e): e is typeof e & { kind: 'purchase' } => e.kind === 'purchase')
			.reverse(),
		rangeFrom,
		rangeTo,
		asOf: isPartial
			? `${MONTH_ABBR[today.m - 1]} ${today.d}`
			: `${MONTH_ABBR[target.m - 1]} ${lastDay}`,
		hasPrev,
		hasNext,
		prevMonth: `${pm.y}-${pad(pm.m)}`,
		nextMonth: `${nm.y}-${pad(nm.m)}`,
		workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone },
		generatedAt: now.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})
	};
}
