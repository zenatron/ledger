import type { FeedSnapshot } from '$lib/domain/banksync/simplefin';

/**
 * The port a bank feed is read through. Read-only by construction: there is no
 * method that could send anything to a bank, and the provider behind it
 * (SimpleFIN) has no write API to call even if there were.
 *
 * Unlike the geocoder and LLM ports this one *does* throw — a `SimpleFinError`
 * with a code the sync records (`revoked`, `payment`, `http`, `network`,
 * `schema`, …). A sync that silently returned nothing would look like a quiet
 * month, which is the one thing a bank feed must never be mistaken for.
 */
export interface BankFeedClient {
	/** Exchange a one-time setup token for a long-lived access URL. */
	claim(setupToken: string): Promise<string>;
	/** GET /accounts for a window. Pending transactions are never requested. */
	fetchAccounts(
		accessUrl: string,
		q: { start: Date; end: Date; balancesOnly?: boolean }
	): Promise<FeedSnapshot & { httpStatus: number }>;
}
