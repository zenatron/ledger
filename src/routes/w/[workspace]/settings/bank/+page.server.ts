import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { audit } from '$lib/server/audit';
import { bankSyncAvailable, bankSyncDeps } from '$lib/server/bank-sync';
import { getEnv } from '$lib/server/env';
import { isUuid } from '$lib/uuid';
import { accountLabel, listAccounts } from '$lib/repo/accounts';
import { getConnection, listConnections } from '$lib/repo/bank-feeds';
import {
	BankSyncError,
	MANUAL_SYNC_MIN_MS,
	connectSimplefin,
	disconnect,
	linkFeedAccount,
	syncConnection
} from '$lib/application/bank-sync';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	const db = getDb();
	const ws = locals.workspace!;
	const [connections, accounts] = await Promise.all([
		listConnections(db, ws.id),
		listAccounts(db, ws.id)
	]);
	return {
		isOwner: locals.member!.role === 'owner',
		available: bankSyncAvailable(),
		hosts: getEnv().SIMPLEFIN_HOSTS,
		currency: ws.currency,
		accounts: accounts.map((a) => ({ id: a.id, label: accountLabel(a) })),
		// Never the access URL, sealed or not: the page only needs to know it exists.
		connections: connections.map((c) => ({
			id: c.id,
			label: c.label,
			status: c.status,
			lastError: c.lastError,
			lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
			accounts: c.accounts.map((a) => ({
				id: a.id,
				name: a.name,
				orgName: a.orgName,
				currency: a.currency,
				balanceMinor: a.balanceMinor?.toString() ?? null,
				accountId: a.accountId
			}))
		}))
	};
};

function ownerOnly(locals: App.Locals) {
	if (locals.member!.role !== 'owner') error(403, 'Only the owner can manage bank sync');
	if (!bankSyncAvailable()) error(400, 'Bank sync needs SECRETS_KEY set on the server.');
}

function scopeOf(locals: App.Locals) {
	return { workspaceId: locals.workspace!.id, memberId: locals.member!.id };
}

export const actions: Actions = {
	connect: async (event) => {
		const { locals, request } = event;
		ownerOnly(locals);
		const token = String((await request.formData()).get('token') ?? '');
		try {
			const { connectionId } = await connectSimplefin(
				getDb(),
				bankSyncDeps(),
				scopeOf(locals),
				token
			);
			const conn = await getConnection(getDb(), locals.workspace!.id, connectionId);
			await audit(event, {
				action: 'bank.connected',
				detail: { connectionId, label: conn?.label ?? null }
			});
			return { connected: true };
		} catch (e) {
			if (e instanceof BankSyncError) return fail(400, { error: e.message });
			throw e;
		}
	},

	link: async ({ locals, request }) => {
		ownerOnly(locals);
		const form = await request.formData();
		const feedAccountId = String(form.get('feedAccountId') ?? '');
		const target = String(form.get('target') ?? '');
		if (!isUuid(feedAccountId)) return fail(400, { error: 'Pick an account.' });
		try {
			await linkFeedAccount(
				getDb(),
				bankSyncDeps(),
				scopeOf(locals),
				feedAccountId,
				target === '' ? null : target === 'new' ? { create: true } : { accountId: target }
			);
			return { linked: true };
		} catch (e) {
			if (e instanceof BankSyncError) return fail(400, { error: e.message });
			throw e;
		}
	},

	sync: async ({ locals, request }) => {
		ownerOnly(locals);
		const id = String((await request.formData()).get('connectionId') ?? '');
		if (!isUuid(id)) return fail(400, { error: 'Pick a connection.' });
		const db = getDb();
		const deps = bankSyncDeps();
		const conn = await getConnection(db, locals.workspace!.id, id);
		if (!conn) return fail(404, { error: 'That connection no longer exists.' });
		// The bridge rate-limits per connection; a held-down button must not spend it.
		if (
			conn.lastAttemptAt &&
			deps.clock.now().getTime() - conn.lastAttemptAt.getTime() < MANUAL_SYNC_MIN_MS
		) {
			return fail(429, { error: 'Synced a moment ago. Try again in a few minutes.' });
		}
		try {
			const result = await syncConnection(db, deps, locals.workspace!.id, id, {
				actorMemberId: locals.member!.id
			});
			return { synced: result };
		} catch (e) {
			if (e instanceof BankSyncError) return fail(400, { error: e.message });
			throw e;
		}
	},

	disconnect: async (event) => {
		const { locals, request } = event;
		ownerOnly(locals);
		const id = String((await request.formData()).get('connectionId') ?? '');
		if (!isUuid(id)) return fail(400, { error: 'Pick a connection.' });
		const conn = await getConnection(getDb(), locals.workspace!.id, id);
		if (!conn) return fail(404, { error: 'That connection no longer exists.' });
		await disconnect(getDb(), scopeOf(locals), id);
		await audit(event, {
			action: 'bank.disconnected',
			detail: { connectionId: id, label: conn.label }
		});
		return { disconnected: true };
	}
};
