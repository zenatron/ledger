import { error, json } from '@sveltejs/kit';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { deletePushSubscription, upsertPushSubscription } from '$lib/repo/notifications';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

// Standalone endpoints skip SvelteKit's form-action CSRF check.
const SubscriptionSchema = v.object({
	endpoint: v.pipe(v.string(), v.url()),
	keys: v.object({
		p256dh: v.pipe(v.string(), v.nonEmpty()),
		auth: v.pipe(v.string(), v.nonEmpty())
	})
});

/** Called on every launch: upsert by endpoint (subscriptions rotate and expire). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	assertSameOrigin(request);
	const parsed = v.safeParse(SubscriptionSchema, await request.json());
	if (!parsed.success) error(400, 'Malformed subscription');
	await upsertPushSubscription(
		getDb(),
		{ clock: systemClock, ids: uuidv7 },
		{
			userId: locals.user.id,
			endpoint: parsed.output.endpoint,
			p256dh: parsed.output.keys.p256dh,
			auth: parsed.output.keys.auth,
			userAgent: request.headers.get('user-agent')
		}
	);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	assertSameOrigin(request);
	const body = (await request.json()) as { endpoint?: string };
	if (!body.endpoint) error(400, 'Missing endpoint');
	await deletePushSubscription(getDb(), locals.user.id, body.endpoint);
	return json({ ok: true });
};
