/**
 * Wording for the security log. Pure, so the sentences an owner reads when
 * reconstructing an incident are tested rather than eyeballed.
 */

export interface LogEntry {
	action: string;
	actorName: string | null;
	targetName: string | null;
	detail: unknown;
}

/** "iPhone · Safari 27.0" from a user-agent string; good enough to tell two
 *  devices apart at a glance, not a fingerprint. */
export function deviceLabel(ua: string | null | undefined): string {
	if (!ua) return 'Unknown device';
	const os = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Macintosh|Mac OS X/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: /Linux/.test(ua)
							? 'Linux'
							: null;
	const browser =
		match(ua, /Edg\/(\d+)/, 'Edge') ??
		match(ua, /Firefox\/(\d+)/, 'Firefox') ??
		match(ua, /CriOS\/(\d+)/, 'Chrome') ??
		match(ua, /Chrome\/(\d+)/, 'Chrome') ??
		match(ua, /Version\/([\d.]+).*Safari/, 'Safari');
	const parts = [os, browser].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : ua.slice(0, 40);
}

function match(ua: string, re: RegExp, name: string): string | null {
	const m = re.exec(ua);
	return m ? `${name} ${m[1]}` : null;
}

/**
 * A session used from a device other than the one it signed in on. Compares
 * device labels, not raw strings, so build noise (Chrome's patch digits, iOS
 * build ids) is ignored — but a browser version is kept, because two phones a
 * Safari release apart are exactly the two phones that need telling apart. A
 * browser update mid-session therefore shows as a mismatch too; the page says so.
 */
export function isDeviceMismatch(
	userAgent: string | null | undefined,
	sessionUserAgent: string | null | undefined
): boolean {
	if (!userAgent || !sessionUserAgent) return false;
	return deviceLabel(userAgent) !== deviceLabel(sessionUserAgent);
}

const obj = (d: unknown): Record<string, unknown> =>
	d && typeof d === 'object' ? (d as Record<string, unknown>) : {};

export function describeEvent(e: LogEntry): string {
	const who = e.actorName ?? 'Someone';
	const whom = e.targetName ?? 'a member';
	const d = obj(e.detail);
	switch (e.action) {
		case 'auth.login':
			return `${who} signed in`;
		case 'auth.logout':
			return `${who} signed out`;
		case 'session.device_mismatch':
			return `${who}’s session was used from a different device than it signed in on`;
		case 'member.role_changed':
			return e.targetName && e.targetName === e.actorName
				? `${who} changed their own role from ${d.from} to ${d.to}`
				: `${who} changed ${whom} from ${d.from} to ${d.to}`;
		case 'member.status_changed':
			return d.to === 'disabled' ? `${who} disabled ${whom}` : `${who} re-enabled ${whom}`;
		case 'member.policy_changed':
			return `${who} changed ${whom}’s approval policy`;
		case 'invite.created':
			return `${who} created an invite code`;
		case 'invite.consumed':
			return `${who} joined with an invite code`;
		case 'api_token.created':
			return `${who} created API token “${d.name}”`;
		case 'api_token.revoked':
			return `${who} revoked an API token`;
		case 'ntfy.target_set':
			return `${who} sent their notifications to ntfy topic “${d.topic}”`;
		case 'ntfy.target_removed':
			return `${who} turned off ntfy notifications`;
		case 'workspace.settings_changed':
			return 'flag' in d
				? `${who} turned ${d.value ? 'on' : 'off'} ${d.flag}`
				: `${who} changed ${Object.keys(d).join(', ')}`;
		case 'workspace.deleted':
			return `${who} deleted workspace “${d.name}”`;
		default:
			return `${who}: ${e.action}`;
	}
}
