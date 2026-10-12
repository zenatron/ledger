import type { AccountSet } from '$lib/domain/bankfeed/simplefin';

/**
 * Where synced bank transactions come from. One adapter today, SimpleFIN
 * (`infra/bankfeed/simplefin-client`); the shape is the protocol's, because it
 * is already the smallest thing that does the job: trade a one-time token for
 * a credential, then read accounts and posted transactions with it.
 *
 * Both methods throw on failure, with a message a person can act on — the sync
 * records it against the connection rather than swallowing it.
 */
export interface BankFeed {
	/** Trade a setup token for a long-lived access URL. Works once per token. */
	claim(setupToken: string): Promise<string>;
	/** Accounts and their posted transactions in [start, end]. */
	accounts(
		accessUrl: string,
		window: { start: Date; end: Date } | { balancesOnly: true }
	): Promise<AccountSet>;
}
