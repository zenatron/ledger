import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendNtfy } from './ntfy';

afterEach(() => vi.unstubAllGlobals());

function capture() {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			// Build a real Request, so header validation runs exactly as undici's
			// would: this is what threw on a Cyrillic title before.
			new Request(url, init);
			calls.push({ url, init });
			return new Response(null, { status: 200 });
		})
	);
	return calls;
}

const target = { serverUrl: 'https://ntfy.example/', topic: 'household-abc' };
const msg = {
	title: 'Анна requested approval 🎁',
	body: '李 · 小笼包 · ¥88',
	path: '/w/home/purchases/1',
	origin: 'https://ledger.example',
	tag: '1'
};

describe('sendNtfy', () => {
	it('sends any name, in UTF-8, in the body', async () => {
		const calls = capture();
		expect(await sendNtfy(target, msg)).toBe(true);
		expect(calls[0].url).toBe('https://ntfy.example');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			topic: 'household-abc',
			title: 'Анна requested approval 🎁',
			message: '李 · 小笼包 · ¥88',
			click: 'https://ledger.example/w/home/purchases/1',
			tags: ['moneybag']
		});
	});

	it("keeps the deployment's token to the deployment's own server", async () => {
		const calls = capture();
		const token = { value: 'secret', origin: 'https://ntfy.example' };
		await sendNtfy(target, msg, token);
		await sendNtfy({ serverUrl: 'https://elsewhere.example', topic: 't' }, msg, token);
		const auth = (i: number) => new Headers(calls[i].init.headers).get('authorization');
		expect(auth(0)).toBe('Bearer secret');
		expect(auth(1)).toBeNull();
	});
});
