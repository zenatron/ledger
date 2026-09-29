ALTER TABLE "bucket_transaction" ADD COLUMN "purchase_id" uuid;--> statement-breakpoint
CREATE INDEX "bucket_txn_purchase_idx" ON "bucket_transaction" USING btree ("purchase_id");--> statement-breakpoint
-- Backfill: link each existing charge withdrawal to the purchase it came from.
-- Until now the only link was the note (the item name), so match on exactly
-- what withdrawFromBucket wrote: same bucket, note = item name, amount = the
-- negated final amount. Ambiguous matches (two identical charges) link to the
-- newest purchase; either way the movement inherits a seal it should have had.
UPDATE "bucket_transaction" bt
SET "purchase_id" = (
	SELECT p."id" FROM "purchase" p
	WHERE p."bucket_id" = bt."bucket_id"
		AND p."item_name" = bt."note"
		AND p."final_amount_minor" = -bt."amount_minor"
		AND p."parent_purchase_id" IS NULL
	ORDER BY p."created_at" DESC
	LIMIT 1
)
WHERE bt."type" = 'withdrawal' AND bt."purchase_id" IS NULL AND bt."note" IS NOT NULL;
