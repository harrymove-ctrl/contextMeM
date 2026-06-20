-- Hosted delegate identity binding (#23): make the self-asserted x-memwal-account-id
-- header non-spoofable.
--
-- The hosted Worker has no signup/session, so before this change a caller could
-- claim ANY owner id just by setting a header, and the namespace artifact-edit route
-- (`POST /api/namespaces/:ns/artifact-edit`) authorized writes on a raw string match
-- against that header. We now bind each hosted owner to the FIRST delegate secret we
-- see (trust-on-first-use) and verify every later owner-scoped mutation against the
-- stored hash, so an attacker who guesses a victim's owner id but lacks the bound
-- delegate secret is rejected.
--
-- secret_hash is sha256(owner_id || ':' || delegate_secret) — salted by owner so the
-- raw delegate secret is never stored. created_at/last_seen_at are advisory.
CREATE TABLE IF NOT EXISTS contextmem_hosted_delegates (
  owner_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
