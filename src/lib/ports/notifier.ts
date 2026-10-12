/**
 * Outbound notifications. Callers are responsible for seal safety: never pass
 * a concealed-from member as a recipient. Delivery is best-effort and must
 * never fail the mutation that triggered it.
 */

export type NotificationEventType =
	| 'approval_requested'
	| 'approval_decided'
	| 'stale_nudge'
	| 'seal_opened'
	| 'recurring_due'
	| 'budget_exceeded'
	| 'safe_to_spend'
	| 'periodic_summary'
	| 'bank_review';

export interface NotificationMessage {
	title: string;
	body: string;
	/** App-absolute deep link, e.g. /w/home/purchases/abc. */
	path: string;
	/** Collapse key: newer notifications with the same tag replace older ones. */
	tag?: string;
}

export interface Recipient {
	userId: string;
	memberId: string;
}

export interface Notifier {
	notify(
		recipients: Recipient[],
		eventType: NotificationEventType,
		msg: NotificationMessage
	): Promise<void>;
}

/** No-op for tests and for boot paths where notifications are not configured. */
export const nullNotifier: Notifier = {
	notify: async () => {}
};
