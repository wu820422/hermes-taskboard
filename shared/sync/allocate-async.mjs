import {
  IDENTIFIER_SLOT_STRIDE,
  deviceTag,
  disambiguatedPrefix,
  leaseMatchesSlot,
  legacyPrefix,
  rangeFor,
} from "./allocate.mjs";

async function meta(db, key) {
  return (await db.get("SELECT value FROM sync_meta WHERE key = ?", [key]))?.value ?? null;
}

async function readLeases(db, deviceId, prefix) {
  return db.all(`
    SELECT generation, range_start, range_end, cursor
    FROM identifier_leases
    WHERE device_id = ? AND prefix = ?
    ORDER BY generation
  `, [deviceId, prefix]);
}

async function openCanonicalLease(db, deviceId, prefix, slot) {
  const leases = await readLeases(db, deviceId, prefix);
  const open = leases.find((lease) => leaseMatchesSlot(lease, slot) && lease.cursor < lease.range_end);
  if (open) return open;
  const unused = leases.find((lease) => lease.cursor === lease.range_start && !leaseMatchesSlot(lease, slot));
  if (unused) {
    const range = rangeFor(slot, unused.generation);
    await db.run(`
      UPDATE identifier_leases
      SET range_start = ?, range_end = ?, cursor = ?
      WHERE device_id = ? AND prefix = ? AND generation = ?
    `, [range.start, range.end, range.start, deviceId, prefix, unused.generation]);
    return { generation: unused.generation, range_start: range.start, range_end: range.end, cursor: range.start };
  }
  const generation = leases.reduce((max, lease) => Math.max(max, Number(lease.generation)), -1) + 1;
  const range = rangeFor(slot, generation);
  try {
    await db.run(`
      INSERT INTO identifier_leases (
        device_id, prefix, generation, range_start, range_end, cursor
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [deviceId, prefix, generation, range.start, range.end, range.start]);
  } catch (error) {
    if (!/UNIQUE/i.test(String(error?.message ?? error))) throw error;
    const again = await readLeases(db, deviceId, prefix);
    const existing = again.find((lease) => Number(lease.generation) === generation)
      ?? again.find((lease) => leaseMatchesSlot(lease, slot) && lease.cursor < lease.range_end);
    if (!existing) throw error;
    return existing;
  }
  return { generation, range_start: range.start, range_end: range.end, cursor: range.start };
}

async function identifierTaken(db, identifier) {
  return Boolean(await db.get("SELECT 1 AS ok FROM tasks WHERE identifier = ?", [identifier]));
}

async function recordAllocation(db, identifier, deviceId) {
  await db.run(`
    INSERT INTO identifier_allocations (identifier, task_id, device_id, created_at)
    VALUES (?, '', ?, ?)
    ON CONFLICT(identifier) DO NOTHING
  `, [identifier, deviceId, new Date().toISOString()]);
}

async function allocateSymbolic(db, prefix, deviceId) {
  const key = `symbolic:${deviceId}:${prefix}`;
  const current = Number(await meta(db, key) ?? "0");
  const next = current + 1;
  await db.run(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, String(next)]);
  const identifier = `${prefix}-P${deviceTag(deviceId)}-${next}`;
  await recordAllocation(db, identifier, deviceId);
  return identifier;
}

export async function allocateIdentifierAsync(db, project) {
  const prefix = String(project.identifier_prefix || legacyPrefix(project)).toUpperCase();
  const deviceId = await meta(db, "device_id");
  const slotRaw = await meta(db, "device_slot");
  const slot = slotRaw === null || slotRaw === "" ? null : Number(slotRaw);
  if (!deviceId || slot === null || !Number.isInteger(slot) || slot < 0 || slot >= IDENTIFIER_SLOT_STRIDE) {
    return allocateSymbolic(db, prefix, deviceId || "unassigned");
  }
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const lease = await openCanonicalLease(db, deviceId, prefix, slot);
    const claimed = await db.get(`
      UPDATE identifier_leases
      SET cursor = cursor + 1
      WHERE device_id = ? AND prefix = ? AND generation = ? AND cursor < range_end
      RETURNING cursor
    `, [deviceId, prefix, lease.generation]);
    if (!claimed) continue;
    const identifier = `${prefix}-${Number(claimed.cursor) - 1}`;
    if (!(await identifierTaken(db, identifier))) {
      await recordAllocation(db, identifier, deviceId);
      return identifier;
    }
  }
  return allocateSymbolic(db, prefix, deviceId);
}

export async function takenPrefixesAsync(db, exceptProjectId = null) {
  const taken = new Set();
  const prefixed = await db.all(`
    SELECT id, identifier_prefix FROM projects
    WHERE identifier_prefix IS NOT NULL AND identifier_prefix != ''
  `);
  for (const row of prefixed) {
    if (row.id !== exceptProjectId) taken.add(String(row.identifier_prefix).toUpperCase());
  }
  const tasks = await db.all("SELECT identifier FROM tasks");
  for (const row of tasks) {
    const match = String(row.identifier).match(/^([A-Z0-9]+)-/i);
    if (match) taken.add(match[1].toUpperCase());
  }
  return taken;
}

export async function assignProjectPrefixAsync(db, project) {
  const enabled = (await meta(db, "v2_identifiers")) === "1";
  if (!enabled) return null;
  const legacy = legacyPrefix({ ...project, first_identifier: null });
  const taken = await takenPrefixesAsync(db, project.id);
  const chosen = disambiguatedPrefix(legacy, taken);
  await db.run("UPDATE projects SET identifier_prefix = ? WHERE id = ?", [chosen, project.id]);
  return chosen;
}
