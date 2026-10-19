import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { apiToken, workspace, workspaceMember, user } from '$lib/db/schema';

export type ApiScope = 'read' | 'write' | 'approve';
export const API_SCOPES: readonly ApiScope[] = ['read', 'write', 'approve'];

/** Human-facing token: "ldg_" + 32 random bytes as base64url. Shown once. */
const TOKEN_PREFIX = 'ldg_';

export function hashToken(secret: string): string {
	return createHash('sha256').update(secret).digest('hex');
}

/** Mint a new secret. The caller stores `hash`/`prefix`; the secret is returned once. */
export function mintToken(): { secret: string; hash: string; prefix: string } {
	const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
	return { secret, hash: hashToken(secret), prefix: secret.slice(0, 12) };
}

export interface CreateTokenCmd {
	workspaceMemberId: string;
	name: string;
	scopes: ApiScope[];
	/** Absolute expiry, or null for no expiry. */
	expiresAt: Date | null;
}

export async function createToken(
	db: Db,
	ids: { newId: () => string },
	now: Date,
	cmd: CreateTokenCmd
): Promise<{ id: string; secret: string; prefix: string }> {
	const { secret, hash, prefix } = mintToken();
	const id = ids.newId();
	await db.insert(apiToken).values({
		id,
		workspaceMemberId: cmd.workspaceMemberId,
		name: cmd.name,
		tokenHash: hash,
		prefix,
		scopes: cmd.scopes,
		expiresAt: cmd.expiresAt,
		createdAt: now
	});
	return { id, secret, prefix };
}

export interface ApiTokenListItem {
	id: string;
	name: string;
	prefix: string;
	scopes: ApiScope[];
	createdAt: Date;
	lastUsedAt: Date | null;
	expiresAt: Date | null;
}

/** Active (non-revoked) tokens for a member, newest first. */
export async function listTokens(db: Db, workspaceMemberId: string): Promise<ApiTokenListItem[]> {
	const rows = await db
		.select()
		.from(apiToken)
		.where(and(eq(apiToken.workspaceMemberId, workspaceMemberId), isNull(apiToken.revokedAt)))
		.orderBy(desc(apiToken.createdAt));
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		prefix: r.prefix,
		scopes: r.scopes as ApiScope[],
		createdAt: r.createdAt,
		lastUsedAt: r.lastUsedAt,
		expiresAt: r.expiresAt
	}));
}

/** Soft-revoke: the row stays for audit but stops authenticating immediately. */
export async function revokeToken(
	db: Db,
	now: Date,
	workspaceMemberId: string,
	tokenId: string
): Promise<boolean> {
	const rows = await db
		.update(apiToken)
		.set({ revokedAt: now })
		.where(
			and(
				eq(apiToken.id, tokenId),
				eq(apiToken.workspaceMemberId, workspaceMemberId),
				isNull(apiToken.revokedAt)
			)
		)
		.returning({ id: apiToken.id });
	return rows.length > 0;
}

export interface AuthedToken {
	tokenId: string;
	scopes: ApiScope[];
	workspace: typeof workspace.$inferSelect;
	member: typeof workspaceMember.$inferSelect;
	user: typeof user.$inferSelect;
}

/**
 * Resolve a bearer secret to its full acting context, or null if it doesn't
 * authenticate. Rejects revoked, expired, and disabled-member tokens. The hash
 * is compared in constant time to keep timing from leaking which prefix matched.
 */
export async function authenticateToken(
	db: Db,
	secret: string,
	now: Date
): Promise<AuthedToken | null> {
	if (!secret.startsWith(TOKEN_PREFIX)) return null;
	const hash = hashToken(secret);
	const rows = await db
		.select({ token: apiToken, workspace, member: workspaceMember, user })
		.from(apiToken)
		.innerJoin(workspaceMember, eq(apiToken.workspaceMemberId, workspaceMember.id))
		.innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.where(eq(apiToken.tokenHash, hash))
		.limit(1);
	const hit = rows[0];
	if (!hit) return null;

	// Constant-time confirm (the unique index already narrowed to one row; this
	// guards against a theoretical hash-prefix collision without leaking timing).
	const a = Buffer.from(hit.token.tokenHash);
	const b = Buffer.from(hash);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	if (hit.token.revokedAt) return null;
	if (hit.token.expiresAt && hit.token.expiresAt.getTime() <= now.getTime()) return null;
	if (hit.member.status !== 'active') return null;

	// Best-effort last-used stamp, throttled to once a minute so a chatty client
	// doesn't write on every call. Not awaited on the hot path.
	const last = hit.token.lastUsedAt?.getTime() ?? 0;
	if (now.getTime() - last > 60_000) {
		void db
			.update(apiToken)
			.set({ lastUsedAt: now })
			.where(eq(apiToken.id, hit.token.id))
			.catch(() => {});
	}

	return {
		tokenId: hit.token.id,
		scopes: hit.token.scopes as ApiScope[],
		workspace: hit.workspace,
		member: hit.member,
		user: hit.user
	};
}
