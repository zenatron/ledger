import { describe, expect, it } from 'vitest';
import { Money } from '../money/money';
import {
	appeal,
	approve,
	autoApprove,
	cancel,
	complete,
	deny,
	edit,
	hold,
	markRefunded,
	needsReapproval,
	overrideDenial,
	requestApproval,
	wake,
	PurchaseStateError,
	type Purchase,
	type PurchaseState
} from './purchase';

const NOW = new Date('2026-07-01T12:00:00Z');
const usd = (n: number) => Money.of(n, 'USD');

function draft(overrides: Partial<Purchase> = {}): Purchase {
	return {
		id: 'p1',
		workspaceId: 'w1',
		memberId: 'm-requester',
		state: 'draft',
		accountId: null,
		itemName: 'Headphones',
		note: null,
		categoryId: 'cat-electronics',
		requestedAmount: usd(18000),
		approvedAmount: null,
		finalAmount: null,
		sealedUntil: null,
		sealedFromMemberIds: [],
		requestedAt: null,
		decidedAt: null,
		completedAt: null,
		clearedAt: null,
		lastNudgedAt: null,
		nudgeCount: 0,
		recurringRuleId: null,
		parentPurchaseId: null,
		approverMemberIds: [],
		bucketId: null,
		merchantId: null,
		heldUntil: null,
		heldBy: null,
		place: null,
		...overrides
	};
}

const pending = (o: Partial<Purchase> = {}) =>
	draft({ state: 'pending_approval', approverMemberIds: ['m-approver'], requestedAt: NOW, ...o });
const approved = (o: Partial<Purchase> = {}) =>
	draft({
		state: 'approved',
		approverMemberIds: ['m-approver'],
		approvedAmount: usd(18000),
		decidedAt: NOW,
		...o
	});
const completed = (o: Partial<Purchase> = {}) =>
	approved({ state: 'completed', finalAmount: usd(17500), completedAt: NOW, ...o });

describe('requestApproval', () => {
	it('moves draft to pending with snapshot and timestamps', () => {
		const { purchase, event } = requestApproval(draft(), ['m-approver', 'm-other'], NOW);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.approverMemberIds).toEqual(['m-approver', 'm-other']);
		expect(purchase.requestedAt).toBe(NOW);
		expect(event).toMatchObject({ fromState: 'draft', toState: 'pending_approval' });
		expect(event.amountSnapshot?.minor).toBe(18000n);
	});

	it('rejects empty approver set', () => {
		expect(() => requestApproval(draft(), [], NOW)).toThrow(PurchaseStateError);
	});

	it('rejects from every non-draft state', () => {
		for (const p of [pending(), approved(), completed(), draft({ state: 'denied' })]) {
			expect(() => requestApproval(p, ['m-approver'], NOW)).toThrow(PurchaseStateError);
		}
	});
});

describe('autoApprove (exempt path)', () => {
	it('approves a draft without an actor', () => {
		const { purchase, event } = autoApprove(draft(), NOW, 'approval not required');
		expect(purchase.state).toBe('approved');
		expect(purchase.approvedAmount?.minor).toBe(18000n);
		expect(event.actorMemberId).toBeNull();
		expect(event.reason).toBe('approval not required');
	});
});

describe('approve', () => {
	it('approves at the requested amount', () => {
		const { purchase, event } = approve(pending(), 'm-approver', NOW);
		expect(purchase.state).toBe('approved');
		expect(purchase.approvedAmount?.minor).toBe(18000n);
		expect(purchase.decidedAt).toBe(NOW);
		expect(event.toState).toBe('approved');
	});

	it('rejects a non-approver, including the requester', () => {
		expect(() => approve(pending(), 'm-requester', NOW)).toThrow(PurchaseStateError);
		expect(() => approve(pending(), 'm-stranger', NOW)).toThrow(PurchaseStateError);
	});

	it('allows self-approval when the requester is in the approver set', () => {
		const p = pending({ approverMemberIds: ['m-requester'] });
		expect(approve(p, 'm-requester', NOW).purchase.state).toBe('approved');
	});

	it('does not call a first-time approval an overage', () => {
		// A logged purchase ("already bought") carries its final amount from the
		// start, so it reaches approval with finalAmount set but having never been
		// approved. Approving it still completes — the money is spent — but there
		// was no overage, and saying so confused people approving ordinary logs.
		const loggedAwaitingApproval = pending({
			finalAmount: usd(18000),
			approvedAmount: null,
			completedAt: NOW
		});
		const { purchase, event } = approve(loggedAwaitingApproval, 'm-approver', NOW);
		expect(purchase.state).toBe('completed');
		expect(event.reason).toBeNull();
	});

	it('completes directly when re-approving an overage', () => {
		const p = pending({ finalAmount: usd(25000), approvedAmount: usd(18000), completedAt: NOW });
		const { purchase, event } = approve(p, 'm-approver', NOW);
		expect(purchase.state).toBe('completed');
		expect(purchase.approvedAmount?.minor).toBe(25000n);
		expect(event.reason).toBe('overage approved');
	});

	it('rejects from non-pending states', () => {
		for (const p of [draft(), approved(), completed()]) {
			expect(() => approve(p, 'm-approver', NOW)).toThrow(PurchaseStateError);
		}
	});
});

describe('deny', () => {
	it('denies with a reason', () => {
		const { purchase, event } = deny(pending(), 'm-approver', 'too pricey', NOW);
		expect(purchase.state).toBe('denied');
		expect(event.reason).toBe('too pricey');
	});

	it('rejects non-approvers and non-pending states', () => {
		expect(() => deny(pending(), 'm-stranger', null, NOW)).toThrow(PurchaseStateError);
		expect(() => deny(approved(), 'm-approver', null, NOW)).toThrow(PurchaseStateError);
	});
});

const denied = (o: Partial<Purchase> = {}) =>
	draft({
		state: 'denied',
		approverMemberIds: ['m-approver'],
		requestedAt: NOW,
		decidedAt: NOW,
		...o
	});

describe('appeal', () => {
	it('sends a denial back for a decision, with the note on the event', () => {
		const { purchase, event } = appeal(
			denied(),
			'm-requester',
			"it's on sale",
			['m-approver'],
			NOW
		);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.approverMemberIds).toEqual(['m-approver']);
		// Cleared, or the row would claim it had been decided while it waits.
		expect(purchase.decidedAt).toBeNull();
		expect(event.reason).toBe("appealed: it's on sale");
	});

	it('routes to whoever can decide now, not to whoever was asked before', () => {
		const p = denied({ approverMemberIds: ['m-gone'] });
		expect(appeal(p, 'm-requester', 'changed', ['m-new'], NOW).purchase.approverMemberIds).toEqual([
			'm-new'
		]);
	});

	it("is the requester's alone, and only from denied", () => {
		expect(() => appeal(denied(), 'm-approver', 'x', ['m-approver'], NOW)).toThrow(
			PurchaseStateError
		);
		expect(() => appeal(pending(), 'm-requester', 'x', ['m-approver'], NOW)).toThrow(
			PurchaseStateError
		);
	});

	it('needs something new to say, and someone to say it to', () => {
		expect(() => appeal(denied(), 'm-requester', '   ', ['m-approver'], NOW)).toThrow(
			PurchaseStateError
		);
		expect(() => appeal(denied(), 'm-requester', 'x', [], NOW)).toThrow(PurchaseStateError);
	});
});

describe('overrideDenial', () => {
	it('approves a denied request and says so in the log', () => {
		const { purchase, event } = overrideDenial(denied(), 'm-approver', 'talked it over', NOW);
		expect(purchase.state).toBe('approved');
		expect(purchase.approvedAmount).toEqual(usd(18000));
		expect(event.reason).toBe('denial overturned: talked it over');
	});

	it('completes instead when the money already went out', () => {
		// A logged purchase carries its final amount, so allowing it is not a
		// promise to spend: it is a record that the spending stands.
		const p = denied({ finalAmount: usd(18000) });
		const { purchase } = overrideDenial(p, 'm-approver', 'fine', NOW);
		expect(purchase.state).toBe('completed');
		expect(purchase.completedAt).toEqual(NOW);
	});

	it('is limited to the people who were asked', () => {
		expect(() => overrideDenial(denied(), 'm-stranger', 'why not', NOW)).toThrow(
			PurchaseStateError
		);
		expect(() => overrideDenial(denied(), 'm-requester', 'let me', NOW)).toThrow(
			PurchaseStateError
		);
	});

	it('will not overturn silently', () => {
		expect(() => overrideDenial(denied(), 'm-approver', '  ', NOW)).toThrow(PurchaseStateError);
	});

	it('only applies to a denial', () => {
		expect(() => overrideDenial(pending(), 'm-approver', 'x', NOW)).toThrow(PurchaseStateError);
	});
});

describe('cancel', () => {
	it('cancels draft, pending, and approved — requester only', () => {
		for (const p of [draft(), pending(), approved()]) {
			expect(cancel(p, 'm-requester', NOW).purchase.state).toBe('cancelled');
			expect(() => cancel(p, 'm-approver', NOW)).toThrow(PurchaseStateError);
		}
	});

	it('never cancels settled states', () => {
		for (const state of ['denied', 'cancelled', 'completed', 'refunded'] as PurchaseState[]) {
			expect(() => cancel(draft({ state }), 'm-requester', NOW)).toThrow(PurchaseStateError);
		}
	});
});

describe('needsReapproval', () => {
	it('is false at or under the threshold, true above it', () => {
		// approved $180.00, threshold 10% → limit $198.00
		expect(needsReapproval(usd(18000), usd(19800), 10)).toBe(false); // exactly 10% over
		expect(needsReapproval(usd(18000), usd(19801), 10)).toBe(true); // one cent past
		expect(needsReapproval(usd(18000), usd(18000), 10)).toBe(false);
		expect(needsReapproval(usd(18000), usd(1), 10)).toBe(false); // underspend never
	});

	it('handles 0% threshold (any overage re-approves)', () => {
		expect(needsReapproval(usd(100), usd(101), 0)).toBe(true);
		expect(needsReapproval(usd(100), usd(100), 0)).toBe(false);
	});
});

describe('complete', () => {
	const FINAL_AT = new Date('2026-07-03T09:00:00Z');

	it('completes an approved purchase within threshold', () => {
		const { purchase, event } = complete(
			approved(),
			'm-requester',
			{ amount: usd(17500), at: FINAL_AT },
			10,
			NOW
		);
		expect(purchase.state).toBe('completed');
		expect(purchase.finalAmount?.minor).toBe(17500n);
		expect(purchase.completedAt).toBe(FINAL_AT);
		expect(event.toState).toBe('completed');
	});

	it('completes a draft directly (exempt log path)', () => {
		const { purchase } = complete(
			draft(),
			'm-requester',
			{ amount: usd(950), at: FINAL_AT },
			10,
			NOW
		);
		expect(purchase.state).toBe('completed');
	});

	it('auto-approved purchases (no approver snapshot) complete at any price', () => {
		const p = approved({ approverMemberIds: [] });
		const { purchase } = complete(p, 'm-requester', { amount: usd(99999), at: FINAL_AT }, 10, NOW);
		expect(purchase.state).toBe('completed');
	});

	it('returns to pending on overage past the threshold, resetting nudges', () => {
		const p = approved({ lastNudgedAt: NOW, nudgeCount: 3 });
		const { purchase, event } = complete(
			p,
			'm-requester',
			{ amount: usd(50000), at: FINAL_AT },
			10,
			NOW
		);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.finalAmount?.minor).toBe(50000n);
		expect(purchase.approvedAmount?.minor).toBe(18000n); // original approval kept for the diff
		expect(purchase.nudgeCount).toBe(0);
		expect(purchase.lastNudgedAt).toBeNull();
		expect(event.reason).toBe('overage');
	});

	it('rejects wrong actor, non-positive amounts, wrong states', () => {
		expect(() =>
			complete(approved(), 'm-approver', { amount: usd(1), at: FINAL_AT }, 10, NOW)
		).toThrow();
		expect(() =>
			complete(approved(), 'm-requester', { amount: usd(0), at: FINAL_AT }, 10, NOW)
		).toThrow();
		expect(() =>
			complete(approved(), 'm-requester', { amount: usd(-5), at: FINAL_AT }, 10, NOW)
		).toThrow();
		for (const p of [pending(), completed(), draft({ state: 'denied' })]) {
			expect(() => complete(p, 'm-requester', { amount: usd(1), at: FINAL_AT }, 10, NOW)).toThrow();
		}
	});
});

describe('edit', () => {
	it('invalidates approval on substantive change', () => {
		const { purchase, event } = edit(
			approved(),
			'm-requester',
			{ requestedAmount: usd(20000) },
			NOW
		);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.approvedAmount).toBeNull();
		expect(purchase.requestedAmount.minor).toBe(20000n);
		expect(event.reason).toBe('edited after approval');
	});

	it('item and category changes also invalidate; note-only does not', () => {
		expect(edit(approved(), 'm-requester', { itemName: 'Speakers' }, NOW).purchase.state).toBe(
			'pending_approval'
		);
		expect(edit(approved(), 'm-requester', { categoryId: 'cat-other' }, NOW).purchase.state).toBe(
			'pending_approval'
		);
		const noteOnly = edit(approved(), 'm-requester', { note: 'for the office' }, NOW);
		expect(noteOnly.purchase.state).toBe('approved');
		expect(noteOnly.purchase.approvedAmount?.minor).toBe(18000n);
	});

	it('no-op "changes" equal to current values do not invalidate', () => {
		const same = edit(
			approved(),
			'm-requester',
			{ itemName: 'Headphones', requestedAmount: usd(18000) },
			NOW
		);
		expect(same.purchase.state).toBe('approved');
	});

	it('an auto-approved purchase edits in place instead of stranding itself', () => {
		// "Ask first" under a policy that needs no approval lands here: approved
		// with zero approvers. Invalidating would send it to pending_approval with
		// nobody able to decide it, so the amount could never be corrected.
		const autoApproved = approved({ approverMemberIds: [] });
		const { purchase, event } = edit(
			autoApproved,
			'm-requester',
			{ requestedAmount: usd(22000) },
			NOW
		);
		expect(purchase.state).toBe('approved');
		expect(purchase.requestedAmount.minor).toBe(22000n);
		// The approved amount tracks the edit; leaving it stale would make the
		// purchase look like a 4,000 overage the moment it completes.
		expect(purchase.approvedAmount?.minor).toBe(22000n);
		expect(event.reason).toBe('edited');
	});

	it('still invalidates when there is someone who can re-approve', () => {
		const { purchase } = edit(approved(), 'm-requester', { requestedAmount: usd(22000) }, NOW);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.approvedAmount).toBeNull();
	});

	it('pending and draft edits keep their state', () => {
		expect(edit(pending(), 'm-requester', { requestedAmount: usd(1) }, NOW).purchase.state).toBe(
			'pending_approval'
		);
		expect(edit(draft(), 'm-requester', { itemName: 'X' }, NOW).purchase.state).toBe('draft');
	});

	it('rejects edits by others and on settled states', () => {
		expect(() => edit(approved(), 'm-approver', { note: 'hi' }, NOW)).toThrow(PurchaseStateError);
		for (const p of [completed(), draft({ state: 'denied' }), draft({ state: 'cancelled' })]) {
			expect(() => edit(p, 'm-requester', { note: 'hi' }, NOW)).toThrow(PurchaseStateError);
		}
	});
});

describe('markRefunded', () => {
	it('only completed purchases can be refunded', () => {
		expect(markRefunded(completed(), 'm-requester', NOW).purchase.state).toBe('refunded');
		for (const p of [draft(), pending(), approved(), draft({ state: 'cancelled' })]) {
			expect(() => markRefunded(p, 'm-requester', NOW)).toThrow(PurchaseStateError);
		}
	});
});

describe('place', () => {
	const SF = { latE3: 37775, lngE3: -122419, label: 'Ferry Building', source: 'device' as const };

	it('survives every transition untouched', () => {
		// A place is annotation carried alongside the state machine, never through
		// it. If a transition ever started rebuilding the aggregate field by field
		// instead of spreading it, the pin would silently vanish on approval — and
		// nothing else in the app would notice until a map went empty.
		const p = draft({ place: SF });
		expect(requestApproval(p, ['m-approver'], NOW).purchase.place).toEqual(SF);
		expect(autoApprove(p, NOW, 'approval not required').purchase.place).toEqual(SF);
		expect(approve(pending({ place: SF }), 'm-approver', NOW).purchase.place).toEqual(SF);
		expect(deny(pending({ place: SF }), 'm-approver', null, NOW).purchase.place).toEqual(SF);
		expect(cancel(pending({ place: SF }), 'm-requester', NOW).purchase.place).toEqual(SF);
		expect(
			complete(approved({ place: SF }), 'm-requester', { amount: usd(18000), at: NOW }, 10, NOW)
				.purchase.place
		).toEqual(SF);
		expect(markRefunded(completed({ place: SF }), 'm-requester', NOW).purchase.place).toEqual(SF);
	});

	it('is not something an edit can change', () => {
		// The edit surface is itemName/amount/category/note. A place moves only
		// through setPurchasePlace, which audits it on its own.
		const edited = edit(draft({ place: SF }), 'm-requester', { itemName: 'Speakers' }, NOW);
		expect(edited.purchase.place).toEqual(SF);
	});

	it('does not make a purchase without one invalid', () => {
		expect(draft().place).toBeNull();
		expect(requestApproval(draft(), ['m-approver'], NOW).purchase.place).toBeNull();
	});
});

describe('hold / wake', () => {
	const LATER = new Date('2026-07-05T12:00:00Z');

	it('wakes a held-approved purchase back to approved, not pending', () => {
		// The approvers snapshot stays on an approved purchase, so presence of
		// approvers is not evidence that a decision is outstanding.
		const slept = hold(approved(), 'm-approver', LATER, NOW).purchase;
		const { purchase, event } = wake(slept, 'm-approver', NOW);
		expect(purchase.state).toBe('approved');
		expect(purchase.approvedAmount!.minor).toBe(18000n);
		expect(purchase.decidedAt).toBe(NOW);
		expect(event.toState).toBe('approved');
	});

	it('wakes a held request back to pending with the clock restarted', () => {
		const slept = hold(pending(), 'm-requester', LATER, NOW).purchase;
		const later = new Date('2026-07-02T12:00:00Z');
		const { purchase, event } = wake(slept, 'm-requester', later);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.requestedAt).toBe(later);
		expect(event.toState).toBe('pending_approval');
	});

	it('wakes an overage bounce-back to pending, still mid-re-approval', () => {
		// complete() parked a final amount and sent it back for another look;
		// decidedAt survives from the first round, but a decision is outstanding.
		const bounced = pending({ decidedAt: NOW, finalAmount: usd(22000) });
		const slept = hold(bounced, 'm-requester', LATER, NOW).purchase;
		const { purchase } = wake(slept, 'm-requester', NOW);
		expect(purchase.state).toBe('pending_approval');
		expect(purchase.finalAmount!.minor).toBe(22000n);
	});

	it('refuses to sleep on a completed purchase', () => {
		expect(() => hold(completed(), 'm-requester', LATER, NOW)).toThrow(PurchaseStateError);
	});
});
