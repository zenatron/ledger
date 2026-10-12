import { describe, it, expect } from 'vitest';
import { createSimplefinFeed } from './simplefin-client';

const HOSTS = ['beta-bridge.simplefin.org'];

function recorder(respond: (url: string, init: RequestInit) => Response) {
	const seen: { url: string; init: RequestInit }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		return respond(url, init);
	}) as unknown as typeof fetch;
	return { seen, fetchImpl };
}

describe('simplefin client', () => {
	it('claims a token with a POST and refuses redirects', async () => {
		const { seen, fetchImpl } = recorder(
			() => new Response('https://u:p@beta-bridge.simplefin.org/simplefin\n')
		);
		const feed = createSimplefinFeed({ allowedHosts: HOSTS, fetch: fetchImpl });
		const url = await feed.claim(btoa('https://beta-bridge.simplefin.org/simplefin/claim/abc'));
		expect(url).toBe('https://u:p@beta-bridge.simplefin.org/simplefin');
		expect(seen[0].init.method).toBe('POST');
		expect(seen[0].init.redirect).toBe('error');
	});

	it('says a used token is used', async () => {
		const { fetchImpl } = recorder(() => new Response('', { status: 403 }));
		const feed = createSimplefinFeed({ allowedHosts: HOSTS, fetch: fetchImpl });
		await expect(
			feed.claim(btoa('https://beta-bridge.simplefin.org/simplefin/claim/abc'))
		).rejects.toThrow(/already been used/);
	});

	it('refuses an access URL pointing off the allowlist', async () => {
		const { fetchImpl } = recorder(() => new Response('https://u:p@evil.example/simplefin'));
		const feed = createSimplefinFeed({ allowedHosts: HOSTS, fetch: fetchImpl });
		await expect(
			feed.claim(btoa('https://beta-bridge.simplefin.org/simplefin/claim/abc'))
		).rejects.toThrow(/not set up to talk to/);
	});

	it('reads accounts with Basic auth and a date window, never credentials in the URL', async () => {
		const { seen, fetchImpl } = recorder(() => Response.json({ errors: [], accounts: [] }));
		const feed = createSimplefinFeed({ allowedHosts: HOSTS, fetch: fetchImpl });
		await feed.accounts('https://user:pass@beta-bridge.simplefin.org/simplefin', {
			start: new Date(1_700_000_000_000),
			end: new Date(1_700_086_400_000)
		});
		const { url, init } = seen[0];
		expect(url).toBe(
			'https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1700000000&end-date=1700086400'
		);
		expect((init.headers as Record<string, string>).authorization).toBe(
			`Basic ${btoa('user:pass')}`
		);
	});

	it('turns a revoked connection into words', async () => {
		const { fetchImpl } = recorder(() => new Response('', { status: 403 }));
		const feed = createSimplefinFeed({ allowedHosts: HOSTS, fetch: fetchImpl });
		await expect(
			feed.accounts('https://u:p@beta-bridge.simplefin.org/simplefin', { balancesOnly: true })
		).rejects.toThrow(/no longer accepts/);
	});
});
