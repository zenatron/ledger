import { describe, it, expect, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from '$lib/repo/_test/harness';
import { loadPurchase } from '$lib/repo/purchases';
import { isMalformedInputError } from './errors';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

describe('isMalformedInputError', () => {
	it('recognises a non-uuid reaching a uuid column, however drizzle wraps it', async () => {
		h = await makeTestDb();
		const ws = '00000000-0000-4000-8000-000000000001';
		const err = await loadPurchase(h.db, { workspaceId: ws, viewerId: ws }, 'not-a-uuid', {
			now: new Date()
		}).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(isMalformedInputError(err)).toBe(true);
	});

	it('leaves every other failure alone', () => {
		expect(isMalformedInputError(new Error('boom'))).toBe(false);
		expect(isMalformedInputError({ code: '23505' })).toBe(false);
		expect(isMalformedInputError(null)).toBe(false);
	});
});
