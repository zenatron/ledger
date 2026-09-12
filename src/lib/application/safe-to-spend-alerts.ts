import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { workspace, workspaceMember } from '$lib/db/schema';
import { safeToSpend } from '$lib/repo/forecast';
import { statusLevel } from '$lib/domain/forecast/safe-to-spend';
import { monthPeriod } from '$lib/domain/analytics/period';
import { calDateInZone } from '$lib/domain/time/zoned';
import { formatMinor } from '$lib/money-format';
import type { Clock } from '$lib/ports/clock';
import type { Notifier, Recipient } from '$lib/ports/notifier';

/**
 * Harmony's Safe-to-Spend watch: nudge a member the moment their month tips into
 * "tight" (approving everything pending would put them over) or "over" (already
 * past what's coming in). Part of the sweep.
 *
 * Deterministic, and quiet by design:
 *   - Only workspaces with Safe-to-Spend alerts enabled.
 *   - Per member, computed as *they* see it — so a sealed gift never leaks and a
 *     member is only ever told about their own number.
 *   - High-water mark per month (`safeToSpendAlertMonth` / `safeToSpendAlertLevel`):
 *     we speak once per level per month, escalate tight → over, and never repeat
 *     or walk back. The conditional UPDATE is the real gate — it claims the alert
 *     atomically, so two overlapping sweeps can't both notify.
 */
export async function sendSafeToSpendAlerts(
	db: Db,
	deps: { clock: Clock; notifier: Notifier }
): Promise<number> {
	const now = deps.clock.now();

	const workspaces = await db
		.select({
			id: workspace.id,
			slug: workspace.slug,
			timezone: workspace.timezone,
			currency: workspace.currency
		})
		.from(workspace)
		.where(eq(workspace.safeToSpendAlertsEnabled, true));

	let alerted = 0;
	for (const ws of workspaces) {
		const today = calDateInZone(now, ws.timezone);
		const period = monthPeriod(today);
		const pad = (n: number) => String(n).padStart(2, '0');
		const monthStr = `${period.from.y}-${pad(period.from.m)}-${pad(period.from.d)}`;

		const members = await db
			.select({
				id: workspaceMember.id,
				userId: workspaceMember.userId,
				alertMonth: workspaceMember.safeToSpendAlertMonth,
				alertLevel: workspaceMember.safeToSpendAlertLevel
			})
			.from(workspaceMember)
			.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.status, 'active')));

		for (const m of members) {
			// Cheap pre-gate before the forecast: level only ever escalates (the
			// high-water mark below is the claim rule), so a member already at the
			// top level for this month can never need another look. Everyone else
			// still computes — there is no sound cheaper test, because bills and
			// bucket savings can tip a quiet-looking month.
			if (m.alertMonth === monthStr && m.alertLevel === 2) continue;

			const forecast = await safeToSpend(
				db,
				{ workspaceId: ws.id, viewerId: m.id, timezone: ws.timezone },
				now
			);
			const level = statusLevel(forecast.status);
			if (level === 0) continue; // clear: nothing to say

			// Claim the alert before sending. Mirrors the pure `supersedesStsAlert`
			// rule: fire when this month's high-water mark is below `level` (a new
			// month, or never alerted, counts as zero via the null / not-equal arms).
			const claimed = await db
				.update(workspaceMember)
				.set({ safeToSpendAlertMonth: monthStr, safeToSpendAlertLevel: level })
				.where(
					and(
						eq(workspaceMember.id, m.id),
						or(
							isNull(workspaceMember.safeToSpendAlertMonth),
							ne(workspaceMember.safeToSpendAlertMonth, monthStr),
							lt(workspaceMember.safeToSpendAlertLevel, level)
						)
					)
				)
				.returning({ id: workspaceMember.id });
			if (claimed.length === 0) continue;

			const overByMinor = level === 2 ? -forecast.freeMinor : -forecast.afterReservedMinor;
			const body =
				level === 2
					? `You're ${formatMinor(overByMinor, ws.currency)} over for the month. Consider holding off on new spending.`
					: `Approving what's pending would put you ${formatMinor(overByMinor, ws.currency)} over this month.`;

			const recipients: Recipient[] = [{ userId: m.userId, memberId: m.id }];
			await deps.notifier.notify(recipients, 'safe_to_spend', {
				title: 'Harmony',
				body,
				path: `/w/${ws.slug}/purchases`,
				// Collapse key per member: a worse alert replaces the standing one.
				tag: `harmony-sts:${m.id}`
			});
			alerted += 1;
		}
	}

	return alerted;
}
