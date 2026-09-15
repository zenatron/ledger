ALTER TABLE "bucket" ADD COLUMN "is_allowance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: only buckets the old Members-page setup created are allowances.
-- It named them "<name>'s allowance" and made them "only me"; a personal
-- bucket someone made for themselves (a Savings pot) stays an ordinary bucket.
UPDATE "bucket" SET "is_allowance" = true WHERE "charge_member_ids" = '{}' AND "name" LIKE '%''s allowance';
