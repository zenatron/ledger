-- createToken took an expiry but never wrote it, so every token minted with
-- one has been valid forever. The chosen expiry was recorded in the security
-- log at creation, keyed by the token's prefix; restore it from there. Tokens
-- created before the log existed have no record and stay unexpiring.
UPDATE "api_token" t
SET "expires_at" = (e."detail"->>'expiresAt')::timestamptz
FROM "security_event" e
WHERE e."action" = 'api_token.created'
	AND e."actor_member_id" = t."workspace_member_id"
	AND e."detail"->>'prefix' = t."prefix"
	AND e."detail"->>'expiresAt' IS NOT NULL
	AND t."expires_at" IS NULL;
