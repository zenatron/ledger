/**
 * The SimpleFIN protocol, minus the network.
 *
 * SimpleFIN (https://www.simplefin.org/protocol.html) is two requests. A setup
 * token is a base64'd *claim URL*; POSTing to it once returns an *access URL*
 * with credentials in its userinfo, `https://user:pass@host/simplefin`. Every
 * read after that is `GET {access}/accounts`, which answers with an "account
 * set": accounts, each with a balance and its transactions.
 *
 * Everything here is pure so the shapes the bridge sends can be tested without
 * one. The I/O half is `infra/bankfeed/simplefin-client`.
 */

import { Money } from '$lib/domain/money/money';
import type { RawStatementLine } from '$lib/domain/reconcile/parse-csv';
import { normaliseDescription } from '$lib/domain/reconcile/parse-csv';

export class SimplefinError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SimplefinError';
	}
}

/**
 * The claim URL inside a setup token, refused unless it is https on a host the
 * operator allowed. The server POSTs to whatever this decodes to, so without
 * the allowlist a pasted token is a request to anywhere the server can reach.
 */
export function decodeSetupToken(token: string, allowedHosts: readonly string[]): URL {
	const trimmed = token.trim();
	if (!trimmed) throw new SimplefinError('Paste the setup token from SimpleFIN Bridge.');
	let decoded: string;
	try {
		decoded = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/')).trim();
	} catch {
		throw new SimplefinError('That does not look like a SimpleFIN setup token.');
	}
	let url: URL;
	try {
		url = new URL(decoded);
	} catch {
		throw new SimplefinError('That does not look like a SimpleFIN setup token.');
	}
	if (url.protocol !== 'https:') {
		throw new SimplefinError('That setup token does not point at an https address.');
	}
	if (!allowedHosts.includes(url.hostname.toLowerCase())) {
		throw new SimplefinError(
			`That setup token points at ${url.hostname}, which this server is not set up to talk to. The operator can allow it with SIMPLEFIN_HOSTS.`
		);
	}
	return url;
}

/**
 * Split an access URL into the base to request and the Basic credential to send.
 * `fetch` refuses URLs with credentials in them, so they travel as a header.
 */
export function splitAccessUrl(
	accessUrl: string,
	allowedHosts: readonly string[]
): { base: string; authorization: string } {
	let url: URL;
	try {
		url = new URL(accessUrl);
	} catch {
		throw new SimplefinError('The stored SimpleFIN access URL is not valid. Reconnect the bank.');
	}
	if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase())) {
		throw new SimplefinError(
			`This connection points at ${url.hostname}, which this server is not set up to talk to.`
		);
	}
	const user = decodeURIComponent(url.username);
	const pass = decodeURIComponent(url.password);
	url.username = '';
	url.password = '';
	const base = url.toString().replace(/\/+$/, '');
	const bytes = new TextEncoder().encode(`${user}:${pass}`);
	return { base, authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` };
}

/** One account as the ledger keeps it. */
export interface FeedAccount {
	externalId: string;
	name: string;
	orgName: string | null;
	currency: string;
	balanceMinor: bigint | null;
	balanceAt: Date | null;
	transactions: FeedTransaction[];
}

/** A posted transaction, already in the shape statement lines are made of. */
export interface FeedTransaction extends RawStatementLine {
	/** The bridge's id, unique within its account. */
	id: string;
}

export interface AccountSet {
	accounts: FeedAccount[];
	/** Messages the bridge wants shown — usually an institution needing a re-login. */
	errors: string[];
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
	return null;
}

/**
 * Amounts arrive as decimal strings ("-12.34"). Parsed with the currency's own
 * precision; a value with more places than the currency has is dropped as
 * unreadable rather than rounded.
 */
function amount(v: unknown, currency: string): bigint | null {
	const s = str(v) ?? (typeof v === 'number' ? String(v) : null);
	if (s === null) return null;
	try {
		return Money.fromDecimal(s.replace(/^\+/, ''), currency).minor;
	} catch {
		return null;
	}
}

/**
 * Noon UTC on the calendar day the bridge reports. Banks give dates, not
 * instants; the bridge turns them into epoch seconds at an arbitrary hour. The
 * CSV parser pins dates to noon UTC, and synced lines must agree with it so the
 * matcher's day arithmetic means the same thing for both.
 */
function postedDay(epochSeconds: number): Date {
	const d = new Date(epochSeconds * 1000);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}

/**
 * Read an account-set response. Tolerant of what it does not need and strict
 * about what it does: a transaction without an id, a posted date or a readable
 * amount is skipped, never invented. Pending transactions are skipped too — a
 * pending charge changes amount and id when it posts, and reconciliation wants
 * the settled fact.
 */
export function parseAccountSet(body: unknown): AccountSet {
	if (!body || typeof body !== 'object') {
		throw new SimplefinError('SimpleFIN answered with something that is not an account list.');
	}
	const o = body as Record<string, unknown>;
	const errors: string[] = [];
	if (Array.isArray(o.errors)) {
		for (const e of o.errors) if (typeof e === 'string' && e.trim()) errors.push(e.trim());
	}
	// Protocol v2 reports errors as objects.
	if (Array.isArray(o.errlist)) {
		for (const e of o.errlist) {
			const msg = e && typeof e === 'object' ? str((e as Record<string, unknown>).msg) : null;
			if (msg?.trim()) errors.push(msg.trim());
		}
	}

	const accounts: FeedAccount[] = [];
	for (const raw of Array.isArray(o.accounts) ? o.accounts : []) {
		if (!raw || typeof raw !== 'object') continue;
		const a = raw as Record<string, unknown>;
		const externalId = str(a.id);
		const currency = (str(a.currency) ?? '').toUpperCase();
		// A custom currency is a URL; nothing in the ledger can hold it.
		if (!externalId || !ISO_CURRENCY.test(currency)) continue;
		const org = a.org && typeof a.org === 'object' ? (a.org as Record<string, unknown>) : null;
		const balanceDate = num(a['balance-date']);

		const transactions: FeedTransaction[] = [];
		for (const rt of Array.isArray(a.transactions) ? a.transactions : []) {
			if (!rt || typeof rt !== 'object') continue;
			const t = rt as Record<string, unknown>;
			const id = str(t.id);
			const posted = num(t.posted);
			const minor = amount(t.amount, currency);
			if (!id || !posted || minor === null || t.pending === true) continue;
			const description = (str(t.description) ?? str(t.payee) ?? str(t.memo) ?? '').trim();
			transactions.push({
				id,
				postedAt: postedDay(posted),
				amountMinor: minor,
				currency,
				rawDescription: description || '(no description)',
				normalizedDescription: normaliseDescription(description)
			});
		}

		accounts.push({
			externalId,
			name: (str(a.name) ?? '').trim() || 'Account',
			orgName: (str(org?.name) ?? str(org?.domain) ?? '').trim() || null,
			currency,
			balanceMinor: amount(a.balance, currency),
			balanceAt: balanceDate ? new Date(balanceDate * 1000) : null,
			transactions
		});
	}
	return { accounts, errors };
}
