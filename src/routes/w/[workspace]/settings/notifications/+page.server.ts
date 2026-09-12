import { fail } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { workspaceMember } from '$lib/db/schema';
import { getEnv } from '$lib/server/env';
import {
	deleteNtfyTarget,
	getNtfyTarget,
	listDisabledPrefs,
	listPushSubscriptions,
	setNtfyTarget,
	setPref
} from '$lib/repo/notifications';
import { sendNtfy } from '$lib/infra/notify/ntfy';
import { sendWebPush } from '$lib/infra/notify/webpush';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import { EVENT_TYPES } from '$lib/notification-events';
import type { Actions, PageServerLoad } from './$types';

const deps = { clock: systemClock, ids: uuidv7 };

export const load: PageServerLoad = async ({ locals, params }) => {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const db = getDb();
	const env = getEnv();
	const [ntfy, disabled, subs] = await Promise.all([
		getNtfyTarget(db, locals.user!.id),
		listDisabledPrefs(db, [locals.member!.id]),
		listPushSubscriptions(db, [locals.user!.id])
	]);
	return {
		isOwner: locals.member!.role === 'owner',
		vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
		ntfy: ntfy
			? { topic: ntfy.topic, serverUrl: ntfy.serverUrl }
			: {
					topic: `budget-${randomBytes(6).toString('hex')}`,
					serverUrl: env.NTFY_SERVER_URL ?? 'https://ntfy.sh',
					unsaved: true
				},
		subscriptionCount: subs.length,
		disabled: disabled.map((d) => `${d.eventType}:${d.channel}`),
		eventTypes: EVENT_TYPES.map((e) => ({ ...e })),
		safeToSpendAlertsEnabled: locals.workspace!.safeToSpendAlertsEnabled,
		summaryCadence: locals.member!.summaryCadence
	};
};

const SUMMARY_CADENCES = ['off', 'weekly', 'monthly'] as const;

const NtfySchema = v.object({
	topic: v.pipe(
		v.string(),
		v.trim(),
		v.regex(/^[A-Za-z0-9_-]{4,64}$/, 'Topic: 4–64 letters, digits, - or _')
	),
	serverUrl: v.pipe(
		v.string(),
		v.trim(),
		v.url('Server must be a URL'),
		// The server POSTs to whatever this names, so the same rules as every
		// other outbound URL: http(s) only, no credentials, and no link-local
		// (that is where cloud metadata lives). Your own LAN stays allowed —
		// a self-hosted ntfy is half the point.
		v.check((s) => {
			try {
				const u = new URL(s);
				if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
				if (u.username || u.password) return false;
				if (/^169\.254\./.test(u.hostname) || u.hostname === '0.0.0.0') return false;
				return true;
			} catch {
				return false;
			}
		}, 'Server must be an http(s) URL, no credentials')
	)
});

export const actions: Actions = {
	summary: async ({ locals, request }) => {
		const cadence = String((await request.formData()).get('cadence') ?? '');
		if (!(SUMMARY_CADENCES as readonly string[]).includes(cadence)) {
			return fail(400, { error: 'Unknown cadence' });
		}
		// Turning it on re-bases the clock to now, so the first digest arrives at
		// the end of the *next* full period rather than firing immediately.
		await getDb()
			.update(workspaceMember)
			.set({
				summaryCadence: cadence,
				...(cadence !== 'off' ? { summaryLastSentAt: systemClock.now() } : {})
			})
			.where(eq(workspaceMember.id, locals.member!.id));
		return { section: 'summary', ok: true };
	},

	ntfy: async ({ locals, request }) => {
		const parsed = v.safeParse(NtfySchema, Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { section: 'ntfy', error: parsed.issues[0].message });
		await setNtfyTarget(getDb(), deps, {
			userId: locals.user!.id,
			topic: parsed.output.topic,
			serverUrl: parsed.output.serverUrl
		});
		return { section: 'ntfy', ok: true };
	},

	ntfyOff: async ({ locals }) => {
		await deleteNtfyTarget(getDb(), locals.user!.id);
		return { section: 'ntfy', ok: true };
	},

	ntfyTest: async ({ locals }) => {
		const target = await getNtfyTarget(getDb(), locals.user!.id);
		if (!target) return fail(400, { section: 'ntfy', error: 'Save a topic first' });
		const env = getEnv();
		const ok = await sendNtfy(
			target,
			{
				title: 'Budget test',
				body: 'ntfy is wired up correctly.',
				path: `/w/${locals.workspace!.slug}`,
				origin: env.PUBLIC_ORIGIN
			},
			// Same scoping as the notifier: the shared token only rides to the
			// server it was configured for.
			env.NTFY_DEFAULT_TOKEN
				? { value: env.NTFY_DEFAULT_TOKEN, origin: env.NTFY_SERVER_URL ?? 'https://ntfy.sh' }
				: undefined
		);
		return ok
			? { section: 'ntfy', ok: true, tested: true }
			: fail(502, { section: 'ntfy', error: 'The ntfy server did not accept the message' });
	},

	// The push twin of ntfyTest: same message shape, same "it worked" bar. Sent
	// to every registered device of this member — the server cannot tell which
	// device asked, and a test that buzzes the other phone is still a pass.
	pushTest: async ({ locals }) => {
		const env = getEnv();
		if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
			return fail(400, { section: 'push', error: 'Push is not configured on this server' });
		}
		const subs = await listPushSubscriptions(getDb(), [locals.user!.id]);
		if (subs.length === 0) return fail(400, { section: 'push', error: 'Enable push first' });
		const config = {
			publicKey: env.VAPID_PUBLIC_KEY,
			privateKey: env.VAPID_PRIVATE_KEY,
			subject: env.VAPID_SUBJECT ?? env.PUBLIC_ORIGIN
		};
		let delivered = 0;
		for (const sub of subs) {
			const result = await sendWebPush(
				config,
				{ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
				{
					title: 'Budget test',
					body: 'Push is wired up correctly.',
					path: `/w/${locals.workspace!.slug}/purchases`,
					tag: 'test'
				}
			);
			if (result === 'ok') delivered++;
		}
		return delivered > 0
			? { section: 'push', ok: true, tested: true }
			: fail(502, { section: 'push', error: 'No device accepted the test message' });
	},

	prefs: async ({ locals, request }) => {
		const form = await request.formData();
		const enabledKeys = new Set(form.getAll('enabled').map(String));
		const db = getDb();
		// When ntfy isn't set up its checkboxes are disabled and don't submit, so
		// rewriting ntfy prefs here would read them all as "off" and quietly
		// disable the channel for good. Leave ntfy prefs alone until it exists.
		const ntfy = await getNtfyTarget(db, locals.user!.id);
		const channels = ntfy ? ['webpush', 'ntfy'] : ['webpush'];
		for (const event of EVENT_TYPES) {
			for (const channel of channels) {
				await setPref(db, {
					memberId: locals.member!.id,
					eventType: event.id,
					channel,
					enabled: enabledKeys.has(`${event.id}:${channel}`)
				});
			}
		}
		return { section: 'prefs', ok: true };
	}
};
