ALTER TABLE contextmem_extraction_jobs ADD COLUMN build_kind TEXT NOT NULL DEFAULT 'single' CHECK (build_kind IN ('single', 'multi'));
ALTER TABLE contextmem_extraction_jobs ADD COLUMN sources_json TEXT;
ALTER TABLE contextmem_extraction_jobs ADD COLUMN source_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE contextmem_namespaces ADD COLUMN build_kind TEXT NOT NULL DEFAULT 'single' CHECK (build_kind IN ('single', 'multi'));
ALTER TABLE contextmem_namespaces ADD COLUMN sources_json TEXT;
ALTER TABLE contextmem_namespaces ADD COLUMN source_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS contextmem_extraction_jobs_build_kind_idx ON contextmem_extraction_jobs(build_kind, updated_at);
CREATE INDEX IF NOT EXISTS contextmem_namespaces_build_kind_idx ON contextmem_namespaces(build_kind, updated_at);
