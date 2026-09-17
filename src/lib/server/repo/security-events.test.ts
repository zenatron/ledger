import { describe, it, expect, afterEach } from 'vitest';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import {
	insertSecurityEvent,
	listUserSecurityEvents,
	listWorkspaceSecurityEvents,
	sessionTag
} from './security-events';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const id = () => crypto.randomUUID();

describe('security events', () => {
	it('never stores the session id, only a fingerprint of it', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const sid = 'a-real-session-id-that-is-a-credential';
		await insertSecurityEvent(h.db, {
			id: id(),
			at: new Date(),
			action: 'member.role_changed',
			workspaceId: ws.workspaceId,
			actorUserId: ws.ownerUserId,
			sessionId: sid
		});
		const [row] = await listWorkspaceSecurityEvents(h.db, ws.workspaceId);
		expect(row.sessionTag).toBe(sessionTag(sid));
		expect(JSON.stringify(row)).not.toContain(sid);
	});

	it('keeps workspace events and account events in their own streams', async () => {
		h = await makeTestDb();
		const ws = await seedWorkspace(h.db);
		const base = { actorUserId: ws.ownerUserId };
		await insertSecurityEvent(h.db, {
			...base,
			id: id(),
			at: new Date('2026-09-17T02:50:00Z'),
			action: 'auth.login'
		});
		await insertSecurityEvent(h.db, {
			...base,
			id: id(),
			at: new Date('2026-09-17T02:51:00Z'),
			action: 'member.role_changed',
			workspaceId: ws.workspaceId
		});

		const own = await listWorkspaceSecurityEvents(h.db, ws.workspaceId);
		expect(own.map((e) => e.action)).toEqual(['member.role_changed']);
		const account = await listUserSecurityEvents(h.db, [ws.ownerUserId]);
		expect(account.map((e) => e.action)).toEqual(['auth.login']);
		expect(await listUserSecurityEvents(h.db, [])).toEqual([]);
	});

	it('outlives the workspace it describes', async () => {
		h = await makeTestDb();
		// No foreign keys: an id that references nothing still inserts.
		const gone = id();
		await insertSecurityEvent(h.db, {
			id: id(),
			at: new Date(),
			action: 'workspace.deleted',
			workspaceId: gone,
			detail: { name: 'Gloopy' }
		});
		expect(await listWorkspaceSecurityEvents(h.db, gone)).toHaveLength(1);
	});
});
