import { getEnv } from '$lib/server/env';
import { openSecret, sealSecret } from '$lib/server/secrets';
import { serverDeps } from '$lib/server/deps';
import { createSimplefinFeed } from '$lib/infra/bankfeed/simplefin-client';
import type { BankFeed } from '$lib/ports/bank-feed';
import type { SecretBox } from '$lib/application/bank-sync';

/**
 * Bank sync's half of the composition root.
 *
 * Available only with `SECRETS_KEY` set: the access URL it stores reads the
 * household's bank history, so unlike the model key it is never kept in the
 * clear, and without a key there is nothing to keep it under.
 */
export function bankSyncAvailable(): boolean {
	return !!getEnv().SECRETS_KEY;
}

let feed: BankFeed | undefined;

const secrets: SecretBox = {
	seal: (plain) => sealSecret(plain),
	open: (stored) => openSecret(stored)
};

export function bankSyncDeps() {
	feed ??= createSimplefinFeed({ allowedHosts: getEnv().SIMPLEFIN_HOSTS });
	return { ...serverDeps(), feed, secrets };
}
