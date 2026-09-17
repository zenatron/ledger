import { getDb } from '$lib/server/db';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import {
	insertSecurityEvent,
	type SecurityAction,
	type SecurityEventInput
} from '$lib/server/repo/security-events';

/** The parts of a SvelteKit request event the log reads. */
export interface AuditEvent {
	request: Request;
	getClientAddress: () => string;
	locals: App.Locals;
}

export type AuditEntry = Pick<
	SecurityEventInput,
	'targetMemberId' | 'targetName' | 'detail' | 'workspaceId'
> & {
	action: SecurityAction;
	/** For the login itself, before locals carry a user or session. */
	actor?: { userId: string; name: string; sessionId: string; sessionUserAgent: string | null };
};

/**
 * Record a security-relevant change, stamped with who did it, from which
 * device, on which session.
 *
 * Never throws. The action it describes has already happened by the time this
 * runs; failing the request now would tell the user it didn't. A write that
 * fails is logged loudly instead, which is where an operator would look anyway.
 */
export async function audit(event: AuditEvent, entry: AuditEntry): Promise<void> {
	const { locals, request } = event;
	let ip: string | null = null;
	try {
		ip = event.getClientAddress();
	} catch {
		/* no address during prerender */
	}
	try {
		await insertSecurityEvent(getDb(), {
			id: uuidv7.newId(),
			at: systemClock.now(),
			action: entry.action,
			workspaceId:
				entry.workspaceId !== undefined ? entry.workspaceId : (locals.workspace?.id ?? null),
			actorUserId: entry.actor?.userId ?? locals.user?.id ?? null,
			actorMemberId: entry.actor ? null : (locals.member?.id ?? null),
			actorName: entry.actor?.name ?? locals.user?.displayName ?? null,
			targetMemberId: entry.targetMemberId,
			targetName: entry.targetName,
			detail: entry.detail,
			ip,
			userAgent: request.headers.get('user-agent'),
			sessionId: entry.actor?.sessionId ?? locals.session?.id ?? null,
			sessionUserAgent: entry.actor
				? entry.actor.sessionUserAgent
				: (locals.session?.userAgent ?? null)
		});
	} catch (e) {
		console.log(
			JSON.stringify({
				level: 'error',
				msg: 'audit: security event not recorded',
				action: entry.action,
				err: (e as Error).message
			})
		);
	}
}
