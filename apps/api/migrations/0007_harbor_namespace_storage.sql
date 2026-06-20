-- Harbor (Walrus) private storage for namespaces.
-- PRIVATE namespaces are Seal-encrypted in the Worker and their ciphertext is
-- stored in a per-namespace Harbor bucket instead of plaintext R2. All columns
-- are nullable so existing/public artifacts (r2_key only, no harbor_file_id)
-- keep working unchanged. D1/SQLite requires one ALTER per statement.

-- Per-namespace Harbor bucket + Seal policy (resolved/created once, reused across versions).
ALTER TABLE contextmem_namespaces ADD COLUMN harbor_space_id TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN harbor_bucket_id TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN harbor_seal_policy_id TEXT;

-- StorageProvider seam (#19): which backend holds this namespace's artifacts
-- ('harbor' = private/encrypted, NULL or 'r2' = public/plaintext), and the
-- per-namespace Seal identity salt (32-byte nonce, hex) so the encryption identity
-- stays stable across versions. Nullable so existing namespaces keep working.
ALTER TABLE contextmem_namespaces ADD COLUMN storage_provider TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN seal_identity_salt TEXT;

-- Per-artifact Harbor file pointer. When set, the read path decrypts from Harbor
-- and ignores r2_key (which holds a `harbor:<fileId>` sentinel to satisfy NOT NULL).
ALTER TABLE contextmem_namespace_artifacts ADD COLUMN harbor_file_id TEXT;
ALTER TABLE contextmem_namespace_artifacts ADD COLUMN harbor_bucket_id TEXT;

CREATE INDEX IF NOT EXISTS contextmem_artifacts_harbor_idx ON contextmem_namespace_artifacts(harbor_bucket_id, harbor_file_id);
