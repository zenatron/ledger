/**
 * Remote MCP endpoint. Authenticated by a personal access token (Bearer), it
 * exposes the workspace's tools to any MCP client — Claude, ChatGPT connectors,
 * editors. The token resolves to a single workspace member, and every tool runs
 * as that member, so seals, approval routing and permissions all apply.
 *
 * Add the server in a client as:  <origin>/mcp  with header
 *   Authorization: Bearer ldg_…
 */
import { json, text } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getNotifier } from '$lib/server/notify';
import { systemClock } from '$lib/infra/time/system-clock';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { rateLimitOk } from '$lib/server/rate-limit';
import { authenticateToken } from '$lib/server/repo/api-tokens';
import { dispatch, type JsonRpcRequest } from '$lib/server/mcp/server';
import type { ToolContext } from '$lib/server/mcp/tools';
import type { RequestHandler } from './$types';

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
	'Access-Control-Max-Age': '86400'
};

/** Per-token calls a minute: generous, but bounds a runaway agent loop. */
const CALLS_PER_MINUTE = 240;
/** Messages in one JSON-RPC batch. Clients send one at a time in practice. */
const MAX_BATCH = 20;

function unauthorized(message: string) {
	return json(
		{ jsonrpc: '2.0', id: null, error: { code: -32001, message } },
		{ status: 401, headers: { ...CORS, 'WWW-Authenticate': 'Bearer realm="ledger-mcp"' } }
	);
}

export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: CORS });

// A bare GET (some clients probe for an SSE stream). We don't offer one — all
// traffic is request/response over POST — so say so plainly.
export const GET: RequestHandler = () =>
	text('This is an MCP endpoint. POST JSON-RPC with an Authorization: Bearer token.', {
		status: 405,
		headers: { ...CORS, Allow: 'POST, OPTIONS' }
	});

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const auth = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
	if (!match) return unauthorized('Missing bearer token. Add Authorization: Bearer ldg_…');

	// Damp brute-forcing before the (constant-time) hash lookup.
	if (!rateLimitOk(`mcp-auth:${getClientAddress()}`, 30, 60_000)) {
		return json(
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32002, message: 'Too many attempts. Wait a minute.' }
			},
			{ status: 429, headers: CORS }
		);
	}

	const now = systemClock.now();
	const authed = await authenticateToken(getDb(), match[1].trim(), now);
	if (!authed) return unauthorized('Invalid, expired, or revoked token.');

	// Per-token call budget: generous, but bounds a runaway agent loop.
	if (!rateLimitOk(`mcp-call:${authed.tokenId}`, CALLS_PER_MINUTE, 60_000)) {
		return json(
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32002, message: 'Rate limit exceeded. Slow down.' }
			},
			{ status: 429, headers: CORS }
		);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ status: 400, headers: CORS }
		);
	}

	const ctx: ToolContext = {
		db: getDb(),
		deps: { clock: systemClock, ids: uuidv7, notifier: getNotifier() },
		authed,
		now
	};

	// A batch (array) or a single message. Notifications (no id) produce no reply.
	const messages = Array.isArray(body) ? body : [body];
	// The call budget above counts requests, so a batch is bounded and every
	// message after the first is charged to it too — otherwise one POST of a
	// thousand tool calls would cost the same as one.
	if (messages.length > MAX_BATCH) {
		return json(
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: `Batch too large. Send at most ${MAX_BATCH} messages.` }
			},
			{ status: 400, headers: CORS }
		);
	}
	const responses = [];
	for (const [i, m] of messages.entries()) {
		if (i > 0 && !rateLimitOk(`mcp-call:${authed.tokenId}`, CALLS_PER_MINUTE, 60_000)) {
			// Dropped either way; only a request (one with an id) is owed a reply.
			const id = (m as JsonRpcRequest | null)?.id;
			if (id !== undefined) {
				responses.push({
					jsonrpc: '2.0',
					id,
					error: { code: -32002, message: 'Rate limit exceeded. Slow down.' }
				});
			}
			continue;
		}
		if (!m || typeof m !== 'object' || (m as JsonRpcRequest).jsonrpc !== '2.0') {
			responses.push({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Invalid Request' }
			});
			continue;
		}
		const res = await dispatch(ctx, m as JsonRpcRequest);
		if (res) responses.push(res);
	}

	// All notifications → 202 with no body, per JSON-RPC.
	if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
	return json(Array.isArray(body) ? responses : responses[0], { headers: CORS });
};
