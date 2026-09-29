-- Sessions are stored as SHA-256 of the cookie token, base64url without padding
-- (see hashSessionToken in src/lib/server/auth/session.ts). Rows written before
-- that held the token itself; rewrite each under its hash so every existing
-- login keeps working and no plaintext credential is left in the table.
-- sha256() is built into Postgres 11+, so no extension is needed.
UPDATE "session"
SET "id" = translate(rtrim(encode(sha256(convert_to("id", 'UTF8')), 'base64'), '='), '+/', '-_');
