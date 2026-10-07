ALTER TABLE projects ADD COLUMN start_date TEXT;
ALTER TABLE projects ADD COLUMN identifier_prefix TEXT;

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_field_clocks (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  hlc TEXT NOT NULL,
  prev_hlc TEXT,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  device_id TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, field)
);
CREATE TABLE IF NOT EXISTS sync_entities (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  prev_hlc TEXT,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  fields_json TEXT,
  hlc TEXT NOT NULL,
  prev_hlc TEXT,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_log_entity ON sync_log(entity_type, entity_id, seq);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  local_value_json TEXT,
  local_hlc TEXT,
  local_device TEXT,
  remote_value_json TEXT,
  remote_hlc TEXT,
  remote_device TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  peer_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS identifier_counters (
  prefix TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identifier_leases (
  device_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  generation INTEGER NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY (device_id, prefix, generation)
);
CREATE TABLE IF NOT EXISTS identifier_aliases (
  alias TEXT NOT NULL,
  task_id TEXT NOT NULL,
  stored_identifier TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (alias, task_id)
);
CREATE TABLE IF NOT EXISTS identifier_allocations (
  identifier TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
