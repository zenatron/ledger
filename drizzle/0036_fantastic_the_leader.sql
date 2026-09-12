CREATE INDEX "bucket_due_accrual_idx" ON "bucket" USING btree ("next_accrual_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "purchase_due_unseal_idx" ON "purchase" USING btree ("sealed_until") WHERE cardinality(sealed_from_member_ids) > 0;--> statement-breakpoint
CREATE INDEX "purchase_due_hold_release_idx" ON "purchase" USING btree ("held_until") WHERE state = 'held' and held_notified_at is null;--> statement-breakpoint
CREATE INDEX "purchase_open_states_idx" ON "purchase" USING btree ("workspace_id") WHERE state in ('approved', 'pending_approval', 'held');