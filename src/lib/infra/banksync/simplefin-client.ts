import type { BankFeedClient } from '$lib/ports/bank-feed';
import {
	SimpleFinError,
	decodeSetupToken,
	parseAccessUrl,
	parseAccountSet
} from '$lib/domain/banksync/simplefin';

const TIMEOUT_MS = 60_000;
/** A year of a busy household's transactions is well under 1 MB. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const USER_AGENT = 'ledger-budget (self-hosted; +https://github.com/zenatron/ledger)';

/**
 * Read a body with a hard size cap, so a misbehaving (or impersonated) bridge
 * can't make the server buffer an unbounded response.
 */
async function readCapped(res: Response): Promise<string> {
	const declared = Number(res.headers.get('content-length') ?? '0');
	if (declared > MAX_BODY_BYTES)
		throw new SimpleFinError('The bridge response was too large.', 'size');
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new SimpleFinError('The bridge response was too large.', 'size');
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function send(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, {
			...init,
			// A redirect could carry the Authorization header somewhere we never
			// vetted. The protocol has no reason to redirect, so we refuse to.
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain', ...init.headers }
		});
	} catch (e) {
		const name = (e as Error).name;
		throw new SimpleFinError(
			name === 'TimeoutError'
				? 'The bridge took too long to answer.'
				: 'Could not reach the bridge.',
			name === 'TimeoutError' ? 'timeout' : 'network'
		);
	}
}

export function simpleFinClient(allowedHosts: readonly string[]): BankFeedClient {
	return {
		async claim(setupToken) {
			const claimUrl = decodeSetupToken(setupToken, allowedHosts);
			const res = await send(claimUrl.toString(), {
				method: 'POST',
				headers: { 'content-length': '0' }
			});
			if (res.status === 403) {
				// Per the protocol: an already-claimed token may mean someone else
				// claimed it first. Say so — the person should disable it at the bridge.
				throw new SimpleFinError(
					'That setup token was already used. If you didn’t use it, disable it at SimpleFIN Bridge and create a new one.',
					'claimed'
				);
			}
			if (!res.ok)
				throw new SimpleFinError(`The bridge refused the token (HTTP ${res.status}).`, 'http');
			const body = (await readCapped(res)).trim();
			// Validates https + host + credentials before we ever store it.
			parseAccessUrl(body, allowedHosts);
			return body;
		},

		async fetchAccounts(accessUrl, q) {
			const cred = parseAccessUrl(accessUrl, allowedHosts);
			const params = new URLSearchParams({
				'start-date': String(Math.floor(q.start.getTime() / 1000)),
				'end-date': String(Math.ceil(q.end.getTime() / 1000)),
				version: '2'
			});
			if (q.balancesOnly) params.set('balances-only', '1');
			const auth = Buffer.from(`${cred.username}:${cred.password}`, 'utf8').toString('base64');
			const res = await send(`${cred.base}/accounts?${params}`, {
				method: 'GET',
				headers: { authorization: `Basic ${auth}` }
			});
			if (res.status === 403) {
				throw new SimpleFinError(
					'SimpleFIN refused access. The connection was disabled at the bridge — reconnect with a new setup token.',
					'revoked'
				);
			}
			if (res.status === 402) {
				throw new SimpleFinError(
					'SimpleFIN Bridge says the subscription needs payment.',
					'payment'
				);
			}
			if (!res.ok) throw new SimpleFinError(`The bridge answered HTTP ${res.status}.`, 'http');
			let body: unknown;
			try {
				body = JSON.parse(await readCapped(res));
			} catch (e) {
				if (e instanceof SimpleFinError) throw e;
				throw new SimpleFinError('The bridge sent a response this app could not read.', 'schema');
			}
			return { ...parseAccountSet(body), httpStatus: res.status };
		}
	};
}
