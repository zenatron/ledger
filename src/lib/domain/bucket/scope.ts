/**
 * Who may charge a purchase to a bucket.
 *
 * Bucket ownership used to be enforced on one side only. `loadOwnBucket` gates
 * every mutation, so nobody could rename or withdraw from a bucket that wasn't
 * theirs, while the charge path checked only that the bucket was in the
 * workspace and active. Any active member could spend out of anyone's bucket,
 * and a member kept to a cap could clear it by charging someone else's.
 *
 * Two settings close that, from opposite ends. A bucket names who may charge it
 * (`chargeMemberIds`), and a member can be held to the buckets they own
 * (`own_buckets_only`). Either one refusing is a refusal.
 *
 * Pure, so both the submit path and the recurring-rule path decide it the same
 * way, and both are testable without a database.
 */

export interface ChargeableBucket {
	/** The member the bucket belongs to. */
	memberId: string;
	/**
	 * Who else may charge it. Null means anyone in the workspace, which is what
	 * every bucket was before this existed. A list names exactly who; empty is
	 * therefore "only me". The owner is always allowed and never appears here,
	 * so the two can't contradict each other.
	 */
	chargeMemberIds: string[] | null;
}

export interface ChargeScope {
	/** The member doing the charging. */
	memberId: string;
	/** They may only charge buckets they own. */
	ownBucketsOnly: boolean;
}

/** Why a charge was refused. The two are worth telling apart. */
export type ChargeRefusal = 'not-listed' | 'restricted';

/**
 * Null means the charge is allowed. Otherwise, which rule turned it down —
 * one is about the bucket and the other is about the person, and the fix
 * differs, so the caller can say something true either way.
 */
export function refuseBucketCharge(
	bkt: ChargeableBucket,
	scope: ChargeScope
): ChargeRefusal | null {
	if (bkt.memberId === scope.memberId) return null;
	if (bkt.chargeMemberIds !== null && !bkt.chargeMemberIds.includes(scope.memberId)) {
		return 'not-listed';
	}
	if (scope.ownBucketsOnly) return 'restricted';
	return null;
}

/** The message for a refusal, shared by every charge path. */
export function chargeRefusalMessage(refusal: ChargeRefusal): string {
	return refusal === 'not-listed'
		? 'That bucket is limited to the people its owner picked'
		: 'You can only charge to your own buckets';
}

/**
 * How a bucket's charge scope reads in a list, given who is looking.
 *
 * Null is the quiet case and gets no label at all: "anyone can charge this" is
 * true of almost every bucket, so saying it would be noise on all of them and
 * would stop the restricted ones standing out.
 */
export function describeChargeScope(
	bkt: ChargeableBucket,
	viewerMemberId: string,
	nameOf: (memberId: string) => string
): string | null {
	if (bkt.chargeMemberIds === null) return null;
	const mine = bkt.memberId === viewerMemberId;
	if (bkt.chargeMemberIds.length === 0) return mine ? 'Only me' : `${nameOf(bkt.memberId)} only`;
	if (mine) {
		const others = bkt.chargeMemberIds.filter((id) => id !== viewerMemberId);
		return others.length === 1 ? `Me and ${nameOf(others[0])}` : `Me and ${others.length} others`;
	}
	const all = [bkt.memberId, ...bkt.chargeMemberIds];
	return all.length === 2
		? `${nameOf(all[0])} and ${nameOf(all[1])}`
		: `${all.length} people can charge this`;
}

/**
 * What the holder of an allowance may not change about it themselves.
 *
 * The pot belongs to the member it is for, so every "your own bucket" path
 * reached it. But its amount, its schedule and who can spend it are the terms
 * an owner set, and the allowance policy lets through, unasked, anything the
 * pot can cover. A holder who could raise the amount, or add money that was
 * never set aside, could write their own cap. Those changes go through an
 * owner's "Change allowance"; naming it, colouring it, setting a goal and
 * taking money out stay the holder's.
 */
export interface AllowanceChange {
	amountMinor?: bigint;
	/** A new accrual rule was asked for. */
	reschedules?: boolean;
	/** A new charge scope was asked for. */
	chargeMemberIds?: string[] | null;
	/** Money moved into the pot by hand. */
	depositMinor?: bigint;
}

export const ALLOWANCE_TERMS_MESSAGE =
	'An owner sets the allowance amount, schedule and who can spend it. Ask them to change it.';
export const ALLOWANCE_DEPOSIT_MESSAGE = 'Only an owner can add money to an allowance.';

/** Null when the change is the holder's to make; otherwise why it isn't. */
export function refuseAllowanceChange(
	bkt: { isAllowance: boolean; amountMinor: bigint; chargeMemberIds: string[] | null },
	change: AllowanceChange
): string | null {
	if (!bkt.isAllowance) return null;
	if (change.depositMinor !== undefined && change.depositMinor > 0n) {
		return ALLOWANCE_DEPOSIT_MESSAGE;
	}
	if (change.amountMinor !== undefined && change.amountMinor !== bkt.amountMinor) {
		return ALLOWANCE_TERMS_MESSAGE;
	}
	if (change.reschedules) return ALLOWANCE_TERMS_MESSAGE;
	if (change.chargeMemberIds !== undefined) {
		const same =
			change.chargeMemberIds !== null &&
			bkt.chargeMemberIds !== null &&
			change.chargeMemberIds.length === bkt.chargeMemberIds.length &&
			change.chargeMemberIds.every((id) => bkt.chargeMemberIds!.includes(id));
		if (!same) return ALLOWANCE_TERMS_MESSAGE;
	}
	return null;
}
