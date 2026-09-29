import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { workspace, workspaceMember } from '$lib/db/schema';
import {
	monthPeriod,
	previousMonthPeriod,
	previousWeekPeriod,
	weekPeriod,
	type Period
} from '$lib/domain/analytics/period';
import { calDateInZone, zonedTimeToUtc } from '$lib/domain/time/zoned';
import { categoryBreakdown, periodTotal, type AnalyticsScope } from '$lib/repo/analytics';
import { incomeInPeriod } from '$lib/repo/income';
import { bucketFlowsInPeriod } from '$lib/repo/buckets';
import { formatMinor } from '$lib/money-format';
import type { Clock } from '$lib/ports/clock';
import type { Notifier, NotificationMessage } from '$lib/ports/notifier';

/**
 * Intelligence summaries: a short spending digest sent to each member on the
 * cadence they chose (weekly or monthly, or off). Part of the sweep.
 *
 * Two properties matter most:
 *
 *   - **Per recipient, seal-safe.** A summary is aggregate spending, and an
 *     aggregate can leak a hidden purchase by subtraction. So every figure is
 *     computed with the member as the viewer — the analytics repo already
 *     filters sealed rows per viewer — and the digest is composed once per
 *     member, never once per workspace.
 *
 *   - **Fires once per period, no catch-up spam.** It summarises the period that
 *     just ended and stamps `summaryLastSentAt`. After downtime it sends a
 *     single digest for the most recent completed period, not one per missed
 *     week.
 */

interface Deps {
	clock: Clock;
	notifier: Notifier;
}

interface MemberRow {
	memberId: string;
	userId: string;
	cadence: string;
	lastSentAt: Date | null;
	workspaceId: string;
	slug: string;
	name: string;
	timezone: string;
	currency: string;
	weekStartDay: number;
}

export async function sendDueSummaries(db: Db, deps: Deps): Promise<number> {
	const now = deps.clock.now();

	const rows: MemberRow[] = await db
		.select({
			memberId: workspaceMember.id,
			userId: workspaceMember.userId,
			cadence: workspaceMember.summaryCadence,
			lastSentAt: workspaceMember.summaryLastSentAt,
			workspaceId: workspace.id,
			slug: workspace.slug,
			name: workspace.name,
			timezone: workspace.timezone,
			currency: workspace.currency,
			weekStartDay: workspace.weekStartDay
		})
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(ne(workspaceMember.summaryCadence, 'off'), eq(workspaceMember.status, 'active')));

	let sent = 0;
	for (const r of rows) {
		const weekly = r.cadence === 'weekly';
		const today = calDateInZone(now, r.timezone);
		const periodStart = weekly ? weekPeriod(today, r.weekStartDay).from : monthPeriod(today).from;
		const startInstant = zonedTimeToUtc(periodStart, 0, 0, r.timezone);

		// Never sent under this setting: start the clock rather than firing a
		// digest the moment someone turns it on.
		if (!r.lastSentAt) {
			await stamp(db, r.memberId, now);
			continue;
		}
		// The current period hasn't turned over since the last send — nothing due.
		if (r.lastSentAt >= startInstant) continue;

		const period = weekly ? previousWeekPeriod(today, r.weekStartDay) : previousMonthPeriod(today);
		const scope: AnalyticsScope = {
			workspaceId: r.workspaceId,
			viewerId: r.memberId,
			timezone: r.timezone
		};

		const msg = await compose(db, scope, period, r, weekly, today, now);
		// A period in which literally nothing happened isn't worth a notification.
		// Still stamp it so it doesn't re-evaluate every sweep.
		if (msg) {
			try {
				await deps.notifier.notify(
					[{ userId: r.userId, memberId: r.memberId }],
					'periodic_summary',
					msg
				);
				sent++;
			} catch {
				/* best-effort: a failed digest must not wedge the sweep */
			}
		}
		await stamp(db, r.memberId, now);
	}
	return sent;
}

function stamp(db: Db, memberId: string, at: Date) {
	return db
		.update(workspaceMember)
		.set({ summaryLastSentAt: at })
		.where(eq(workspaceMember.id, memberId));
}

/** null when the period was empty (nothing to say). */
async function compose(
	db: Db,
	scope: AnalyticsScope,
	period: Period,
	r: MemberRow,
	weekly: boolean,
	today: { y: number; m: number; d: number },
	now: Date
): Promise<NotificationMessage | null> {
	const [spent, cats, income, bucket] = await Promise.all([
		periodTotal(db, scope, period, now),
		categoryBreakdown(db, scope, period, now),
		incomeInPeriod(db, scope.workspaceId, period, scope.timezone, today),
		bucketFlowsInPeriod(db, scope.workspaceId, period, scope.timezone, {
			viewerId: scope.viewerId,
			now
		})
	]);

	// Set aside, and the funded part of what came back out. Kept apart so a
	// bucket charge can't read as negative savings. See domain/bucket/flows.
	const savings = bucket.setAsideMinor;
	if (spent === 0n && income === 0n && savings === 0n) return null;

	const money = (m: bigint) => formatMinor(m, r.currency);
	const span = weekly ? 'week' : 'month';
	const top = cats[0];

	let body: string;
	if (spent === 0n) {
		body = `Nothing spent this ${span}.`;
	} else {
		body = `You spent ${money(spent)} this ${span}`;
		body += top && top.name ? `, most on ${top.name} (${money(top.totalMinor)}).` : '.';
	}
	const net = income - spent - savings + bucket.releasedMinor;
	if (income > 0n || savings > 0n) {
		body += ` Net ${net >= 0n ? '+' : ''}${money(net)}.`;
	}

	return {
		title: `Your ${span} on Ledger`,
		body,
		// Opens the matching Activity view.
		path: `/w/${r.slug}/analytics?period=${weekly ? 'week' : 'month'}`,
		// One digest per member per period; a newer one replaces an unread older.
		tag: `summary-${r.memberId}`
	};
}
