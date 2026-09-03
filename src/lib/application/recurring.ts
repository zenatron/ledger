import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bucket, purchase, recurringRule, user, workspace, workspaceMember } from '$lib/db/schema';
import { Money } from '$lib/domain/money/money';
import type { Purchase, TransitionEvent } from '$lib/domain/purchase/purchase';
import { addDays, nextOccurrence, parseRRule } from '$lib/domain/recurrence/rrule';
import { calDateInZone, zonedTimeToUtc } from '$lib/domain/time/zoned';
import { insertPurchase } from '$lib/repo/purchases';
import { announcePurchaseChange } from '$lib/application/notify-dispatch';
import { withdrawFromBucket } from '$lib/application/purchases';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { Notifier } from '$lib/ports/notifier';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import { chargeRefusalMessage, refuseBucketCharge } from '$lib/domain/bucket/scope';

/** Recurring charges land at 09:00 workspace-local on their occurrence date. */
const MATERIALIZE_HOUR = 9;
const DAY_MS = 86_400_000;

interface Deps {
	clock: Clock;
	ids: IdGenerator;
	notifier: Notifier;
}

interface Scope {
	workspaceId: string;
	memberId: string;
}

export class RecurringRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RecurringRuleError';
	}
}

export interface CreateRuleCmd {
	itemName: string;
	amount: Money;
	categoryId: string | null;
	rrule: string;
	autoComplete: boolean;
	/** Charge generated purchases against this bucket (withdrawn on completion). */
	bucketId?: string | null;
	/** Also generate the occurrences between the start date and today. */
	backfill?: boolean;
}

/**
 * The bucket a rule may charge: real, in this workspace, active, and one this
 * member may spend from.
 *
 * Checked when the rule is written rather than when it fires. A rule is a
 * standing instruction, so a charge it generates months from now has nobody at
 * the keyboard to tell; refusing it up front is the only place the answer is
 * useful. The other end is `updateBucket`, which detaches a bucket from other
 * members' rules the moment it is made personal, so a rule cannot keep drawing
 * on a bucket that has since closed to its owner.
 */
async function assertChargableBucket(db: Db, scope: Scope, bucketId: string) {
	const [bkt] = await db
		.select({
			id: bucket.id,
			status: bucket.status,
			memberId: bucket.memberId,
			chargeMemberIds: bucket.chargeMemberIds
		})
		.from(bucket)
		.where(and(eq(bucket.id, bucketId), eq(bucket.workspaceId, scope.workspaceId)))
		.limit(1);
	if (!bkt) throw new RecurringRuleError('Bucket not found');
	if (bkt.status !== 'active') {
		throw new RecurringRuleError('Cannot charge to a paused or archived bucket');
	}
	const [me] = await db
		.select({ policy: workspaceMember.approvalPolicy })
		.from(workspaceMember)
		.where(
			and(
				eq(workspaceMember.id, scope.memberId),
				eq(workspaceMember.workspaceId, scope.workspaceId)
			)
		)
		.limit(1);
	const policy = me?.policy as ApprovalPolicy | undefined;
	const refusal = refuseBucketCharge(bkt, {
		memberId: scope.memberId,
		ownBucketsOnly: policy?.own_buckets_only === true
	});
	if (refusal) throw new RecurringRuleError(chargeRefusalMessage(refusal));
}

export async function createRule(
	db: Db,
	deps: Deps,
	scope: Scope,
	cmd: CreateRuleCmd
): Promise<{ ruleId: string }> {
	const now = deps.clock.now();
	const [ws] = await db
		.select()
		.from(workspace)
		.where(eq(workspace.id, scope.workspaceId))
		.limit(1);
	if (!ws) throw new RecurringRuleError('Workspace not found');
	if (cmd.amount.currency !== ws.currency || !cmd.amount.isPositive) {
		throw new RecurringRuleError(`Amount must be positive ${ws.currency}`);
	}
	const rec = parseRRule(cmd.rrule); // throws RecurrenceError on bad input
	if (cmd.bucketId) await assertChargableBucket(db, scope, cmd.bucketId);

	// Normally the first occurrence is today at the earliest — nothing in the
	// past. Backfilling instead anchors to the rule's own start date, and the
	// materialization sweep walks forward from there on its next pass (capped at
	// MAX_CATCHUP). Those charges land silently; see materializeDueRules.
	const today = calDateInZone(now, ws.timezone);
	const from = cmd.backfill ? addDays(rec.start, -1) : addDays(today, -1);
	const next = nextOccurrence(rec, from);

	const ruleId = deps.ids.newId();
	await db.insert(recurringRule).values({
		id: ruleId,
		workspaceId: scope.workspaceId,
		memberId: scope.memberId,
		itemName: cmd.itemName,
		categoryId: cmd.categoryId,
		merchantId: null,
		amountMinor: cmd.amount.minor,
		currency: cmd.amount.currency,
		bucketId: cmd.bucketId ?? null,
		rrule: cmd.rrule,
		nextOccurrenceAt: zonedTimeToUtc(next, MATERIALIZE_HOUR, 0, ws.timezone),
		lastGeneratedAt: null,
		status: 'active',
		autoComplete: cmd.autoComplete,
		endedAt: null
	});
	return { ruleId };
}

async function loadOwnRule(db: Db, scope: Scope, ruleId: string) {
	const rows = await db
		.select()
		.from(recurringRule)
		.where(and(eq(recurringRule.id, ruleId), eq(recurringRule.workspaceId, scope.workspaceId)))
		.limit(1);
	const rule = rows[0];
	if (!rule) throw new RecurringRuleError('Rule not found');
	if (rule.memberId !== scope.memberId) {
		throw new RecurringRuleError('Only the rule owner can change it');
	}
	return rule;
}

export async function pauseRule(db: Db, deps: Deps, scope: Scope, ruleId: string) {
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status !== 'active') throw new RecurringRuleError('Only active rules can pause');
	await db.update(recurringRule).set({ status: 'paused' }).where(eq(recurringRule.id, ruleId));
}

/** Resuming skips anything missed while paused — next occurrence is future-only. */
export async function resumeRule(db: Db, deps: Deps, scope: Scope, ruleId: string) {
	const now = deps.clock.now();
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status !== 'paused') throw new RecurringRuleError('Only paused rules can resume');
	const [ws] = await db
		.select({ timezone: workspace.timezone })
		.from(workspace)
		.where(eq(workspace.id, scope.workspaceId))
		.limit(1);
	const next = nextOccurrence(parseRRule(rule.rrule), calDateInZone(now, ws.timezone));
	await db
		.update(recurringRule)
		.set({
			status: 'active',
			nextOccurrenceAt: zonedTimeToUtc(next, MATERIALIZE_HOUR, 0, ws.timezone)
		})
		.where(eq(recurringRule.id, ruleId));
}

export async function endRule(db: Db, deps: Deps, scope: Scope, ruleId: string) {
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status === 'ended') throw new RecurringRuleError('Rule already ended');
	await db
		.update(recurringRule)
		.set({ status: 'ended', endedAt: deps.clock.now(), nextOccurrenceAt: null })
		.where(eq(recurringRule.id, ruleId));
}

/** Price change: applies to future occurrences only; history stays as charged. */
export async function updateRuleAmount(
	db: Db,
	deps: Deps,
	scope: Scope,
	ruleId: string,
	amount: Money
) {
	const rule = await loadOwnRule(db, scope, ruleId);
	if (amount.currency !== rule.currency || !amount.isPositive) {
		throw new RecurringRuleError(`Amount must be positive ${rule.currency}`);
	}
	if (rule.status === 'ended') throw new RecurringRuleError('Rule already ended');
	await db
		.update(recurringRule)
		.set({ amountMinor: amount.minor })
		.where(eq(recurringRule.id, ruleId));
}

export interface UpdateRuleCmd {
	itemName?: string;
	amount?: Money;
	categoryId?: string | null;
	bucketId?: string | null;
	rrule?: string;
	autoComplete?: boolean;
}

/**
 * The editable fields of a rule, validated and turned into a column patch.
 *
 * Shared by `updateRule` and `restartRule`. A restart is the one moment a rule
 * is most likely to need a new price: a subscription you cancelled in March
 * and want back in September is rarely still the March price. Running both
 * through the same validation keeps a restarted rule as trustworthy as an
 * edited one, down to the bucket check.
 */
async function ruleFieldUpdates(
	db: Db,
	scope: Scope,
	currency: string,
	cmd: UpdateRuleCmd
): Promise<Record<string, unknown>> {
	const updates: Record<string, unknown> = {};
	if (cmd.itemName !== undefined) updates.itemName = cmd.itemName;
	if (cmd.amount !== undefined) {
		if (cmd.amount.currency !== currency || !cmd.amount.isPositive) {
			throw new RecurringRuleError(`Amount must be positive ${currency}`);
		}
		updates.amountMinor = cmd.amount.minor;
	}
	if (cmd.categoryId !== undefined) updates.categoryId = cmd.categoryId;
	if (cmd.bucketId !== undefined) {
		if (cmd.bucketId) await assertChargableBucket(db, scope, cmd.bucketId);
		updates.bucketId = cmd.bucketId;
	}
	if (cmd.autoComplete !== undefined) updates.autoComplete = cmd.autoComplete;
	return updates;
}

export async function updateRule(
	db: Db,
	deps: Deps,
	scope: Scope,
	ruleId: string,
	cmd: UpdateRuleCmd
) {
	const now = deps.clock.now();
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status === 'ended') throw new RecurringRuleError('Rule already ended');

	const [ws] = await db
		.select({ timezone: workspace.timezone, currency: workspace.currency })
		.from(workspace)
		.where(eq(workspace.id, scope.workspaceId))
		.limit(1);
	if (!ws) throw new RecurringRuleError('Workspace not found');

	const updates = await ruleFieldUpdates(db, scope, rule.currency, cmd);
	if (cmd.rrule !== undefined) {
		const rec = parseRRule(cmd.rrule);
		const today = calDateInZone(now, ws.timezone);
		const next = nextOccurrence(rec, addDays(today, -1));
		updates.rrule = cmd.rrule;
		updates.nextOccurrenceAt = zonedTimeToUtc(next, MATERIALIZE_HOUR, 0, ws.timezone);
	}
	if (Object.keys(updates).length === 0) return;
	await db.update(recurringRule).set(updates).where(eq(recurringRule.id, ruleId));
}

/**
 * Bring an ended rule back, at whatever price and cadence it charges now.
 *
 * Deliberately not a one-tap undo of `endRule`. Things get cancelled and picked
 * up again months later, and in between the price goes up and the billing day
 * moves, so this takes the same field patch an edit does. `updateRule` refuses
 * an ended rule outright, which is why this is its own path.
 *
 * The rule is reused, never recreated: its old purchases stay attached, so what
 * it has cost you keeps adding up across the gap.
 */
export async function restartRule(
	db: Db,
	deps: Deps,
	scope: Scope,
	ruleId: string,
	cmd: UpdateRuleCmd = {}
) {
	const now = deps.clock.now();
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status !== 'ended') throw new RecurringRuleError('Only ended rules can start again');

	const [ws] = await db
		.select({ timezone: workspace.timezone, currency: workspace.currency })
		.from(workspace)
		.where(eq(workspace.id, scope.workspaceId))
		.limit(1);
	if (!ws) throw new RecurringRuleError('Workspace not found');

	const updates = await ruleFieldUpdates(db, scope, rule.currency, cmd);
	// Whatever schedule was posted, or the one it ended on if the caller sent none.
	const rrule = cmd.rrule ?? rule.rrule;
	const rec = parseRRule(rrule);

	// Forward-only, and never backfilled. The months it sat ended are a real gap
	// in what was paid; generating charges for them would invent spending nobody
	// did. `addDays(today, -1)` still lets an occurrence falling today count,
	// matching createRule.
	const today = calDateInZone(now, ws.timezone);
	const next = nextOccurrence(rec, addDays(today, -1));

	await db
		.update(recurringRule)
		.set({
			...updates,
			rrule,
			status: 'active',
			endedAt: null,
			nextOccurrenceAt: zonedTimeToUtc(next, MATERIALIZE_HOUR, 0, ws.timezone)
		})
		.where(eq(recurringRule.id, ruleId));
}

/**
 * Erase an ended rule for good.
 *
 * Only ended rules qualify, so getting rid of one is always two deliberate
 * steps: end it, then delete it. Nothing that is still charging can be removed
 * by a single tap.
 *
 * `purchase.recurring_rule_id` carries a real foreign key, so the charges have
 * to let go of the rule before the row can leave. They keep their money and
 * their place in the ledger; what they lose is the marker saying a rule made
 * them. The confirm on the page says so before this runs.
 */
export async function deleteRule(db: Db, deps: Deps, scope: Scope, ruleId: string) {
	const rule = await loadOwnRule(db, scope, ruleId);
	if (rule.status !== 'ended') throw new RecurringRuleError('End the rule before deleting it');
	await db.transaction(async (tx) => {
		await tx
			.update(purchase)
			.set({ recurringRuleId: null })
			.where(eq(purchase.recurringRuleId, ruleId));
		await tx.delete(recurringRule).where(eq(recurringRule.id, ruleId));
	});
}

/**
 * Materialization sweep. Each due rule generates its missed occurrences
 * (capped), advancing next_occurrence_at as it goes. Generated purchases skip
 * approval by design: auto_complete rules land COMPLETED, others land APPROVED
 * awaiting the real final amount. Sealing recurring items is not a thing.
 */
export async function materializeDueRules(db: Db, deps: Deps): Promise<number> {
	const now = deps.clock.now();
	const due = await db
		.select({
			ruleId: recurringRule.id,
			tz: workspace.timezone,
			catchupMax: workspace.recurringCatchupMax
		})
		.from(recurringRule)
		.innerJoin(workspace, eq(recurringRule.workspaceId, workspace.id))
		.where(and(eq(recurringRule.status, 'active'), lte(recurringRule.nextOccurrenceAt, now)));

	let generated = 0;
	for (const { ruleId, tz, catchupMax } of due) {
		// One transaction per occurrence, not per catch-up batch: a failure on the
		// 30th missed occurrence must not roll back the 29 already generated and
		// leave next_occurrence_at unadvanced (which would replay them forever).
		for (let i = 0; i < catchupMax; i++) {
			const made = await db.transaction(async (tx) => {
				// Re-check under lock; a concurrent sweep may have handled this rule.
				const locked = await tx
					.select()
					.from(recurringRule)
					.where(eq(recurringRule.id, ruleId))
					.for('update')
					.limit(1);
				const r = locked[0];
				if (!r || r.status !== 'active' || !r.nextOccurrenceAt || r.nextOccurrenceAt > now) {
					return null;
				}

				// A malformed rule must not wedge the sweep: parsing throws, the
				// transaction rolls back with next_occurrence_at unadvanced, and the
				// row re-throws every sweep — starving every rule after it. Pause it
				// instead. The candidate query filters status='active', so a paused
				// rule leaves the queue for good; it shows as paused and resumes in one
				// tap once corrected.
				let rec;
				try {
					rec = parseRRule(r.rrule);
				} catch (e) {
					await tx
						.update(recurringRule)
						.set({ status: 'paused' })
						.where(eq(recurringRule.id, r.id));
					console.log(
						JSON.stringify({
							level: 'warn',
							msg: 'sweep: recurring paused (unparseable rule)',
							ruleId: r.id,
							err: (e as Error).message
						})
					);
					return null;
				}
				const occurrenceAt = r.nextOccurrenceAt;
				const amount = Money.of(r.amountMinor, r.currency);
				const p: Purchase = {
					id: deps.ids.newId(),
					workspaceId: r.workspaceId,
					memberId: r.memberId,
					state: r.autoComplete ? 'completed' : 'approved',
					itemName: r.itemName,
					note: null,
					categoryId: r.categoryId,
					requestedAmount: amount,
					approvedAmount: amount,
					finalAmount: r.autoComplete ? amount : null,
					sealedUntil: null,
					sealedFromMemberIds: [],
					requestedAt: null,
					decidedAt: occurrenceAt,
					completedAt: r.autoComplete ? occurrenceAt : null,
					clearedAt: null,
					lastNudgedAt: null,
					nudgeCount: 0,
					recurringRuleId: r.id,
					parentPurchaseId: null,
					approverMemberIds: [],
					bucketId: r.bucketId,
					merchantId: null,
					accountId: null,
					heldUntil: null,
					heldBy: null,
					// A rule fires on a schedule, not at a shop — nobody was anywhere
					// when this row appeared. It carries no merchant either, so there
					// is not even a vendor default to inherit. Adding a pin here would
					// be inventing a place from a calendar.
					place: null
				};
				const event: TransitionEvent = {
					fromState: null,
					toState: p.state,
					actorMemberId: null,
					reason: 'recurring',
					amountSnapshot: amount,
					at: occurrenceAt
				};
				await insertPurchase(tx, deps, p, event);
				// A rule charged to a bucket that completes itself draws the bucket
				// down right away; confirm-at-price rules withdraw when confirmed.
				if (p.state === 'completed' && p.bucketId) {
					await withdrawFromBucket(tx, deps, p);
				}

				const next = nextOccurrence(rec, calDateInZone(occurrenceAt, tz));
				await tx
					.update(recurringRule)
					.set({
						lastGeneratedAt: now,
						nextOccurrenceAt: zonedTimeToUtc(next, MATERIALIZE_HOUR, 0, tz)
					})
					.where(eq(recurringRule.id, r.id));
				return { purchase: p, event };
			});

			if (!made) break;

			// Anything dated more than a day ago is history, not news: a backfilled
			// subscription or a catch-up after downtime. Open pages still refresh
			// over SSE; nobody's phone buzzes twelve times.
			const fresh = made.purchase.decidedAt
				? made.purchase.decidedAt.getTime() >= now.getTime() - DAY_MS
				: true;
			await announcePurchaseChange(db, deps.notifier, made.purchase, made.event, {
				push: fresh
			});
			if (fresh) await notifyRuleOwner(db, deps.notifier, made.purchase);
			generated += 1;
		}
	}
	return generated;
}

async function notifyRuleOwner(db: Db, notifier: Notifier, p: Purchase) {
	try {
		const [row] = await db
			.select({ userId: workspaceMember.userId, slug: workspace.slug })
			.from(workspaceMember)
			.innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
			.innerJoin(user, eq(workspaceMember.userId, user.id))
			.where(eq(workspaceMember.id, p.memberId))
			.limit(1);
		if (!row) return;
		await notifier.notify([{ userId: row.userId, memberId: p.memberId }], 'recurring_due', {
			title: p.state === 'completed' ? 'Recurring charge recorded' : 'Recurring charge due',
			body: `${p.itemName} · ${p.requestedAmount.format()}`,
			path: `/w/${row.slug}/purchases/${p.id}`,
			tag: p.id
		});
	} catch (e) {
		console.log(
			JSON.stringify({ level: 'warn', msg: 'notify: recurring failed', err: (e as Error).message })
		);
	}
}
