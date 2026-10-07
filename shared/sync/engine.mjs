import { encodeValue, mergeFieldState } from "./hlc.mjs";

const ENTITY_ORDER = [
  "project",
  "project_readme",
  "task",
  "comment",
  "attachment",
  "project_readme_attachment",
  "relation",
];

const DELETE_ORDER = [...ENTITY_ORDER].reverse();

// Statements per db.batch call during capture. One entity never spans two
// batches, so a batch can exceed this by one entity's worth of statements.
const CAPTURE_BATCH_STATEMENTS = 400;
const CAPTURE_BATCH_BYTES = 900_000;

function typeIndex(entityType) {
  const index = ENTITY_ORDER.indexOf(entityType);
  return index === -1 ? ENTITY_ORDER.length : index;
}

/**
 * Upserts apply parent-before-child. Deletes apply child-before-parent so a
 * project tombstone cannot run while its tasks still reference it.
 * A row that is both upserted and deleted in one batch keeps sequence order.
 */
export function orderChangesForApply(changes) {
  const groups = new Map();
  for (const change of changes) {
    const key = `${change.entityType}\0${change.entityId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(change);
  }
  const plain = [];
  const mixed = [];
  for (const group of groups.values()) {
    const operations = new Set(group.map((change) => change.op));
    if (operations.has("delete") && (operations.size > 1 || group.some((change) => change.op !== "delete"))) {
      mixed.push(...group);
    } else {
      plain.push(...group);
    }
  }
  const bySeq = (left, right) => (left.seq ?? 0) - (right.seq ?? 0);
  const upserts = plain.filter((change) => change.op !== "delete").sort((left, right) => {
    const compared = typeIndex(left.entityType) - typeIndex(right.entityType);
    return compared || bySeq(left, right);
  });
  const deletes = plain.filter((change) => change.op === "delete").sort((left, right) => {
    const compared = typeIndex(right.entityType) - typeIndex(left.entityType);
    return compared || bySeq(left, right);
  });
  mixed.sort(bySeq);
  return [...upserts, ...deletes, ...mixed];
}

export function conflictIdentity(conflict) {
  const clocks = [conflict.localHlc, conflict.remoteHlc].filter(Boolean).sort();
  return [conflict.entityType, conflict.entityId, conflict.field, clocks.join("~")].join("|");
}

function parseSupersedes(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function hashBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function baseHlc(parts) {
  const digest = await hashBytes(parts.join("|"));
  return `000000000000001:000000:${digest.slice(0, 16)}`;
}

function relationId(row) {
  return `${row.relation_type}\u001f${row.source_task_id}\u001f${row.target_task_id}`;
}

function splitRelationId(id) {
  const [relationType, sourceTaskId, targetTaskId] = String(id).split("\u001f");
  return { relationType, sourceTaskId, targetTaskId };
}

const columnCache = new WeakMap();

async function columnsOf(db, table) {
  let tables = columnCache.get(db);
  if (!tables) {
    tables = new Map();
    columnCache.set(db, tables);
  }
  if (!tables.has(table)) {
    const rows = await db.all(`PRAGMA table_info(${table})`);
    tables.set(table, new Set(rows.map((row) => row.name)));
  }
  return tables.get(table);
}

function pickColumns(available, wanted) {
  return wanted.filter((name) => available.has(name));
}

function normalizeTask(row, columns) {
  const next = { ...row };
  const hasMachineColumns = columns.has("git_branch") || columns.has("worktree_path");
  if (hasMachineColumns) {
    if (row.worktree_branch) {
      next.development_context_type = "worktree";
      next.development_branch = row.worktree_branch;
    } else if (row.git_branch && !row.worktree_path) {
      next.development_context_type = "branch";
      next.development_branch = row.git_branch;
    } else if (!row.worktree_path) {
      next.development_context_type = row.development_context_type ?? null;
      next.development_branch = row.development_branch ?? null;
    } else {
      next.development_context_type = row.development_context_type ?? null;
      next.development_branch = row.development_branch ?? null;
    }
  }
  delete next.git_branch;
  delete next.worktree_path;
  delete next.worktree_branch;
  return next;
}

function machineDevelopment(fields) {
  if (!Object.hasOwn(fields, "development_context_type") && !Object.hasOwn(fields, "development_branch")) {
    return {};
  }
  const type = fields.development_context_type ?? null;
  const branch = fields.development_branch ?? null;
  if (type === "worktree") return { git_branch: null, worktree_branch: branch };
  if (type === "branch") return { git_branch: branch, worktree_path: null, worktree_branch: null };
  if (type === null && Object.hasOwn(fields, "development_context_type")) {
    return { git_branch: null, worktree_path: null, worktree_branch: null };
  }
  return {};
}

async function loadRows(db, entityType) {
  switch (entityType) {
    case "project": {
      const columns = await columnsOf(db, "projects");
      const selected = pickColumns(columns, ["id", "name", "start_date", "labels", "identifier_prefix", "created_at"]);
      return db.all(`SELECT ${selected.join(", ")} FROM projects`);
    }
    case "project_readme":
      return db.all(`
        SELECT project_id AS id, content, created_at FROM project_readmes
      `);
    case "task": {
      const columns = await columnsOf(db, "tasks");
      const selected = pickColumns(columns, [
        "id", "identifier", "project_id", "title", "description", "status", "priority", "labels",
        "sort_order", "thread_id",
        "creator_type", "creator_id", "creator_name", "creator_avatar_url",
        "assignee_type", "assignee_id", "assignee_name", "assignee_avatar_url",
        "start_date", "due_date", "recurrence_interval", "recurrence_unit", "archived_at",
        "external_source", "external_origin", "external_id", "external_key", "external_url",
        "git_branch", "worktree_path", "worktree_branch",
        "development_context_type", "development_branch", "created_at",
      ]);
      const rows = await db.all(`SELECT ${selected.join(", ")} FROM tasks`);
      return rows.map((row) => normalizeTask(row, columns));
    }
    case "comment":
      return db.all(`
        SELECT
          id, task_id, body, author_type, author_id, author_name, author_avatar_url, created_at
        FROM comments
      `);
    case "attachment":
      return db.all(`
        SELECT id, task_id, comment_id, kind, filename, content_type, size, created_at
        FROM attachments
      `);
    case "project_readme_attachment":
      return db.all(`
        SELECT id, project_id, filename, content_type, size, created_at
        FROM project_readme_attachments
      `);
    case "relation": {
      const rows = await db.all(`
        SELECT relation_type, source_task_id, target_task_id, origin, created_at
        FROM task_relations
      `);
      return rows.map((row) => ({ id: relationId(row), ...row }));
    }
    default:
      throw new Error(`Unknown entity type ${entityType}`);
  }
}

const FIELDS = {
  project: ["name", "start_date", "labels", "identifier_prefix", "created_at"],
  project_readme: ["content", "created_at"],
  task: [
    "identifier", "project_id", "title", "description", "status", "priority", "labels",
    "sort_order", "thread_id",
    "creator_type", "creator_id", "creator_name", "creator_avatar_url",
    "assignee_type", "assignee_id", "assignee_name", "assignee_avatar_url",
    "start_date", "due_date", "recurrence_interval", "recurrence_unit", "archived_at",
    "external_source", "external_origin", "external_id", "external_key", "external_url",
    "development_context_type", "development_branch", "created_at",
  ],
  comment: ["task_id", "body", "author_type", "author_id", "author_name", "author_avatar_url", "created_at"],
  attachment: ["task_id", "comment_id", "kind", "filename", "content_type", "size", "created_at", "content_sha256"],
  project_readme_attachment: ["project_id", "filename", "content_type", "size", "created_at", "content_sha256"],
  relation: ["relation_type", "source_task_id", "target_task_id", "origin", "created_at"],
};

function rowField(row, field) {
  if (!Object.hasOwn(row, field)) return null;
  return row[field] === undefined ? null : row[field];
}

export function createSyncEngine(db, options = {}) {
  const deviceId = options.deviceId ?? "local";
  const clock = options.clock;
  if (!clock?.tick) throw new Error("createSyncEngine requires a clock");
  const blobs = options.blobs ?? {
    async get() { return null; },
    async put() {},
  };
  const now = options.now ?? (() => new Date().toISOString());

  async function tick() {
    return clock.tick();
  }

  async function clocksFor(entityType, entityId) {
    const rows = await db.all(`
      SELECT field, value_json, hlc, prev_hlc, supersedes_json, device_id
      FROM sync_field_clocks
      WHERE entity_type = ? AND entity_id = ?
    `, [entityType, entityId]);
    return new Map(rows.map((row) => [row.field, row]));
  }

  async function entityState(entityType, entityId) {
    return db.get(`
      SELECT entity_type, entity_id, hlc, prev_hlc, supersedes_json, deleted, device_id
      FROM sync_entities
      WHERE entity_type = ? AND entity_id = ?
    `, [entityType, entityId]);
  }

  async function contentHash(id) {
    const bytes = await blobs.get(id);
    if (!bytes) return undefined;
    return hashBytes(bytes);
  }

  async function materializeRow(entityType, row) {
    const copy = { ...row };
    if (entityType === "attachment" || entityType === "project_readme_attachment") {
      const hash = await contentHash(row.id);
      if (hash !== undefined) copy.content_sha256 = hash;
    }
    return copy;
  }

  function clockStatement(entityType, entityId, field, state) {
    return [`
      INSERT INTO sync_field_clocks (
        entity_type, entity_id, field, value_json, hlc, prev_hlc, supersedes_json, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
        value_json = excluded.value_json,
        hlc = excluded.hlc,
        prev_hlc = excluded.prev_hlc,
        supersedes_json = excluded.supersedes_json,
        device_id = excluded.device_id
    `, [
      entityType,
      entityId,
      field,
      encodeValue(state.value),
      state.hlc,
      state.prev ?? null,
      JSON.stringify(state.supersedes ?? []),
      state.deviceId ?? deviceId,
    ]];
  }

  async function writeClock(entityType, entityId, field, state) {
    await db.run(...clockStatement(entityType, entityId, field, state));
  }

  function entityStatement(entityType, entityId, state) {
    return [`
      INSERT INTO sync_entities (
        entity_type, entity_id, hlc, prev_hlc, supersedes_json, deleted, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        hlc = excluded.hlc,
        prev_hlc = excluded.prev_hlc,
        supersedes_json = excluded.supersedes_json,
        deleted = excluded.deleted,
        device_id = excluded.device_id
    `, [
      entityType,
      entityId,
      state.hlc,
      state.prev ?? null,
      JSON.stringify(state.supersedes ?? []),
      state.deleted ? 1 : 0,
      state.deviceId ?? deviceId,
    ]];
  }

  async function writeEntity(entityType, entityId, state) {
    await db.run(...entityStatement(entityType, entityId, state));
  }

  function logStatement(entry) {
    return [`
      INSERT INTO sync_log (
        entity_type, entity_id, op, fields_json, hlc, prev_hlc, supersedes_json, device_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.entityType,
      entry.entityId,
      entry.op,
      entry.fields ? JSON.stringify(entry.fields) : null,
      entry.hlc,
      entry.prev ?? null,
      JSON.stringify(entry.supersedes ?? []),
      deviceId,
      now(),
    ]];
  }

  async function appendLog(entry) {
    await db.run(...logStatement(entry));
  }

  async function openConflict(conflict) {
    const id = conflictIdentity(conflict);
    await db.run(`
      INSERT INTO sync_conflicts (
        id, entity_type, entity_id, field,
        local_value_json, local_hlc, local_device,
        remote_value_json, remote_hlc, remote_device,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      ON CONFLICT(id) DO NOTHING
    `, [
      id,
      conflict.entityType,
      conflict.entityId,
      conflict.field,
      encodeValue(conflict.localValue),
      conflict.localHlc ?? null,
      conflict.localDevice ?? null,
      encodeValue(conflict.remoteValue),
      conflict.remoteHlc,
      conflict.remoteDevice ?? null,
      now(),
    ]);
    return { id, ...conflict };
  }

  // Statements for one entity are queued together and flushed through
  // db.batch when the adapter has it (D1: one batch = one subrequest, and it
  // runs as a transaction). Adapters without batch run them immediately.
  function createWriter(maxStatements = CAPTURE_BATCH_STATEMENTS) {
    const queue = [];
    let bytes = 0;
    const sizeOf = (statements) => statements.reduce((total, [sql, params = []]) => (
      total + sql.length + params.reduce((sum, value) => sum + (typeof value === "string" ? value.length * 3 : 8), 0)
    ), 0);
    return {
      async add(statements) {
        if (typeof db.batch !== "function") {
          for (const statement of statements) await db.run(...statement);
          return;
        }
        const size = sizeOf(statements);
        if (queue.length && (queue.length + statements.length > maxStatements || bytes + size > CAPTURE_BATCH_BYTES)) await this.flush();
        queue.push(...statements);
        bytes += size;
      },
      async flush() {
        if (!queue.length) return;
        const pending = queue.splice(0, queue.length);
        bytes = 0;
        await db.batch(pending);
      },
    };
  }

  async function preload(entityType) {
    const clockRows = await db.all(`
      SELECT entity_id, field, value_json, hlc, prev_hlc, supersedes_json, device_id
      FROM sync_field_clocks
      WHERE entity_type = ?
    `, [entityType]);
    const clocksById = new Map();
    for (const row of clockRows) {
      let fields = clocksById.get(String(row.entity_id));
      if (!fields) {
        fields = new Map();
        clocksById.set(String(row.entity_id), fields);
      }
      fields.set(row.field, row);
    }
    const entityRows = await db.all(`
      SELECT entity_type, entity_id, hlc, prev_hlc, supersedes_json, deleted, device_id
      FROM sync_entities
      WHERE entity_type = ?
    `, [entityType]);
    return { clocksById, entities: new Map(entityRows.map((row) => [String(row.entity_id), row])) };
  }

  /**
   * Register local rows into the sync tables. `maxRows` caps how many rows
   * get new clock/log writes in this call (a Worker invocation has a hard
   * subrequest limit); when the cap is hit the call returns
   * { complete: false } and the next call resumes, because rows that are
   * already registered are skipped. Deletes are only detected on a
   * complete pass.
   */
  async function capture(options = {}) {
    const maxRows = Number.isFinite(options.maxRows) && options.maxRows > 0 ? Math.floor(options.maxRows) : Infinity;
    const run = async () => {
      const writer = createWriter(options.batchStatements);
      const pendingDeletes = [];
      let written = 0;
      let complete = true;
      for (const entityType of ENTITY_ORDER) {
        if (!complete) break;
        const rows = await loadRows(db, entityType);
        const { clocksById, entities } = await preload(entityType);
        const seen = new Set();
        for (const raw of rows) {
          seen.add(String(raw.id));
          const row = await materializeRow(entityType, raw);
          const clocks = clocksById.get(String(raw.id)) ?? new Map();
          const entity = entities.get(String(raw.id)) ?? null;
          const fields = {};
          let changed = false;
          for (const field of FIELDS[entityType]) {
            if (entityType === "project" && raw.id === "local" && field === "created_at") continue;
            let value = rowField(row, field);
            if ((entityType === "attachment" || entityType === "project_readme_attachment") && field === "content_sha256" && value === null && !Object.hasOwn(row, "content_sha256")) {
              const existing = clocks.get(field);
              if (existing) value = JSON.parse(existing.value_json);
            }
            const encoded = encodeValue(value);
            const existing = clocks.get(field);
            if (!existing || existing.value_json !== encoded || entity?.deleted) {
              // The first observation of a value uses a hash clock so two peers
              // that already hold the same bytes do not conflict on first sync.
              // A real local edit (or a resurrection) gets a new causal clock.
              const initial = !existing && !entity?.deleted;
              const hlc = initial
                ? await baseHlc([entityType, raw.id, field, encoded])
                : await tick();
              fields[field] = {
                value,
                hlc,
                prev: entity?.deleted ? entity.hlc : (existing?.hlc ?? null),
                supersedes: [],
              };
              changed = true;
            }
          }
          if (!changed && entity) continue;
          if (written >= maxRows) {
            complete = false;
            break;
          }
          written += 1;
          if (!changed) {
            const hlc = await baseHlc([entityType, raw.id, "entity"]);
            await writer.add([entityStatement(entityType, raw.id, { hlc, prev: null, deleted: false, deviceId })]);
            continue;
          }
          const statements = [];
          for (const [field, state] of Object.entries(fields)) {
            statements.push(clockStatement(entityType, raw.id, field, { ...state, deviceId }));
          }
          const initialOnly = Object.values(fields).every((state) => state.prev == null && String(state.hlc).startsWith("000000000000001:"));
          const prev = entity?.hlc ?? null;
          const hlc = initialOnly
            ? await baseHlc([entityType, raw.id, "entity"])
            : await tick();
          statements.push(entityStatement(entityType, raw.id, {
            hlc,
            prev,
            deleted: false,
            deviceId,
            supersedes: entity?.deleted ? [entity.hlc] : [],
          }));
          statements.push(logStatement({
            entityType,
            entityId: raw.id,
            op: "upsert",
            fields,
            hlc,
            prev,
            supersedes: entity?.deleted ? [entity.hlc] : [],
          }));
          await writer.add(statements);
        }
        if (!complete) break;
        for (const [entityId, entity] of entities) {
          if (Number(entity.deleted) || seen.has(entityId)) continue;
          pendingDeletes.push({ entityType, entityId, hlc: entity.hlc });
        }
      }
      await writer.flush();
      if (!complete) return { complete: false, written };
      pendingDeletes.sort((left, right) => typeIndex(right.entityType) - typeIndex(left.entityType));
      for (const item of pendingDeletes) {
        const hlc = await tick();
        await writeEntity(item.entityType, item.entityId, {
          hlc,
          prev: item.hlc ?? null,
          deleted: true,
          deviceId,
        });
        await appendLog({
          entityType: item.entityType,
          entityId: item.entityId,
          op: "delete",
          fields: null,
          hlc,
          prev: item.hlc ?? null,
          supersedes: [],
        });
        await closeConflictsForEntity(item.entityType, item.entityId, "deleted");
      }
      return { complete: true, written };
    };
    if (db.transaction) return db.transaction(run);
    return run();
  }

  async function changesSince(seq = 0, limit = undefined) {
    const page = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
    const rows = await db.all(`
      SELECT seq, entity_type, entity_id, op, fields_json, hlc, prev_hlc, supersedes_json, device_id, created_at
      FROM sync_log
      WHERE seq > ?
      ORDER BY seq${page ? "\n      LIMIT ?" : ""}
    `, page ? [seq, page + 1] : [seq]);
    const more = page ? rows.length > page : false;
    const changes = (more ? rows.slice(0, page) : rows).map(decodeChange);
    const cursor = changes.length ? changes[changes.length - 1].seq : seq;
    return page ? { changes, cursor, more } : { changes, cursor };
  }

  async function latestSeq() {
    const row = await db.get("SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_log");
    return Number(row?.seq ?? 0);
  }

  async function getCursor(peerId) {
    const row = await db.get("SELECT last_seq FROM sync_cursors WHERE peer_id = ?", [peerId]);
    return Number(row?.last_seq ?? 0);
  }

  async function setCursor(peerId, seq) {
    await db.run(`
      INSERT INTO sync_cursors (peer_id, last_seq) VALUES (?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET last_seq = excluded.last_seq
    `, [peerId, seq]);
  }

  async function rememberConflict(conflict) {
    return openConflict({
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      field: conflict.field,
      localValue: conflict.localValue,
      localHlc: conflict.localHlc,
      localDevice: conflict.localDevice,
      remoteValue: conflict.remoteValue,
      remoteHlc: conflict.remoteHlc,
      remoteDevice: conflict.remoteDevice,
    });
  }

  function rejectedIdentity(direction, change) {
    return [direction, change.op ?? "upsert", change.entityType, change.entityId, change.hlc ?? ""].join("|");
  }

  async function rememberRejected({ direction, change, reason }) {
    const id = rejectedIdentity(direction, change);
    const timestamp = now();
    await db.run(`
      INSERT INTO sync_rejected (
        id, direction, entity_type, entity_id, op, hlc, change_json, reason,
        attempts, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reason = excluded.reason,
        change_json = excluded.change_json,
        attempts = sync_rejected.attempts + 1,
        status = 'pending',
        updated_at = excluded.updated_at
    `, [
      id,
      direction,
      change.entityType,
      change.entityId,
      change.op ?? "upsert",
      change.hlc ?? "",
      JSON.stringify(change),
      String(reason ?? "apply failed"),
      timestamp,
      timestamp,
    ]);
    return id;
  }

  async function clearRejected({ direction, change }) {
    await db.run(`
      UPDATE sync_rejected
      SET status = 'applied', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `, [now(), rejectedIdentity(direction, change)]);
  }

  async function listRejected(status = "pending") {
    return db.all(`
      SELECT id, direction, entity_type, entity_id, op, hlc, reason, attempts, status, created_at, updated_at
      FROM sync_rejected
      WHERE status = ?
      ORDER BY created_at, id
    `, [status]);
  }

  async function pendingChanges(direction) {
    const rows = await db.all(`
      SELECT change_json
      FROM sync_rejected
      WHERE status = 'pending' AND direction = ?
      ORDER BY created_at, id
    `, [direction]);
    return rows.map((row) => JSON.parse(row.change_json));
  }

  async function closeConflictsForEntity(entityType, entityId, resolution) {
    await db.run(`
      UPDATE sync_conflicts
      SET status = 'resolved', resolution = ?, resolved_at = ?
      WHERE status = 'open' AND entity_type = ? AND entity_id = ?
    `, [resolution, now(), entityType, entityId]);
  }

  async function closeSupersededConflicts(entityType, entityId, field, incoming) {
    const rows = await db.all(`
      SELECT id, local_hlc, remote_hlc
      FROM sync_conflicts
      WHERE status = 'open' AND entity_type = ? AND entity_id = ? AND field = ?
    `, [entityType, entityId, field]);
    const covered = new Set([...(incoming?.supersedes ?? []), incoming?.hlc].filter(Boolean));
    for (const row of rows) {
      const heads = [row.local_hlc, row.remote_hlc].filter(Boolean);
      if (heads.length === 0 || !heads.every((hlc) => covered.has(hlc))) continue;
      await db.run(`
        UPDATE sync_conflicts
        SET status = 'resolved', resolution = 'synced', resolved_at = ?
        WHERE id = ?
      `, [now(), row.id]);
    }
  }

  async function applyRemote(changes, applyOptions = {}) {
    const getBlob = applyOptions.getBlob ?? (async () => null);
    const conflicts = [];
    const accepted = [];
    const rejected = [];
    const inbound = await pendingChanges("inbound");
    const seen = new Set();
    const merged = [];
    for (const change of [...inbound, ...changes]) {
      const key = `${change.op}|${change.entityType}|${change.entityId}|${change.hlc ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(change);
    }
    const ordered = orderChangesForApply(merged);
    const taskDeletes = new Set(
      ordered.filter((change) => change.op === "delete" && change.entityType === "task").map((change) => change.entityId),
    );
    // Local SQLite wraps the batch in a transaction, so a failed statement has
    // to roll back to a savepoint or it would undo the changes that already
    // applied. D1 autocommits each statement and rejects SAVEPOINT, so a
    // constraint error there is caught and the rest of the batch continues.
    const isolate = typeof db.transaction === "function";
    const run = async () => {
      for (const change of ordered) {
        if (isolate) await db.run("SAVEPOINT sync_apply");
        try {
          if (change.op === "delete") {
            const outcome = await applyDelete(change, taskDeletes, conflicts);
            const tombstone = outcome === "applied"
              || (outcome === "noop" && (await entityState(change.entityType, change.entityId))?.deleted);
            if (tombstone) await closeConflictsForEntity(change.entityType, change.entityId, "deleted");
            if (outcome === "applied") accepted.push(change);
          } else {
            const outcome = await applyUpsert(change, getBlob, conflicts);
            if (outcome === "applied" || outcome === "partial") accepted.push(change);
          }
          if (isolate) await db.run("RELEASE SAVEPOINT sync_apply");
          await clearRejected({ direction: "inbound", change });
        } catch (error) {
          if (isolate) {
            try { await db.run("ROLLBACK TO SAVEPOINT sync_apply"); } catch { /* savepoint already gone */ }
            try { await db.run("RELEASE SAVEPOINT sync_apply"); } catch { /* savepoint already gone */ }
          }
          const message = String(error?.message ?? error);
          await rememberRejected({ direction: "inbound", change, reason: message });
          rejected.push({
            seq: change.seq ?? null,
            entityType: change.entityType,
            entityId: change.entityId,
            op: change.op,
            message,
          });
        }
      }
    };
    if (db.transaction) await db.transaction(run);
    else await run();
    return { conflicts, accepted, rejected };
  }

  async function applyDelete(change, taskDeletes, conflicts) {
    const entity = await entityState(change.entityType, change.entityId);
    const decision = mergeFieldState(
      entity ? { hlc: entity.hlc, prev_hlc: entity.prev_hlc, supersedes_json: entity.supersedes_json } : null,
      { hlc: change.hlc, prev: change.prev ?? null, supersedes: change.supersedes ?? [] },
    );
    if (decision.action === "noop") return "noop";
    if (decision.action === "conflict") {
      conflicts.push(await openConflict({
        entityType: change.entityType,
        entityId: change.entityId,
        field: "__deleted__",
        localValue: entity?.deleted ? null : { present: true },
        localHlc: entity?.hlc ?? null,
        localDevice: entity?.device_id ?? null,
        remoteValue: null,
        remoteHlc: change.hlc,
        remoteDevice: change.deviceId,
      }));
      return "conflict";
    }
    if (change.entityType === "project") {
      const children = await db.all("SELECT id FROM tasks WHERE project_id = ?", [change.entityId]);
      const concurrent = [];
      for (const child of children) {
        if (taskDeletes.has(child.id)) continue;
        const childState = await entityState("task", child.id);
        if (childState && !childState.deleted && childState.device_id === deviceId && childState.hlc !== change.prev) {
          concurrent.push(child.id);
        }
      }
      if (concurrent.length > 0) {
        conflicts.push(await openConflict({
          entityType: "project",
          entityId: change.entityId,
          field: "__deleted__",
          localValue: { present: true, concurrentTasks: concurrent },
          localHlc: entity?.hlc ?? null,
          localDevice: deviceId,
          remoteValue: null,
          remoteHlc: change.hlc,
          remoteDevice: change.deviceId,
        }));
        return "conflict";
      }
    }
    await deleteRow(change.entityType, change.entityId);
    // The tombstone clock is written only after the row delete succeeds. D1
    // autocommits, so stamping the entity first would make a failed delete look
    // already applied on the next retry.
    await writeEntity(change.entityType, change.entityId, {
      hlc: change.hlc,
      prev: change.prev ?? null,
      supersedes: change.supersedes ?? [],
      deleted: true,
      deviceId: change.deviceId,
    });
    return "applied";
  }

  async function applyUpsert(change, getBlob, conflicts) {
    const entity = await entityState(change.entityType, change.entityId);
    if (entity?.deleted) {
      const decision = mergeFieldState(
        { hlc: entity.hlc, prev_hlc: entity.prev_hlc, supersedes_json: entity.supersedes_json },
        { hlc: change.hlc, prev: change.prev ?? null, supersedes: change.supersedes ?? [] },
      );
      if (decision.action === "conflict" || decision.action === "noop") {
        if (decision.action === "conflict") {
          conflicts.push(await openConflict({
            entityType: change.entityType,
            entityId: change.entityId,
            field: "__deleted__",
            localValue: null,
            localHlc: entity.hlc,
            localDevice: entity.device_id,
            remoteValue: change.fields,
            remoteHlc: change.hlc,
            remoteDevice: change.deviceId,
          }));
        }
        if (decision.action !== "apply") return decision.action === "noop" ? "noop" : "conflict";
      }
    }
    const applied = {};
    const pendingClocks = [];
    let any = false;
    let conflicted = false;
    for (const [field, incoming] of Object.entries(change.fields ?? {})) {
      if (change.entityType === "project" && change.entityId === "local" && field === "created_at") continue;
      const local = (await clocksFor(change.entityType, change.entityId)).get(field);
      const decision = mergeFieldState(local, {
        hlc: incoming.hlc,
        prev: incoming.prev ?? null,
        supersedes: incoming.supersedes ?? [],
      });
      if (decision.action === "apply") {
        applied[field] = incoming.value;
        pendingClocks.push([field, incoming]);
        any = true;
      } else if (decision.action === "conflict") {
        conflicted = true;
        conflicts.push(await openConflict({
          entityType: change.entityType,
          entityId: change.entityId,
          field,
          localValue: local ? JSON.parse(local.value_json) : null,
          localHlc: local?.hlc ?? null,
          localDevice: local?.device_id ?? null,
          remoteValue: incoming.value,
          remoteHlc: incoming.hlc,
          remoteDevice: change.deviceId,
        }));
      }
    }
    if (any) {
      if ((change.entityType === "attachment" || change.entityType === "project_readme_attachment") && Object.hasOwn(applied, "content_sha256") && applied.content_sha256) {
        const bytes = await getBlob(change.entityId);
        if (bytes) await blobs.put(change.entityId, bytes);
      }
      const clocksWritten = await upsertRow(change.entityType, change.entityId, applied, change);
      // D1 autocommits each statement. Record clocks only after the row write
      // succeeds, or a rejected change looks already applied when the same sync retries it.
      for (const [field, incoming] of pendingClocks) {
        if (clocksWritten?.has(field)) continue;
        await writeClock(change.entityType, change.entityId, field, {
          value: incoming.value,
          hlc: incoming.hlc,
          prev: incoming.prev ?? null,
          supersedes: incoming.supersedes ?? [],
          deviceId: change.deviceId,
        });
        await closeSupersededConflicts(change.entityType, change.entityId, field, incoming);
      }
      await writeEntity(change.entityType, change.entityId, {
        hlc: change.hlc,
        prev: change.prev ?? null,
        supersedes: change.supersedes ?? [],
        deleted: false,
        deviceId: change.deviceId,
      });
    }
    if (conflicted && any) return "partial";
    if (conflicted) return "conflict";
    if (!any) return "noop";
    return "applied";
  }

  async function upsertRow(entityType, entityId, fields, change) {
    const merged = { ...fields };
    if (entityType === "relation" && !merged.relation_type) {
      const parts = splitRelationId(entityId);
      merged.relation_type = parts.relationType;
      merged.source_task_id = parts.sourceTaskId;
      merged.target_task_id = parts.targetTaskId;
    }
    try {
      await writeMergedRow(entityType, entityId, merged);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (entityType === "task" && message.includes("UNIQUE") && message.toLowerCase().includes("identifier") && merged.identifier) {
        const suffix = String(entityId).replace(/-/g, "").slice(0, 8);
        const moved = `${merged.identifier}#${suffix}`;
        await db.run(`
          INSERT INTO identifier_aliases (alias, task_id, stored_identifier, reason, created_at)
          VALUES (?, ?, ?, 'identifier_collision', ?)
          ON CONFLICT(alias, task_id) DO UPDATE SET stored_identifier = excluded.stored_identifier
        `, [merged.identifier, entityId, moved, now()]);
        merged.identifier = moved;
        await writeMergedRow(entityType, entityId, merged);
        await writeClock(entityType, entityId, "identifier", {
          value: moved,
          hlc: change.fields?.identifier?.hlc ?? change.hlc,
          prev: change.fields?.identifier?.prev ?? null,
          supersedes: [],
          deviceId: change.deviceId,
        });
        await openConflict({
          entityType,
          entityId,
          field: "identifier",
          localValue: fields.identifier,
          localHlc: null,
          localDevice: null,
          remoteValue: moved,
          remoteHlc: change.hlc,
          remoteDevice: change.deviceId,
        });
        return new Set(["identifier"]);
      }
      throw error;
    }
    return new Set();
  }

  async function writeMergedRow(entityType, entityId, fields) {
    const timestamp = now();
    if (entityType === "project") {
      const existing = await db.get("SELECT id FROM projects WHERE id = ?", [entityId]);
      if (!existing) {
        await db.run(`
          INSERT INTO projects (
            id, name, workspace_path, start_date, labels, identifier_prefix, next_task_number, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?)
        `, [
          entityId,
          fields.name ?? "Untitled",
          fields.start_date ?? null,
          fields.labels ?? "[]",
          fields.identifier_prefix ?? null,
          fields.created_at ?? timestamp,
          timestamp,
        ]);
      } else {
        await updateColumns("projects", "id", entityId, {
          name: fields.name,
          start_date: fields.start_date,
          labels: fields.labels,
          identifier_prefix: fields.identifier_prefix,
          updated_at: timestamp,
        });
      }
      return;
    }
    if (entityType === "project_readme") {
      const existing = await db.get("SELECT project_id FROM project_readmes WHERE project_id = ?", [entityId]);
      if (!existing) {
        await db.run(`
          INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `, [entityId, fields.content ?? "", fields.created_at ?? timestamp, timestamp]);
      } else {
        await db.run(`
          UPDATE project_readmes
          SET content = COALESCE(?, content), version = version + 1, updated_at = ?
          WHERE project_id = ?
        `, [fields.content ?? null, timestamp, entityId]);
      }
      return;
    }
    if (entityType === "task") {
      const existing = await db.get("SELECT id, version FROM tasks WHERE id = ?", [entityId]);
      const taskFields = { ...fields, ...machineDevelopment(fields) };
      const available = await columnsOf(db, "tasks");
      if (!existing) {
        const values = Object.fromEntries(
          Object.entries(taskColumns(entityId, taskFields, timestamp)).filter(([column]) => available.has(column)),
        );
        const columns = Object.keys(values);
        await db.run(
          `INSERT INTO tasks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => values[column]),
        );
      } else {
        await updateColumns("tasks", "id", entityId, { ...taskFields, updated_at: timestamp }, available);
        await db.run("UPDATE tasks SET version = version + 1 WHERE id = ?", [entityId]);
      }
      return;
    }
    if (entityType === "comment") {
      const existing = await db.get("SELECT id FROM comments WHERE id = ?", [entityId]);
      if (!existing) {
        await db.run(`
          INSERT INTO comments (
            id, task_id, body, author_type, author_id, author_name, author_avatar_url,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `, [
          entityId,
          fields.task_id,
          fields.body ?? "",
          fields.author_type ?? "user",
          fields.author_id ?? "sync",
          fields.author_name ?? "Sync",
          fields.author_avatar_url ?? null,
          fields.created_at ?? timestamp,
          timestamp,
        ]);
      } else {
        await updateColumns("comments", "id", entityId, {
          task_id: fields.task_id,
          body: fields.body,
          author_type: fields.author_type,
          author_id: fields.author_id,
          author_name: fields.author_name,
          author_avatar_url: fields.author_avatar_url,
          updated_at: timestamp,
        });
        await db.run("UPDATE comments SET version = version + 1 WHERE id = ?", [entityId]);
      }
      return;
    }
    if (entityType === "attachment") {
      const existing = await db.get("SELECT id FROM attachments WHERE id = ?", [entityId]);
      if (!existing) {
        await db.run(`
          INSERT INTO attachments (
            id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `, [
          entityId,
          fields.task_id,
          fields.comment_id ?? null,
          fields.kind ?? "attachment",
          fields.filename ?? "file",
          fields.content_type ?? "application/octet-stream",
          Number(fields.size ?? 0),
          fields.created_at ?? timestamp,
        ]);
      } else {
        await updateColumns("attachments", "id", entityId, {
          task_id: fields.task_id,
          comment_id: fields.comment_id,
          kind: fields.kind,
          filename: fields.filename,
          content_type: fields.content_type,
          size: fields.size,
        });
      }
      return;
    }
    if (entityType === "project_readme_attachment") {
      const existing = await db.get("SELECT id FROM project_readme_attachments WHERE id = ?", [entityId]);
      if (!existing) {
        await db.run(`
          INSERT INTO project_readme_attachments (
            id, project_id, filename, content_type, size, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          entityId,
          fields.project_id,
          fields.filename ?? "file",
          fields.content_type ?? "application/octet-stream",
          Number(fields.size ?? 0),
          fields.created_at ?? timestamp,
        ]);
      } else {
        await updateColumns("project_readme_attachments", "id", entityId, fields);
      }
      return;
    }
    if (entityType === "relation") {
      const parts = splitRelationId(entityId);
      const relationType = fields.relation_type ?? parts.relationType;
      const source = fields.source_task_id ?? parts.sourceTaskId;
      const target = fields.target_task_id ?? parts.targetTaskId;
      await db.run(`
        INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(relation_type, source_task_id, target_task_id) DO UPDATE SET
          origin = excluded.origin
      `, [relationType, source, target, fields.origin ?? "manual", fields.created_at ?? timestamp]);
    }
  }

  async function updateColumns(table, idColumn, id, fields, available = null) {
    const columns = available ?? await columnsOf(db, table);
    const entries = Object.entries(fields).filter(([column, value]) => value !== undefined && columns.has(column));
    if (entries.length === 0) return;
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    await db.run(
      `UPDATE ${table} SET ${assignments} WHERE ${idColumn} = ?`,
      [...entries.map(([, value]) => value), id],
    );
  }

  async function deleteRow(entityType, entityId) {
    if (entityType === "project") {
      await db.run("DELETE FROM projects WHERE id = ?", [entityId]);
      return;
    }
    if (entityType === "project_readme") {
      await db.run("DELETE FROM project_readmes WHERE project_id = ?", [entityId]);
      return;
    }
    if (entityType === "task") {
      await db.run("DELETE FROM tasks WHERE id = ?", [entityId]);
      return;
    }
    if (entityType === "comment") {
      await db.run("DELETE FROM comments WHERE id = ?", [entityId]);
      return;
    }
    if (entityType === "attachment") {
      await db.run("DELETE FROM attachments WHERE id = ?", [entityId]);
      if (blobs.delete) await blobs.delete(entityId);
      return;
    }
    if (entityType === "project_readme_attachment") {
      await db.run("DELETE FROM project_readme_attachments WHERE id = ?", [entityId]);
      return;
    }
    if (entityType === "relation") {
      const parts = splitRelationId(entityId);
      await db.run(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `, [parts.relationType, parts.sourceTaskId, parts.targetTaskId]);
    }
  }

  async function listConflicts(status = "open") {
    return db.all(`
      SELECT *
      FROM sync_conflicts
      WHERE status = ?
      ORDER BY created_at, id
    `, [status]);
  }

  async function resolveConflict(id, choice, customValue = undefined) {
    const conflict = await db.get("SELECT * FROM sync_conflicts WHERE id = ?", [id]);
    if (!conflict) throw new Error(`Conflict ${id} was not found`);
    if (conflict.status !== "open") throw new Error(`Conflict ${id} is already ${conflict.status}`);
    let value;
    if (choice === "local") value = JSON.parse(conflict.local_value_json);
    else if (choice === "remote") value = JSON.parse(conflict.remote_value_json);
    else if (choice === "custom") value = customValue;
    else throw new Error("choice must be local, remote, or custom");
    const clocks = await clocksFor(conflict.entity_type, conflict.entity_id);
    const local = clocks.get(conflict.field);
    const hlc = await tick();
    const supersedes = [conflict.local_hlc, conflict.remote_hlc].filter(Boolean);
    if (conflict.field === "__deleted__") {
      if (value === null) {
        await deleteRow(conflict.entity_type, conflict.entity_id);
        await writeEntity(conflict.entity_type, conflict.entity_id, {
          hlc,
          prev: local?.hlc ?? conflict.local_hlc,
          supersedes,
          deleted: true,
          deviceId,
        });
        await appendLog({
          entityType: conflict.entity_type,
          entityId: conflict.entity_id,
          op: "delete",
          hlc,
          prev: conflict.local_hlc,
          supersedes,
        });
      }
    } else {
      await writeClock(conflict.entity_type, conflict.entity_id, conflict.field, {
        value,
        hlc,
        prev: local?.hlc ?? conflict.local_hlc,
        supersedes,
        deviceId,
      });
      await writeMergedRow(conflict.entity_type, conflict.entity_id, { [conflict.field]: value });
      const entity = await entityState(conflict.entity_type, conflict.entity_id);
      const entityHlc = await tick();
      await writeEntity(conflict.entity_type, conflict.entity_id, {
        hlc: entityHlc,
        prev: entity?.hlc ?? null,
        supersedes,
        deleted: false,
        deviceId,
      });
      await appendLog({
        entityType: conflict.entity_type,
        entityId: conflict.entity_id,
        op: "upsert",
        fields: {
          [conflict.field]: { value, hlc, prev: local?.hlc ?? conflict.local_hlc, supersedes },
        },
        hlc: entityHlc,
        prev: entity?.hlc ?? null,
        supersedes,
      });
    }
    await db.run(`
      UPDATE sync_conflicts
      SET status = 'resolved', resolution = ?, resolved_at = ?
      WHERE id = ?
    `, [choice, now(), id]);
    return { id, choice, value };
  }

  const engine = {
    deviceId,
    capture,
    changesSince,
    latestSeq,
    getCursor,
    setCursor,
    applyRemote,
    listConflicts,
    listRejected,
    rememberRejected,
    clearRejected,
    pendingChanges,
    resolveConflict,
    rememberConflict,
    hashBytes,
    readBlob: (id) => blobs.get(id),
  };
  return engine;
}

function decodeChange(row) {
  return {
    seq: row.seq,
    entityType: row.entity_type,
    entityId: row.entity_id,
    op: row.op,
    fields: row.fields_json ? JSON.parse(row.fields_json) : null,
    hlc: row.hlc,
    prev: row.prev_hlc,
    supersedes: parseSupersedes(row.supersedes_json),
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

function taskColumns(entityId, fields, timestamp) {
  return {
    id: entityId,
    identifier: fields.identifier ?? `SYNC-${String(entityId).slice(0, 8)}`,
    project_id: fields.project_id,
    title: fields.title ?? "",
    description: fields.description ?? "",
    status: fields.status ?? "backlog",
    priority: fields.priority ?? "none",
    labels: fields.labels ?? "[]",
    sort_order: fields.sort_order ?? 1000,
    thread_id: fields.thread_id ?? null,
    creator_type: fields.creator_type ?? "user",
    creator_id: fields.creator_id ?? "sync",
    creator_name: fields.creator_name ?? "Sync",
    creator_avatar_url: fields.creator_avatar_url ?? null,
    assignee_type: fields.assignee_type ?? "user",
    assignee_id: fields.assignee_id ?? "sync",
    assignee_name: fields.assignee_name ?? "Sync",
    assignee_avatar_url: fields.assignee_avatar_url ?? null,
    start_date: fields.start_date ?? null,
    due_date: fields.due_date ?? null,
    recurrence_interval: fields.recurrence_interval ?? null,
    recurrence_unit: fields.recurrence_unit ?? null,
    archived_at: fields.archived_at ?? null,
    external_source: fields.external_source ?? null,
    external_origin: fields.external_origin ?? null,
    external_id: fields.external_id ?? null,
    external_key: fields.external_key ?? null,
    external_url: fields.external_url ?? null,
    git_branch: fields.git_branch ?? null,
    worktree_path: fields.worktree_path ?? null,
    worktree_branch: fields.worktree_branch ?? null,
    development_context_type: fields.development_context_type ?? null,
    development_branch: fields.development_branch ?? null,
    version: 1,
    created_at: fields.created_at ?? timestamp,
    updated_at: timestamp,
  };
}

export async function replicate(source, target, sourcePeerId, options = {}) {
  if (options.capture !== false) await source.capture();
  const cursor = await target.getCursor(sourcePeerId);
  const exported = await source.changesSince(cursor);
  const blobMap = new Map();
  for (const change of exported.changes) {
    if (change.op !== "upsert") continue;
    if (change.entityType !== "attachment" && change.entityType !== "project_readme_attachment") continue;
    const bytes = await sourceBlobs(source, change.entityId);
    if (bytes && bytes.byteLength > 0) blobMap.set(change.entityId, bytes);
  }
  const applied = await target.applyRemote(exported.changes, {
    getBlob: async (id) => blobMap.get(id) ?? null,
  });
  await target.setCursor(sourcePeerId, exported.cursor);
  return { ...applied, cursor: exported.cursor, changeCount: exported.changes.length };
}

async function sourceBlobs(engine, id) {
  if (!engine.readBlob) return null;
  return engine.readBlob(id);
}

export function attachBlobReader(engine, blobs) {
  engine.readBlob = (id) => blobs.get(id);
  return engine;
}

export async function syncPair(left, right) {
  await left.engine.capture();
  await right.engine.capture();
  const leftToRight = await replicate(left.engine, right.engine, left.engine.deviceId, { capture: false });
  const rightToLeft = await replicate(right.engine, left.engine, right.engine.deviceId, { capture: false });
  return { leftToRight, rightToLeft };
}

export { FIELDS, ENTITY_ORDER, DELETE_ORDER, hashBytes };
