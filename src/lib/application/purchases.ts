import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	purchase as purchaseTable,
	workspace,
	workspaceMember,
	merchant,
	bucket,
	bucketTransaction,
	purchaseImage,
	purchaseApprover,
	approvalEvent
} from '$lib/db/schema';
import { Money } from '$lib/domain/money/money';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import { approvalRequired, resolveApprovers } from '$lib/domain/approval/evaluate';
import {
	appeal,
	approve,
	cancel,
	complete,
	deny,
	edit,
	markRefunded,
	overrideDenial,
	requestApproval,
	autoApprove,
	PurchaseStateError,
	type Purchase,
	type PurchaseEdit
} from '$lib/domain/purchase/purchase';
import {
	approversNotConcealed,
	isSealed,
	validateSeal,
	type SealSpec
} from '$lib/domain/visibility/seal';
import { appendEvent, applyTransition, insertPurchase, loadPurchase } from '$lib/repo/purchases';
import { normalizeMerchantName } from '$lib/domain/purchase/merchant';
import { overdraftBy } from '$lib/domain/bucket/flows';
import { chargeRefusalMessage, refuseBucketCharge } from '$lib/domain/bucket/scope';
import { bucketBalance } from '$lib/repo/buckets';
import {
	isObservedPlace,
	placeFromColumns,
	placeToColumns,
	samePlace,
	type PurchasePlace
} from '$lib/domain/location/place';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { Notifier } from '$lib/ports/notifier';
import { announcePurchaseChange } from '$lib/application/notify-dispatch';
import { checkBudgetsForPurchase } from '$lib/application/budget-alerts';

export class PurchaseNotFoundError extends Error {
	constructor() {
		super('Purchase not found');
		this.name = 'PurchaseNotFoundError';
	}
}

interface Deps {
	clock: Clock;
	ids: IdGenerator;
	notifier: Notifier;
}

interface Scope {
	workspaceId: string;
	/** The acting member's workspace_member id — also the seal-filter viewer. */
	memberId: string;
}

/** Find-or-create by normalized name — merchants are per-workspace, case-insensitive. */
async function findOrCreateMerchant(
	tx: Db,
	deps: Deps,
	workspaceId: string,
	name: string
): Promise<string | null> {
	const normalized = normalizeMerchantName(name);
	if (normalized.length === 0) return null;
	const [existing] = await tx
		.select({ id: merchant.id })
		.from(merchant)
		.where(and(eq(merchant.workspaceId, workspaceId), eq(merchant.normalizedName, normalized)))
		.limit(1);
	if (existing) return existing.id;
	const id = deps.ids.newId();
	await tx.insert(merchant).values({
		id,
		workspaceId,
		name: name.trim(),
		normalizedName: normalized
	});
	return id;
}

export interface SubmitPurchaseCmd {
	itemName: string;
	amount: Money;
	categoryId: string | null;
	note: string | null;
	/** 'request' = intent, not yet bought. 'log' = already spent (amount is final). */
	intent: 'request' | 'log';
	/** When intent is 'log': when the money was actually spent. */
	spentAt?: Date;
	/** Gift mode: hide this purchase entirely from these members until the date. */
	seal?: SealSpec;
	merchantName?: string | null;
	/** Charge this purchase against a bucket (withdraw on completion). */
	bucketId?: string | null;
	/** The card it was paid on, when known. */
	accountId?: string | null;
	/**
	 * Where it was spent. Always already rounded — callers hand this over having
	 * been through `roundToE3`, which is the only way a coordinate is allowed to
	 * reach a column. Omitted means "no pin was offered", which is the normal
	 * case; the vendor's saved default may then fill in.
	 */
	place?: PurchasePlace | null;
}

/**
 * Where the two pins meet.
 *
 * A purchase's own pin is the fact; a vendor's is a default learned from one.
 * The rules are asymmetric on purpose:
 *
 *  - **Inherit** when no pin was offered and the vendor has one, marked
 *    `'merchant'` so the map can say the pin came from the vendor's usual place
 *    rather than implying somebody stood there.
 *  - **Teach** the vendor from an *observed* pin, and only while the vendor has
 *    none. Letting an inherited pin write back would launder a guess into a
 *    fact, and overwriting an existing default would let one trip to a different
 *    branch move every historical purchase at that vendor.
 */
async function reconcilePlaceWithMerchant(
	tx: Db,
	offered: PurchasePlace | null,
	merchantId: string | null,
	now: Date,
	/**
	 * Whether this purchase is hidden from anyone. A sealed purchase never
	 * teaches its vendor a pin — see below.
	 */
	sealed: boolean
): Promise<PurchasePlace | null> {
	if (!merchantId) return offered;

	if (!offered) {
		const [vendor] = await tx
			.select({
				latE3: merchant.latE3,
				lngE3: merchant.lngE3,
				placeLabel: merchant.placeLabel,
				locationSource: merchant.locationSource
			})
			.from(merchant)
			.where(eq(merchant.id, merchantId))
			.limit(1);
		const learned = vendor ? placeFromColumns(vendor) : null;
		return learned ? { ...learned, source: 'merchant' } : null;
	}

	/*
	 * A sealed purchase teaches nothing.
	 *
	 * `merchant` rows are workspace-global and carry no seal — which the read
	 * path handles by always entering through `purchase`. The *write* path can
	 * launder around that: teach a vendor from a sealed gift, and the very next
	 * unsealed purchase at that vendor inherits the coordinate and shows it to
	 * the person the gift was hidden from. Buy a ring at a jeweller, seal it,
	 * then buy a $5 nothing at the same jeweller, and the map draws a bubble at
	 * a place only the sealed purchase ever supplied.
	 *
	 * The pin still lives on the sealed purchase itself, where the seal filter
	 * covers it. All that is lost is the convenience of the vendor remembering a
	 * place — cheap against a leak of exactly the kind sealing exists to stop.
	 */
	if (isObservedPlace(offered) && !sealed) {
		await tx
			.update(merchant)
			.set({
				latE3: offered.latE3,
				lngE3: offered.lngE3,
				placeLabel: offered.label,
				locationSource: offered.source,
				locationUpdatedAt: now
			})
			.where(and(eq(merchant.id, merchantId), isNull(merchant.latE3)));
	}
	return offered;
}

/**
 * Submit a purchase. Policy decides the path:
 *  - needs approval  → PENDING_APPROVAL (a 'log' keeps its final amount so a
 *    later approval completes it in one step — retroactive approval).
 *  - exempt 'request' → APPROVED automatically (recorded as such).
 *  - exempt 'log'     → COMPLETED immediately.
 */
export async function submitPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	cmd: SubmitPurchaseCmd
): Promise<{ purchaseId: string }> {
	const now = deps.clock.now();
	const result = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspace)
			.where(eq(workspace.id, scope.workspaceId))
			.limit(1);
		if (!ws) throw new PurchaseNotFoundError();
		if (cmd.amount.currency !== ws.currency) {
			throw new PurchaseStateError(
				`This workspace uses ${ws.currency}; got ${cmd.amount.currency}`
			);
		}
		if (!cmd.amount.isPositive) {
			throw new PurchaseStateError('Amount must be positive');
		}

		const merchantId = cmd.merchantName
			? await findOrCreateMerchant(tx, deps, scope.workspaceId, cmd.merchantName)
			: null;
		// Gated on the workspace flag here, not only in the route: this is the one
		// door every caller goes through, including MCP and recurring materializat-
		// ion, so a workspace with places off cannot acquire one by any path.
		const place = ws.locationEnabled
			? await reconcilePlaceWithMerchant(tx, cmd.place ?? null, merchantId, now, Boolean(cmd.seal))
			: null;

		const members = await tx
			.select({ id: workspaceMember.id, policy: workspaceMember.approvalPolicy })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, scope.workspaceId),
					eq(workspaceMember.status, 'active')
				)
			);
		const me = members.find((m) => m.id === scope.memberId);
		if (!me) throw new PurchaseNotFoundError();
		const policy = me.policy as ApprovalPolicy;

		if (cmd.seal) {
			validateSeal(cmd.seal, {
				now,
				maxSealDays: ws.maxSealDays,
				requesterMemberId: scope.memberId,
				activeMemberIds: members.map((m) => m.id)
			});
		}

		// Validate bucket if provided — must be active, in this workspace, and one
		// this member is allowed to spend from. The last of those is the real gate:
		// the pickers filter to the same set, but a form post, a recurring rule or
		// an MCP token all arrive here, and only here is it enforced.
		let bucketWouldOverdraw = false;
		if (cmd.bucketId) {
			const [bkt] = await tx
				.select({
					id: bucket.id,
					status: bucket.status,
					memberId: bucket.memberId,
					chargeMemberIds: bucket.chargeMemberIds
				})
				.from(bucket)
				.where(and(eq(bucket.id, cmd.bucketId), eq(bucket.workspaceId, scope.workspaceId)))
				// The row lock serializes concurrent chargers: the overdraw judgement
				// below is only as good as the balance it reads, and two submits
				// racing one near-empty bucket must not both see the same one.
				.for('update')
				.limit(1);
			if (!bkt) throw new PurchaseStateError('Bucket not found');
			if (bkt.status !== 'active')
				throw new PurchaseStateError('Cannot charge to a paused or archived bucket');
			const refusal = refuseBucketCharge(bkt, {
				memberId: scope.memberId,
				ownBucketsOnly: policy.own_buckets_only === true
			});
			if (refusal) throw new PurchaseStateError(chargeRefusalMessage(refusal));

			// Read inside the transaction, so the balance the cap is judged against
			// is the one the withdrawal will land on. A charge bigger than what the
			// bucket holds is spending that was never set aside, and for a member on
			// an allowance that is what turns a free purchase into a request.
			bucketWouldOverdraw =
				overdraftBy(await bucketBalance(tx, cmd.bucketId), cmd.amount.minor) > 0n;
		}

		const isLog = cmd.intent === 'log';
		const draft: Purchase = {
			id: deps.ids.newId(),
			workspaceId: scope.workspaceId,
			memberId: scope.memberId,
			state: 'draft',
			itemName: cmd.itemName,
			note: cmd.note,
			categoryId: cmd.categoryId,
			requestedAmount: cmd.amount,
			approvedAmount: null,
			// A logged purchase carries its final amount from the start.
			finalAmount: isLog ? cmd.amount : null,
			sealedUntil: cmd.seal?.sealedUntil ?? null,
			sealedFromMemberIds: cmd.seal?.sealedFromMemberIds ?? [],
			requestedAt: null,
			decidedAt: null,
			completedAt: isLog ? (cmd.spentAt ?? now) : null,
			clearedAt: null,
			lastNudgedAt: null,
			nudgeCount: 0,
			recurringRuleId: null,
			parentPurchaseId: null,
			approverMemberIds: [],
			bucketId: cmd.bucketId ?? null,
			merchantId,
			accountId: cmd.accountId ?? null,
			heldUntil: null,
			heldBy: null,
			place
		};

		// The bucket carve-out is part of what the policy means, so it is decided
		// in the policy engine rather than short-circuited here — the member's own
		// rule can now override the workspace default in either direction.
		const needed = approvalRequired(policy, cmd.amount, cmd.categoryId, {
			chargedToBucket: Boolean(cmd.bucketId),
			workspaceSkipsBucketCharges: ws.bucketChargesSkipApproval,
			bucketWouldOverdraw
		});
		let result;
		if (needed) {
			const approvers = resolveApprovers(
				policy,
				members.map((m) => m.id)
			);
			// Approval × seal conflict: route to approvers who can see it; if
			// none can, auto-approve *with disclosure* — never a silent skip.
			const eligible = cmd.seal ? approversNotConcealed(approvers, cmd.seal) : approvers;
			if (eligible.length > 0) {
				result = requestApproval(draft, eligible, now);
			} else if (isLog) {
				const bare = { ...draft, finalAmount: null, completedAt: null };
				result = complete(
					bare,
					scope.memberId,
					{ amount: cmd.amount, at: cmd.spentAt ?? now },
					ws.reapprovalThresholdPct,
					now
				);
				result.event.reason = 'sealed: approver concealed, recorded without approval';
			} else {
				result = autoApprove(draft, now, 'sealed: approver concealed, recorded without approval');
			}
		} else if (isLog) {
			// completedAt/finalAmount already on the draft; complete() re-asserts them.
			const bare = { ...draft, finalAmount: null, completedAt: null };
			result = complete(
				bare,
				scope.memberId,
				{ amount: cmd.amount, at: cmd.spentAt ?? now },
				ws.reapprovalThresholdPct,
				now
			);
		} else {
			result = autoApprove(draft, now, 'approval not required');
		}
		await insertPurchase(tx, deps, result.purchase, result.event);
		if (result.purchase.state === 'completed' && result.purchase.bucketId) {
			await withdrawFromBucket(tx, deps, result.purchase);
		}
		if (cmd.seal) {
			// Audit the seal itself — private until unseal, not secret after it.
			await appendEvent(tx, deps.ids, result.purchase.id, {
				fromState: result.purchase.state,
				toState: result.purchase.state,
				actorMemberId: scope.memberId,
				reason: `sealed until ${cmd.seal.sealedUntil.toISOString().slice(0, 10)} (hidden from ${cmd.seal.sealedFromMemberIds.length})`,
				amountSnapshot: null,
				at: now
			});
		}
		return result;
	});
	// After commit only — a rolled-back purchase must never notify anyone.
	await announcePurchaseChange(db, deps.notifier, result.purchase, result.event);
	if (result.purchase.state === 'completed' && result.purchase.completedAt) {
		await checkBudgetsForPurchase(db, deps, {
			workspaceId: result.purchase.workspaceId,
			categoryId: result.purchase.categoryId,
			completedAt: result.purchase.completedAt
		});
	}
	return { purchaseId: result.purchase.id };
}

/**
 * Record a refund as a negative child row — spending history is never deleted.
 * Partial refunds leave the parent COMPLETED; once cumulative refunds cover the
 * final amount, the parent transitions to REFUNDED. Totals stay honest because
 * analytics sums both states: parent (+X) and children (−…) net out.
 */
export async function refundPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	amount: Money
): Promise<void> {
	const now = deps.clock.now();
	const result = await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		if (p.memberId !== scope.memberId) {
			throw new PurchaseStateError('Only the requester can record a refund');
		}
		if (p.state !== 'completed') {
			throw new PurchaseStateError('Only completed purchases can be refunded');
		}
		if (isSealed(p, now)) {
			throw new PurchaseStateError('Sealed purchases cannot be refunded until the seal opens');
		}
		if (!amount.isPositive) throw new PurchaseStateError('Refund amount must be positive');
		// Refunds mix minor units with the parent's remaining total below and
		// the child inherits the parent's currency, so a foreign denomination
		// must not slip in.
		if (amount.currency !== p.finalAmount!.currency) {
			throw new PurchaseStateError(
				`This purchase was made in ${p.finalAmount!.currency}; got ${amount.currency}`
			);
		}

		const [prior] = await tx
			.select({ refunded: sql<string>`coalesce(sum(${purchaseTable.finalAmountMinor}), 0)` })
			.from(purchaseTable)
			.where(eq(purchaseTable.parentPurchaseId, p.id));
		const remaining = p.finalAmount!.minor + BigInt(prior.refunded); // prior is negative
		if (amount.minor > remaining) {
			throw new PurchaseStateError(
				`Refund exceeds what is left (${Money.of(remaining, amount.currency).format()})`
			);
		}

		const child: Purchase = {
			...p,
			id: deps.ids.newId(),
			state: 'refunded',
			itemName: `Refund: ${p.itemName}`,
			note: null,
			requestedAmount: amount.negate(),
			approvedAmount: null,
			finalAmount: amount.negate(),
			sealedUntil: null,
			sealedFromMemberIds: [],
			requestedAt: null,
			decidedAt: null,
			completedAt: now,
			clearedAt: null,
			lastNudgedAt: null,
			nudgeCount: 0,
			recurringRuleId: null,
			parentPurchaseId: p.id,
			approverMemberIds: []
		};
		await insertPurchase(tx, deps, child, {
			fromState: null,
			toState: 'refunded',
			actorMemberId: scope.memberId,
			reason: 'refund recorded',
			amountSnapshot: amount.negate(),
			at: now
		});

		if (p.bucketId) {
			// Money going back *into* the bucket, so it's an adjustment, not a
			// withdrawal — a positive row typed 'withdrawal' read as "Taken from
			// Travel  +$40" on the ledger and counted the wrong way when a period's
			// bucket movement is replayed. See domain/bucket/flows.
			await tx.insert(bucketTransaction).values({
				id: deps.ids.newId(),
				bucketId: p.bucketId,
				amountMinor: amount.minor,
				currency: amount.currency,
				type: 'adjustment',
				note: `Refund: ${p.itemName}`,
				createdAt: now
			});
		}

		if (amount.minor === remaining) {
			const r = markRefunded(p, scope.memberId, now);
			await applyTransition(tx, deps.ids, r.purchase, r.event);
			return r;
		}
		await appendEvent(tx, deps.ids, p.id, {
			fromState: p.state,
			toState: p.state,
			actorMemberId: scope.memberId,
			reason: `partial refund`,
			amountSnapshot: amount.negate(),
			at: now
		});
		return { purchase: p, event: null };
	});
	if (result.event) {
		await announcePurchaseChange(db, deps.notifier, result.purchase, result.event);
	}
}

/**
 * How recent a purchase must be for its own author to remove it. The workspace
 * owner is exempt — this window only guards a member against quietly erasing
 * their own settled history from the shared ledger.
 */
export const RECENT_DELETE_HOURS = 72;

/**
 * Remove-a-mistake: a true hard delete, unlike cancel/refund which keep the row.
 * A member may remove their *own* recent entries; the workspace owner may remove
 * any. Mistakes happen to refunds too, so both a refund and a purchase that has
 * refunds against it can be removed — the latter takes its refunds with it, and
 * removing a refund un-refunds its parent when that leaves it fully paid again.
 *
 * Money any deleted row moved in or out of a bucket is put back with a
 * compensating adjustment rather than deleting the original transaction (linked
 * only by note) — the same pattern refundPurchase uses. `finalAmountMinor`
 * already carries the right sign (a spend is positive, a refund negative), so
 * crediting it back undoes whatever that row did. Child rows have no FK cascade,
 * so we clear them by hand.
 */
export async function deletePurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string
): Promise<void> {
	const now = deps.clock.now();
	const removedPurchase = await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();

		const [me] = await tx
			.select({ role: workspaceMember.role })
			.from(workspaceMember)
			.where(eq(workspaceMember.id, scope.memberId))
			.limit(1);
		const isOwner = me?.role === 'owner';
		const mine = p.memberId === scope.memberId;
		if (!mine && !isOwner) {
			throw new PurchaseStateError('You can only remove your own entries');
		}

		// The recency gate only binds a member removing their own entry.
		if (!isOwner) {
			const [row] = await tx
				.select({ createdAt: purchaseTable.createdAt })
				.from(purchaseTable)
				.where(eq(purchaseTable.id, p.id))
				.limit(1);
			const [ws] = await tx
				.select({ recentDeleteHours: workspace.recentDeleteHours })
				.from(workspace)
				.where(eq(workspace.id, scope.workspaceId))
				.limit(1);
			const deleteHours = ws?.recentDeleteHours ?? 72;
			const ageMs = now.getTime() - row.createdAt.getTime();
			if (deleteHours > 0 && ageMs > deleteHours * 3_600_000) {
				throw new PurchaseStateError('This entry is too old to remove. Ask a workspace owner');
			}
		}

		// Deleting a purchase takes any refunds recorded against it too.
		const children = await tx
			.select({
				id: purchaseTable.id,
				bucketId: purchaseTable.bucketId,
				finalAmountMinor: purchaseTable.finalAmountMinor,
				currency: purchaseTable.currency,
				itemName: purchaseTable.itemName
			})
			.from(purchaseTable)
			.where(eq(purchaseTable.parentPurchaseId, p.id));

		const removed = [
			{
				id: p.id,
				bucketId: p.bucketId,
				finalAmountMinor: p.finalAmount?.minor ?? null,
				currency: p.requestedAmount.currency,
				itemName: p.itemName
			},
			...children
		];

		// Put back what each removed row moved through a bucket.
		for (const r of removed) {
			if (r.bucketId && r.finalAmountMinor !== null && r.finalAmountMinor !== 0n) {
				await tx.insert(bucketTransaction).values({
					id: deps.ids.newId(),
					bucketId: r.bucketId,
					amountMinor: r.finalAmountMinor,
					currency: r.currency,
					type: 'adjustment',
					note: `Removed: ${r.itemName}`,
					createdAt: now
				});
			}
		}

		// Removing a refund can leave its parent no longer fully refunded.
		if (p.parentPurchaseId) {
			const [parent] = await tx
				.select({
					id: purchaseTable.id,
					state: purchaseTable.state,
					finalAmountMinor: purchaseTable.finalAmountMinor
				})
				.from(purchaseTable)
				.where(eq(purchaseTable.id, p.parentPurchaseId))
				.for('update')
				.limit(1);
			if (parent && parent.state === 'refunded') {
				const [rem] = await tx
					.select({
						sum: sql<string>`coalesce(sum(${purchaseTable.finalAmountMinor}), 0)`
					})
					.from(purchaseTable)
					.where(
						and(eq(purchaseTable.parentPurchaseId, parent.id), sql`${purchaseTable.id} <> ${p.id}`)
					);
				// parent (+X) plus the refunds still standing (each negative). Anything
				// left over means it's no longer fully paid back → back to completed.
				const leftover = (parent.finalAmountMinor ?? 0n) + BigInt(rem.sum);
				if (leftover > 0n) {
					await tx
						.update(purchaseTable)
						.set({ state: 'completed' })
						.where(eq(purchaseTable.id, parent.id));
					await appendEvent(tx, deps.ids, parent.id, {
						fromState: 'refunded',
						toState: 'completed',
						actorMemberId: scope.memberId,
						reason: 'refund removed',
						amountSnapshot: null,
						at: now
					});
				}
			}
		}

		const ids = removed.map((r) => r.id);
		await tx.delete(purchaseImage).where(inArray(purchaseImage.purchaseId, ids));
		await tx.delete(purchaseApprover).where(inArray(purchaseApprover.purchaseId, ids));
		await tx.delete(approvalEvent).where(inArray(approvalEvent.purchaseId, ids));
		// Children reference the parent, so they go first.
		if (children.length > 0) {
			await tx.delete(purchaseTable).where(
				inArray(
					purchaseTable.id,
					children.map((c) => c.id)
				)
			);
		}
		await tx.delete(purchaseTable).where(eq(purchaseTable.id, p.id));
		return p;
	});
	// Pages showing this purchase — a pending queue, an approver's badge — must
	// hear that it is gone: the publish is what makes them refetch. No push,
	// though: a deletion is bookkeeping, not news for someone's phone.
	await announcePurchaseChange(
		db,
		deps.notifier,
		removedPurchase,
		{
			fromState: removedPurchase.state,
			toState: removedPurchase.state,
			actorMemberId: scope.memberId,
			reason: 'deleted',
			amountSnapshot: null,
			at: now
		},
		{ push: false }
	);
}

/**
 * Change the merchant, requester-only. The merchant is a label — it plays no
 * part in approval policy — so unlike the full edit this is allowed in any
 * state, including completed and refunded. The change is audited either way.
 */
export async function setPurchaseMerchant(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	merchantName: string | null
) {
	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		if (p.memberId !== scope.memberId) {
			throw new PurchaseStateError('Only the requester can change the merchant');
		}
		const merchantId = merchantName
			? await findOrCreateMerchant(tx, deps, scope.workspaceId, merchantName)
			: null;
		if (merchantId === p.merchantId) return;
		await tx.update(purchaseTable).set({ merchantId }).where(eq(purchaseTable.id, p.id));
		await appendEvent(tx, deps.ids, p.id, {
			fromState: p.state,
			toState: p.state,
			actorMemberId: scope.memberId,
			reason: merchantId ? 'merchant updated' : 'merchant cleared',
			amountSnapshot: null,
			at: now
		});
	});
}

/**
 * Set or clear the place, requester-only.
 *
 * Like the merchant and unlike the amount, a place is annotation rather than
 * substance — no approval policy reads it — so it may be changed in any state,
 * including completed. It is audited either way: a pin is a claim about where
 * somebody was, and a claim that can be changed silently is worse than one that
 * can't be changed at all.
 *
 * Only the requester, and never an approver: the person who was there is the
 * only one in a position to say where that was.
 */
export async function setPurchasePlace(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	place: PurchasePlace | null
) {
	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		const [ws] = await tx
			.select({ locationEnabled: workspace.locationEnabled })
			.from(workspace)
			.where(eq(workspace.id, scope.workspaceId))
			.limit(1);
		if (!ws) throw new PurchaseNotFoundError();
		// Clearing stays available with the flag off, so turning places off never
		// strands a pin somebody can no longer reach.
		if (place && !ws.locationEnabled) {
			throw new PurchaseStateError('Places are turned off for this workspace');
		}

		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		if (p.memberId !== scope.memberId) {
			throw new PurchaseStateError('Only the requester can change the place');
		}
		if (samePlace(place, p.place)) return;

		await tx
			.update(purchaseTable)
			.set({ ...placeToColumns(place), updatedAt: now })
			.where(eq(purchaseTable.id, p.id));

		// Teach the vendor its default from an observed pin, on the same terms as
		// submitPurchase: only when it has none, never from an inherited one, and
		// never from a purchase that is hidden from somebody — a vendor pin is
		// workspace-global, so that would hand the concealed member the location
		// through the next unsealed purchase at that vendor.
		if (place && p.merchantId && isObservedPlace(place) && !isSealed(p, now)) {
			await tx
				.update(merchant)
				.set({
					latE3: place.latE3,
					lngE3: place.lngE3,
					placeLabel: place.label,
					locationSource: place.source,
					locationUpdatedAt: now
				})
				.where(and(eq(merchant.id, p.merchantId), isNull(merchant.latE3)));
		}

		await appendEvent(tx, deps.ids, p.id, {
			fromState: p.state,
			toState: p.state,
			actorMemberId: scope.memberId,
			reason: place ? 'place updated' : 'place cleared',
			amountSnapshot: null,
			at: now
		});
	});
}

/**
 * Recategorize, requester-only. Before completion the category is substance —
 * per-category policy may depend on it — so the change goes through the state
 * machine and an approved purchase goes back for approval. Once the amount is
 * settled (completed/refunded) the category is pure annotation, like the note:
 * a direct update, audited, never a re-approval.
 */
export async function recategorizePurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	categoryId: string | null
) {
	const now = deps.clock.now();
	const result = await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		if (p.memberId !== scope.memberId) {
			throw new PurchaseStateError('Only the requester can recategorize a purchase');
		}
		if (p.categoryId === categoryId) return null;
		if (p.state === 'draft' || p.state === 'pending_approval' || p.state === 'approved') {
			const r = edit(p, scope.memberId, { categoryId }, now);
			await applyTransition(tx, deps.ids, r.purchase, r.event);
			return r;
		}
		if (p.state !== 'completed' && p.state !== 'refunded') {
			throw new PurchaseStateError('This purchase can no longer be recategorized');
		}
		await tx.update(purchaseTable).set({ categoryId }).where(eq(purchaseTable.id, p.id));
		await appendEvent(tx, deps.ids, p.id, {
			fromState: p.state,
			toState: p.state,
			actorMemberId: scope.memberId,
			reason: categoryId ? 'recategorized' : 'category cleared',
			amountSnapshot: null,
			at: now
		});
		return null;
	});
	if (result) await announcePurchaseChange(db, deps.notifier, result.purchase, result.event);
}

/**
 * Edit just the note, allowed in any state the purchase is yours — including
 * completed and refunded, where the full edit is closed because the amount is
 * settled. The note is annotation, not ledger data, so changing it never moves
 * money; the change is still audited so the history shows a note was revised.
 */
export async function editPurchaseNote(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	note: string | null
): Promise<void> {
	const now = deps.clock.now();
	await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		if (p.memberId !== scope.memberId) {
			throw new PurchaseStateError('Only the requester can edit the note');
		}
		if ((p.note ?? '') === (note ?? '')) return;
		await tx.update(purchaseTable).set({ note }).where(eq(purchaseTable.id, p.id));
		await appendEvent(tx, deps.ids, p.id, {
			fromState: p.state,
			toState: p.state,
			actorMemberId: scope.memberId,
			reason: note ? 'note edited' : 'note cleared',
			amountSnapshot: null,
			at: now
		});
	});
}

/** Early unseal by the requester — the only person who may open it before time. */
export async function unsealPurchase(db: Db, deps: Deps, scope: Scope, purchaseId: string) {
	const now = deps.clock.now();
	await db
		.transaction(async (tx) => {
			const p = await loadPurchase(
				tx,
				{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
				purchaseId,
				{ forUpdate: true, now }
			);
			if (!p) throw new PurchaseNotFoundError();
			if (p.memberId !== scope.memberId) {
				throw new PurchaseStateError('Only the person who sealed a purchase can unseal it early');
			}
			if (!isSealed(p, now)) throw new PurchaseStateError('This purchase is not sealed');
			const formerlyConcealed = p.sealedFromMemberIds;
			const unsealed: Purchase = { ...p, sealedFromMemberIds: [] };
			const event = unsealEvent(unsealed, scope.memberId, formerlyConcealed, now);
			await applyTransition(tx, deps.ids, unsealed, event);
			return { purchase: unsealed, event };
		})
		.then((r) => announcePurchaseChange(db, deps.notifier, r.purchase, r.event));
}

export function unsealEvent(
	p: Purchase,
	actorMemberId: string | null,
	formerlyConcealed: string[],
	now: Date
) {
	return {
		fromState: p.state,
		toState: p.state,
		actorMemberId,
		reason: 'seal opened',
		amountSnapshot: null,
		at: now,
		sealOpenedRecipients: formerlyConcealed
	};
}

async function withPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	fn: (p: Purchase, thresholdPct: number) => ReturnType<typeof approve>,
	after?: (tx: Db, deps: Deps, purchase: Purchase) => Promise<void>
): Promise<void> {
	const now = deps.clock.now();
	const result = await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();
		const [ws] = await tx
			.select({ pct: workspace.reapprovalThresholdPct })
			.from(workspace)
			.where(eq(workspace.id, scope.workspaceId))
			.limit(1);
		const r = fn(p, ws.pct);
		await applyTransition(tx, deps.ids, r.purchase, r.event);
		if (r.purchase.state === 'completed' && r.purchase.bucketId && after) {
			await after(tx, deps, r.purchase);
		}
		return r;
	});
	await announcePurchaseChange(db, deps.notifier, result.purchase, result.event);
	if (result.purchase.state === 'completed' && result.purchase.completedAt) {
		await checkBudgetsForPurchase(db, deps, {
			workspaceId: result.purchase.workspaceId,
			categoryId: result.purchase.categoryId,
			completedAt: result.purchase.completedAt
		});
	}
}

export async function approvePurchase(db: Db, deps: Deps, scope: Scope, purchaseId: string) {
	/*
	 * Passes withdrawFromBucket because approving can *complete* a purchase, not
	 * just approve it — a logged purchase or an overage arrives already carrying
	 * its final amount. Without it, approving a bucket-charged log moved money in
	 * the ledger and left the bucket balance untouched, so the bucket silently
	 * overstated what was left in it.
	 */
	await withPurchase(
		db,
		deps,
		scope,
		purchaseId,
		(p) => approve(p, scope.memberId, deps.clock.now()),
		withdrawFromBucket
	);
}

export async function denyPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	reason: string | null
) {
	await withPurchase(db, deps, scope, purchaseId, (p) =>
		deny(p, scope.memberId, reason, deps.clock.now())
	);
}

/**
 * Ask again after a denial.
 *
 * Approvers are resolved fresh from the requester's current policy, the same
 * way `submitPurchase` does, rather than reusing the snapshot on the row: the
 * people who could decide months ago may have left, and an appeal that routed
 * to them would sit unanswerable. The seal is honoured for the same reason it
 * is at submit — an appeal must not reveal a hidden purchase to someone it was
 * hidden from.
 */
export async function appealPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	note: string
) {
	const now = deps.clock.now();
	const result = await db.transaction(async (tx) => {
		const p = await loadPurchase(
			tx,
			{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
			purchaseId,
			{ forUpdate: true, now }
		);
		if (!p) throw new PurchaseNotFoundError();

		const members = await tx
			.select({ id: workspaceMember.id, policy: workspaceMember.approvalPolicy })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, scope.workspaceId),
					eq(workspaceMember.status, 'active')
				)
			);
		const me = members.find((m) => m.id === scope.memberId);
		if (!me) throw new PurchaseNotFoundError();

		const approvers = resolveApprovers(
			me.policy as ApprovalPolicy,
			members.map((m) => m.id)
		);
		const eligible = isSealed(p, now)
			? approvers.filter((id) => !p.sealedFromMemberIds.includes(id))
			: approvers;
		if (eligible.length === 0) {
			throw new PurchaseStateError('Nobody who can decide this is able to see it');
		}

		const r = appeal(p, scope.memberId, note, eligible, now);
		await applyTransition(tx, deps.ids, r.purchase, r.event);
		return r;
	});
	await announcePurchaseChange(db, deps.notifier, result.purchase, result.event);
}

/** Overturn a denial, as an approver, with a note that goes on the record. */
export async function overrideDenialForPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	note: string
) {
	await withPurchase(
		db,
		deps,
		scope,
		purchaseId,
		(p) => overrideDenial(p, scope.memberId, note, deps.clock.now()),
		withdrawFromBucket
	);
}

export async function cancelPurchase(db: Db, deps: Deps, scope: Scope, purchaseId: string) {
	await withPurchase(db, deps, scope, purchaseId, (p) =>
		cancel(p, scope.memberId, deps.clock.now())
	);
}

export async function completePurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	final: { amount: Money; at: Date }
) {
	await withPurchase(
		db,
		deps,
		scope,
		purchaseId,
		(p, pct) => complete(p, scope.memberId, final, pct, deps.clock.now()),
		withdrawFromBucket
	);
}

export async function editPurchase(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	changes: PurchaseEdit
) {
	await withPurchase(db, deps, scope, purchaseId, (p) =>
		edit(p, scope.memberId, changes, deps.clock.now())
	);
}

export async function withdrawFromBucket(tx: Db, deps: Deps, p: Purchase): Promise<void> {
	if (!p.bucketId || !p.finalAmount) return;
	const amountMinor = -p.finalAmount.minor;
	if (amountMinor >= 0n) return;
	await tx.insert(bucketTransaction).values({
		id: deps.ids.newId(),
		bucketId: p.bucketId,
		amountMinor,
		currency: p.finalAmount.currency,
		type: 'withdrawal',
		note: p.itemName,
		createdAt: p.completedAt ?? deps.clock.now()
	});
}
