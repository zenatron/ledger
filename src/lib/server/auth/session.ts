import { createHash, randomBytes } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { Db } from '$lib/db/types';
import { session, user } from '$lib/db/schema';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding renewal: extend when less than half the TTL remains. */
const RENEW_BELOW_MS = SESSION_TTL_MS / 2;

export type { UserRow as SessionUser } from '$lib/repo/users';
type SessionUser = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;

/**
 * Bulk-delete expired sessions. Runs in the periodic sweep: a row is created
 * on every login but only ever deleted when its own cookie is re-presented,
 * so sessions from people who never came back would otherwise sit in the
 * table forever.
 */
export async function deleteExpiredSessions(db: Db, now = new Date()): Promise<number> {
	const removed = await db
		.delete(session)
		.where(lte(session.expiresAt, now))
		.returning({ id: session.id });
	return removed.length;
}

/**
 * What the database stores for a session: a SHA-256 of the cookie, never the
 * cookie itself.
 *
 * The cookie is a bearer credential. Stored as-is, anyone who could read the
 * session table — a leaked backup, a read-only replica, a stray `pg_dump` —
 * held a live login for every household member. API tokens have always been
 * kept this way; sessions now are too. 32 random bytes need no salt or
 * stretching: there is nothing to guess.
 */
export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

/**
 * Create a session. Returns the row (whose `id` is the hash) and the `token`
 * to put in the cookie — the only time the token exists outside the browser.
 */
export async function createSession(
	db: Db,
	userId: string,
	meta: { userAgent?: string | null; ip?: string | null; activeWorkspaceId?: string | null }
): Promise<{ session: SessionRow; token: string }> {
	const now = new Date();
	const token = randomBytes(32).toString('base64url');
	const row: SessionRow = {
		id: hashSessionToken(token),
		userId,
		activeWorkspaceId: meta.activeWorkspaceId ?? null,
		expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
		createdAt: now,
		userAgent: meta.userAgent ?? null,
		ip: meta.ip ?? null
	};
	await db.insert(session).values(row);
	return { session: row, token };
}

/**
 * Resolve a cookie to its session. `token` is the cookie value; the row is
 * found by its hash. Sessions from before hashing were rewritten under their
 * hash by migration 0041, so they keep working with nobody signed out.
 */
export async function validateSession(
	db: Db,
	token: string
): Promise<{ session: SessionRow; user: SessionUser; renewed: boolean } | null> {
	const sessionId = hashSessionToken(token);
	const rows = await db
		.select({ session, user })
		.from(session)
		.innerJoin(user, eq(session.userId, user.id))
		.where(eq(session.id, sessionId))
		.limit(1);
	const hit = rows[0];
	if (!hit) return null;
	const now = Date.now();
	if (hit.session.expiresAt.getTime() <= now) {
		await db.delete(session).where(eq(session.id, sessionId));
		return null;
	}
	if (hit.session.expiresAt.getTime() - now < RENEW_BELOW_MS) {
		hit.session.expiresAt = new Date(now + SESSION_TTL_MS);
		await db
			.update(session)
			.set({ expiresAt: hit.session.expiresAt })
			.where(eq(session.id, sessionId));
		return { ...hit, renewed: true };
	}
	return { ...hit, renewed: false };
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
	await db.delete(session).where(eq(session.id, sessionId));
}

export async function setActiveWorkspace(
	db: Db,
	sessionId: string,
	workspaceId: string
): Promise<void> {
	await db.update(session).set({ activeWorkspaceId: workspaceId }).where(eq(session.id, sessionId));
}

export function setSessionCookie(cookies: Cookies, sessionId: string, expiresAt: Date): void {
	cookies.set(SESSION_COOKIE, sessionId, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		expires: expiresAt
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
