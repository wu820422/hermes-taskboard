CREATE TABLE IF NOT EXISTS sync_rejected (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  hlc TEXT NOT NULL,
  change_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_rejected_status ON sync_rejected(status, direction);
