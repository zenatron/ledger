import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { session } from '$lib/db/schema';

vi.mock('$app/environment', () => ({ dev: true }));
const { createSession, hashSessionToken, validateSession } = await import('./session');

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

describe('sessions at rest', () => {
	it('stores only a hash of the cookie, and finds the session by the cookie', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const { session: row, token } = await createSession(h.db, ws.ownerUserId, {});

		const stored = await h.db.select({ id: session.id }).from(session);
		expect(stored.map((r) => r.id)).toEqual([hashSessionToken(token)]);
		expect(stored[0].id).not.toBe(token);

		const hit = await validateSession(h.db, token);
		expect(hit?.session.id).toBe(row.id);
		// The hash itself is not a credential.
		expect(await validateSession(h.db, row.id)).toBeNull();
	});

	it('matches the hash migration 0041 wrote over pre-hashing sessions', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const legacyToken = randomBytes(32).toString('base64url');
		await h.db.insert(session).values({
			id: legacyToken,
			userId: ws.ownerUserId,
			activeWorkspaceId: null,
			expiresAt: new Date(Date.now() + 86_400_000 * 20),
			createdAt: new Date(),
			userAgent: null,
			ip: null
		});
		// The migration's own statement, re-run against a row it would have met.
		const sql = readFileSync(
			new URL('../../../../drizzle/0041_hash_session_ids.sql', import.meta.url),
			'utf8'
		);
		await h.db.execute(sql.replace(/--.*$/gm, ''));

		// The cookie the browser already holds still signs in.
		const hit = await validateSession(h.db, legacyToken);
		expect(hit?.user.id).toBe(ws.ownerUserId);
		const rows = await h.db.select({ id: session.id }).from(session);
		expect(rows.map((r) => r.id)).toEqual([hashSessionToken(legacyToken)]);
	});
});
