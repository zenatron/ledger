/**
 * SimpleFIN over the network. The protocol's shapes and validation live in
 * `domain/bankfeed/simplefin`; this is only the two requests.
 *
 * Redirects are refused: the host allowlist is checked on the URL we were
 * given, and following a redirect would let the far end send the request (and
 * its Basic credential) somewhere that check never saw.
 */

import {
	SimplefinError,
	decodeSetupToken,
	parseAccountSet,
	splitAccessUrl
} from '$lib/domain/bankfeed/simplefin';
import type { BankFeed } from '$lib/ports/bank-feed';

const TIMEOUT_MS = 30_000;

type Fetch = typeof fetch;

async function send(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetchImpl(url, {
			...init,
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (e) {
		const timedOut = e instanceof Error && e.name === 'TimeoutError';
		throw new SimplefinError(
			timedOut ? 'SimpleFIN did not answer in time.' : 'Could not reach SimpleFIN.'
		);
	}
}

export function createSimplefinFeed(opts: {
	allowedHosts: readonly string[];
	fetch?: Fetch;
}): BankFeed {
	const fetchImpl = opts.fetch ?? fetch;
	return {
		async claim(setupToken) {
			const claimUrl = decodeSetupToken(setupToken, opts.allowedHosts);
			const res = await send(fetchImpl, claimUrl.toString(), {
				method: 'POST',
				headers: { 'content-length': '0' }
			});
			if (res.status === 403) {
				throw new SimplefinError(
					'That setup token has already been used, or has expired. Create a new one in SimpleFIN Bridge.'
				);
			}
			if (!res.ok) throw new SimplefinError(`SimpleFIN refused the token (HTTP ${res.status}).`);
			const accessUrl = (await res.text()).trim();
			// Validate before it is stored: the same allowlist governs every read.
			splitAccessUrl(accessUrl, opts.allowedHosts);
			return accessUrl;
		},

		async accounts(accessUrl, window) {
			const { base, authorization } = splitAccessUrl(accessUrl, opts.allowedHosts);
			const q = new URLSearchParams();
			if ('balancesOnly' in window) {
				q.set('balances-only', '1');
			} else {
				q.set('start-date', String(Math.floor(window.start.getTime() / 1000)));
				q.set('end-date', String(Math.floor(window.end.getTime() / 1000)));
			}
			const res = await send(fetchImpl, `${base}/accounts?${q}`, {
				headers: { authorization, accept: 'application/json' }
			});
			if (res.status === 401 || res.status === 403) {
				throw new SimplefinError(
					'SimpleFIN no longer accepts this connection. It may have been revoked in SimpleFIN Bridge; connect it again.'
				);
			}
			if (res.status === 402) {
				throw new SimplefinError('The SimpleFIN Bridge subscription needs attention.');
			}
			if (!res.ok) throw new SimplefinError(`SimpleFIN answered HTTP ${res.status}.`);
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				throw new SimplefinError('SimpleFIN answered with something that is not an account list.');
			}
			return parseAccountSet(body);
		}
	};
}
