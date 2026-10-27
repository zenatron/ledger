/**
 * Bank sync — a one-way, read-only feed from a bank aggregator into
 * reconciliation.
 *
 * What it does: on a schedule (and on demand), pull posted transactions for the
 * accounts a household switched on, and add them as statement lines — one
 * rolling import per account per month — with matches proposed, rules applied
 * and categories suggested. That is the whole write surface.
 *
 * What it never does: create, edit or delete a purchase; move money; or send
 * anything to a bank. Lines arrive in the same review screen a CSV does, so the
 * ledger stays a thing a person vouches for. Turning a line into a purchase is
 * still a tap, through `createPurchaseFromLine` and the approval policy.
 *
 * Security posture, in one place:
 *  - The credential (a SimpleFIN access URL) is sealed with SECRETS_KEY, and
 *    connecting refuses outright when no key is configured.
 *  - It is opened only here, only for the length of one request, and never
 *    logged, returned to a page, or written into a run record.
 *  - Disconnecting destroys it (the column is nulled), it isn't just flagged.
 *  - Every bridge host is allowlisted (see domain/banksync/simplefin).
 *  - A lease on the connection row stops a manual tap and the sweep running the
 *    same sync twice; a daily cap keeps us inside the bridge's quota, which it
 *    enforces by disabling the token.
 */

import { createHash } from 'node:crypto';
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql
} from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	account,
	bankBalanceSnapshot,
	bankConnection,
	bankFeedAccount,
	bankRule,
	bankSyncRun,
	category,
	merchant,
	purchase,
	statementImport,
	statementLine,
	workspace,
	workspaceMember,
	type BankSyncMessage
} from '$lib/db/schema';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';
import type { BankFeedClient } from '$lib/ports/bank-feed';
import {
	MAX_WINDOW_DAYS,
	SimpleFinError,
	redact,
	sanitizeText,
	type FeedAccount
} from '$lib/domain/banksync/simplefin';
import { firstRule, merchantKey, normalizePattern, type Rule } from '$lib/domain/banksync/rules';
import type { RawStatementLine } from '$lib/domain/reconcile/parse-csv';
import { calDateInZone, formatCalDate } from '$lib/domain/time/zoned';
import { proposeMatches } from '$lib/application/reconcile';
import { refreshMatchedCount } from '$lib/repo/statements';

export class BankSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BankSyncError';
	}
}

/** Seal/open for the stored credential. `available` is false without SECRETS_KEY. */
export interface SecretBox {
	available: boolean;
	seal(plain: string): string;
	open(sealed: string): string | null;
}

export interface BankSyncDeps {
	clock: Clock;
	ids: IdGenerator;
	feed: BankFeedClient;
	secrets: SecretBox;
	config: { intervalHours: number; backfillDays: number };
	/** For schedule jitter; injectable so tests are deterministic. */
	random?: () => number;
}

interface Scope {
	workspaceId: string;
	memberId: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Banks post late; each sync re-reads this far behind where it got to. */
const OVERLAP_DAYS = 5;
/** Well under the bridge's ~24/day, leaving room for a few taps of "Sync now". */
export const MAX_RUNS_PER_DAY = 12;
/** A manual sync this soon after the last one is refused. */
export const MANUAL_COOLDOWN_MS = 10 * 60_000;
/** A run that crashed mid-way frees the connection after this long. */
const LEASE_MS = 5 * 60_000;

function sha256(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

/** The next scheduled run: the interval plus up to 45 minutes of jitter, so
 *  every self-hosted instance doesn't hit the bridge on the hour. */
function nextRunAt(deps: BankSyncDeps, now: Date): Date {
	const jitter = Math.floor((deps.random ?? Math.random)() * 45 * 60_000);
	return new Date(now.getTime() + deps.config.intervalHours * HOUR_MS + jitter);
}

/** A message safe to show a person and to store. */
function userMessage(e: unknown): { code: string; msg: string } {
	if (e instanceof SimpleFinError) return { code: e.code, msg: e.message };
	if (e instanceof BankSyncError) return { code: 'sync', msg: e.message };
	return {
		code: 'internal',
		msg: sanitizeText(redact((e as Error)?.message ?? 'Unknown error'), 300)
	};
}

function guessKind(name: string): 'card' | 'bank' {
	return /credit|card|visa|master|amex|express|discover|sapphire|freedom/i.test(name)
		? 'card'
		: 'bank';
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

/**
 * Claim a SimpleFIN setup token and store the connection. Then discover its
 * accounts (balances only — no transactions are pulled until a person switches
 * an account on).
 */
export async function connectSimpleFin(
	db: Db,
	deps: BankSyncDeps,
	scope: Scope,
	input: { setupToken: string; label?: string | null }
): Promise<{ connectionId: string; host: string }> {
	if (!deps.secrets.available) {
		throw new BankSyncError(
			'Bank sync needs SECRETS_KEY set on the server, so the bank credential is never stored unencrypted.'
		);
	}
	const accessUrl = await deps.feed.claim(input.setupToken);
	const host = new URL(accessUrl).hostname;
	const now = deps.clock.now();
	const connectionId = deps.ids.newId();
	await db.insert(bankConnection).values({
		id: connectionId,
		workspaceId: scope.workspaceId,
		memberId: scope.memberId,
		provider: 'simplefin',
		label: sanitizeText(input.label ?? '', 60) || 'SimpleFIN',
		credentialSealed: deps.secrets.seal(accessUrl),
		host,
		status: 'active',
		nextSyncAt: nextRunAt(deps, now),
		createdAt: now
	});
	await syncConnection(db, deps, connectionId, 'connect');
	return { connectionId, host };
}

/** Destroy the credential and stop syncing. Lines already synced stay — they
 *  are the history the ledger was reconciled against. */
export async function disconnect(
	db: Db,
	deps: Pick<BankSyncDeps, 'clock'>,
	scope: Scope,
	connectionId: string
): Promise<boolean> {
	const now = deps.clock.now();
	const rows = await db
		.update(bankConnection)
		.set({
			credentialSealed: null,
			status: 'disconnected',
			nextSyncAt: null,
			disconnectedAt: now
		})
		.where(
			and(eq(bankConnection.id, connectionId), eq(bankConnection.workspaceId, scope.workspaceId))
		)
		.returning({ id: bankConnection.id });
	if (rows.length === 0) return false;
	await db
		.update(bankFeedAccount)
		.set({ enabled: false })
		.where(eq(bankFeedAccount.connectionId, connectionId));
	return true;
}

/**
 * Switch an account's feed on or off. Turning one on attributes its lines to a
 * ledger account (card) — the one picked, or a new one named after it.
 */
export async function setFeedAccountEnabled(
	db: Db,
	deps: Pick<BankSyncDeps, 'clock' | 'ids'>,
	scope: Scope,
	feedAccountId: string,
	enabled: boolean,
	linkAccountId?: string | null,
	opts: { holderMemberId?: string | null; visibility?: 'holder' | 'shared' } = {}
): Promise<void> {
	const [feed] = await db
		.select()
		.from(bankFeedAccount)
		.where(
			and(eq(bankFeedAccount.id, feedAccountId), eq(bankFeedAccount.workspaceId, scope.workspaceId))
		)
		.limit(1);
	if (!feed) throw new BankSyncError('That account no longer exists.');
	if (enabled && feed.unsupportedReason) throw new BankSyncError(feed.unsupportedReason);

	let accountId = feed.accountId;
	if (enabled && linkAccountId) {
		const [acct] = await db
			.select({ id: account.id })
			.from(account)
			.where(and(eq(account.id, linkAccountId), eq(account.workspaceId, scope.workspaceId)))
			.limit(1);
		if (!acct) throw new BankSyncError('That card or account isn’t in this workspace.');
		accountId = acct.id;
	} else if (enabled && !accountId) {
		accountId = deps.ids.newId();
		await db.insert(account).values({
			id: accountId,
			workspaceId: scope.workspaceId,
			name: feed.name.slice(0, 60),
			last4: /(\d{4})\D*$/.exec(feed.name)?.[1] ?? null,
			kind: guessKind(feed.name),
			isArchived: false,
			createdAt: deps.clock.now()
		});
	}
	// The cardholder: named, or whoever switched it on. Must be an active member.
	const holderMemberId = opts.holderMemberId ?? feed.holderMemberId ?? scope.memberId;
	const [holder] = await db
		.select({ id: workspaceMember.id })
		.from(workspaceMember)
		.where(
			and(
				eq(workspaceMember.id, holderMemberId),
				eq(workspaceMember.workspaceId, scope.workspaceId),
				eq(workspaceMember.status, 'active')
			)
		)
		.limit(1);
	if (!holder) throw new BankSyncError('That cardholder isn’t an active member of this workspace.');
	const visibility = opts.visibility ?? (feed.visibility === 'shared' ? 'shared' : 'holder');

	await db
		.update(bankFeedAccount)
		.set({ enabled, accountId, holderMemberId, visibility })
		.where(eq(bankFeedAccount.id, feedAccountId));
	// Statements already synced follow the account's current setting, so
	// changing who may see a card applies to its history too.
	await db
		.update(statementImport)
		.set({
			visibleToMemberId: visibility === 'holder' ? holderMemberId : null,
			memberId: holderMemberId
		})
		.where(
			and(
				eq(statementImport.workspaceId, scope.workspaceId),
				sql`${statementImport.contentHash} like ${`sync:${feedAccountId}:%`}`
			)
		);

	// Something to fetch now: let the next sweep pick it up promptly rather than
	// waiting out the interval.
	if (enabled) {
		await db
			.update(bankConnection)
			.set({ nextSyncAt: deps.clock.now() })
			.where(and(eq(bankConnection.id, feed.connectionId), eq(bankConnection.status, 'active')));
	}
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleInput {
	match: Rule['match'];
	pattern: string;
	direction: Rule['direction'];
	minAmountMinor: bigint | null;
	maxAmountMinor: bigint | null;
	feedAccountId: string | null;
	action: Rule['action'];
	categoryId: string | null;
	renameTo: string | null;
	priority?: number;
}

export async function createRule(
	db: Db,
	deps: Pick<BankSyncDeps, 'clock' | 'ids'>,
	scope: Scope,
	input: RuleInput
): Promise<string> {
	const pattern = normalizePattern(input.pattern).slice(0, 120);
	if (pattern.length < 2)
		throw new BankSyncError('Give the rule at least two characters to match.');
	if (input.action === 'categorize' && !input.categoryId && !input.renameTo?.trim()) {
		throw new BankSyncError('Pick a category or a name for lines this rule matches.');
	}
	if (input.categoryId) {
		const [c] = await db
			.select({ id: category.id })
			.from(category)
			.where(and(eq(category.id, input.categoryId), eq(category.workspaceId, scope.workspaceId)))
			.limit(1);
		if (!c) throw new BankSyncError('That category isn’t in this workspace.');
	}
	if (input.feedAccountId) {
		const [f] = await db
			.select({ id: bankFeedAccount.id })
			.from(bankFeedAccount)
			.where(
				and(
					eq(bankFeedAccount.id, input.feedAccountId),
					eq(bankFeedAccount.workspaceId, scope.workspaceId)
				)
			)
			.limit(1);
		if (!f) throw new BankSyncError('That account isn’t in this workspace.');
	}
	const id = deps.ids.newId();
	await db.insert(bankRule).values({
		id,
		workspaceId: scope.workspaceId,
		priority: input.priority ?? 100,
		match: input.match,
		pattern,
		direction: input.direction,
		minAmountMinor: input.minAmountMinor,
		maxAmountMinor: input.maxAmountMinor,
		feedAccountId: input.feedAccountId,
		action: input.action,
		categoryId: input.action === 'categorize' ? input.categoryId : null,
		renameTo: input.action === 'categorize' ? sanitizeText(input.renameTo ?? '', 80) || null : null,
		createdAt: deps.clock.now()
	});
	return id;
}

export async function deleteRule(db: Db, scope: Scope, ruleId: string): Promise<boolean> {
	const rows = await db
		.delete(bankRule)
		.where(and(eq(bankRule.id, ruleId), eq(bankRule.workspaceId, scope.workspaceId)))
		.returning({ id: bankRule.id });
	return rows.length > 0;
}

async function loadRules(db: Db, workspaceId: string): Promise<Rule[]> {
	const rows = await db
		.select()
		.from(bankRule)
		.where(eq(bankRule.workspaceId, workspaceId))
		.orderBy(bankRule.priority, bankRule.createdAt);
	return rows.map((r) => ({
		id: r.id,
		priority: r.priority,
		match: r.match,
		pattern: r.pattern,
		direction: r.direction as Rule['direction'],
		minAmountMinor: r.minAmountMinor,
		maxAmountMinor: r.maxAmountMinor,
		feedAccountId: r.feedAccountId,
		action: r.action,
		categoryId: r.categoryId,
		renameTo: r.renameTo
	}));
}

/**
 * What this workspace last filed a merchant under, found by the cleaned bank
 * descriptor *starting with* a known merchant name — "blue bottle coffee san
 * francisco" finds "blue bottle". Longest name wins.
 *
 * Only purchases sealed from nobody count. A line's suggestion is shown to every
 * member who opens the statement, so it must not be learned from a purchase
 * that's hidden from any of them — that would be a gift spoiled by a category.
 */
async function categoryFromMemory(
	db: Db,
	workspaceId: string,
	key: string,
	now: Date
): Promise<string | null> {
	if (key.length < 3) return null;
	const [row] = await db
		.select({ categoryId: purchase.categoryId })
		.from(purchase)
		.innerJoin(merchant, eq(purchase.merchantId, merchant.id))
		.innerJoin(category, eq(purchase.categoryId, category.id))
		.where(
			and(
				eq(purchase.workspaceId, workspaceId),
				sql`length(${merchant.normalizedName}) >= 3`,
				sql`starts_with(${key}, ${merchant.normalizedName})`,
				inArray(purchase.state, ['completed', 'approved']),
				eq(category.isArchived, false),
				or(
					sql`cardinality(${purchase.sealedFromMemberIds}) = 0`,
					and(isNotNull(purchase.sealedUntil), lte(purchase.sealedUntil, now))
				)
			)
		)
		.orderBy(sql`length(${merchant.normalizedName}) desc`, desc(purchase.createdAt))
		.limit(1);
	return row?.categoryId ?? null;
}

/**
 * Re-run rules over synced lines still waiting for an answer. For when a rule
 * is written after the lines it was written for have already arrived.
 */
export async function reapplyRules(db: Db, scope: Scope): Promise<number> {
	const rules = await loadRules(db, scope.workspaceId);
	if (rules.length === 0) return 0;
	const lines = await db
		.select({
			id: statementLine.id,
			importId: statementLine.importId,
			amountMinor: statementLine.amountMinor,
			rawDescription: statementLine.rawDescription,
			externalId: statementLine.externalId
		})
		.from(statementLine)
		.innerJoin(statementImport, eq(statementLine.importId, statementImport.id))
		.where(
			and(
				eq(statementLine.workspaceId, scope.workspaceId),
				eq(statementImport.format, 'sync'),
				eq(statementLine.matchState, 'unmatched')
			)
		);
	let changed = 0;
	const touched = new Set<string>();
	const hits = new Map<string, number>();
	for (const l of lines) {
		const feedAccountId = l.externalId?.split(':')[1] ?? '';
		const rule = firstRule(rules, {
			amountMinor: l.amountMinor,
			description: l.rawDescription,
			feedAccountId
		});
		if (!rule) continue;
		await db
			.update(statementLine)
			.set(
				rule.action === 'ignore'
					? { matchState: 'ignored', ruleId: rule.id, matchReason: 'ignored by rule' }
					: {
							suggestedCategoryId: rule.categoryId,
							suggestedName: rule.renameTo,
							suggestionSource: 'rule',
							ruleId: rule.id
						}
			)
			.where(eq(statementLine.id, l.id));
		touched.add(l.importId);
		hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1);
		changed++;
	}
	for (const id of touched) await refreshMatchedCount(db, id);
	for (const [ruleId, n] of hits) {
		await db
			.update(bankRule)
			.set({ hitCount: sql`${bankRule.hitCount} + ${n}`, lastHitAt: new Date() })
			.where(eq(bankRule.id, ruleId));
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncSummary {
	runId: string | null;
	status: 'ok' | 'partial' | 'error' | 'skipped';
	inserted: number;
	matched: number;
	message: string | null;
}

/** Every connection due for its scheduled run. For the background sweep. */
export async function syncDueConnections(db: Db, deps: BankSyncDeps): Promise<number> {
	const now = deps.clock.now();
	const due = await db
		.select({ id: bankConnection.id })
		.from(bankConnection)
		.where(
			and(
				eq(bankConnection.status, 'active'),
				isNotNull(bankConnection.credentialSealed),
				lte(bankConnection.nextSyncAt, now)
			)
		)
		.limit(20);
	let inserted = 0;
	for (const c of due) {
		try {
			const r = await syncConnection(db, deps, c.id, 'schedule');
			inserted += r.inserted;
		} catch (e) {
			// syncConnection records its own failures; this only catches the lease
			// being held, which is not an error worth more than a line.
			console.log(
				JSON.stringify({ level: 'warn', msg: 'bank sync: skipped', err: userMessage(e).msg })
			);
		}
	}
	return inserted;
}

/**
 * Run one sync for one connection. Returns a summary rather than throwing for
 * provider failures — those are recorded on the run and the connection, which
 * is where a person will look. Throws `BankSyncError` only when the sync
 * couldn't start (busy, cooling down, over the daily cap).
 */
export async function syncConnection(
	db: Db,
	deps: BankSyncDeps,
	connectionId: string,
	trigger: 'schedule' | 'manual' | 'connect'
): Promise<SyncSummary> {
	const now = deps.clock.now();

	// Lease. One UPDATE both checks and claims, so two callers can't both pass.
	const leaseBefore = new Date(
		now.getTime() - (trigger === 'manual' ? MANUAL_COOLDOWN_MS : LEASE_MS)
	);
	const [conn] = await db
		.update(bankConnection)
		.set({ lastSyncAt: now })
		.where(
			and(
				eq(bankConnection.id, connectionId),
				inArray(bankConnection.status, ['active', 'error']),
				isNotNull(bankConnection.credentialSealed),
				or(isNull(bankConnection.lastSyncAt), lt(bankConnection.lastSyncAt, leaseBefore))
			)
		)
		.returning();
	if (!conn) {
		throw new BankSyncError(
			trigger === 'manual'
				? 'This connection synced a few minutes ago. Try again shortly.'
				: 'Sync already running.'
		);
	}

	const [{ n: recentRuns }] = await db
		.select({ n: count() })
		.from(bankSyncRun)
		.where(
			and(
				eq(bankSyncRun.connectionId, connectionId),
				gte(bankSyncRun.startedAt, new Date(now.getTime() - DAY_MS))
			)
		);
	if (recentRuns >= MAX_RUNS_PER_DAY) {
		await db
			.update(bankConnection)
			.set({ nextSyncAt: new Date(now.getTime() + 2 * HOUR_MS) })
			.where(eq(bankConnection.id, connectionId));
		throw new BankSyncError(
			'This connection has hit its daily sync limit, which keeps it inside the bridge’s quota. It will resume automatically.'
		);
	}

	const [ws] = await db
		.select({ timezone: workspace.timezone })
		.from(workspace)
		.where(eq(workspace.id, conn.workspaceId))
		.limit(1);
	const tz = ws?.timezone ?? 'UTC';

	const feeds = await db
		.select()
		.from(bankFeedAccount)
		.where(eq(bankFeedAccount.connectionId, connectionId));
	const enabled = feeds.filter((f) => f.enabled && !f.unsupportedReason);
	const balancesOnly = enabled.length === 0;

	// Window: from the furthest-behind enabled account (less the overlap), or a
	// backfill for one never synced; never more than the protocol allows.
	const end = now;
	const floor = new Date(end.getTime() - MAX_WINDOW_DAYS * DAY_MS + HOUR_MS);
	let start = new Date(end.getTime() - DAY_MS);
	for (const f of enabled) {
		const s = f.syncedThrough
			? new Date(f.syncedThrough.getTime() - OVERLAP_DAYS * DAY_MS)
			: new Date(end.getTime() - deps.config.backfillDays * DAY_MS);
		if (s < start) start = s;
	}
	if (start < floor) start = floor;

	const runId = deps.ids.newId();
	await db.insert(bankSyncRun).values({
		id: runId,
		connectionId,
		workspaceId: conn.workspaceId,
		trigger,
		startedAt: now,
		status: 'running',
		windowStart: balancesOnly ? null : start,
		windowEnd: balancesOnly ? null : end
	});

	const messages: BankSyncMessage[] = [];
	const stats = {
		accountsSeen: 0,
		fetched: 0,
		inserted: 0,
		duplicates: 0,
		skipped: 0,
		matched: 0,
		categorized: 0,
		ignoredByRule: 0
	};

	const finish = async (
		status: 'ok' | 'partial' | 'error',
		httpStatus: number | null,
		connPatch: Partial<typeof bankConnection.$inferInsert>
	): Promise<SyncSummary> => {
		const done = deps.clock.now();
		await db
			.update(bankSyncRun)
			.set({
				status,
				finishedAt: done,
				httpStatus,
				...stats,
				messages: messages.slice(0, 50),
				durationMs: done.getTime() - now.getTime()
			})
			.where(eq(bankSyncRun.id, runId));
		await db.update(bankConnection).set(connPatch).where(eq(bankConnection.id, connectionId));
		const firstError = messages.find((m) => m.level === 'error')?.msg ?? null;
		console.log(
			JSON.stringify({
				level: status === 'error' ? 'error' : 'info',
				msg: 'bank sync',
				connection: connectionId,
				trigger,
				status,
				...stats,
				ms: done.getTime() - now.getTime()
			})
		);
		return { runId, status, inserted: stats.inserted, matched: stats.matched, message: firstError };
	};

	const accessUrl = conn.credentialSealed ? deps.secrets.open(conn.credentialSealed) : null;
	if (!accessUrl) {
		messages.push({
			level: 'error',
			code: 'credential',
			msg: 'The stored credential could not be read (was SECRETS_KEY changed?). Reconnect this bank.'
		});
		return finish('error', null, {
			status: 'error',
			lastError: messages[0].msg,
			nextSyncAt: null
		});
	}

	let snapshot;
	try {
		snapshot = await deps.feed.fetchAccounts(accessUrl, { start, end, balancesOnly });
	} catch (e) {
		const { code, msg } = userMessage(e);
		messages.push({ level: 'error', code, msg });
		const revoked = code === 'revoked';
		return finish('error', null, {
			status: revoked ? 'revoked' : 'error',
			lastError: msg,
			// A revoked token is dead: stop asking. Anything else, try again later.
			nextSyncAt: revoked ? null : nextRunAt(deps, now)
		});
	}
	messages.push(...snapshot.messages);
	stats.accountsSeen = snapshot.accounts.length;

	// Discovery and balances, for every account the bridge reported.
	const byExternal = new Map(feeds.map((f) => [f.externalId, f]));
	const today = formatCalDate(calDateInZone(now, tz));
	for (const a of snapshot.accounts) {
		const existing = byExternal.get(a.id);
		const patch = {
			name: a.name,
			institution: a.institution,
			currency: a.currency,
			unsupportedReason: a.unsupported,
			balanceMinor: a.balanceMinor,
			availableBalanceMinor: a.availableBalanceMinor,
			balanceAt: a.balanceAt ?? now
		};
		if (existing) {
			await db.update(bankFeedAccount).set(patch).where(eq(bankFeedAccount.id, existing.id));
			Object.assign(existing, patch);
		} else {
			const id = deps.ids.newId();
			const row = {
				id,
				connectionId,
				workspaceId: conn.workspaceId,
				externalId: a.id,
				enabled: false,
				accountId: null,
				syncedThrough: null,
				createdAt: now,
				...patch
			};
			await db.insert(bankFeedAccount).values(row);
			byExternal.set(a.id, row as typeof bankFeedAccount.$inferSelect);
		}
		const feed = byExternal.get(a.id)!;
		if (feed.enabled && a.balanceMinor !== null) {
			await db
				.insert(bankBalanceSnapshot)
				.values({
					feedAccountId: feed.id,
					day: today,
					balanceMinor: a.balanceMinor,
					availableBalanceMinor: a.availableBalanceMinor,
					currency: a.currency
				})
				.onConflictDoUpdate({
					target: [bankBalanceSnapshot.feedAccountId, bankBalanceSnapshot.day],
					set: { balanceMinor: a.balanceMinor, availableBalanceMinor: a.availableBalanceMinor }
				});
		}
	}

	if (!balancesOnly) {
		const rules = await loadRules(db, conn.workspaceId);
		const ruleHits = new Map<string, number>();
		const memory = new Map<string, string | null>();
		for (const a of snapshot.accounts) {
			const feed = byExternal.get(a.id)!;
			if (!feed.enabled || feed.unsupportedReason) continue;
			try {
				await storeAccountLines(db, deps, conn, feed, a, tz, now, rules, ruleHits, memory, stats);
			} catch (e) {
				const { code, msg } = userMessage(e);
				messages.push({ level: 'error', code, msg, account: feed.name });
			}
		}
		const hitAt = deps.clock.now();
		for (const [ruleId, n] of ruleHits) {
			await db
				.update(bankRule)
				.set({ hitCount: sql`${bankRule.hitCount} + ${n}`, lastHitAt: hitAt })
				.where(eq(bankRule.id, ruleId));
		}
	}

	const errors = messages.filter((m) => m.level === 'error');
	return finish(errors.length > 0 ? 'partial' : 'ok', snapshot.httpStatus, {
		status: 'active',
		lastError: errors[0]?.msg ?? null,
		lastSuccessAt: now,
		nextSyncAt: nextRunAt(deps, now)
	});
}

/** One feed account's new transactions → statement lines, per-month imports. */
async function storeAccountLines(
	db: Db,
	deps: BankSyncDeps,
	conn: typeof bankConnection.$inferSelect,
	feed: typeof bankFeedAccount.$inferSelect,
	a: FeedAccount,
	tz: string,
	now: Date,
	rules: Rule[],
	ruleHits: Map<string, number>,
	memory: Map<string, string | null>,
	stats: {
		fetched: number;
		inserted: number;
		duplicates: number;
		skipped: number;
		matched: number;
		categorized: number;
		ignoredByRule: number;
	}
): Promise<void> {
	// Pending transactions are never stored: their ids can change when they
	// post, which would leave a ghost line beside the real one.
	// Zero-amount rows (authorisation checks, some banks' memo lines) are
	// nothing to reconcile and would only clutter the review.
	const posted = a.transactions.filter((t) => !t.pending && t.amountMinor !== 0n);
	stats.skipped += a.transactions.length - posted.length;
	stats.fetched += posted.length;

	// Within-batch duplicates (a bridge repeating an id) collapse to one.
	const byExt = new Map(posted.map((t) => [`sf:${feed.id}:${t.id}`, t]));
	const extIds = [...byExt.keys()];
	const existing = new Set<string>();
	for (let i = 0; i < extIds.length; i += 500) {
		const rows = await db
			.select({ e: statementLine.externalId })
			.from(statementLine)
			.where(
				and(
					eq(statementLine.workspaceId, conn.workspaceId),
					inArray(statementLine.externalId, extIds.slice(i, i + 500))
				)
			);
		for (const r of rows) if (r.e) existing.add(r.e);
	}
	const fresh = extIds.filter((e) => !existing.has(e)).map((e) => ({ ext: e, t: byExt.get(e)! }));
	stats.duplicates += posted.length - fresh.length;

	if (fresh.length > 0) {
		const lines: RawStatementLine[] = fresh.map(({ t }) => ({
			postedAt: t.postedAt,
			amountMinor: t.amountMinor,
			currency: a.currency,
			rawDescription: t.description,
			normalizedDescription: normalizePattern(t.description)
		}));
		const { proposals, privateLines } = await proposeMatches(
			db,
			{ workspaceId: conn.workspaceId, memberId: holderOf(conn, feed) },
			lines,
			feed.accountId,
			now,
			await claimedPurchaseIds(db, conn.workspaceId)
		);

		// Build each row, then group by month.
		const groups = new Map<string, (typeof statementLine.$inferInsert)[]>();
		for (let i = 0; i < fresh.length; i++) {
			const l = lines[i];
			const p = proposals[i];
			const isPrivate = privateLines.has(i);
			let matchState: (typeof statementLine.$inferInsert)['matchState'] = isPrivate
				? 'private'
				: p.state;
			let matchReason = isPrivate ? null : p.reason;
			let suggestedCategoryId: string | null = null;
			let suggestedName: string | null = null;
			let suggestionSource: string | null = null;
			let ruleId: string | null = null;

			// Rules and memory only speak to a line nothing has explained yet.
			if (matchState === 'unmatched') {
				const rule = firstRule(rules, {
					amountMinor: l.amountMinor,
					description: l.rawDescription,
					feedAccountId: feed.id
				});
				if (rule) {
					ruleId = rule.id;
					ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);
					if (rule.action === 'ignore') {
						matchState = 'ignored';
						matchReason = 'ignored by rule';
						stats.ignoredByRule++;
					} else {
						suggestedCategoryId = rule.categoryId;
						suggestedName = rule.renameTo;
						suggestionSource = 'rule';
						if (rule.categoryId) stats.categorized++;
					}
				} else if (l.amountMinor < 0n) {
					const key = merchantKey(l.rawDescription);
					if (!memory.has(key)) {
						memory.set(key, await categoryFromMemory(db, conn.workspaceId, key, now));
					}
					const hit = memory.get(key) ?? null;
					if (hit) {
						suggestedCategoryId = hit;
						suggestionSource = 'memory';
						stats.categorized++;
					}
				}
			}
			if (matchState === 'matched') stats.matched++;

			const ym = formatCalDate(calDateInZone(l.postedAt, tz)).slice(0, 7);
			const row: typeof statementLine.$inferInsert = {
				id: deps.ids.newId(),
				importId: '', // set per group below
				workspaceId: conn.workspaceId,
				postedAt: l.postedAt,
				amountMinor: l.amountMinor,
				currency: l.currency,
				rawDescription: l.rawDescription,
				normalizedDescription: l.normalizedDescription,
				externalId: fresh[i].ext,
				matchState,
				matchedPurchaseId: isPrivate ? null : p.purchaseId,
				matchReason,
				suggestedPurchaseIds: isPrivate ? [] : p.suggestions.map((s) => s.purchaseId),
				dedupHash: sha256(fresh[i].ext),
				suggestedCategoryId,
				suggestedName,
				suggestionSource,
				ruleId
			};
			const g = groups.get(ym) ?? [];
			g.push(row);
			groups.set(ym, g);
		}

		for (const [ym, rows] of groups) {
			const importId = await rollingImport(db, deps, conn, feed, a.currency, ym, now);
			let added = 0;
			await db.transaction(async (tx) => {
				for (let i = 0; i < rows.length; i += 500) {
					const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, importId }));
					// The unique (workspace, external_id) index is the real guard;
					// the pre-check above just keeps the matcher's work honest.
					const ins = await tx
						.insert(statementLine)
						.values(chunk)
						.onConflictDoNothing()
						.returning({ id: statementLine.id });
					added += ins.length;
				}
				const [agg] = await tx
					.select({
						n: count(),
						lo: sql<Date>`min(${statementLine.postedAt})`.mapWith(statementLine.postedAt),
						hi: sql<Date>`max(${statementLine.postedAt})`.mapWith(statementLine.postedAt)
					})
					.from(statementLine)
					.where(eq(statementLine.importId, importId));
				await tx
					.update(statementImport)
					.set({
						lineCount: agg.n,
						periodStart: agg.lo,
						periodEnd: agg.hi,
						// New lines are new questions; a closed month reopens.
						...(added > 0 ? { status: 'reviewing' } : {})
					})
					.where(eq(statementImport.id, importId));
			});
			await refreshMatchedCount(db, importId);
			stats.inserted += added;
		}
	}

	// Lines that arrived before their purchase was logged (or marked bought)
	// get another look now that the ledger may have caught up.
	stats.matched += await rematchWaiting(db, conn, feed, now);

	await db
		.update(bankFeedAccount)
		.set({ syncedThrough: now })
		.where(eq(bankFeedAccount.id, feed.id));
}

/** Matching runs as the cardholder: it's their seals that decide what's hidden. */
function holderOf(
	conn: typeof bankConnection.$inferSelect,
	feed: typeof bankFeedAccount.$inferSelect
): string {
	return feed.holderMemberId ?? conn.memberId;
}

/** Purchases a line already holds, so no second line is proposed the same one. */
async function claimedPurchaseIds(db: Db, workspaceId: string): Promise<Set<string>> {
	const rows = await db
		.select({ id: statementLine.matchedPurchaseId })
		.from(statementLine)
		.where(
			and(
				eq(statementLine.workspaceId, workspaceId),
				isNotNull(statementLine.matchedPurchaseId),
				inArray(statementLine.matchState, ['matched', 'confirmed'])
			)
		);
	return new Set(rows.map((r) => r.id!));
}

/** How far back a waiting line is re-matched on each sync. */
const REMATCH_DAYS = 60;

/**
 * Re-run matching over this account's still-unanswered recent lines. Updates
 * only what changed: a line that now has a match, or a different shortlist.
 * Lines a rule ignored, or a person answered, are never touched.
 */
async function rematchWaiting(
	db: Db,
	conn: typeof bankConnection.$inferSelect,
	feed: typeof bankFeedAccount.$inferSelect,
	now: Date
): Promise<number> {
	const waiting = await db
		.select()
		.from(statementLine)
		.where(
			and(
				eq(statementLine.workspaceId, conn.workspaceId),
				eq(statementLine.matchState, 'unmatched'),
				sql`${statementLine.externalId} like ${`sf:${feed.id}:%`}`,
				gte(statementLine.postedAt, new Date(now.getTime() - REMATCH_DAYS * DAY_MS))
			)
		);
	if (waiting.length === 0) return 0;
	const { proposals, privateLines } = await proposeMatches(
		db,
		{ workspaceId: conn.workspaceId, memberId: holderOf(conn, feed) },
		waiting.map((l) => ({
			postedAt: l.postedAt,
			amountMinor: l.amountMinor,
			currency: l.currency,
			rawDescription: l.rawDescription,
			normalizedDescription: l.normalizedDescription
		})),
		feed.accountId,
		now,
		await claimedPurchaseIds(db, conn.workspaceId)
	);
	let matched = 0;
	const touched = new Set<string>();
	for (let i = 0; i < waiting.length; i++) {
		const l = waiting[i];
		const p = proposals[i];
		const ids = privateLines.has(i) ? [] : p.suggestions.map((x) => x.purchaseId);
		if (privateLines.has(i)) {
			await db
				.update(statementLine)
				.set({ matchState: 'private', matchReason: null, suggestedPurchaseIds: [] })
				.where(eq(statementLine.id, l.id));
		} else if (p.state === 'matched') {
			await db
				.update(statementLine)
				.set({
					matchState: 'matched',
					matchedPurchaseId: p.purchaseId,
					matchReason: p.reason,
					suggestedPurchaseIds: []
				})
				.where(eq(statementLine.id, l.id));
			matched++;
		} else if (JSON.stringify(ids) !== JSON.stringify(l.suggestedPurchaseIds ?? [])) {
			await db
				.update(statementLine)
				.set({ suggestedPurchaseIds: ids })
				.where(eq(statementLine.id, l.id));
		} else continue;
		touched.add(l.importId);
	}
	for (const id of touched) await refreshMatchedCount(db, id);
	return matched;
}

/** The import a feed account's lines for one month live in, created on demand. */
async function rollingImport(
	db: Db,
	deps: BankSyncDeps,
	conn: typeof bankConnection.$inferSelect,
	feed: typeof bankFeedAccount.$inferSelect,
	currency: string,
	ym: string,
	now: Date
): Promise<string> {
	const contentHash = `sync:${feed.id}:${ym}`;
	const [found] = await db
		.select({ id: statementImport.id })
		.from(statementImport)
		.where(
			and(
				eq(statementImport.workspaceId, conn.workspaceId),
				eq(statementImport.contentHash, contentHash)
			)
		)
		.limit(1);
	if (found) return found.id;
	const id = deps.ids.newId();
	const [y, m] = ym.split('-').map(Number);
	const monthName = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en', {
		month: 'short',
		timeZone: 'UTC'
	});
	await db.insert(statementImport).values({
		id,
		workspaceId: conn.workspaceId,
		memberId: holderOf(conn, feed),
		// Private to the cardholder unless the account is marked shared (joint).
		visibleToMemberId: feed.visibility === 'shared' ? null : holderOf(conn, feed),
		filename: `${feed.name} · ${monthName} ${y} (bank sync)`,
		accountId: feed.accountId,
		format: 'sync',
		currency,
		blobId: null,
		periodStart: null,
		periodEnd: null,
		lineCount: 0,
		matchedCount: 0,
		status: 'reviewing',
		modelRead: false,
		contentHash,
		createdAt: now
	});
	return id;
}
