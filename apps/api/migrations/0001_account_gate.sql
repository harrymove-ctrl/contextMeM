CREATE TABLE IF NOT EXISTS contextmem_accounts (
  id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'unknown',
  memwal_account_id TEXT,
  delegate_key_ciphertext TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES contextmem_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_run_owners (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES contextmem_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contextmem_quota_consumptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES contextmem_accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE,
  consumed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contextmem_quota_account_time_idx ON contextmem_quota_consumptions(account_id, consumed_at);
CREATE INDEX IF NOT EXISTS contextmem_run_owners_account_idx ON contextmem_run_owners(account_id);
