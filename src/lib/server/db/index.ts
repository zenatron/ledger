import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '$lib/db/schema';
import type { Db } from '$lib/db/types';
import { getEnv } from '$lib/server/env';

export type { Db };

let instance: Db | undefined;
let client: ReturnType<typeof postgres> | undefined;

/** Lazy so importing route modules during `vite build` needs no DATABASE_URL. */
export function getDb(): Db {
	if (!instance) {
		client = postgres(getEnv().DATABASE_URL, {
			// Fail a dead database in seconds, not at the OS's TCP timeout, so the
			// healthcheck reports it instead of hanging along with every request.
			connect_timeout: 10,
			// Let idle connections go; a household's traffic is bursty.
			idle_timeout: 60
		});
		instance = drizzle(client, { schema });
	}
	return instance;
}

/** Drain the pool on shutdown: in-flight queries finish, new ones are refused. */
export async function closeDb(): Promise<void> {
	if (!client) return;
	const c = client;
	client = undefined;
	instance = undefined;
	await c.end({ timeout: 5 });
}
