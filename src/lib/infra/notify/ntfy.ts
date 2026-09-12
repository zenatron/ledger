import type { NotificationMessage } from '$lib/ports/notifier';

export interface NtfyTargetInfo {
	serverUrl: string;
	topic: string;
}

/**
 * A credential the deployment itself holds, and the origin it belongs to. It
 * is sent nowhere else: a member may point their target at any ntfy server
 * they like, and the server must not hand the deployment's token to a host
 * its operator never configured.
 */
export interface NtfyToken {
	value: string;
	origin: string;
}

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

/**
 * ntfy delivery: plain HTTP POST to {server}/{topic}. Title/Click/Tags travel
 * as headers, the body is the message text. Reliable even where Web Push
 * isn't (Safari tabs, no A2HS).
 */
export async function sendNtfy(
	target: NtfyTargetInfo,
	msg: NotificationMessage & { origin: string },
	token?: NtfyToken
): Promise<boolean> {
	const auth: Record<string, string> =
		token && sameOrigin(token.origin, target.serverUrl)
			? { Authorization: `Bearer ${token.value}` }
			: {};
	try {
		const res = await fetch(`${target.serverUrl.replace(/\/$/, '')}/${target.topic}`, {
			method: 'POST',
			headers: {
				Title: msg.title,
				Click: msg.origin + msg.path,
				Tags: 'moneybag',
				...auth
			},
			body: msg.body,
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			console.log(JSON.stringify({ level: 'warn', msg: 'ntfy: send failed', status: res.status }));
		}
		return res.ok;
	} catch {
		console.log(JSON.stringify({ level: 'warn', msg: 'ntfy: send failed', status: null }));
		return false;
	}
}
