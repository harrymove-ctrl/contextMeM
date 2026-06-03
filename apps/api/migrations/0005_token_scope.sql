ALTER TABLE contextmem_namespace_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read';
ALTER TABLE contextmem_namespace_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE contextmem_namespace_tokens ADD COLUMN snapshot_pin TEXT;
