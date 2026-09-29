import webpush from 'web-push';
import type { NotificationMessage } from '$lib/ports/notifier';

export interface WebPushConfig {
	publicKey: string;
	privateKey: string;
	subject: string;
}

export interface WebPushTarget {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export type WebPushResult = 'ok' | 'gone' | 'failed';

/**
 * One send per subscription. 404/410 mean the subscription is dead ('gone') —
 * normal lifecycle, the caller prunes the row. Payloads stay minimal: title,
 * body, deep-link path, collapse tag. The path stays relative on purpose.
 */
export async function sendWebPush(
	config: WebPushConfig,
	target: WebPushTarget,
	// No `origin`: unlike ntfy, the service worker knows its own.
	msg: NotificationMessage
): Promise<WebPushResult> {
	try {
		await webpush.sendNotification(
			{ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
			JSON.stringify({
				title: msg.title,
				body: msg.body,
				// Path only. The service worker resolves it against the origin
				// actually serving it, so a wrong PUBLIC_ORIGIN can't produce a
				// notification that opens localhost on someone's phone.
				path: msg.path,
				tag: msg.tag
			}),
			{
				vapidDetails: {
					subject: config.subject,
					publicKey: config.publicKey,
					privateKey: config.privateKey
				},
				TTL: 24 * 3600,
				urgency: 'high',
				// The library sets no timeout of its own, so a push service that
				// accepts the connection and never answers held the send forever.
				timeout: 10_000
			}
		);
		return 'ok';
	} catch (e) {
		const status = (e as { statusCode?: number }).statusCode;
		if (status === 404 || status === 410) return 'gone';
		console.log(
			JSON.stringify({ level: 'warn', msg: 'webpush: send failed', status: status ?? null })
		);
		return 'failed';
	}
}
