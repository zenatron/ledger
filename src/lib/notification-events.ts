/** Notification event catalogue shown on the settings page. */
export const EVENT_TYPES = [
	{ id: 'approval_requested', label: 'Approvals to decide' },
	{ id: 'approval_decided', label: 'Decisions on my requests' },
	{ id: 'stale_nudge', label: 'Waiting-request reminders' },
	{ id: 'seal_opened', label: 'Gifts being revealed' },
	{ id: 'recurring_due', label: 'Recurring charges recorded' },
	{ id: 'budget_exceeded', label: 'Budget met or exceeded' },
	{ id: 'safe_to_spend', label: 'Safe-to-Spend alerts' },
	{ id: 'bank_review', label: 'Bank transactions to review' }
] as const;

export const CHANNELS = [
	{ id: 'webpush', label: 'Push' },
	{ id: 'ntfy', label: 'ntfy' }
] as const;
