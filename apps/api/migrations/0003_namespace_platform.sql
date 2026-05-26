ALTER TABLE contextmem_namespaces ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE contextmem_namespaces ADD COLUMN display_name TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN description TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE contextmem_namespaces ADD COLUMN source_type TEXT NOT NULL DEFAULT 'import';
ALTER TABLE contextmem_namespaces ADD COLUMN directory_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE contextmem_namespace_tokens ADD COLUMN token_id TEXT;

CREATE INDEX IF NOT EXISTS contextmem_namespaces_owner_updated_idx ON contextmem_namespaces(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS contextmem_namespaces_directory_idx ON contextmem_namespaces(visibility, directory_enabled, updated_at);
CREATE INDEX IF NOT EXISTS contextmem_namespace_tokens_token_id_idx ON contextmem_namespace_tokens(token_id);

CREATE TABLE IF NOT EXISTS contextmem_extraction_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  display_name TEXT,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  directory_enabled INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'extract',
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS contextmem_extraction_jobs_owner_updated_idx ON contextmem_extraction_jobs(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS contextmem_extraction_jobs_namespace_idx ON contextmem_extraction_jobs(namespace);
