import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from '$lib/server/env';

/**
 * Secrets a workspace stores — today, only an external model's API key —
 * encrypted at rest when the deployment provides `SECRETS_KEY`.
 *
 * The key is the household's credential with a third party, and it sat in the
 * workspace row in the clear: anyone holding a database backup held the key.
 * With `SECRETS_KEY` set it is written as AES-256-GCM, `enc:v1:iv:ct:tag`, and
 * only this module can read it back. Without it nothing changes, and a value
 * written before the key was configured still reads as-is — the next save of
 * the settings page encrypts it.
 *
 * Decrypted once per request, in hooks.server.ts, where the workspace is
 * loaded; everything downstream sees plain text and never imports this.
 */

const PREFIX = 'enc:v1:';

function key(): Buffer | null {
	const raw = getEnv().SECRETS_KEY;
	return raw ? Buffer.from(raw, 'base64') : null;
}

export function sealSecret(plain: string | null): string | null {
	if (plain === null || plain === '') return plain;
	const k = key();
	if (!k) return plain;
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', k, iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return `${PREFIX}${iv.toString('base64url')}:${ct.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

/**
 * The plain value, or null when it can't be read — an encrypted value with no
 * key configured, or a key that has since changed. Null makes the model
 * integration fall back to "not configured" rather than send garbage upstream.
 */
export function openSecret(stored: string | null): string | null {
	if (stored === null || !stored.startsWith(PREFIX)) return stored;
	const k = key();
	if (!k) return null;
	try {
		const [iv, ct, tag] = stored.slice(PREFIX.length).split(':');
		const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
		decipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(ct, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch {
		console.log(
			JSON.stringify({ level: 'warn', msg: 'secrets: stored value could not be decrypted' })
		);
		return null;
	}
}
