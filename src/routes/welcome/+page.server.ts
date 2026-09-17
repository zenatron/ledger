import { fail, redirect } from '@sveltejs/kit';
import { audit } from '$lib/server/audit';
import * as v from 'valibot';
import { createWorkspace } from '$lib/application/create-workspace';
import { JoinWorkspaceError, joinWorkspace } from '$lib/application/join-workspace';
import { getDb } from '$lib/server/db';
import { listWorkspacesForUser } from '$lib/repo/workspaces';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import type { Actions, PageServerLoad } from './$types';

const deps = { clock: systemClock, ids: uuidv7 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/');
	const memberships = await listWorkspacesForUser(getDb(), locals.user.id);
	return {
		displayName: locals.user.displayName,
		workspaces: memberships.map((m) => ({
			slug: m.workspace.slug,
			name: m.workspace.name,
			accentColor: m.workspace.accentColor
		})),
		timezones: Intl.supportedValuesOf('timeZone'),
		currencies: Intl.supportedValuesOf('currency')
	};
};

const CreateSchema = v.object({
	name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name is required'), v.maxLength(60)),
	currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, 'Pick a currency')),
	timezone: v.pipe(
		v.string(),
		v.check((tz) => Intl.supportedValuesOf('timeZone').includes(tz), 'Pick a timezone')
	),
	accentColor: v.optional(v.pipe(v.string(), v.regex(/^#[0-9A-Fa-f]{6}$/)))
});

const JOIN_MESSAGES: Record<JoinWorkspaceError['reason'], string> = {
	invalid_code: 'That code is not valid.',
	expired: 'That invite has expired. Ask for a new one.',
	already_used: 'That invite was already used. Ask for a new one.',
	already_member: 'You are already a member of that workspace.'
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const form = Object.fromEntries(await request.formData());
		const parsed = v.safeParse(CreateSchema, form);
		if (!parsed.success) {
			return fail(400, { action: 'create', error: parsed.issues[0].message });
		}
		const { slug } = await createWorkspace(getDb(), deps, {
			userId: locals.user.id,
			...parsed.output
		});
		redirect(303, `/w/${slug}`);
	},

	join: async (event) => {
		const { locals, request } = event;
		if (!locals.user) redirect(303, '/');
		const code = String((await request.formData()).get('code') ?? '')
			.trim()
			.toUpperCase();
		if (!code) return fail(400, { action: 'join', error: 'Enter an invite code.' });
		try {
			const { slug, workspaceId } = await joinWorkspace(getDb(), deps, {
				userId: locals.user.id,
				code
			});
			await audit(event, { action: 'invite.consumed', workspaceId });
			redirect(303, `/w/${slug}`);
		} catch (e) {
			if (e instanceof JoinWorkspaceError) {
				return fail(400, { action: 'join', error: JOIN_MESSAGES[e.reason] });
			}
			throw e;
		}
	}
};
