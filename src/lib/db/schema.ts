import { sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

// IDs are UUIDv7, generated in the application (IdGenerator port), never in the DB.
// Money is bigint minor units + ISO-4217 code. Timestamps are timestamptz (UTC);
// period bucketing happens in the workspace timezone, in domain/analytics only.

export const memberRole = pgEnum('workspace_member_role', ['owner', 'member']);
export const memberStatus = pgEnum('workspace_member_status', ['active', 'invited', 'disabled']);
export const purchaseState = pgEnum('purchase_state', [
	'draft',
	'pending_approval',
	'approved',
	'denied',
	'cancelled',
	'completed',
	'refunded',
	// "Sleep on it": a pending request paused until held_until, then resurfaced.
	'held'
]);
export const recurringStatus = pgEnum('recurring_rule_status', ['active', 'paused', 'ended']);
export const budgetPeriod = pgEnum('budget_period', ['month', 'week']);
export const bucketStatus = pgEnum('bucket_status', ['active', 'paused', 'archived']);
// How Harmony's optional LLM assist is sourced. 'off' keeps the deterministic
// parsing we already ship — the LLM is never required. 'local' points at a
// self-hosted endpoint (Ollama etc.), so nothing leaves the box. 'external'
// allows a third-party API for those who don't mind the privacy trade.
export const aiMode = pgEnum('workspace_ai_mode', ['off', 'local', 'external']);
export const bucketTxnType = pgEnum('bucket_txn_type', ['accrual', 'withdrawal', 'adjustment']);
export const statementImportFormat = pgEnum('statement_import_format', ['csv', 'pdf']);
/** A card or account statements arrive for. See the `account` table. */
export const accountKind = pgEnum('account_kind', ['card', 'bank']);
export const statementLineMatchState = pgEnum('statement_line_match_state', [
	'unmatched',
	'matched',
	'confirmed',
	'private',
	'ignored'
]);

// "user" is a reserved word in SQL; app_user keeps raw analytics queries sane.
export const user = pgTable('app_user', {
	id: uuid('id').primaryKey(),
	oidcSubject: text('oidc_subject').notNull().unique(),
	email: text('email').notNull(),
	displayName: text('display_name').notNull(),
	avatarBlobId: text('avatar_blob_id'),
	/** Where the avatar came from: 'oidc' (fetched from the IdP, refreshed on
	 *  login) or 'custom' (user-uploaded — never overwritten by the IdP). */
	avatarSource: text('avatar_source'),
	isDeploymentAdmin: boolean('is_deployment_admin').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	lastLoginAt: timestamp('last_login_at', { withTimezone: true })
});

export const workspace = pgTable('workspace', {
	id: uuid('id').primaryKey(),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	ownerUserId: uuid('owner_user_id')
		.notNull()
		.references(() => user.id),
	currency: text('currency').notNull(),
	timezone: text('timezone').notNull(),
	weekStartDay: smallint('week_start_day').notNull().default(1),
	staleAfterHours: integer('stale_after_hours').notNull().default(48),
	reapprovalThresholdPct: integer('reapproval_threshold_pct').notNull().default(10),
	sealedPurchaseCapMinor: bigint('sealed_purchase_cap_minor', { mode: 'bigint' }),
	maxSealDays: integer('max_seal_days').notNull().default(90),
	accentColor: text('accent_color'),
	bucketChargesSkipApproval: boolean('bucket_charges_skip_approval').notNull().default(false),
	/** Whether Activity shows "who owes whom". Households that don't split
	 *  spending have no use for it, and it is a whole section of the page. */
	settleUpEnabled: boolean('settle_up_enabled').notNull().default(true),
	keepStatementFiles: boolean('keep_statement_files').notNull().default(false),
	/** Alpha: read a bill PDF to prefill a purchase. Off until asked for. */
	billImportEnabled: boolean('bill_import_enabled').notNull().default(false),
	/** Alpha: barcode scanning. Off until a product-lookup API is wired up. */
	barcodeEnabled: boolean('barcode_enabled').notNull().default(false),
	/** Whether a purchase may carry a place, and the spending map is offered.
	 *  Off by default — a location is the most sensitive thing this app can
	 *  store, so a workspace opts in before the field exists at all. Unlike
	 *  `barcodeEnabled` this is **not** gated on an environment variable: with no
	 *  configuration you still get device capture, offline map-link parsing, the
	 *  "By place" breakdown and the tile-free map. `MAP_TILE_URL` and
	 *  `GEOCODER_URL` only add streets and address search. */
	locationEnabled: boolean('location_enabled').notNull().default(false),
	/** Reserved, and deliberately **read by nothing**. Deterministic Harmony is
	 *  always on and the optional LLM assist is gated by `aiMode` alone, so this
	 *  column decides nothing today. It is kept — rather than dropped — so the
	 *  surface can be gated again without a migration, but nothing may branch on
	 *  it until something also writes it: a flag that is written and never read
	 *  is a trap for the next reader of this schema, which is why the settings
	 *  endpoint no longer accepts it. */
	intelligenceEnabled: boolean('intelligence_enabled').notNull().default(true),
	/** Whether Harmony's deterministic Safe-to-Spend alerts are sent. Workspace-wide. */
	safeToSpendAlertsEnabled: boolean('safe_to_spend_alerts_enabled').notNull().default(true),
	/** Optional LLM assist for Harmony. 'off' = deterministic parsing only (the
	 *  default). A fuzzy reducer, never an approver: it only ever suggests, and
	 *  every suggestion is validated against a deterministic option set before use. */
	aiMode: aiMode('ai_mode').notNull().default('off'),
	/** Base URL of the model endpoint. Local (Ollama) or an OpenAI-compatible API. */
	aiEndpoint: text('ai_endpoint'),
	/** Model name to request, e.g. 'llama3.2' or 'gpt-4o-mini'. */
	aiModel: text('ai_model'),
	/** Bearer token for an external API. Null for local endpoints that need none. */
	aiApiKey: text('ai_api_key'),
	/** Budget alert threshold: percentage of a budget consumed when the first
	 *  warning fires. Default 80. */
	budgetAlertPct: integer('budget_alert_pct').notNull().default(80),
	/** Minimum hours between re-alerts for the same overspent budget. */
	budgetAlertCooldownHours: integer('budget_alert_cooldown_hours').notNull().default(24),
	/** Hours after creation a non-owner can still hard-delete their own purchase.
	 *  Zero means only the owner can delete. */
	recentDeleteHours: integer('recent_delete_hours').notNull().default(72),
	/** How many nudge notifications a stale pending request gets before the
	 *  system stops poking. */
	maxNudges: integer('max_nudges').notNull().default(5),
	/** Number of days an invite link remains valid. */
	inviteTtlDays: integer('invite_ttl_days').notNull().default(7),
	/** Maximum missed recurring occurrences generated in one sweep. Caps the
	 *  flood after a long period of downtime. */
	recurringCatchupMax: integer('recurring_catchup_max').notNull().default(36),
	/** Require category names to be unique within this workspace. */
	uniqueCategories: boolean('unique_categories').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull()
});

export const workspaceMember = pgTable(
	'workspace_member',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		userId: uuid('user_id')
			.notNull()
			.references(() => user.id),
		role: memberRole('role').notNull().default('member'),
		approvalPolicy: jsonb('approval_policy').notNull(),
		status: memberStatus('status').notNull().default('active'),
		/** Intelligence summary cadence for this member: 'off' | 'weekly' | 'monthly'.
		 *  Per-member because a summary is your own seal-filtered view. */
		summaryCadence: text('summary_cadence').notNull().default('off'),
		/** When their last summary was sent, so the sweep fires once per period and
		 *  can catch up after downtime. */
		summaryLastSentAt: timestamp('summary_last_sent_at', { withTimezone: true }),
		/** Harmony's Safe-to-Spend watch, per member (their own seal-filtered number).
		 *  The month (period start) and the worst level already alerted for it —
		 *  a high-water mark so we nudge once per level per month, not every sweep. */
		safeToSpendAlertMonth: date('safe_to_spend_alert_month'),
		safeToSpendAlertLevel: integer('safe_to_spend_alert_level').notNull().default(0),
		/** Whether to show bucket activity on the ledger. A display preference, not a
		 *  permissions control — persisted here so it follows you across devices. */
		includeLedgerMovements: boolean('include_ledger_movements').notNull().default(false),
		/** How the Safe to Spend headline reads on the ledger for this member:
		 *  'shown' | 'masked' | 'off' (see domain/visibility/discretion). Discretion
		 *  over your own shoulder, not access control — per member, like the above.
		 *  Defaults to masked: the number reads across a café from the next table,
		 *  and a default you have to notice to turn on is the wrong way round. */
		safeToSpendDisplay: text('safe_to_spend_display').notNull().default('masked'),
		/** Whether the Safe to Spend breakdown projects the months after this one. */
		showRunwayMonths: boolean('show_runway_months').notNull().default(true),
		joinedAt: timestamp('joined_at', { withTimezone: true }).notNull()
	},
	(t) => [uniqueIndex('workspace_member_workspace_user_uq').on(t.workspaceId, t.userId)]
);

export const invite = pgTable('invite', {
	id: uuid('id').primaryKey(),
	workspaceId: uuid('workspace_id')
		.notNull()
		.references(() => workspace.id),
	code: text('code').notNull().unique(),
	createdBy: uuid('created_by')
		.notNull()
		.references(() => workspaceMember.id),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	consumedBy: uuid('consumed_by').references(() => user.id),
	consumedAt: timestamp('consumed_at', { withTimezone: true })
});

export const category = pgTable(
	'category',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		name: text('name').notNull(),
		icon: text('icon'),
		color: text('color'),
		parentId: uuid('parent_id').references((): AnyPgColumn => category.id),
		isArchived: boolean('is_archived').notNull().default(false),
		isBuiltIn: boolean('is_built_in').notNull().default(false)
	},
	(t) => [index('category_workspace_idx').on(t.workspaceId)]
);

/**
 * Who money was paid to. The UI calls this field **"From"**; it is `merchant`
 * here, in the repositories, and in the MCP tool arguments, and that difference
 * is deliberate rather than drift. The form used to label it "Where", which
 * conflated two questions — *who did you pay* and *where were you* — and the
 * second one now has its own columns below. Renaming the table would have
 * broken every existing MCP client to buy nothing, so the label moved and the
 * schema did not.
 *
 * The pin here is where this vendor **usually** is: learned from the first
 * purchase that carried an observed pin, and used to prefill and to place
 * historical purchases that were logged from the sofa. It is a default, never
 * authoritative over a purchase's own pin — a chain is one row here
 * (`merchant_workspace_normalized_uq` folds on name alone) and many places in
 * the world, so the Costco in Foster City and the one in South San Francisco
 * share this row and cannot both live in it.
 *
 * **Seal trap.** These rows are workspace-global and carry no seal of their
 * own. `select * from merchant where lat_e3 is not null` would hand a concealed
 * viewer the location of a vendor that exists only because of a sealed gift.
 * Every map query must enter through `purchase` — where `visibleTo` applies —
 * and join out to here. Never the other way round.
 */
export const merchant = pgTable(
	'merchant',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull(),
		/** Millidegrees — see the note on `purchase.latE3`. */
		latE3: integer('lat_e3'),
		lngE3: integer('lng_e3'),
		/** The address as a person reads it, for the picker and the map sheet. */
		placeLabel: text('place_label'),
		/** 'device' | 'geocode' | 'link' — how this default was arrived at. Only
		 *  an observed pin may teach it; an inherited one must never become one. */
		locationSource: text('location_source'),
		locationUpdatedAt: timestamp('location_updated_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('merchant_workspace_normalized_uq').on(t.workspaceId, t.normalizedName),
		check('merchant_latlng_paired', sql`(${t.latE3} is null) = (${t.lngE3} is null)`),
		check('merchant_lat_range', sql`${t.latE3} is null or ${t.latE3} between -90000 and 90000`),
		check('merchant_lng_range', sql`${t.lngE3} is null or ${t.lngE3} between -180000 and 180000`)
	]
);

/**
 * A card or account money is spent from.
 *
 * Exists for reconciliation. Statements arrive per card, but a workspace's
 * purchases were one undifferentiated pool, so importing three cards over the
 * same month put every purchase in the running for every card's lines — and
 * nothing recorded which card a purchase was actually on. Both halves are fixed
 * by the same nullable reference.
 *
 * Nullable everywhere on purpose: a household that never reconciles never has
 * to name an account, and every purchase recorded before this existed stays
 * valid. `last4` is a label, not a credential — the digits printed on the card
 * so two Visas can be told apart in a picker.
 */
export const account = pgTable(
	'account',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		name: text('name').notNull(),
		last4: text('last4'),
		kind: accountKind('kind').notNull().default('card'),
		isArchived: boolean('is_archived').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [index('account_workspace_idx').on(t.workspaceId, t.isArchived)]
);

export const purchase = pgTable(
	'purchase',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		state: purchaseState('state').notNull(),
		itemName: text('item_name').notNull(),
		note: text('note'),
		categoryId: uuid('category_id').references(() => category.id),
		merchantId: uuid('merchant_id').references(() => merchant.id),
		/** Which card this was paid on. Null until reconciling teaches us, or the
		 *  person picks one on the form. */
		accountId: uuid('account_id').references(() => account.id),
		/**
		 * Where the money was actually spent, in **millidegrees** — integers, so
		 * ~110 m is the only precision this column is able to hold.
		 *
		 * The rounding is `domain/location/coords.roundToE3`, applied on the device
		 * before the reading ever enters a form field. It does not depend on the
		 * client honouring it: millidegrees are also the wire format, so a
		 * hand-posted request cannot express a doorstep either. A float column
		 * would have let a later writer store seven decimals without going through
		 * any of that, and the privacy decision would be gone with nothing left to
		 * show it had been made.
		 *
		 * Null is the norm and always will be: capture is opt-in per purchase and
		 * never automatic. Falls back to `merchant.lat_e3` on the map only.
		 */
		latE3: integer('lat_e3'),
		lngE3: integer('lng_e3'),
		/** What the place is called, when the person typed or geocoded one. */
		placeLabel: text('place_label'),
		/** 'device' | 'geocode' | 'link' | 'merchant'. 'merchant' means inherited
		 *  from the vendor's usual place, which the map says out loud rather than
		 *  implying somebody stood there. */
		locationSource: text('location_source'),
		requestedAmountMinor: bigint('requested_amount_minor', { mode: 'bigint' }).notNull(),
		approvedAmountMinor: bigint('approved_amount_minor', { mode: 'bigint' }),
		finalAmountMinor: bigint('final_amount_minor', { mode: 'bigint' }),
		currency: text('currency').notNull(),
		sealedUntil: timestamp('sealed_until', { withTimezone: true }),
		sealedFromMemberIds: uuid('sealed_from_member_ids')
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		requestedAt: timestamp('requested_at', { withTimezone: true }),
		decidedAt: timestamp('decided_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		clearedAt: timestamp('cleared_at', { withTimezone: true }),
		lastNudgedAt: timestamp('last_nudged_at', { withTimezone: true }),
		nudgeCount: integer('nudge_count').notNull().default(0),
		recurringRuleId: uuid('recurring_rule_id'),
		parentPurchaseId: uuid('parent_purchase_id').references((): AnyPgColumn => purchase.id),
		bucketId: uuid('bucket_id'),
		// "Sleep on it" hold: when the pause lifts, who set it, and whether the
		// "ready to decide" nudge has already gone out (so the sweep fires once).
		heldUntil: timestamp('held_until', { withTimezone: true }),
		heldBy: uuid('held_by'),
		heldNotifiedAt: timestamp('held_notified_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
	},
	(t) => [
		// Approver queue: pending requests per workspace, oldest first.
		index('purchase_pending_idx')
			.on(t.workspaceId, t.requestedAt)
			.where(sql`state = 'pending_approval'`),
		// Analytics scans.
		index('purchase_workspace_completed_idx').on(t.workspaceId, t.completedAt),
		// Seal filtering.
		index('purchase_sealed_from_gin').using('gin', t.sealedFromMemberIds),
		// Sweep probes. These run every five minutes against every workspace;
		// partial indexes keep each an index-only probe instead of a full scan.
		index('purchase_due_unseal_idx')
			.on(t.sealedUntil)
			.where(sql`cardinality(sealed_from_member_ids) > 0`),
		index('purchase_due_hold_release_idx')
			.on(t.heldUntil)
			.where(sql`state = 'held' and held_notified_at is null`),
		// Safe-to-Spend / ledger "open money" reads: approved, pending and held
		// rows are a small fraction of history and the only unbounded-time states
		// the forecast aggregates.
		index('purchase_open_states_idx')
			.on(t.workspaceId)
			.where(sql`state in ('approved', 'pending_approval', 'held')`),
		index('purchase_member_idx').on(t.memberId),
		// FK lookups: bucket detail lists its purchases, and archiving scans by it.
		index('purchase_bucket_idx').on(t.bucketId),
		// recurring_rule is declared below; declare the FK here to keep types happy.
		foreignKey({
			name: 'purchase_recurring_rule_fk',
			columns: [t.recurringRuleId],
			foreignColumns: [recurringRule.id]
		}),
		foreignKey({
			name: 'purchase_bucket_fk',
			columns: [t.bucketId],
			foreignColumns: [bucket.id]
		}),
		// A half-written pin is not a place. Enforced in the database because the
		// map coalesces the two columns independently, and one of them being null
		// would put a bubble on the prime meridian.
		check('purchase_latlng_paired', sql`(${t.latE3} is null) = (${t.lngE3} is null)`),
		check('purchase_lat_range', sql`${t.latE3} is null or ${t.latE3} between -90000 and 90000`),
		check('purchase_lng_range', sql`${t.lngE3} is null or ${t.lngE3} between -180000 and 180000`),
		// A seal has two halves: who it hides from and when it opens. An
		// open-ended seal would hide from the concealed viewer forever (the
		// visibility predicate fails closed), so both must move together.
		check(
			'purchase_seal_paired',
			sql`cardinality(${t.sealedFromMemberIds}) = 0 or ${t.sealedUntil} is not null`
		)
	]
);

// Snapshot of routing at request time — policy changes must not re-route pending requests.
export const purchaseApprover = pgTable(
	'purchase_approver',
	{
		purchaseId: uuid('purchase_id')
			.notNull()
			.references(() => purchase.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		isRequired: boolean('is_required').notNull().default(false)
	},
	(t) => [primaryKey({ columns: [t.purchaseId, t.memberId] })]
);

export const purchaseImage = pgTable(
	'purchase_image',
	{
		id: uuid('id').primaryKey(),
		purchaseId: uuid('purchase_id')
			.notNull()
			.references(() => purchase.id),
		blobId: text('blob_id').notNull(),
		thumbBlobId: text('thumb_blob_id').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		byteSize: integer('byte_size').notNull(),
		position: integer('position').notNull().default(0)
	},
	(t) => [index('purchase_image_purchase_idx').on(t.purchaseId)]
);

// Append-only. Never updated, never deleted.
export const approvalEvent = pgTable(
	'approval_event',
	{
		id: uuid('id').primaryKey(),
		purchaseId: uuid('purchase_id')
			.notNull()
			.references(() => purchase.id),
		actorMemberId: uuid('actor_member_id').references(() => workspaceMember.id),
		fromState: purchaseState('from_state'),
		toState: purchaseState('to_state').notNull(),
		reason: text('reason'),
		amountSnapshotMinor: bigint('amount_snapshot_minor', { mode: 'bigint' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [index('approval_event_purchase_idx').on(t.purchaseId)]
);

export const recurringRule = pgTable(
	'recurring_rule',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		itemName: text('item_name').notNull(),
		categoryId: uuid('category_id').references(() => category.id),
		merchantId: uuid('merchant_id').references(() => merchant.id),
		/** Generated purchases are charged against this bucket (withdrawn on completion). */
		bucketId: uuid('bucket_id'),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		currency: text('currency').notNull(),
		rrule: text('rrule').notNull(),
		nextOccurrenceAt: timestamp('next_occurrence_at', { withTimezone: true }),
		lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
		status: recurringStatus('status').notNull().default('active'),
		autoComplete: boolean('auto_complete').notNull().default(false),
		endedAt: timestamp('ended_at', { withTimezone: true })
	},
	(t) => [
		index('recurring_rule_workspace_idx').on(t.workspaceId),
		// bucket is declared below; declare the FK here to keep types happy.
		foreignKey({
			name: 'recurring_rule_bucket_fk',
			columns: [t.bucketId],
			foreignColumns: [bucket.id]
		})
	]
);

export const income = pgTable(
	'income',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		source: text('source').notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		currency: text('currency').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
		rrule: text('rrule'),
		note: text('note')
	},
	(t) => [index('income_workspace_received_idx').on(t.workspaceId, t.receivedAt)]
);

export const budget = pgTable(
	'budget',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		categoryId: uuid('category_id').references(() => category.id), // null = overall budget
		period: budgetPeriod('period').notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		effectiveFrom: date('effective_from').notNull(),
		effectiveTo: date('effective_to')
	},
	(t) => [index('budget_workspace_idx').on(t.workspaceId)]
);

/**
 * One row per budget line per period: what the last alert said and when.
 * Keyed by category, not budget row id — replacing a budget (setBudget
 * deletes and reinserts the row) must not reset the cooldown or the alert
 * would repeat after every edit.
 */
export const budgetAlertLog = pgTable(
	'budget_alert_log',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		/** Category id, or 'overall' for the all-category budget. */
		categoryKey: text('category_key').notNull(),
		/**
		 * The period this alert state belongs to: 'YYYY-MM' for a monthly
		 * budget, the week's first day 'YYYY-MM-DD' for a weekly one. The two
		 * shapes can't collide, and a weekly overspend never satisfies a monthly
		 * cooldown.
		 */
		periodKey: text('period_key').notNull(),
		/** 'nearing' | 'exceeded'. */
		level: text('level').notNull(),
		/** Spend reported in the last alert; re-alerts measure growth from here. */
		actualMinor: bigint('actual_minor', { mode: 'bigint' }).notNull(),
		lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }).notNull()
	},
	(t) => [uniqueIndex('budget_alert_log_scope_idx').on(t.workspaceId, t.categoryKey, t.periodKey)]
);

export const bucket = pgTable(
	'bucket',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		name: text('name').notNull(),
		/** Amount added per accrual (per occurrence of the rrule). */
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		currency: text('currency').notNull(),
		goalCapMinor: bigint('goal_cap_minor', { mode: 'bigint' }),
		color: text('color'),
		icon: text('icon'),
		status: bucketStatus('status').notNull().default('active'),
		/**
		 * Who may charge a purchase to this bucket, besides its owner.
		 *
		 * Null means anyone in the workspace, which is what every bucket was
		 * before this column and stays the default. A list names exactly who else
		 * may charge it; an empty list is therefore "only me", which is what makes
		 * a bucket an allowance. The owner is always implied and never stored, so
		 * the two can't drift apart.
		 */
		chargeMemberIds: uuid('charge_member_ids').array(),
		/** Accrual schedule — the same RRULE subset recurring purchases use. */
		rrule: text('rrule').notNull(),
		/** When the next accrual is due. Null = not scheduled yet; the sweep
		 *  initializes it from the rrule and advances it after each accrual. */
		nextAccrualAt: timestamp('next_accrual_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [
		index('bucket_workspace_idx').on(t.workspaceId),
		// The accrual sweep's candidate probe, every five minutes: active
		// buckets are nearly all of them, but the scan is by pointer, not id.
		index('bucket_due_accrual_idx')
			.on(t.nextAccrualAt)
			.where(sql`status = 'active'`)
	]
);

export const bucketTransaction = pgTable(
	'bucket_transaction',
	{
		id: uuid('id').primaryKey(),
		bucketId: uuid('bucket_id')
			.notNull()
			.references(() => bucket.id),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		currency: text('currency').notNull(),
		type: bucketTxnType('type').notNull(),
		note: text('note'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [index('bucket_txn_bucket_idx').on(t.bucketId)]
);

export const statementImport = pgTable(
	'statement_import',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		filename: text('filename').notNull(),
		/** The card this statement is for. Null keeps the old behaviour: match
		 *  against every purchase in the window. */
		accountId: uuid('account_id').references(() => account.id),
		format: statementImportFormat('format').notNull(),
		currency: text('currency').notNull(),
		blobId: text('blob_id'),
		periodStart: timestamp('period_start', { withTimezone: true }),
		periodEnd: timestamp('period_end', { withTimezone: true }),
		lineCount: integer('line_count').notNull(),
		matchedCount: integer('matched_count').notNull(),
		status: text('status').notNull().default('reviewing'),
		/**
		 * True when these lines came off a *picture* of a statement that a model
		 * transcribed, rather than off text the app read itself.
		 *
		 * It is carried for two reasons, and only one of them exists yet. The one
		 * that does: the review screen says so, on every screen, so nobody ticks a
		 * match off transcribed evidence without knowing that's what it is. The one
		 * that doesn't yet: reconciliation cannot currently create a ledger entry,
		 * but the day something can turn a bank line into a purchase, that feature
		 * must refuse a model-read import — it would be the first path putting a
		 * model-derived amount into the ledger directly. This column is what that
		 * guard will be written against.
		 */
		modelRead: boolean('model_read').notNull().default(false),
		contentHash: text('content_hash').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [index('statement_import_workspace_idx').on(t.workspaceId, t.createdAt)]
);

export const statementLine = pgTable(
	'statement_line',
	{
		id: uuid('id').primaryKey(),
		importId: uuid('import_id')
			.notNull()
			.references(() => statementImport.id),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
		amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
		currency: text('currency').notNull(),
		rawDescription: text('raw_description').notNull(),
		normalizedDescription: text('normalized_description').notNull(),
		externalId: text('external_id'),
		matchState: statementLineMatchState('match_state').notNull().default('unmatched'),
		matchedPurchaseId: uuid('matched_purchase_id').references(() => purchase.id),
		matchReason: text('match_reason'),
		/**
		 * Purchase ids the matcher ranked for this line but would not claim, best
		 * first. The ranking is computed at import for every line and used to be
		 * discarded, which left an ambiguous line facing a blank search box even
		 * though we already knew the two or three purchases it was probably about.
		 *
		 * Deliberately *just ids*, and deliberately not a foreign key: this is a
		 * hint, not a relationship. Nothing reads it without re-checking each id
		 * against the seal-filtered purchase rows, so a stale or invisible id
		 * simply doesn't render. Empty for a matched line, and for a line with
		 * nothing in range at all.
		 */
		suggestedPurchaseIds: jsonb('suggested_purchase_ids').notNull().default([]).$type<string[]>(),
		dedupHash: text('dedup_hash').notNull()
	},
	(t) => [
		index('statement_line_import_idx').on(t.importId),
		index('statement_line_matched_purchase_idx').on(t.matchedPurchaseId),
		uniqueIndex('statement_line_import_dedup_uq').on(t.importId, t.dedupHash)
	]
);

export const pushSubscription = pgTable('push_subscription', {
	id: uuid('id').primaryKey(),
	userId: uuid('user_id')
		.notNull()
		.references(() => user.id),
	endpoint: text('endpoint').notNull().unique(),
	p256dh: text('p256dh').notNull(),
	auth: text('auth').notNull(),
	userAgent: text('user_agent'),
	platform: text('platform'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
	failureCount: integer('failure_count').notNull().default(0)
});

export const ntfyTarget = pgTable('ntfy_target', {
	id: uuid('id').primaryKey(),
	userId: uuid('user_id')
		.notNull()
		.references(() => user.id),
	topic: text('topic').notNull(),
	serverUrl: text('server_url').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull()
});

export const notificationPref = pgTable(
	'notification_pref',
	{
		workspaceMemberId: uuid('workspace_member_id')
			.notNull()
			.references(() => workspaceMember.id),
		eventType: text('event_type').notNull(),
		channel: text('channel').notNull(),
		enabled: boolean('enabled').notNull().default(true)
	},
	(t) => [primaryKey({ columns: [t.workspaceMemberId, t.eventType, t.channel] })]
);

// Personal access tokens for the MCP server (and any future API surface).
// The secret is shown once at creation and never stored — only its SHA-256 hash
// is kept, so a database leak can't be replayed. Scoped to a single
// workspace_member, so every read/write acts as that person: seals, approval
// routing and permissions all apply exactly as they do in the web app.
export const apiToken = pgTable(
	'api_token',
	{
		id: uuid('id').primaryKey(),
		workspaceMemberId: uuid('workspace_member_id')
			.notNull()
			.references(() => workspaceMember.id),
		name: text('name').notNull(),
		/** SHA-256 hex of the secret. Unique so a lookup is a single indexed hit. */
		tokenHash: text('token_hash').notNull().unique(),
		/** First few visible chars (e.g. "ldg_A1b2") for the list — never the secret. */
		prefix: text('prefix').notNull(),
		/** Subset of ['read','write','approve']. Empty = no access (revoked shape). */
		scopes: text('scopes')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true })
	},
	(t) => [index('api_token_member_idx').on(t.workspaceMemberId)]
);

// id is a high-entropy random token (not uuidv7 — session ids must be unguessable).
export const session = pgTable(
	'session',
	{
		id: text('id').primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => user.id),
		activeWorkspaceId: uuid('active_workspace_id').references(() => workspace.id),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		userAgent: text('user_agent'),
		ip: text('ip')
	},
	(t) => [index('session_user_idx').on(t.userId)]
);

/*
 * A receipt photo shared into the app from the OS share sheet (the manifest's
 * `share_target`), staged for the new-purchase form to pick up. Staging only:
 * rows are swept an hour after creation, win or lose.
 *
 * The blob itself goes through the same content-addressed store as every
 * other image, but it is NOT served by /blobs/[blobId] — that route gates on
 * purchase attachment (isBlobVisible), and a share has no purchase yet. It
 * gets its own member-scoped route instead, so the attachment invariant stays
 * exactly as strict as it was.
 */
export const pendingShare = pgTable(
	'pending_share',
	{
		id: uuid('id').primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspace.id),
		memberId: uuid('member_id')
			.notNull()
			.references(() => workspaceMember.id),
		blobId: text('blob_id').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull()
	},
	(t) => [index('pending_share_member_idx').on(t.workspaceId, t.memberId, t.createdAt)]
);
