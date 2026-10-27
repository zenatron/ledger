import { getEnv } from '$lib/server/env';
import { openSecret, sealSecret } from '$lib/server/secrets';
import { systemClock } from '$lib/infra/time/system-clock';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { simpleFinClient } from '$lib/infra/banksync/simplefin-client';
import { DEFAULT_SIMPLEFIN_HOSTS } from '$lib/domain/banksync/simplefin';
import type { BankSyncDeps } from '$lib/application/bank-sync';

let instance: BankSyncDeps | undefined;

/** Bank sync bound to its real adapters and this deployment's configuration. */
export function bankSyncDeps(): BankSyncDeps {
	if (instance) return instance;
	const env = getEnv();
	const extra = env.SIMPLEFIN_ALLOWED_HOSTS.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter((h) => /^[a-z0-9.-]+$/.test(h));
	instance = {
		clock: systemClock,
		ids: uuidv7,
		feed: simpleFinClient([...DEFAULT_SIMPLEFIN_HOSTS, ...extra]),
		secrets: {
			available: !!env.SECRETS_KEY,
			seal: (plain) => {
				const sealed = sealSecret(plain);
				// sealSecret passes plain text through when no key is set. Refuse
				// that here too, so no caller can store a bank credential in clear.
				if (!sealed || !sealed.startsWith('enc:')) throw new Error('SECRETS_KEY is not configured');
				return sealed;
			},
			open: (sealed) => (sealed.startsWith('enc:') ? openSecret(sealed) : null)
		},
		config: {
			intervalHours: env.BANK_SYNC_INTERVAL_HOURS,
			backfillDays: env.BANK_SYNC_BACKFILL_DAYS
		}
	};
	return instance;
}
