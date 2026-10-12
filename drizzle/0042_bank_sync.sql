CREATE TYPE "public"."bank_connection_status" AS ENUM('ok', 'error');--> statement-breakpoint
ALTER TYPE "public"."statement_import_format" ADD VALUE 'feed';--> statement-breakpoint
CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"label" text NOT NULL,
	"access_url" text NOT NULL,
	"status" "bank_connection_status" DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_feed_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"org_name" text,
	"currency" text NOT NULL,
	"balance_minor" bigint,
	"balance_at" timestamp with time zone,
	"account_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_member_id_workspace_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_account" ADD CONSTRAINT "bank_feed_account_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_connection_workspace_idx" ON "bank_connection" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_account_connection_ext_uq" ON "bank_feed_account" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_line_workspace_external_uq" ON "statement_line" USING btree ("workspace_id","external_id") WHERE external_id is not null;