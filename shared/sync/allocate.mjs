// Identifier allocation for Hermes Taskboard v2.
//
// Human identifiers (HER-72, 202-119, CHA-143) stay stable. Sync identity is the
// immutable task id. New numbers come from a block that depends only on the
// device slot and generation, never on the highest number this device has seen:
//
//   range(slot, generation) = [1 + (generation * 64 + slot) * 100, +100)
//
// Slot 0 is Leo's Mac (1–100, then 6401–6500, …). Slot 1 is the cloud worker
// (101–200, then 6501–6600, …). A number already stored for that prefix is
// skipped, not rewritten. When a device has no slot, the allocator uses
// PREFIX-P{deviceTag}-N, which cannot collide with PREFIX-N.

export const IDENTIFIER_BLOCK = 100;
export const IDENTIFIER_SLOT_STRIDE = 64;

export function legacyPrefix(project) {
  const idPrefix = String(project.id ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && /^[A-Z0-9]+$/i.test(existingPrefix) && existingPrefix !== idPrefix) {
    return existingPrefix.toUpperCase();
  }
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = String(project.name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 3);
  return namePrefix || idPrefix.slice(0, 3);
}

export function rangeFor(slot, generation) {
  const start = 1 + (generation * IDENTIFIER_SLOT_STRIDE + slot) * IDENTIFIER_BLOCK;
  return { start, end: start + IDENTIFIER_BLOCK };
}

export function leaseMatchesSlot(lease, slot) {
  const expected = rangeFor(slot, Number(lease.generation));
  return Number(lease.range_start) === expected.start && Number(lease.range_end) === expected.end;
}

export function deviceTag(deviceId) {
  return String(deviceId ?? "xxxx").replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase() || "XXXX";
}

export function v2IdentifiersEnabled(database) {
  try {
    const row = database.prepare("SELECT value FROM sync_meta WHERE key = 'v2_identifiers'").get();
    return row?.value === "1";
  } catch {
    return false;
  }
}

function meta(database, key) {
  return database.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key)?.value ?? null;
}

function identifierTaken(database, identifier) {
  return Boolean(database.prepare("SELECT 1 AS ok FROM tasks WHERE identifier = ?").get(identifier));
}

function recordAllocation(database, identifier, deviceId) {
  database.prepare(`
    INSERT INTO identifier_allocations (identifier, task_id, device_id, created_at)
    VALUES (?, '', ?, ?)
    ON CONFLICT(identifier) DO NOTHING
  `).run(identifier, deviceId, new Date().toISOString());
}

function readLeases(database, deviceId, prefix) {
  return database.prepare(`
    SELECT generation, range_start, range_end, cursor
    FROM identifier_leases
    WHERE device_id = ? AND prefix = ?
    ORDER BY generation
  `).all(deviceId, prefix);
}

function openCanonicalLease(database, deviceId, prefix, slot) {
  const leases = readLeases(database, deviceId, prefix);
  const open = leases.find((lease) => leaseMatchesSlot(lease, slot) && lease.cursor < lease.range_end);
  if (open) return open;
  const unused = leases.find((lease) => lease.cursor === lease.range_start && !leaseMatchesSlot(lease, slot));
  if (unused) {
    const range = rangeFor(slot, unused.generation);
    database.prepare(`
      UPDATE identifier_leases
      SET range_start = ?, range_end = ?, cursor = ?
      WHERE device_id = ? AND prefix = ? AND generation = ?
    `).run(range.start, range.end, range.start, deviceId, prefix, unused.generation);
    return { generation: unused.generation, range_start: range.start, range_end: range.end, cursor: range.start };
  }
  const generation = leases.reduce((max, lease) => Math.max(max, Number(lease.generation)), -1) + 1;
  const range = rangeFor(slot, generation);
  database.prepare(`
    INSERT INTO identifier_leases (
      device_id, prefix, generation, range_start, range_end, cursor
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, prefix, generation, range.start, range.end, range.start);
  return { generation, range_start: range.start, range_end: range.end, cursor: range.start };
}

function takeFromLease(database, deviceId, prefix, slot) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lease = openCanonicalLease(database, deviceId, prefix, slot);
    let cursor = Number(lease.cursor);
    const rangeEnd = Number(lease.range_end);
    const generation = lease.generation;
    while (cursor < rangeEnd) {
      const identifier = `${prefix}-${cursor}`;
      const next = cursor + 1;
      database.prepare(`
        UPDATE identifier_leases
        SET cursor = ?
        WHERE device_id = ? AND prefix = ? AND generation = ?
      `).run(next, deviceId, prefix, generation);
      cursor = next;
      if (!identifierTaken(database, identifier)) {
        recordAllocation(database, identifier, deviceId);
        return identifier;
      }
    }
  }
  return null;
}

export function allocateIdentifierSync(database, { project, deviceId = null, deviceSlot = null } = {}) {
  const prefix = (project.identifier_prefix || legacyPrefix(project)).toUpperCase();
  const resolvedDevice = deviceId ?? meta(database, "device_id");
  const slotRaw = deviceSlot ?? meta(database, "device_slot");
  const slot = slotRaw === null || slotRaw === undefined || slotRaw === "" ? null : Number(slotRaw);
  if (!resolvedDevice || slot === null || !Number.isInteger(slot) || slot < 0 || slot >= IDENTIFIER_SLOT_STRIDE) {
    return allocateSymbolic(database, prefix, resolvedDevice || "unassigned");
  }
  const issued = takeFromLease(database, resolvedDevice, prefix, slot);
  if (issued) return issued;
  return allocateSymbolic(database, prefix, resolvedDevice);
}

function allocateSymbolic(database, prefix, deviceId) {
  const key = `symbolic:${deviceId}:${prefix}`;
  const current = Number(meta(database, key) ?? "0");
  const next = current + 1;
  database.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(next));
  const identifier = `${prefix}-P${deviceTag(deviceId)}-${next}`;
  recordAllocation(database, identifier, deviceId);
  return identifier;
}

export function takenPrefixes(database, exceptProjectId = null) {
  const taken = new Set();
  const prefixed = database.prepare(`
    SELECT id, identifier_prefix FROM projects
    WHERE identifier_prefix IS NOT NULL AND identifier_prefix != ''
  `).all();
  for (const row of prefixed) {
    if (row.id !== exceptProjectId) taken.add(String(row.identifier_prefix).toUpperCase());
  }
  const tasks = database.prepare("SELECT identifier FROM tasks").all();
  for (const row of tasks) {
    const match = String(row.identifier).match(/^([A-Z0-9]+)-/i);
    if (match) taken.add(match[1].toUpperCase());
  }
  return taken;
}

export function disambiguatedPrefix(legacy, taken) {
  const base = String(legacy || "TSK").toUpperCase();
  if (!taken.has(base)) return base;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const stem = base.slice(0, Math.min(2, base.length));
  for (const character of alphabet) {
    const candidate = `${stem}${character}`.toUpperCase();
    if (!taken.has(candidate)) return candidate;
  }
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `P${String(index).padStart(2, "0")}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("No free identifier prefix");
}

export function assignProjectPrefixSync(database, project) {
  if (!v2IdentifiersEnabled(database)) return null;
  const legacy = legacyPrefix({ ...project, first_identifier: null });
  const taken = takenPrefixes(database, project.id);
  const chosen = disambiguatedPrefix(legacy, taken);
  database.prepare("UPDATE projects SET identifier_prefix = ? WHERE id = ?").run(chosen, project.id);
  return chosen;
}

export function enableV2Identifiers(database, { deviceId, deviceSlot }) {
  const upsert = database.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  upsert.run("v2_identifiers", "1");
  upsert.run("device_id", deviceId);
  upsert.run("device_slot", String(deviceSlot));
}

export function bindAllocation(database, identifier, taskId) {
  database.prepare(`
    UPDATE identifier_allocations SET task_id = ? WHERE identifier = ?
  `).run(taskId, identifier);
}

/**
 * Keep the bare identifier on the earlier task. The other keeps a stable
 * suffix so existing strings still resolve through identifier_aliases.
 */
export function disambiguateIdentifierCollision(database, {
  identifier,
  keepTaskId,
  moveTaskId,
  now = new Date().toISOString(),
}) {
  const suffix = String(moveTaskId).replace(/-/g, "").slice(0, 8);
  const moved = `${identifier}#${suffix}`;
  database.prepare("UPDATE tasks SET identifier = ? WHERE id = ?").run(moved, moveTaskId);
  const insert = database.prepare(`
    INSERT INTO identifier_aliases (alias, task_id, stored_identifier, reason, created_at)
    VALUES (?, ?, ?, 'identifier_collision', ?)
    ON CONFLICT(alias, task_id) DO UPDATE SET stored_identifier = excluded.stored_identifier
  `);
  insert.run(identifier, keepTaskId, identifier, now);
  insert.run(identifier, moveTaskId, moved, now);
  return { kept: identifier, moved, moveTaskId, keepTaskId };
}
