import { fail } from '@sveltejs/kit';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import { audit } from '$lib/server/audit';
import {
	API_SCOPES,
	createToken,
	listTokens,
	revokeToken,
	type ApiScope
} from '$lib/server/repo/api-tokens';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	// Re-run this workspace-scoped load when the workspace in the URL changes.
	void params.workspace;
	const tokens = await listTokens(getDb(), locals.member!.id);
	return {
		tokens: tokens.map((t) => ({
			id: t.id,
			name: t.name,
			prefix: t.prefix,
			scopes: t.scopes,
			createdAt: t.createdAt.toISOString(),
			lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
			expiresAt: t.expiresAt?.toISOString() ?? null
		}))
	};
};

const CreateSchema = v.object({
	name: v.pipe(
		v.string(),
		v.trim(),
		v.minLength(1, 'Name it something you’ll recognize.'),
		v.maxLength(60)
	),
	scopes: v.pipe(v.array(v.picklist(API_SCOPES)), v.minLength(1, 'Pick at least one permission.')),
	expiresInDays: v.optional(v.string())
});

const EXPIRY_DAYS: Record<string, number> = { '30': 30, '90': 90, '365': 365 };

export const actions: Actions = {
	create: async (event) => {
		const { locals, request } = event;
		const form = await request.formData();
		const parsed = v.safeParse(CreateSchema, {
			name: form.get('name'),
			scopes: form.getAll('scopes').map(String),
			expiresInDays: form.get('expiresInDays') ?? undefined
		});
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		const now = systemClock.now();
		const days = f.expiresInDays ? EXPIRY_DAYS[f.expiresInDays] : undefined;
		const expiresAt = days ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000) : null;

		const { secret, prefix } = await createToken(getDb(), uuidv7, now, {
			workspaceMemberId: locals.member!.id,
			name: f.name,
			scopes: f.scopes as ApiScope[],
			expiresAt
		});
		await audit(event, {
			action: 'api_token.created',
			detail: {
				name: f.name,
				prefix,
				scopes: f.scopes,
				expiresAt: expiresAt?.toISOString() ?? null
			}
		});
		// The secret is returned exactly once — the page shows it, then it's gone.
		return { created: { secret, prefix, name: f.name } };
	},

	revoke: async (event) => {
		const { locals, request } = event;
		const form = await request.formData();
		const tokenId = String(form.get('tokenId') ?? '');
		if (!tokenId) return fail(400, { error: 'Missing token' });
		const removed = await revokeToken(getDb(), systemClock.now(), locals.member!.id, tokenId);
		if (!removed) return fail(400, { error: 'That token no longer exists.' });
		await audit(event, { action: 'api_token.revoked', detail: { tokenId } });
		return { ok: true };
	}
};
