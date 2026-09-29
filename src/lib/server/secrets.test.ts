import { describe, it, expect, vi, beforeEach } from 'vitest';

const env: { SECRETS_KEY?: string } = {};
vi.mock('$lib/server/env', () => ({ getEnv: () => env }));
const { openSecret, sealSecret } = await import('./secrets');

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

beforeEach(() => {
	delete env.SECRETS_KEY;
});

describe('workspace secrets at rest', () => {
	it('round-trips through encryption when a key is configured', () => {
		env.SECRETS_KEY = KEY_A;
		const sealed = sealSecret('sk-live-abc123')!;
		expect(sealed.startsWith('enc:v1:')).toBe(true);
		expect(sealed).not.toContain('sk-live');
		expect(openSecret(sealed)).toBe('sk-live-abc123');
		// Fresh IV each time: equal keys don't produce equal ciphertext.
		expect(sealSecret('sk-live-abc123')).not.toBe(sealed);
	});

	it('leaves values alone without a key, and still reads ones stored before it', () => {
		expect(sealSecret('sk-plain')).toBe('sk-plain');
		env.SECRETS_KEY = KEY_A;
		expect(openSecret('sk-plain')).toBe('sk-plain');
	});

	it('reads as unset rather than garbage with a missing or different key', () => {
		env.SECRETS_KEY = KEY_A;
		const sealed = sealSecret('sk-live-abc123');
		env.SECRETS_KEY = KEY_B;
		expect(openSecret(sealed)).toBeNull();
		delete env.SECRETS_KEY;
		expect(openSecret(sealed)).toBeNull();
	});
});
