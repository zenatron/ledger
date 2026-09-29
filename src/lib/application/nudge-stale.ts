import { and, eq, lt, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '$lib/db/types';
import { purchase, purchaseApprover, user, workspace, workspaceMember } from '$lib/db/schema';
import { Money } from '$lib/domain/money/money';
import { nextNudgeAt, waitingDays } from '$lib/domain/approval/staleness';
import { isSealed } from '$lib/domain/visibility/seal';
import type { Clock } from '$lib/ports/clock';
import type { Notifier, Recipient } from '$lib/ports/notifier';

/**
 * Nudge approvers about stale pending requests: first nudge at the staleness
 * threshold, then daily, capped at MAX_NUDGES — then silence (a nagging app
 * gets its notifications disabled). State lives on the purchase row
 * (last_nudged_at, nudge_count); staleness itself is always derived.
 */
export async function nudgeStaleRequests(
	db: Db,
	deps: { clock: Clock; notifier: Notifier }
): Promise<number> {
	const now = deps.clock.now();
	const rows = await db
		.select({
			p: purchase,
			staleAfterHours: workspace.staleAfterHours,
			maxNudges: workspace.maxNudges,
			slug: workspace.slug,
			requesterName: user.displayName
		})
		.from(purchase)
		.innerJoin(workspace, eq(purchase.workspaceId, workspace.id))
		.innerJoin(workspaceMember, eq(purchase.memberId, workspaceMember.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(
			and(eq(purchase.state, 'pending_approval'), lt(purchase.nudgeCount, workspace.maxNudges))
		);

	let nudged = 0;
	for (const row of rows) {
		if (!row.p.requestedAt) continue;
		const due = nextNudgeAt(
			row.p.requestedAt,
			row.staleAfterHours,
			row.p.lastNudgedAt,
			row.p.nudgeCount,
			row.maxNudges
		);
		if (due === null || due.getTime() > now.getTime()) continue;

		// Optimistic claim: only one sweep instance wins this nudge.
		const claimed = await db
			.update(purchase)
			.set({ lastNudgedAt: now, nudgeCount: row.p.nudgeCount + 1 })
			.where(
				and(
					eq(purchase.id, row.p.id),
					eq(purchase.state, 'pending_approval'),
					eq(purchase.nudgeCount, row.p.nudgeCount)
				)
			)
			.returning({ id: purchase.id });
		if (claimed.length === 0) continue;

		/*
		 * Who to nudge: the snapshot taken at request time, UNION whoever the
		 * requester's policy names now — the same set `loadPurchase` authorizes
		 * against. Nudging the snapshot alone meant chasing people who could no
		 * longer be the ones to act while staying silent towards those who now
		 * can, which is the worst of both: noise for some, an unattended queue
		 * for everyone else.
		 *
		 * Still excludes the requester (you don't nudge someone about their own
		 * request) and still only reaches active members — and never anyone the
		 * purchase is sealed from. The live policy half names the partner a gift
		 * is for as readily as anyone, and a "Still waiting" push carries the item
		 * and its price, so without this the reminder was the leak.
		 */
		const requester = alias(workspaceMember, 'requester_member');
		const approvers = await db
			.select({ memberId: workspaceMember.id, userId: workspaceMember.userId })
			.from(workspaceMember)
			.innerJoin(requester, eq(requester.id, row.p.memberId))
			.where(
				and(
					eq(workspaceMember.workspaceId, row.p.workspaceId),
					eq(workspaceMember.status, 'active'),
					sql`${workspaceMember.id} <> ${row.p.memberId}`,
					isSealed(row.p, now)
						? notInArray(workspaceMember.id, row.p.sealedFromMemberIds)
						: undefined,
					or(
						sql`exists (
							select 1 from ${purchaseApprover}
							where ${purchaseApprover.purchaseId} = ${row.p.id}
							and ${purchaseApprover.memberId} = ${workspaceMember.id}
						)`,
						sql`coalesce(
							${requester.approvalPolicy} -> 'routing' -> 'approver_ids'
								@> to_jsonb(${workspaceMember.id}::text),
							false
						)`
					)
				)
			);
		const recipients: Recipient[] = approvers.map((a) => ({
			userId: a.userId,
			memberId: a.memberId
		}));
		if (recipients.length > 0) {
			const days = waitingDays(row.p.requestedAt, now);
			const amount = Money.of(
				row.p.finalAmountMinor ?? row.p.requestedAmountMinor,
				row.p.currency
			).format();
			await deps.notifier.notify(recipients, 'stale_nudge', {
				title: `Still waiting${days > 0 ? ` (${days} day${days === 1 ? '' : 's'})` : ''}: ${row.requesterName}`,
				body: `${row.p.itemName} · ${amount}`,
				path: `/w/${row.slug}/purchases/${row.p.id}`,
				tag: row.p.id
			});
		}
		nudged += 1;
	}
	return nudged;
}
