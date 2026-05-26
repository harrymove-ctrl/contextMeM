CREATE TABLE IF NOT EXISTS contextmem_namespaces (
  namespace TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  current_version_id TEXT NOT NULL,
  source_run_id TEXT,
  manifest_json TEXT NOT NULL,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  byte_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_namespace_versions (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES contextmem_namespaces(namespace) ON DELETE CASCADE,
  source_run_id TEXT,
  manifest_json TEXT NOT NULL,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  byte_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_namespace_tokens (
  token_hash TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES contextmem_namespaces(namespace) ON DELETE CASCADE,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS contextmem_namespace_artifacts (
  namespace TEXT NOT NULL REFERENCES contextmem_namespaces(namespace) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES contextmem_namespace_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, version_id, path)
);

CREATE INDEX IF NOT EXISTS contextmem_namespace_tokens_namespace_idx ON contextmem_namespace_tokens(namespace);
CREATE INDEX IF NOT EXISTS contextmem_namespace_artifacts_namespace_current_idx ON contextmem_namespace_artifacts(namespace, version_id);
