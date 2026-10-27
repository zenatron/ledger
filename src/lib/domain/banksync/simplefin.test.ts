import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SIMPLEFIN_HOSTS as HOSTS,
	SimpleFinError,
	decodeSetupToken,
	parseAccessUrl,
	parseAccountSet,
	parseAmount,
	redact,
	sanitizeText
} from './simplefin';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('decodeSetupToken', () => {
	it('decodes the bridge claim URL', () => {
		const u = decodeSetupToken(
			b64('https://beta-bridge.simplefin.org/simplefin/claim/demo'),
			HOSTS
		);
		expect(u.toString()).toBe('https://beta-bridge.simplefin.org/simplefin/claim/demo');
	});

	it('accepts url-safe base64 and surrounding whitespace', () => {
		const t = b64('https://bridge.simplefin.org/claim/x?y=1')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
		expect(decodeSetupToken(`  ${t}\n`, HOSTS).hostname).toBe('bridge.simplefin.org');
	});

	it.each([
		['a host not on the allowlist', 'https://evil.example/claim/x', 'host'],
		['an internal address', 'https://169.254.169.254/latest/meta-data', 'host'],
		['plain http', 'http://beta-bridge.simplefin.org/claim/x', 'insecure'],
		['an odd port', 'https://beta-bridge.simplefin.org:8443/claim', 'port'],
		['embedded credentials', 'https://u:p@beta-bridge.simplefin.org/claim', 'token']
	])('refuses %s', (_, url, code) => {
		try {
			decodeSetupToken(b64(url), HOSTS);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(SimpleFinError);
			expect((e as SimpleFinError).code).toBe(code);
		}
	});

	it('refuses garbage', () => {
		expect(() => decodeSetupToken('not a token!', HOSTS)).toThrow(SimpleFinError);
		expect(() => decodeSetupToken(b64('just words'), HOSTS)).toThrow(SimpleFinError);
		expect(() => decodeSetupToken('', HOSTS)).toThrow(SimpleFinError);
	});
});

describe('parseAccessUrl', () => {
	it('splits credentials out of the URL', () => {
		const c = parseAccessUrl('https://user%40x:p%3Ass@beta-bridge.simplefin.org/simplefin/', HOSTS);
		expect(c).toEqual({
			base: 'https://beta-bridge.simplefin.org/simplefin',
			host: 'beta-bridge.simplefin.org',
			username: 'user@x',
			password: 'p:ss'
		});
	});

	it('refuses an access URL for another host or without credentials', () => {
		expect(() => parseAccessUrl('https://u:p@evil.example/simplefin', HOSTS)).toThrow(
			SimpleFinError
		);
		expect(() => parseAccessUrl('https://beta-bridge.simplefin.org/simplefin', HOSTS)).toThrow(
			SimpleFinError
		);
	});
});

describe('redact', () => {
	it('removes URL credentials and basic auth headers', () => {
		expect(redact('GET https://u:secret@host/x failed')).toBe('GET https://***@host/x failed');
		expect(redact('Authorization: Basic dTpw')).toBe('Authorization: Basic ***');
	});
});

describe('sanitizeText', () => {
	it('strips control and bidi characters and caps length', () => {
		expect(sanitizeText('AMAZON‮MOC\u0007  MKTP\n')).toBe('AMAZON MOC MKTP');
		expect(sanitizeText('x'.repeat(500), 10)).toHaveLength(10);
		expect(sanitizeText(42)).toBe('');
	});
});

describe('parseAmount', () => {
	it.each([
		['-12.30', -1230n],
		['+5', 500n],
		['1000.000', 100000n],
		['0.5', 50n],
		['-33293.43', -3329343n],
		[12.5, 1250n]
	])('%s → %s', (raw, want) => expect(parseAmount(raw, 'USD')).toBe(want));

	it('respects the currency precision without silently rounding', () => {
		expect(parseAmount('1.005', 'USD')).toBeNull();
		expect(parseAmount('1500', 'JPY')).toBe(1500n);
		expect(parseAmount('1,234.00', 'USD')).toBeNull();
		expect(parseAmount('1e3', 'USD')).toBeNull();
	});
});

describe('parseAccountSet', () => {
	const body = {
		errlist: [{ code: 'con.auth', msg: 'Chase needs you to log in again\u0000', conn_id: 'C1' }],
		connections: [{ conn_id: 'C1', name: 'Chase', org_id: 'o' }],
		accounts: [
			{
				id: 'A1',
				name: 'Sapphire ·1234',
				conn_id: 'C1',
				currency: 'USD',
				balance: '-512.34',
				'available-balance': '4487.66',
				'balance-date': 1793000000,
				transactions: [
					{ id: 'T1', posted: 1792900000, amount: '-12.30', description: 'SQ *BLUE BOTTLE' },
					{ id: 'T2', posted: 0, amount: '-1.00', description: 'PENDING', pending: true },
					{ id: 'T3', posted: 1792900100, amount: 'abc', description: 'BROKEN' }
				]
			},
			{ id: 'A2', name: 'Points', currency: 'https://points.example', balance: '100' }
		]
	};

	it('normalises accounts, transactions and errors', () => {
		const s = parseAccountSet(body);
		expect(s.accounts).toHaveLength(2);
		const [a, pts] = s.accounts;
		expect(a.institution).toBe('Chase');
		expect(a.balanceMinor).toBe(-51234n);
		expect(a.availableBalanceMinor).toBe(448766n);
		// The pending one has no posted date and is dropped; the broken amount is
		// skipped with a warning rather than failing the whole sync.
		expect(a.transactions.map((t) => t.id)).toEqual(['T1']);
		expect(a.transactions[0].amountMinor).toBe(-1230n);
		expect(pts.unsupported).toMatch(/custom currency/i);
		expect(pts.balanceMinor).toBeNull();
		expect(s.messages[0]).toMatchObject({ level: 'error', code: 'con.auth' });
		expect(s.messages[0].msg).not.toContain('\u0000');
		expect(s.messages.some((m) => m.code === 'amount')).toBe(true);
	});

	it('refuses a body that is not an account set', () => {
		expect(() => parseAccountSet({ nope: true })).toThrow(SimpleFinError);
		expect(() => parseAccountSet('<html>')).toThrow(SimpleFinError);
	});
});
