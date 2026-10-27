import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as v from 'valibot';
import { isUuid } from '$lib/uuid';
import { getDb } from '$lib/server/db';
import { audit } from '$lib/server/audit';
import { rateLimitOk } from '$lib/server/rate-limit';
import { bankSyncDeps } from '$lib/server/bank-sync';
import { bankConnection, bankFeedAccount } from '$lib/db/schema';
import {
	BankSyncError,
	connectSimpleFin,
	createRule,
	deleteRule,
	disconnect,
	reapplyRules,
	setFeedAccountEnabled,
	syncConnection
} from '$lib/application/bank-sync';
import { SimpleFinError } from '$lib/domain/banksync/simplefin';
import { Money } from '$lib/domain/money/money';
import { listConnections, listRecentRuns, listRules } from '$lib/repo/bank-sync';
import { listAccounts } from '$lib/repo/accounts';
import { listCategories, listMembers } from '$lib/repo/workspaces';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	const db = getDb();
	const ws = locals.workspace!;
	const me = locals.member!.id;
	const [connections, runs, rules, categories, accounts, members] = await Promise.all([
		listConnections(db, ws.id),
		listRecentRuns(db, ws.id),
		listRules(db, ws.id),
		listCategories(db, ws.id),
		listAccounts(db, ws.id),
		listMembers(db, ws.id)
	]);
	/*
	 * A card's balance is as private as its lines: the cardholder's unless the
	 * account is shared. Before anyone has claimed it, only the person who
	 * connected the bridge (who can see it at the bridge anyway).
	 */
	const visible = (
		c: (typeof connections)[number],
		a: (typeof connections)[number]['accounts'][number]
	) =>
		a.visibility === 'shared' ||
		a.holderMemberId === me ||
		(!a.holderMemberId && c.memberId === me);
	const names = new Map(members.map((m) => [m.member.id, m.user.displayName]));
	return {
		isOwner: locals.member!.role === 'owner',
		secretsConfigured: bankSyncDeps().secrets.available,
		currency: ws.currency,
		viewerId: me,
		members: members
			.filter((m) => m.member.status === 'active')
			.map((m) => ({ id: m.member.id, name: m.user.displayName })),
		connections: connections.map((c) => ({
			...c,
			accounts: c.accounts.map((a) => {
				const show = visible(c, a);
				return {
					...a,
					holderName: a.holderMemberId ? (names.get(a.holderMemberId) ?? null) : null,
					balanceMinor: show ? a.balanceMinor : null,
					availableBalanceMinor: show ? a.availableBalanceMinor : null
				};
			})
		})),
		runs,
		rules,
		categories: categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
		accounts: accounts.map((a) => ({ id: a.id, name: a.name, last4: a.last4 }))
	};
};

/** Every change here is an owner's call: it decides what bank data enters. */
function ownerOnly(event: RequestEvent) {
	if (event.locals.member!.role !== 'owner') error(403, 'Only an owner can manage bank sync.');
	return { workspaceId: event.locals.workspace!.id, memberId: event.locals.member!.id };
}

function refusal(e: unknown) {
	if (e instanceof BankSyncError || e instanceof SimpleFinError) {
		return fail(400, { error: e.message });
	}
	// Anything else is ours. Log it without detail that could carry a secret.
	console.log(
		JSON.stringify({ level: 'error', msg: 'bank sync action failed', err: (e as Error)?.name })
	);
	return fail(500, { error: 'Something went wrong. Nothing was changed.' });
}

async function connectionInWorkspace(id: string, workspaceId: string) {
	if (!isUuid(id)) return null;
	const [row] = await getDb()
		.select({ id: bankConnection.id, label: bankConnection.label })
		.from(bankConnection)
		.where(and(eq(bankConnection.id, id), eq(bankConnection.workspaceId, workspaceId)))
		.limit(1);
	return row ?? null;
}

const RuleSchema = v.object({
	match: v.picklist(['contains', 'starts_with', 'equals']),
	pattern: v.pipe(
		v.string(),
		v.trim(),
		v.minLength(2, 'Give the rule at least two characters.'),
		v.maxLength(120)
	),
	direction: v.picklist(['out', 'in', 'any']),
	action: v.picklist(['categorize', 'ignore']),
	categoryId: v.optional(v.string()),
	renameTo: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
	feedAccountId: v.optional(v.string()),
	minAmount: v.optional(v.string()),
	maxAmount: v.optional(v.string()),
	priority: v.optional(v.string())
});

export const actions: Actions = {
	connect: async (event) => {
		const scope = ownerOnly(event);
		// Each attempt is a claim against the bridge; a token can be claimed once.
		if (!rateLimitOk(`bank-connect:${scope.memberId}`, 5, 10 * 60_000)) {
			return fail(429, { error: 'Too many attempts. Wait a few minutes and try again.' });
		}
		const form = await event.request.formData();
		const setupToken = String(form.get('setupToken') ?? '');
		const label = String(form.get('label') ?? '');
		try {
			const r = await connectSimpleFin(getDb(), bankSyncDeps(), scope, { setupToken, label });
			await audit(event, {
				action: 'bank.connected',
				detail: { host: r.host, connectionId: r.connectionId }
			});
			return { connected: true };
		} catch (e) {
			return refusal(e);
		}
	},

	sync: async (event) => {
		const scope = ownerOnly(event);
		const form = await event.request.formData();
		const conn = await connectionInWorkspace(
			String(form.get('connectionId') ?? ''),
			scope.workspaceId
		);
		if (!conn) return fail(404, { error: 'That connection no longer exists.' });
		try {
			const r = await syncConnection(getDb(), bankSyncDeps(), conn.id, 'manual');
			if (r.status === 'error') return fail(502, { error: r.message ?? 'The sync failed.' });
			return { synced: { inserted: r.inserted, matched: r.matched, warning: r.message } };
		} catch (e) {
			return refusal(e);
		}
	},

	disconnect: async (event) => {
		const scope = ownerOnly(event);
		const form = await event.request.formData();
		const conn = await connectionInWorkspace(
			String(form.get('connectionId') ?? ''),
			scope.workspaceId
		);
		if (!conn) return fail(404, { error: 'That connection no longer exists.' });
		await disconnect(getDb(), bankSyncDeps(), scope, conn.id);
		await audit(event, {
			action: 'bank.disconnected',
			detail: { connectionId: conn.id, label: conn.label }
		});
		return { disconnected: true };
	},

	toggle: async (event) => {
		const scope = ownerOnly(event);
		const form = await event.request.formData();
		const feedAccountId = String(form.get('feedAccountId') ?? '');
		const enabled = form.get('enabled') === 'true';
		const link = String(form.get('accountId') ?? '');
		const holder = String(form.get('holderMemberId') ?? '');
		const vis = form.get('visibility');
		if (!isUuid(feedAccountId)) return fail(404, { error: 'That account no longer exists.' });
		try {
			await setFeedAccountEnabled(
				getDb(),
				bankSyncDeps(),
				scope,
				feedAccountId,
				enabled,
				isUuid(link) ? link : null,
				{
					holderMemberId: isUuid(holder) ? holder : undefined,
					visibility: vis === 'shared' ? 'shared' : vis === 'holder' ? 'holder' : undefined
				}
			);
			const [f] = await getDb()
				.select({ name: bankFeedAccount.name })
				.from(bankFeedAccount)
				.where(eq(bankFeedAccount.id, feedAccountId))
				.limit(1);
			await audit(event, {
				action: 'bank.account_toggled',
				detail: { feedAccountId, name: f?.name, enabled, holder: holder || null, visibility: vis }
			});
			return { ok: true };
		} catch (e) {
			return refusal(e);
		}
	},

	addRule: async (event) => {
		const scope = ownerOnly(event);
		const form = await event.request.formData();
		const get = (k: string) => {
			const x = form.get(k);
			return typeof x === 'string' && x !== '' ? x : undefined;
		};
		const parsed = v.safeParse(RuleSchema, {
			match: get('match'),
			pattern: get('pattern') ?? '',
			direction: get('direction') ?? 'out',
			action: get('action'),
			categoryId: get('categoryId'),
			renameTo: get('renameTo'),
			feedAccountId: get('feedAccountId'),
			minAmount: get('minAmount'),
			maxAmount: get('maxAmount'),
			priority: get('priority')
		});
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;
		const currency = event.locals.workspace!.currency;
		let min: bigint | null;
		let max: bigint | null;
		try {
			min = f.minAmount ? Money.fromDecimal(f.minAmount, currency).abs().minor : null;
			max = f.maxAmount ? Money.fromDecimal(f.maxAmount, currency).abs().minor : null;
		} catch {
			return fail(400, { error: 'Amounts must be plain numbers, like 12.50.' });
		}
		if (min !== null && max !== null && min > max) {
			return fail(400, { error: 'The smallest amount is bigger than the largest.' });
		}
		const priority = f.priority
			? Math.max(0, Math.min(1000, Math.trunc(Number(f.priority)) || 100))
			: 100;
		try {
			await createRule(getDb(), bankSyncDeps(), scope, {
				match: f.match,
				pattern: f.pattern,
				direction: f.direction,
				action: f.action,
				categoryId: f.categoryId && isUuid(f.categoryId) ? f.categoryId : null,
				renameTo: f.renameTo ?? null,
				feedAccountId: f.feedAccountId && isUuid(f.feedAccountId) ? f.feedAccountId : null,
				minAmountMinor: min,
				maxAmountMinor: max,
				priority
			});
			await audit(event, {
				action: 'bank.rule_changed',
				detail: { op: 'create', pattern: f.pattern }
			});
			return { ruleAdded: true };
		} catch (e) {
			return refusal(e);
		}
	},

	deleteRule: async (event) => {
		const scope = ownerOnly(event);
		const id = String((await event.request.formData()).get('ruleId') ?? '');
		if (!isUuid(id)) return fail(404, { error: 'That rule no longer exists.' });
		const removed = await deleteRule(getDb(), scope, id);
		if (!removed) return fail(404, { error: 'That rule no longer exists.' });
		await audit(event, { action: 'bank.rule_changed', detail: { op: 'delete', ruleId: id } });
		return { ok: true };
	},

	reapply: async (event) => {
		const scope = ownerOnly(event);
		const n = await reapplyRules(getDb(), scope);
		await audit(event, { action: 'bank.rule_changed', detail: { op: 'reapply', lines: n } });
		return { reapplied: n };
	}
};
