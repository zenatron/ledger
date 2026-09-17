import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { securityEvent } from '$lib/db/schema';

export type SecurityAction =
	| 'auth.login'
	| 'auth.logout'
	| 'session.device_mismatch'
	| 'member.role_changed'
	| 'member.status_changed'
	| 'member.policy_changed'
	| 'invite.created'
	| 'invite.consumed'
	| 'api_token.created'
	| 'api_token.revoked'
	| 'ntfy.target_set'
	| 'ntfy.target_removed'
	| 'workspace.settings_changed'
	| 'workspace.deleted';

export type SecurityEventRow = typeof securityEvent.$inferSelect;

export interface SecurityEventInput {
	id: string;
	at: Date;
	action: SecurityAction;
	workspaceId?: string | null;
	actorUserId?: string | null;
	actorMemberId?: string | null;
	actorName?: string | null;
	targetMemberId?: string | null;
	targetName?: string | null;
	detail?: Record<string, unknown> | null;
	ip?: string | null;
	userAgent?: string | null;
	sessionId?: string | null;
	sessionUserAgent?: string | null;
}

/**
 * The session id is a bearer credential, so the log keeps a fingerprint of it:
 * twelve hex characters tell sessions apart and cannot be replayed.
 */
export function sessionTag(sessionId: string): string {
	return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

export async function insertSecurityEvent(db: Db, e: SecurityEventInput): Promise<void> {
	await db.insert(securityEvent).values({
		id: e.id,
		createdAt: e.at,
		action: e.action,
		workspaceId: e.workspaceId ?? null,
		actorUserId: e.actorUserId ?? null,
		actorMemberId: e.actorMemberId ?? null,
		actorName: e.actorName ?? null,
		targetMemberId: e.targetMemberId ?? null,
		targetName: e.targetName ?? null,
		detail: e.detail ?? null,
		ip: e.ip ?? null,
		userAgent: e.userAgent?.slice(0, 512) ?? null,
		sessionTag: e.sessionId ? sessionTag(e.sessionId) : null,
		sessionUserAgent: e.sessionUserAgent?.slice(0, 512) ?? null
	});
}

/** A workspace's log, newest first. */
export async function listWorkspaceSecurityEvents(
	db: Db,
	workspaceId: string,
	limit = 200
): Promise<SecurityEventRow[]> {
	return db
		.select()
		.from(securityEvent)
		.where(eq(securityEvent.workspaceId, workspaceId))
		.orderBy(desc(securityEvent.createdAt))
		.limit(limit);
}

/** One person's events that belong to no workspace — sign-ins, sign-outs,
 *  session warnings — so each workspace's owners can see how its members got in. */
export async function listUserSecurityEvents(
	db: Db,
	userIds: string[],
	limit = 200
): Promise<SecurityEventRow[]> {
	if (userIds.length === 0) return [];
	return db
		.select()
		.from(securityEvent)
		.where(and(inArray(securityEvent.actorUserId, userIds), isNull(securityEvent.workspaceId)))
		.orderBy(desc(securityEvent.createdAt))
		.limit(limit);
}
