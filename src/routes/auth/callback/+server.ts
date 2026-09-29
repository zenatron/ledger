import { error, redirect } from '@sveltejs/kit';
import { finishLogin } from '$lib/server/auth/oidc';
import {
	SESSION_COOKIE,
	createSession,
	destroySession,
	hashSessionToken,
	setSessionCookie
} from '$lib/server/auth/session';
import { audit } from '$lib/server/audit';
import { getDb } from '$lib/server/db';
import { upsertUserFromOidc } from '$lib/repo/users';
import { processAvatar } from '$lib/infra/images/process';
import { getBlobStore } from '$lib/server/blobs';
import { getEnv } from '$lib/server/env';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import { user } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Refuse the absurd before decoding it; a real avatar is a few hundred KB. */
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

export const GET: RequestHandler = async (event) => {
	const { url, cookies, request, getClientAddress } = event;
	const state = cookies.get('oidc_state');
	const nonce = cookies.get('oidc_nonce');
	const codeVerifier = cookies.get('oidc_verifier');
	for (const name of ['oidc_state', 'oidc_nonce', 'oidc_verifier']) {
		cookies.delete(name, { path: '/' });
	}
	if (!state || !nonce || !codeVerifier) {
		// Cookie names only, never values — the flow cookies are single-use
		// secrets, and sid is a credential. An empty list means the request
		// carried no cookies at all; the flow legs landed in different jars.
		console.log(
			JSON.stringify({
				level: 'warn',
				msg: 'oidc: callback arrived without its flow cookies',
				missing: [!state && 'state', !nonce && 'nonce', !codeVerifier && 'verifier'].filter(
					Boolean
				),
				cookieNames:
					request.headers
						.get('cookie')
						?.split(';')
						.map((c) => c.trim().split('=')[0]) ?? [],
				ua: request.headers.get('user-agent')?.slice(0, 140) ?? null
			})
		);
		error(400, 'Login flow expired. Please try again');
	}

	let tokens;
	try {
		tokens = await finishLogin(url, { state, nonce, codeVerifier });
	} catch (e) {
		console.log(
			JSON.stringify({ level: 'warn', msg: 'oidc: callback rejected', err: (e as Error).message })
		);
		error(400, 'Login failed. Please try again');
	}
	const { identity, accessToken } = tokens;

	const db = getDb();
	const stored = await upsertUserFromOidc(db, { clock: systemClock, ids: uuidv7 }, identity);

	// Sync the profile picture from the IdP — but never over a photo the user
	// uploaded themselves. PocketID's picture endpoint requires the access
	// token; a bare fetch just 401s, which is why nothing ever landed. The
	// outcome is logged: a silent catch makes "the picture never shows up"
	// impossible to diagnose.
	if (identity.picture && stored.avatarSource !== 'custom') {
		try {
			// The claim can be a relative path on some IdPs — anchor it to the issuer.
			const issuer = new URL(getEnv().POCKET_ID_ISSUER!);
			const picUrl = new URL(identity.picture, issuer);
			const res = await fetch(picUrl, {
				// The access token is the IdP's, so it only ever goes back to the IdP.
				// A picture hosted anywhere else (a Gravatar, a CDN) is fetched without
				// it — sending it there would hand a live credential to a third party.
				headers: picUrl.origin === issuer.origin ? { authorization: `Bearer ${accessToken}` } : {},
				// A login must not hang on a slow picture host; the avatar is optional.
				signal: AbortSignal.timeout(5_000),
				redirect: picUrl.origin === issuer.origin ? 'follow' : 'error'
			});
			if (!res.ok) {
				console.log(
					JSON.stringify({
						level: 'warn',
						msg: 'oidc: profile picture fetch rejected',
						status: res.status,
						url: picUrl.origin + picUrl.pathname
					})
				);
			} else if (Number(res.headers.get('content-length') ?? 0) > MAX_PICTURE_BYTES) {
				console.log(JSON.stringify({ level: 'warn', msg: 'oidc: profile picture too large' }));
			} else {
				const buf = new Uint8Array(await res.arrayBuffer());
				if (buf.byteLength > MAX_PICTURE_BYTES) throw new Error('profile picture too large');
				const derivative = await processAvatar(buf);
				const blob = await getBlobStore().put(derivative.data, 'webp');
				await db
					.update(user)
					.set({ avatarBlobId: blob.id, avatarSource: 'oidc' })
					.where(eq(user.id, stored.id));
				console.log(JSON.stringify({ level: 'info', msg: 'oidc: profile picture synced' }));
			}
		} catch (e) {
			console.log(
				JSON.stringify({
					level: 'warn',
					msg: 'oidc: profile picture sync failed',
					err: (e as Error).message
				})
			);
		}
	}

	// Signing in again replaces whatever session this browser had: the old one
	// is revoked rather than left valid for the rest of its thirty days.
	const prior = cookies.get(SESSION_COOKIE);
	if (prior) await destroySession(db, hashSessionToken(prior));

	const { session, token } = await createSession(db, stored.id, {
		userAgent: request.headers.get('user-agent'),
		ip: getClientAddress()
	});
	setSessionCookie(cookies, token, session.expiresAt);
	await audit(event, {
		action: 'auth.login',
		workspaceId: null,
		actor: {
			userId: stored.id,
			name: stored.displayName,
			sessionId: session.id,
			sessionUserAgent: session.userAgent
		},
		detail: { oidcSubject: identity.subject }
	});
	redirect(303, '/');
};
