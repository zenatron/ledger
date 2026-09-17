import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listMembers } from '$lib/repo/workspaces';
import {
	listUserSecurityEvents,
	listWorkspaceSecurityEvents
} from '$lib/server/repo/security-events';
import { describeEvent, deviceLabel, isDeviceMismatch } from '$lib/security-log';
import type { PageServerLoad } from './$types';

const LIMIT = 200;

/**
 * Owner-only: who changed access to this workspace, and how its members got in.
 *
 * Two streams merged. This workspace's own events, and the account-level ones
 * (sign-ins, sign-outs, session warnings) of the people who are members of it
 * now, including disabled members, since a removed member's last sign-ins are
 * the ones you most want to see.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	if (locals.member!.role !== 'owner') error(403, 'Only an owner can view the security log');

	const db = getDb();
	const members = await listMembers(db, locals.workspace!.id);
	const [own, account] = await Promise.all([
		listWorkspaceSecurityEvents(db, locals.workspace!.id, LIMIT),
		listUserSecurityEvents(
			db,
			members.map((m) => m.user.id),
			LIMIT
		)
	]);

	const events = [...own, ...account]
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.slice(0, LIMIT)
		.map((e) => ({
			id: e.id,
			at: e.createdAt.toISOString(),
			action: e.action,
			text: describeEvent(e),
			device: deviceLabel(e.userAgent),
			sessionDevice: e.sessionUserAgent ? deviceLabel(e.sessionUserAgent) : null,
			mismatch:
				e.action === 'session.device_mismatch' || isDeviceMismatch(e.userAgent, e.sessionUserAgent),
			sessionTag: e.sessionTag,
			ip: e.ip
		}));

	return { events };
};
