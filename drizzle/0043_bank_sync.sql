CREATE TYPE "public"."bank_connection_status" AS ENUM('active', 'error', 'revoked', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."bank_provider" AS ENUM('simplefin');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_action" AS ENUM('categorize', 'ignore');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_match" AS ENUM('contains', 'starts_with', 'equals');--> statement-breakpoint
ALTER TYPE "public"."statement_import_format" ADD VALUE 'sync';--> statement-breakpoint
CREATE TABLE "bank_balance_snapshot" (
	"feed_account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"balance_minor" bigint NOT NULL,
	"available_balance_minor" bigint,
	"currency" text NOT NULL,
	CONSTRAINT "bank_balance_snapshot_feed_account_id_day_pk" PRIMARY KEY("feed_account_id","day")
);
--> statement-breakpoint
CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"provider" "bank_provider" NOT NULL,
	"label" text NOT NULL,
	"credential_sealed" text,
	"host" text NOT NULL,
	"status" "bank_connection_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_feed_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"institution" text,
	"currency" text NOT NULL,
	"holder_member_id" uuid,
	"visibility" text DEFAULT 'holder' NOT NULL,
	"account_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"unsupported_reason" text,
	"balance_minor" bigint,
	"available_balance_minor" bigint,
	"balance_at" timestamp with time zone,
	"synced_through" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match" "bank_rule_match" NOT NULL,
	"pattern" text NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"min_amount_minor" bigint,
	"max_amount_minor" bigint,
	"feed_account_id" uuid,
	"action" "bank_rule_action" NOT NULL,
	"category_id" uuid,
	"rename_to" text,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_sync_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"http_status" integer,
	"accounts_seen" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"categorized" integer DEFAULT 0 NOT NULL,
	"ignored_by_rule" integer DEFAULT 0 NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "statement_import" ADD COLUMN "visible_to_member_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_line" ADD COLUMN "suggested_category_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_line" ADD COLUMN "suggested_name" text;--> statement-breakpoint
ALTER TABLE "statement_line" ADD COLUMN "suggestion_source" text;--> statement-breakpoint
ALTER TABLE "statement_line" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_balance_snapshot" ADD CONSTRAINT "bank_balance_snapshot_feed_account_id_bank_feed_account_id_fk" FOREIGN KEY ("feed_account_id") REFERENCES "public"."bank_feed_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_member_id_workspace_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_holder_member_id_workspace_member_id_fk" FOREIGN KEY ("holder_member_id") REFERENCES "public"."workspace_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_feed_account_id_bank_feed_account_id_fk" FOREIGN KEY ("feed_account_id") REFERENCES "public"."bank_feed_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_sync_run" ADD CONSTRAINT "bank_sync_run_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_connection_workspace_idx" ON "bank_connection" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bank_connection_due_idx" ON "bank_connection" USING btree ("next_sync_at") WHERE "bank_connection"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_account_conn_ext_uq" ON "bank_feed_account" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "bank_rule_workspace_idx" ON "bank_rule" USING btree ("workspace_id","priority");--> statement-breakpoint
CREATE INDEX "bank_sync_run_conn_idx" ON "bank_sync_run" USING btree ("connection_id","started_at");--> statement-breakpoint
ALTER TABLE "statement_import" ADD CONSTRAINT "statement_import_visible_to_member_id_workspace_member_id_fk" FOREIGN KEY ("visible_to_member_id") REFERENCES "public"."workspace_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_line" ADD CONSTRAINT "statement_line_suggested_category_id_category_id_fk" FOREIGN KEY ("suggested_category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_line_external_uq" ON "statement_line" USING btree ("workspace_id","external_id") WHERE "statement_line"."external_id" is not null;