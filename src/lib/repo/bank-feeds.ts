/**
 * Bank connections and the accounts they report.
 *
 * No purchase is reachable from here, so there is no seal filter to carry:
 * these rows describe the household's links to its bank, not its spending.
 * Everything is still scoped by workspace so an id from elsewhere reads as
 * absent.
 */

import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bankConnection, bankFeedAccount, statementLine } from '$lib/db/schema';
import type { FeedAccount } from '$lib/domain/bankfeed/simplefin';
import type { IdGenerator } from '$lib/ports/id-generator';

export type BankConnectionRow = typeof bankConnection.$inferSelect;
export type BankFeedAccountRow = typeof bankFeedAccount.$inferSelect;

export async function listConnections(
	db: Db,
	workspaceId: string
): Promise<(BankConnectionRow & { accounts: BankFeedAccountRow[] })[]> {
	const conns = await db
		.select()
		.from(bankConnection)
		.where(eq(bankConnection.workspaceId, workspaceId))
		.orderBy(asc(bankConnection.createdAt));
	if (conns.length === 0) return [];
	const accounts = await db
		.select()
		.from(bankFeedAccount)
		.where(
			inArray(
				bankFeedAccount.connectionId,
				conns.map((c) => c.id)
			)
		)
		.orderBy(asc(bankFeedAccount.orgName), asc(bankFeedAccount.name));
	return conns.map((c) => ({ ...c, accounts: accounts.filter((a) => a.connectionId === c.id) }));
}

export async function getConnection(
	db: Db,
	workspaceId: string,
	connectionId: string
): Promise<BankConnectionRow | null> {
	const [row] = await db
		.select()
		.from(bankConnection)
		.where(and(eq(bankConnection.workspaceId, workspaceId), eq(bankConnection.id, connectionId)))
		.limit(1);
	return row ?? null;
}

/** Every connection, in any workspace, not tried since `before`. For the sweep. */
export async function connectionsDue(db: Db, before: Date): Promise<BankConnectionRow[]> {
	return db
		.select()
		.from(bankConnection)
		.where(or(isNull(bankConnection.lastAttemptAt), lt(bankConnection.lastAttemptAt, before)))
		.orderBy(asc(bankConnection.lastAttemptAt));
}

export async function listFeedAccounts(
	db: Db,
	connectionId: string
): Promise<BankFeedAccountRow[]> {
	return db.select().from(bankFeedAccount).where(eq(bankFeedAccount.connectionId, connectionId));
}

export async function getFeedAccount(
	db: Db,
	workspaceId: string,
	feedAccountId: string
): Promise<BankFeedAccountRow | null> {
	const [row] = await db
		.select()
		.from(bankFeedAccount)
		.where(and(eq(bankFeedAccount.workspaceId, workspaceId), eq(bankFeedAccount.id, feedAccountId)))
		.limit(1);
	return row ?? null;
}

/**
 * Record what the bridge reported: new accounts appear (unlinked), known ones
 * get their name and balance refreshed. An account the bridge stops reporting
 * is left alone — it may only be missing from this one answer.
 */
export async function upsertFeedAccounts(
	db: Db,
	ids: IdGenerator,
	conn: Pick<BankConnectionRow, 'id' | 'workspaceId'>,
	reported: FeedAccount[]
): Promise<void> {
	const known = new Map((await listFeedAccounts(db, conn.id)).map((a) => [a.externalId, a]));
	for (const a of reported) {
		const row = known.get(a.externalId);
		const fields = {
			name: a.name,
			orgName: a.orgName,
			currency: a.currency,
			balanceMinor: a.balanceMinor,
			balanceAt: a.balanceAt
		};
		if (row) {
			await db.update(bankFeedAccount).set(fields).where(eq(bankFeedAccount.id, row.id));
		} else {
			await db.insert(bankFeedAccount).values({
				id: ids.newId(),
				connectionId: conn.id,
				workspaceId: conn.workspaceId,
				externalId: a.externalId,
				accountId: null,
				...fields
			});
		}
	}
}

export async function setFeedAccountLink(
	db: Db,
	workspaceId: string,
	feedAccountId: string,
	accountId: string | null
): Promise<void> {
	await db
		.update(bankFeedAccount)
		.set({ accountId })
		.where(
			and(eq(bankFeedAccount.workspaceId, workspaceId), eq(bankFeedAccount.id, feedAccountId))
		);
}

export async function recordSyncResult(
	db: Db,
	connectionId: string,
	at: Date,
	result: { ok: true; warning: string | null } | { ok: false; error: string }
): Promise<void> {
	await db
		.update(bankConnection)
		.set(
			result.ok
				? { status: 'ok', lastError: result.warning, lastAttemptAt: at, lastSyncedAt: at }
				: { status: 'error', lastError: result.error, lastAttemptAt: at }
		)
		.where(eq(bankConnection.id, connectionId));
}

/**
 * Forget a connection and its account list. The statement lines it wrote stay:
 * they are the record of what was reconciled, and deleting them would quietly
 * un-clear purchases. Removing those is the import's own delete, on purpose.
 */
export async function deleteConnection(
	db: Db,
	workspaceId: string,
	connectionId: string
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(bankFeedAccount)
			.where(
				and(
					eq(bankFeedAccount.workspaceId, workspaceId),
					eq(bankFeedAccount.connectionId, connectionId)
				)
			);
		await tx
			.delete(bankConnection)
			.where(and(eq(bankConnection.workspaceId, workspaceId), eq(bankConnection.id, connectionId)));
	});
}

/** Which of these provider transaction ids this workspace already holds. */
export async function knownExternalIds(
	db: Db,
	workspaceId: string,
	externalIds: string[]
): Promise<Set<string>> {
	const out = new Set<string>();
	for (let i = 0; i < externalIds.length; i += 500) {
		const rows = await db
			.select({ id: statementLine.externalId })
			.from(statementLine)
			.where(
				and(
					eq(statementLine.workspaceId, workspaceId),
					inArray(statementLine.externalId, externalIds.slice(i, i + 500))
				)
			);
		for (const r of rows) if (r.id) out.add(r.id);
	}
	return out;
}
