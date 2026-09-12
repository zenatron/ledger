import type { Db } from '$lib/db/types';
import type {
	NotificationEventType,
	NotificationMessage,
	Notifier,
	Recipient
} from '$lib/ports/notifier';
import type { Clock } from '$lib/ports/clock';
import {
	listDisabledPrefs,
	listNtfyTargets,
	listPushSubscriptions,
	recordPushFailure
} from '$lib/repo/notifications';
import { sendNtfy, type NtfyToken } from './ntfy';
import { sendWebPush, type WebPushConfig } from './webpush';

export interface CompositeNotifierConfig {
	origin: string;
	webPush: WebPushConfig | null;
	/** Scoped to its own origin inside sendNtfy — never sent to a user-chosen host. */
	ntfyToken?: NtfyToken;
}

/**
 * Fans a message out to every enabled channel of every recipient. Preferences
 * are per workspace-member (absence = enabled); targets are per user. All
 * failures are logged and swallowed — a missed notification must never fail
 * or roll back the purchase mutation that caused it.
 */
export function createCompositeNotifier(
	db: Db,
	clock: Clock,
	config: CompositeNotifierConfig
): Notifier {
	return {
		async notify(
			recipients: Recipient[],
			eventType: NotificationEventType,
			msg: NotificationMessage
		): Promise<void> {
			if (recipients.length === 0) return;
			try {
				const disabled = await listDisabledPrefs(
					db,
					recipients.map((r) => r.memberId)
				);
				const isOff = (memberId: string, channel: string) =>
					disabled.some(
						(d) =>
							d.workspaceMemberId === memberId && d.eventType === eventType && d.channel === channel
					);

				const pushUsers = recipients.filter((r) => !isOff(r.memberId, 'webpush'));
				const ntfyUsers = recipients.filter((r) => !isOff(r.memberId, 'ntfy'));
				const outbound = { ...msg, origin: config.origin };

				const jobs: Promise<unknown>[] = [];
				if (config.webPush && pushUsers.length > 0) {
					const webPush = config.webPush;
					const subs = await listPushSubscriptions(
						db,
						pushUsers.map((r) => r.userId)
					);
					for (const sub of subs) {
						jobs.push(
							sendWebPush(webPush, sub, outbound).then((result) => {
								if (result === 'gone') return recordPushFailure(db, sub.endpoint, true);
								if (result === 'failed') return recordPushFailure(db, sub.endpoint, false);
							})
						);
					}
				}
				const targets = await listNtfyTargets(
					db,
					ntfyUsers.map((r) => r.userId)
				);
				for (const target of targets) {
					jobs.push(sendNtfy(target, outbound, config.ntfyToken));
				}
				await Promise.allSettled(jobs);
			} catch (e) {
				console.log(
					JSON.stringify({
						level: 'error',
						msg: 'notify: dispatch failed',
						err: (e as Error).message
					})
				);
			}
		}
	};
}
