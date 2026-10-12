/**
 * "N bank transactions to review": the one push bank sync sends.
 *
 * A sync answers what it can by itself (a match on amount, date and
 * description clears; a charge that pays an approved request completes it) and
 * leaves the rest as lines in Reconcile. Nobody knew they were there until
 * they happened to open it. This tells them, and is careful about how:
 *
 * - **Only when there is something new.** A sync that left no new line for a
 *   person marks nothing, so a quiet account never buzzes anyone.
 * - **One alert, the whole count.** The figure is everything still waiting
 *   across the workspace's bank feeds, not this sync's share, and every alert
 *   carries the same collapse tag, so the newest replaces the last on a phone
 *   rather than stacking.
 * - **Daytime only.** The sweep syncs every six hours around the clock. A sync
 *   outside 08:00–21:00 in the workspace's timezone leaves the alert pending
 *   on the connection, and the first sweep tick after 08:00 sends it.
 * - **Nothing on the lock screen but a count.** No merchant, no amount, no
 *   bank name: a notification is shown to whoever holds the phone, and the
 *   lines themselves stay behind sign-in, filtered per viewer as ever.
 * - **Claimed once.** Clearing the pending mark is a conditional UPDATE that
 *   returns what it cleared, so two overlapping sweeps cannot both send.
 *
 * Recipients are the people who look after the money here: the workspace's
 * owners and whoever connected the bank. Each can switch it off per channel in
 * Settings → Notifications, like any other alert.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	bankConnection,
	statementImport,
	statementLine,
	workspace,
	workspaceMember
} from '$lib/db/schema';
import type { Clock } from '$lib/ports/clock';
import type { Notifier, Recipient } from '$lib/ports/notifier';

/** The household's day, in its own timezone: [first hour, last hour). */
export const ALERT_HOURS = { from: 8, to: 21 } as const;

/** Every bank-review alert shares this tag, so a newer one replaces the last. */
export const bankReviewTag = (workspaceId: string) => `bank-review:${workspaceId}`;

function localHour(at: Date, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric',
		hourCycle: 'h23'
	}).formatToParts(at);
	return Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
}

export function isDaytime(at: Date, timezone: string): boolean {
	const h = localHour(at, timezone);
	return h >= ALERT_HOURS.from && h < ALERT_HOURS.to;
}

/** Note that a connection's last sync left new lines for a person. Keeps the earliest mark. */
export async function markReviewPending(db: Db, connectionId: string, at: Date): Promise<void> {
	await db
		.update(bankConnection)
		// Typed explicitly: Postgres cannot infer a bare parameter's type inside
		// coalesce, and PGlite (which the unit tests run on) is laxer about it.
		.set({
			reviewAlertPendingAt: sql`coalesce(${bankConnection.reviewAlertPendingAt}, ${at.toISOString()}::timestamptz)`
		})
		.where(eq(bankConnection.id, connectionId));
}

/**
 * Send whatever is pending, for one workspace or all of them, where it is
 * daytime. Returns the number of workspaces alerted.
 *
 * `excludeMemberId` is the person who pressed "Sync now": they are looking at
 * the result already, so they are not also buzzed about it.
 */
export async function flushBankReviewAlerts(
	db: Db,
	deps: { clock: Clock; notifier: Notifier },
	opts: { workspaceId?: string; excludeMemberId?: string } = {}
): Promise<number> {
	const now = deps.clock.now();
	const pending = await db
		.selectDistinct({
			workspaceId: bankConnection.workspaceId,
			slug: workspace.slug,
			timezone: workspace.timezone
		})
		.from(bankConnection)
		.innerJoin(workspace, eq(workspace.id, bankConnection.workspaceId))
		.where(
			and(
				isNotNull(bankConnection.reviewAlertPendingAt),
				opts.workspaceId ? eq(bankConnection.workspaceId, opts.workspaceId) : undefined
			)
		);

	let alerted = 0;
	for (const ws of pending) {
		if (!isDaytime(now, ws.timezone)) continue;

		// The claim. Whoever clears the marks sends; anyone racing gets nothing.
		const claimed = await db
			.update(bankConnection)
			.set({ reviewAlertPendingAt: null })
			.where(
				and(
					eq(bankConnection.workspaceId, ws.workspaceId),
					isNotNull(bankConnection.reviewAlertPendingAt)
				)
			)
			.returning({ memberId: bankConnection.memberId });
		if (claimed.length === 0) continue;

		const waiting = await waitingLines(db, ws.workspaceId);
		// Answered by hand between the sync and now: nothing left to say.
		if (waiting.count === 0) continue;

		const connectors = [...new Set(claimed.map((c) => c.memberId))];
		const people = await db
			.select({ memberId: workspaceMember.id, userId: workspaceMember.userId })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, ws.workspaceId),
					eq(workspaceMember.status, 'active'),
					or(eq(workspaceMember.role, 'owner'), inArray(workspaceMember.id, connectors))
				)
			);
		const recipients: Recipient[] = people.filter((p) => p.memberId !== opts.excludeMemberId);
		if (recipients.length === 0) continue;

		const n = waiting.count;
		await deps.notifier.notify(recipients, 'bank_review', {
			title: `${n} bank ${n === 1 ? 'transaction' : 'transactions'} to review`,
			body:
				n === 1
					? 'Match it to a purchase or log it in Reconcile.'
					: 'Match them to purchases or log them in Reconcile.',
			// One month of one card: straight to it. Several: the list of them.
			path:
				waiting.importIds.length === 1
					? `/w/${ws.slug}/reconcile/${waiting.importIds[0]}`
					: `/w/${ws.slug}/reconcile`,
			tag: bankReviewTag(ws.workspaceId)
		});
		alerted++;
	}
	return alerted;
}

/** Bank-feed lines still waiting on a person: unanswered, or a proposal awaiting a tap. */
export async function waitingLines(
	db: Db,
	workspaceId: string
): Promise<{ count: number; importIds: string[] }> {
	const rows = await db
		.select({
			importId: statementLine.importId,
			n: sql<number>`count(*)`.mapWith(Number)
		})
		.from(statementLine)
		.innerJoin(statementImport, eq(statementImport.id, statementLine.importId))
		.where(
			and(
				eq(statementLine.workspaceId, workspaceId),
				eq(statementImport.format, 'feed'),
				inArray(statementLine.matchState, ['unmatched', 'matched'])
			)
		)
		.groupBy(statementLine.importId);
	return {
		count: rows.reduce((s, r) => s + r.n, 0),
		importIds: rows.map((r) => r.importId)
	};
}
