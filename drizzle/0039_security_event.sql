CREATE TABLE "security_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"actor_member_id" uuid,
	"actor_name" text,
	"target_member_id" uuid,
	"target_name" text,
	"detail" jsonb,
	"ip" text,
	"user_agent" text,
	"session_tag" text,
	"session_user_agent" text
);
--> statement-breakpoint
CREATE INDEX "security_event_workspace_idx" ON "security_event" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "security_event_actor_idx" ON "security_event" USING btree ("actor_user_id","created_at");