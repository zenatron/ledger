/**
 * Reads for the Bank sync settings page. Nothing here ever selects
 * `credential_sealed` — the page has no use for it, and a column that is never
 * read can't be leaked by a careless serialiser.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { bankConnection, bankFeedAccount, bankRule, bankSyncRun, category } from '$lib/db/schema';

export async function listConnections(db: Db, workspaceId: string) {
	const conns = await db
		.select({
			id: bankConnection.id,
			label: bankConnection.label,
			memberId: bankConnection.memberId,
			provider: bankConnection.provider,
			host: bankConnection.host,
			status: bankConnection.status,
			lastError: bankConnection.lastError,
			lastSyncAt: bankConnection.lastSyncAt,
			lastSuccessAt: bankConnection.lastSuccessAt,
			nextSyncAt: bankConnection.nextSyncAt,
			createdAt: bankConnection.createdAt
		})
		.from(bankConnection)
		.where(eq(bankConnection.workspaceId, workspaceId))
		.orderBy(asc(bankConnection.createdAt));
	if (conns.length === 0) return [];
	const feeds = await db
		.select({
			id: bankFeedAccount.id,
			connectionId: bankFeedAccount.connectionId,
			name: bankFeedAccount.name,
			institution: bankFeedAccount.institution,
			currency: bankFeedAccount.currency,
			accountId: bankFeedAccount.accountId,
			enabled: bankFeedAccount.enabled,
			holderMemberId: bankFeedAccount.holderMemberId,
			visibility: bankFeedAccount.visibility,
			unsupportedReason: bankFeedAccount.unsupportedReason,
			balanceMinor: bankFeedAccount.balanceMinor,
			availableBalanceMinor: bankFeedAccount.availableBalanceMinor,
			balanceAt: bankFeedAccount.balanceAt,
			syncedThrough: bankFeedAccount.syncedThrough
		})
		.from(bankFeedAccount)
		.where(
			inArray(
				bankFeedAccount.connectionId,
				conns.map((c) => c.id)
			)
		)
		.orderBy(asc(bankFeedAccount.institution), asc(bankFeedAccount.name));
	return conns.map((c) => ({ ...c, accounts: feeds.filter((f) => f.connectionId === c.id) }));
}

export async function listRecentRuns(db: Db, workspaceId: string, limit = 25) {
	return db
		.select({
			id: bankSyncRun.id,
			connectionId: bankSyncRun.connectionId,
			trigger: bankSyncRun.trigger,
			startedAt: bankSyncRun.startedAt,
			status: bankSyncRun.status,
			fetched: bankSyncRun.fetched,
			inserted: bankSyncRun.inserted,
			duplicates: bankSyncRun.duplicates,
			matched: bankSyncRun.matched,
			categorized: bankSyncRun.categorized,
			ignoredByRule: bankSyncRun.ignoredByRule,
			messages: bankSyncRun.messages,
			durationMs: bankSyncRun.durationMs
		})
		.from(bankSyncRun)
		.where(eq(bankSyncRun.workspaceId, workspaceId))
		.orderBy(desc(bankSyncRun.startedAt))
		.limit(limit);
}

export async function listRules(db: Db, workspaceId: string) {
	return db
		.select({
			id: bankRule.id,
			priority: bankRule.priority,
			match: bankRule.match,
			pattern: bankRule.pattern,
			direction: bankRule.direction,
			minAmountMinor: bankRule.minAmountMinor,
			maxAmountMinor: bankRule.maxAmountMinor,
			feedAccountId: bankRule.feedAccountId,
			action: bankRule.action,
			categoryId: bankRule.categoryId,
			categoryName: category.name,
			renameTo: bankRule.renameTo,
			hitCount: bankRule.hitCount,
			lastHitAt: bankRule.lastHitAt
		})
		.from(bankRule)
		.leftJoin(category, and(eq(bankRule.categoryId, category.id)))
		.where(eq(bankRule.workspaceId, workspaceId))
		.orderBy(asc(bankRule.priority), asc(bankRule.createdAt));
}
