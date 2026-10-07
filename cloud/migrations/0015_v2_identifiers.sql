INSERT INTO sync_meta (key, value) VALUES ('v2_identifiers', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO sync_meta (key, value) VALUES ('device_id', 'cloud') ON CONFLICT(key) DO NOTHING;
INSERT INTO sync_meta (key, value) VALUES ('device_slot', '1') ON CONFLICT(key) DO NOTHING;
