/**
 * SimpleFIN protocol — the pure half. No I/O.
 *
 * SimpleFIN (https://www.simplefin.org/protocol.html) is a read-only bank data
 * protocol: a person buys access at a bridge (SimpleFIN Bridge, ~$15/yr), links
 * their banks *there*, and hands this app a one-time **setup token**. We claim
 * it once, receive an **access URL** (HTTPS with Basic credentials embedded),
 * and from then on GET `/accounts`. There is no write API at all — nothing we
 * hold can move money — which is the main reason it was picked.
 *
 * Everything that crosses the wire is distrusted here:
 *  - the setup token decodes to a URL we will POST to, so it is pinned to an
 *    allowlist of bridge hosts (otherwise it's an SSRF primitive);
 *  - the response is schema-checked, amounts parsed as digits, never floats;
 *  - every string a bank supplied is stripped of control/bidi characters and
 *    length-capped before it is stored or shown.
 */

import * as v from 'valibot';
import { InvalidMoneyError, Money } from '$lib/domain/money/money';

/** Bridges we will talk to unless the operator adds more (SIMPLEFIN_ALLOWED_HOSTS). */
export const DEFAULT_SIMPLEFIN_HOSTS = ['beta-bridge.simplefin.org', 'bridge.simplefin.org'];

/** The protocol's ceiling on one request's date range. */
export const MAX_WINDOW_DAYS = 90;

export class SimpleFinError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message);
		this.name = 'SimpleFinError';
	}
}

// ---------------------------------------------------------------------------
// Tokens and URLs
// ---------------------------------------------------------------------------

function hostAllowed(host: string, allowed: readonly string[]): boolean {
	const h = host.toLowerCase();
	return allowed.some((a) => a.toLowerCase() === h);
}

function checkUrl(u: URL, allowed: readonly string[]): void {
	if (u.protocol !== 'https:') {
		throw new SimpleFinError('SimpleFIN must be reached over HTTPS.', 'insecure');
	}
	// An explicit port is how "https://bridge…:22" style probing would look.
	if (u.port && u.port !== '443') {
		throw new SimpleFinError('That SimpleFIN address uses an unexpected port.', 'port');
	}
	if (!hostAllowed(u.hostname, allowed)) {
		throw new SimpleFinError(
			`This server only connects to ${allowed.join(', ')}. Ask the operator to allow another bridge.`,
			'host'
		);
	}
}

/**
 * A setup token is base64 of the claim URL. Returns that URL, or throws with a
 * message fit to show a person.
 */
export function decodeSetupToken(token: string, allowed: readonly string[]): URL {
	const t = token.trim().replace(/\s+/g, '');
	if (!t || t.length > 2048 || !/^[A-Za-z0-9+/_-]+=*$/.test(t)) {
		throw new SimpleFinError('That doesn’t look like a SimpleFIN setup token.', 'token');
	}
	let decoded: string;
	try {
		const std = t.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
		decoded = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
	} catch {
		throw new SimpleFinError('That doesn’t look like a SimpleFIN setup token.', 'token');
	}
	let url: URL;
	try {
		url = new URL(decoded.trim());
	} catch {
		throw new SimpleFinError('That doesn’t look like a SimpleFIN setup token.', 'token');
	}
	if (url.username || url.password) {
		throw new SimpleFinError('That doesn’t look like a SimpleFIN setup token.', 'token');
	}
	checkUrl(url, allowed);
	return url;
}

export interface AccessCredential {
	/** Base URL without credentials and without a trailing slash. */
	base: string;
	host: string;
	username: string;
	password: string;
}

/** Parse the access URL a claim returned. Credentials leave the URL here. */
export function parseAccessUrl(raw: string, allowed: readonly string[]): AccessCredential {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new SimpleFinError('The bridge returned an unreadable access URL.', 'access_url');
	}
	checkUrl(url, allowed);
	const username = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	if (!username || !password) {
		throw new SimpleFinError(
			'The bridge returned an access URL without credentials.',
			'access_url'
		);
	}
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return {
		base: url.toString().replace(/\/+$/, ''),
		host: url.hostname,
		username,
		password
	};
}

/** Remove anything credential-shaped from a string bound for a log. */
export function redact(s: string): string {
	return s
		.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')
		.replace(/(authorization:\s*basic\s+)\S+/gi, '$1***');
}

// ---------------------------------------------------------------------------
// Bank-supplied text
// ---------------------------------------------------------------------------

/**
 * Strip control characters and bidi overrides (which can make a descriptor
 * render as something it isn't), collapse whitespace, cap the length.
 */
export function sanitizeText(s: unknown, max = 300): string {
	if (typeof s !== 'string') return '';
	return (
		s
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, max)
	);
}

/**
 * A SimpleFIN amount ("-12.30", "+5", "1000.000") as minor units, or null.
 * Extra trailing zeros past the currency's precision are tolerated; real extra
 * precision is not rounded away silently.
 */
export function parseAmount(raw: unknown, currency: string): bigint | null {
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	let s = String(raw).trim().replace(/^\+/, '');
	const m = /^(-?\d+)\.(\d+)$/.exec(s);
	if (m) s = `${m[1]}.${m[2].replace(/0+$/, '')}`.replace(/\.$/, '');
	try {
		return Money.fromDecimal(s, currency).minor;
	} catch (e) {
		if (e instanceof InvalidMoneyError) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const Epoch = v.pipe(v.number(), v.integer(), v.minValue(0));
const Str = v.pipe(v.string(), v.maxLength(4096));

const TransactionSchema = v.object({
	id: Str,
	posted: Epoch,
	amount: v.union([Str, v.number()]),
	description: v.optional(Str, ''),
	payee: v.optional(Str),
	memo: v.optional(Str),
	transacted_at: v.optional(v.nullable(Epoch)),
	pending: v.optional(v.boolean(), false)
});

const AccountSchema = v.object({
	id: Str,
	name: v.optional(Str, ''),
	conn_id: v.optional(Str),
	currency: Str,
	balance: v.union([Str, v.number()]),
	'available-balance': v.optional(v.nullable(v.union([Str, v.number()]))),
	'balance-date': v.optional(v.nullable(Epoch)),
	org: v.optional(v.object({ name: v.optional(Str), domain: v.optional(Str) })),
	transactions: v.optional(v.array(TransactionSchema), [])
});

const AccountSetSchema = v.object({
	errlist: v.optional(
		v.array(
			v.object({
				code: v.optional(Str, 'error'),
				msg: v.optional(Str, ''),
				account_id: v.optional(Str),
				conn_id: v.optional(Str)
			})
		),
		[]
	),
	errors: v.optional(v.array(Str), []),
	connections: v.optional(
		v.array(v.object({ conn_id: Str, name: v.optional(Str), org_id: v.optional(Str) })),
		[]
	),
	accounts: v.pipe(v.array(AccountSchema), v.maxLength(500))
});

export interface FeedTransaction {
	id: string;
	postedAt: Date;
	transactedAt: Date | null;
	amountMinor: bigint;
	description: string;
	pending: boolean;
}

export interface FeedAccount {
	id: string;
	name: string;
	institution: string | null;
	currency: string;
	/** Null when the currency is one we can't represent (custom currency URL). */
	unsupported: string | null;
	balanceMinor: bigint | null;
	availableBalanceMinor: bigint | null;
	balanceAt: Date | null;
	transactions: FeedTransaction[];
}

export interface FeedMessage {
	level: 'warn' | 'error';
	code: string;
	msg: string;
	account?: string;
}

export interface FeedSnapshot {
	accounts: FeedAccount[];
	messages: FeedMessage[];
}

const ISO = /^[A-Z]{3}$/;

/** Validate and normalise a `/accounts` body. Throws on a shape we can't trust. */
export function parseAccountSet(body: unknown): FeedSnapshot {
	const parsed = v.safeParse(AccountSetSchema, body);
	if (!parsed.success) {
		throw new SimpleFinError('The bridge sent a response this app could not read.', 'schema');
	}
	const set = parsed.output;
	const connNames = new Map(set.connections.map((c) => [c.conn_id, c.name ?? null]));

	const messages: FeedMessage[] = [
		...set.errlist.map((e) => ({
			level: 'error' as const,
			code: sanitizeText(e.code, 40) || 'error',
			msg: sanitizeText(e.msg, 300),
			account: e.account_id ? sanitizeText(e.account_id, 100) : undefined
		})),
		...set.errors.map((e) => ({
			level: 'warn' as const,
			code: 'notice',
			msg: sanitizeText(e, 300)
		}))
	];

	const accounts: FeedAccount[] = set.accounts.map((a) => {
		const currency = sanitizeText(a.currency, 16).toUpperCase();
		const unsupported = ISO.test(currency) ? null : 'Custom currency, not supported';
		const institution =
			sanitizeText(a.org?.name ?? (a.conn_id ? connNames.get(a.conn_id) : '') ?? '', 120) || null;

		const transactions: FeedTransaction[] = [];
		if (!unsupported) {
			for (const t of a.transactions) {
				const amountMinor = parseAmount(t.amount, currency);
				if (amountMinor === null) {
					messages.push({
						level: 'warn',
						code: 'amount',
						msg: 'A transaction had an amount that could not be read and was skipped.',
						account: a.id
					});
					continue;
				}
				// A pending transaction may have posted=0. We never store pendings
				// (their ids can change when they post), but tolerate them here.
				const postedSec = t.posted || t.transacted_at || 0;
				if (!postedSec) continue;
				const description =
					sanitizeText(t.description) ||
					sanitizeText(t.payee) ||
					sanitizeText(t.memo) ||
					'(no description)';
				transactions.push({
					id: sanitizeText(t.id, 200),
					postedAt: new Date(postedSec * 1000),
					transactedAt: t.transacted_at ? new Date(t.transacted_at * 1000) : null,
					amountMinor,
					description,
					pending: t.pending
				});
			}
		}

		return {
			id: sanitizeText(a.id, 200),
			name: sanitizeText(a.name, 120) || 'Account',
			institution,
			currency,
			unsupported,
			balanceMinor: unsupported ? null : parseAmount(a.balance, currency),
			availableBalanceMinor:
				unsupported || a['available-balance'] == null
					? null
					: parseAmount(a['available-balance'], currency),
			balanceAt: a['balance-date'] ? new Date(a['balance-date'] * 1000) : null,
			transactions
		};
	});

	return { accounts, messages };
}
