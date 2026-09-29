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
 * ntfy delivery, through its JSON publish API: POST {server} with the topic,
 * title, message and click URL in the body.
 *
 * Not the header form (POST {server}/{topic} with Title/Click headers), which
 * is what this used to send. HTTP header values are bytes, not text: `fetch`
 * refuses any character above U+00FF outright, so a requester named Анна or
 * 李 — or any title with an emoji — threw before a byte left the process, and
 * the catch below logged it as a failure with no status. Names that did fit
 * (José) went out as Latin-1, which ntfy reads as UTF-8 and garbles. The JSON
 * body is UTF-8 end to end. Reliable even where Web Push isn't (Safari tabs,
 * no A2HS).
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
		const res = await fetch(target.serverUrl.replace(/\/$/, ''), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...auth },
			body: JSON.stringify({
				topic: target.topic,
				title: msg.title,
				message: msg.body,
				click: msg.origin + msg.path,
				tags: ['moneybag']
			}),
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			console.log(JSON.stringify({ level: 'warn', msg: 'ntfy: send failed', status: res.status }));
		}
		return res.ok;
	} catch (e) {
		console.log(
			JSON.stringify({
				level: 'warn',
				msg: 'ntfy: send failed',
				status: null,
				err: (e as Error).message
			})
		);
		return false;
	}
}
