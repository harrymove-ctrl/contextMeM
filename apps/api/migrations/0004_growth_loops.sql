CREATE TABLE IF NOT EXISTS contextmem_feedback (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  page_url TEXT,
  sentiment TEXT,
  message TEXT NOT NULL,
  contact TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_demo_limits (
  bucket_key TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_share_links (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES contextmem_namespaces(namespace) ON DELETE CASCADE,
  target TEXT NOT NULL,
  title TEXT,
  description TEXT,
  source_run_id TEXT,
  version_id TEXT NOT NULL,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  byte_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  target TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  webhook_url TEXT,
  webhook_secret TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES contextmem_schedules(id) ON DELETE CASCADE,
  extraction_job_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  diff_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS contextmem_alerts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  schedule_id TEXT,
  namespace TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  diff_json TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_webhook_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES contextmem_alerts(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  status_code INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contextmem_feedback_created_idx ON contextmem_feedback(created_at);
CREATE INDEX IF NOT EXISTS contextmem_share_links_namespace_idx ON contextmem_share_links(namespace);
CREATE INDEX IF NOT EXISTS contextmem_schedules_owner_next_idx ON contextmem_schedules(owner_id, next_run_at);
CREATE INDEX IF NOT EXISTS contextmem_schedules_active_next_idx ON contextmem_schedules(active, next_run_at);
CREATE INDEX IF NOT EXISTS contextmem_schedule_runs_schedule_idx ON contextmem_schedule_runs(schedule_id, created_at);
CREATE INDEX IF NOT EXISTS contextmem_alerts_owner_created_idx ON contextmem_alerts(owner_id, created_at);
CREATE INDEX IF NOT EXISTS contextmem_webhook_deliveries_alert_idx ON contextmem_webhook_deliveries(alert_id);
