/**
 * Token expiry, end to end through the database.
 *
 * `createToken` took an expiry and never wrote it: the settings page showed
 * "expires in 30 days" and the audit log recorded the date, while the token
 * itself authenticated forever.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { authenticateToken, createToken } from './api-tokens';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const DAY = 86_400_000;

describe('api token expiry', () => {
	it('stores the expiry and stops authenticating once it passes', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const now = new Date('2026-01-01T00:00:00Z');
		const { secret } = await createToken(h.db, uuidv7, now, {
			workspaceMemberId: ws.ownerMemberId,
			name: 'thirty days',
			scopes: ['read'],
			expiresAt: new Date(now.getTime() + 30 * DAY)
		});

		expect(
			await authenticateToken(h.db, secret, new Date(now.getTime() + 29 * DAY))
		).not.toBeNull();
		expect(await authenticateToken(h.db, secret, new Date(now.getTime() + 31 * DAY))).toBeNull();
	});

	it('leaves a token with no expiry valid', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const now = new Date('2026-01-01T00:00:00Z');
		const { secret } = await createToken(h.db, uuidv7, now, {
			workspaceMemberId: ws.ownerMemberId,
			name: 'forever',
			scopes: ['read'],
			expiresAt: null
		});
		expect(
			await authenticateToken(h.db, secret, new Date(now.getTime() + 3650 * DAY))
		).not.toBeNull();
	});
});
