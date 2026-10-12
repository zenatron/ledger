import { describe, it, expect } from 'vitest';
import { SimplefinError, decodeSetupToken, parseAccountSet, splitAccessUrl } from './simplefin';

const HOSTS = ['beta-bridge.simplefin.org'];
const token = (url: string) => btoa(url);

describe('decodeSetupToken', () => {
	it('decodes a claim URL on an allowed host', () => {
		const url = decodeSetupToken(
			token('https://beta-bridge.simplefin.org/simplefin/claim/abc'),
			HOSTS
		);
		expect(url.toString()).toBe('https://beta-bridge.simplefin.org/simplefin/claim/abc');
	});

	it('tolerates surrounding whitespace', () => {
		const t = `  ${token('https://beta-bridge.simplefin.org/claim/x')}\n`;
		expect(decodeSetupToken(t, HOSTS).hostname).toBe('beta-bridge.simplefin.org');
	});

	it('refuses a host the operator did not allow', () => {
		expect(() => decodeSetupToken(token('https://169.254.169.254/latest'), HOSTS)).toThrow(
			/not set up to talk to/
		);
	});

	it('refuses plain http', () => {
		expect(() => decodeSetupToken(token('http://beta-bridge.simplefin.org/claim'), HOSTS)).toThrow(
			/https/
		);
	});

	it('refuses garbage and blanks', () => {
		expect(() => decodeSetupToken('', HOSTS)).toThrow(SimplefinError);
		expect(() => decodeSetupToken('not base64 at all!!', HOSTS)).toThrow(SimplefinError);
		expect(() => decodeSetupToken(token('just words'), HOSTS)).toThrow(SimplefinError);
	});
});

describe('splitAccessUrl', () => {
	it('moves the credentials into a Basic header', () => {
		const { base, authorization } = splitAccessUrl(
			'https://user:p%40ss@beta-bridge.simplefin.org/simplefin',
			HOSTS
		);
		expect(base).toBe('https://beta-bridge.simplefin.org/simplefin');
		expect(authorization).toBe(`Basic ${btoa('user:p@ss')}`);
	});

	it('refuses a stored URL on a host no longer allowed', () => {
		expect(() => splitAccessUrl('https://u:p@evil.example/simplefin', HOSTS)).toThrow(
			SimplefinError
		);
	});
});

describe('parseAccountSet', () => {
	const posted = Date.UTC(2026, 9, 3, 4, 30) / 1000;

	it('reads accounts and posted transactions', () => {
		const set = parseAccountSet({
			errors: ['Reconnect Chase'],
			accounts: [
				{
					org: { name: 'Chase', domain: 'chase.com' },
					id: 'ACT-1',
					name: 'Sapphire',
					currency: 'USD',
					balance: '-1234.56',
					'balance-date': posted,
					transactions: [
						{ id: 'T1', posted, amount: '-12.34', description: 'SQ *BLUE BOTTLE' },
						{ id: 'T2', posted, amount: '100.00', description: 'PAYMENT THANK YOU' }
					]
				}
			]
		});
		expect(set.errors).toEqual(['Reconnect Chase']);
		expect(set.accounts).toHaveLength(1);
		const a = set.accounts[0];
		expect(a).toMatchObject({
			externalId: 'ACT-1',
			name: 'Sapphire',
			orgName: 'Chase',
			currency: 'USD',
			balanceMinor: -123456n
		});
		expect(a.transactions.map((t) => [t.id, t.amountMinor])).toEqual([
			['T1', -1234n],
			['T2', 10000n]
		]);
		// Pinned to noon UTC on the posted calendar day, like CSV lines.
		expect(a.transactions[0].postedAt.toISOString()).toBe('2026-10-03T12:00:00.000Z');
		expect(a.transactions[0].normalizedDescription).toBe('sq *blue bottle');
	});

	it('skips pending, undated, and unreadable transactions', () => {
		const set = parseAccountSet({
			accounts: [
				{
					id: 'A',
					name: 'Checking',
					currency: 'USD',
					balance: '10.00',
					transactions: [
						{ id: 'P', posted, amount: '-1.00', description: 'x', pending: true },
						{ id: 'Z', posted: 0, amount: '-1.00', description: 'x' },
						{ id: 'B', posted, amount: '-1.005', description: 'x' },
						{ posted, amount: '-1.00', description: 'no id' },
						{ id: 'OK', posted, amount: '-1.00', description: '' }
					]
				}
			]
		});
		const txns = set.accounts[0].transactions;
		expect(txns.map((t) => t.id)).toEqual(['OK']);
		expect(txns[0].rawDescription).toBe('(no description)');
	});

	it('drops accounts in a currency the ledger cannot hold', () => {
		const set = parseAccountSet({
			accounts: [{ id: 'X', name: 'Points', currency: 'https://example.com/points', balance: '5' }]
		});
		expect(set.accounts).toEqual([]);
	});

	it('reads protocol v2 error objects', () => {
		expect(
			parseAccountSet({ errlist: [{ code: 'con.auth', msg: 'Login needed' }] }).errors
		).toEqual(['Login needed']);
	});

	it('refuses something that is not an object', () => {
		expect(() => parseAccountSet('nope')).toThrow(SimplefinError);
	});
});
