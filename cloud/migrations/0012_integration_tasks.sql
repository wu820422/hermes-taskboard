ALTER TABLE tasks ADD COLUMN external_source TEXT;
ALTER TABLE tasks ADD COLUMN external_origin TEXT;
ALTER TABLE tasks ADD COLUMN external_id TEXT;
ALTER TABLE tasks ADD COLUMN external_key TEXT;
ALTER TABLE tasks ADD COLUMN external_url TEXT;
CREATE UNIQUE INDEX tasks_external_origin_key_unique
  ON tasks(external_origin, external_key)
  WHERE external_origin IS NOT NULL AND external_key IS NOT NULL;
