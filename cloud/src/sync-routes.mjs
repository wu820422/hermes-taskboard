import { allocateIdentifierAsync, assignProjectPrefixAsync } from "../../shared/sync/allocate-async.mjs";
import { conflictsPage } from "../../shared/sync/conflicts-page.mjs";
import { createSyncEngine } from "../../shared/sync/engine.mjs";
import { createClock } from "../../shared/sync/hlc.mjs";
import { createD1Adapter, createR2Blobs } from "./d1-adapter.mjs";

const clocks = new Map();

// Workers cap subrequests (D1 queries) per invocation at 1000 on the Free
// plan. Capture writes through D1 batches, but it still bounds how many rows
// it registers per request; the rest are picked up by the next request.
const CAPTURE_MAX_ROWS = 150;
const REGISTER_LIMIT_DEFAULT = 150;
const REGISTER_LIMIT_MAX = 400;
const PULL_LIMIT_MAX = 500;

// Every data table the sync engine captures has a trigger that bumps
// global_revision. When the revision has not moved since the last complete
// capture there is nothing to capture, so an idle sync costs a couple of
// single-row reads instead of re-reading every row and clock (D1 Free allows
// 5M rows read per day; a full capture reads ~13k).
async function captureIfChanged(engine, env, options = {}) {
  const db = createD1Adapter(env.DB);
  let revision = null;
  try {
    const row = await db.get("SELECT revision FROM global_revision WHERE singleton = 1");
    if (row) revision = String(row.revision);
  } catch {
    revision = null;
  }
  if (revision !== null) {
    const seen = await db.get("SELECT value FROM sync_meta WHERE key = 'captured_revision'");
    if (seen?.value === revision) return { complete: true, written: 0, unchanged: true };
  }
  const result = await engine.capture(options);
  if (result?.complete && revision !== null) {
    await db.run(`
      INSERT INTO sync_meta (key, value) VALUES ('captured_revision', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [revision]);
  }
  return result;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function ensureCloudDevice(env) {
  const db = createD1Adapter(env.DB);
  const deviceId = env.TASKBOARD_DEVICE_ID || "cloud";
  const deviceSlot = String(env.TASKBOARD_DEVICE_SLOT ?? "1");
  await db.run(`
    INSERT INTO sync_meta (key, value) VALUES ('device_id', ?)
    ON CONFLICT(key) DO NOTHING
  `, [deviceId]);
  await db.run(`
    INSERT INTO sync_meta (key, value) VALUES ('device_slot', ?)
    ON CONFLICT(key) DO NOTHING
  `, [deviceSlot]);
  await db.run(`
    INSERT INTO sync_meta (key, value) VALUES ('v2_identifiers', '1')
    ON CONFLICT(key) DO NOTHING
  `);
  return { deviceId, deviceSlot, db };
}

function engineFor(env) {
  const deviceId = env.TASKBOARD_DEVICE_ID || "cloud";
  if (!clocks.has(deviceId)) clocks.set(deviceId, createClock(deviceId));
  const blobs = createR2Blobs(env.ATTACHMENTS);
  const engine = createSyncEngine(createD1Adapter(env.DB), {
    deviceId,
    clock: clocks.get(deviceId),
    blobs,
  });
  return { engine, blobs };
}

function decodeChange(change) {
  return {
    seq: change.seq,
    entityType: change.entityType,
    entityId: change.entityId,
    op: change.op,
    fields: change.fields ?? null,
    hlc: change.hlc,
    prev: change.prev ?? null,
    supersedes: change.supersedes ?? [],
    deviceId: change.deviceId,
    createdAt: change.createdAt,
  };
}

export async function handleSyncApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/conflicts") {
    return new Response(conflictsPage(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!pathname.startsWith("/api/sync") && !pathname.startsWith("/api/admin/clients")) return null;
  await ensureCloudDevice(env);
  const { engine } = engineFor(env);

  if (pathname === "/api/admin/clients" && request.method === "POST") {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 80) return json({ error: { code: "INVALID_FIELD", message: "name is required" } }, 400);
    const id = crypto.randomUUID();
    const token = `htb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const scopes = String(body.scopes ?? "taskboard:read taskboard:write");
    await env.DB.prepare(`
      INSERT INTO api_clients (id, name, token_hash, scopes, revoked_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).bind(id, name, await sha256Base64Url(token), scopes, new Date().toISOString()).run();
    return json({ client: { id, name, scopes, token } }, 201);
  }

  const revokeMatch = pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (revokeMatch && request.method === "DELETE") {
    await env.DB.prepare(`
      UPDATE api_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).bind(new Date().toISOString(), decodeURIComponent(revokeMatch[1])).run();
    return new Response(null, { status: 204 });
  }

  if (pathname === "/api/admin/clients" && request.method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT id, name, scopes, revoked_at, created_at FROM api_clients ORDER BY created_at
    `).all();
    return json({ clients: rows.results ?? [] });
  }

  if (pathname === "/api/sync/register" && request.method === "POST") {
    // Resumable first-sync registration: each call registers at most `limit`
    // rows so one Worker invocation stays far below the subrequest cap.
    const limit = clampInt(url.searchParams.get("limit"), REGISTER_LIMIT_DEFAULT, 1, REGISTER_LIMIT_MAX);
    const result = await engine.capture({ maxRows: limit });
    return json({ ...result, limit, cursor: await engine.latestSeq() });
  }

  if (pathname === "/api/sync/pull" && request.method === "GET") {
    await engine.applyRemote([]);
    await captureIfChanged(engine, env, { maxRows: CAPTURE_MAX_ROWS });
    const since = Number(url.searchParams.get("since") ?? "0");
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? undefined : clampInt(limitParam, PULL_LIMIT_MAX, 1, PULL_LIMIT_MAX);
    const exported = await engine.changesSince(Number.isFinite(since) ? since : 0, limit);
    return json(exported);
  }

  if (pathname === "/api/sync/push" && request.method === "POST") {
    const body = await request.json();
    await captureIfChanged(engine, env, { maxRows: CAPTURE_MAX_ROWS });
    const inline = new Map();
    for (const [id, base64] of Object.entries(body.blobs ?? {})) {
      inline.set(id, Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
    }
    const applied = await engine.applyRemote((body.changes ?? []).map(decodeChange), {
      getBlob: async (id) => inline.get(id) ?? null,
    });
    return json({
      conflicts: applied.conflicts,
      accepted: applied.accepted.length,
      rejected: applied.rejected,
      cursor: await engine.latestSeq(),
    });
  }

  if (pathname === "/api/sync/conflicts" && request.method === "GET") {
    const conflicts = await engine.listConflicts(url.searchParams.get("status") ?? "open");
    const rejected = await engine.listRejected("pending");
    return json({ conflicts, rejected });
  }

  if (pathname === "/api/sync/status" && request.method === "GET") {
    const conflicts = await engine.listConflicts("open");
    const rejected = await engine.listRejected("pending");
    return json({ openConflicts: conflicts.length, rejected });
  }

  const resolveMatch = pathname.match(/^\/api\/sync\/conflicts\/([^/]+)\/resolve$/);
  if (resolveMatch && request.method === "POST") {
    const body = await request.json();
    try {
      const result = await engine.resolveConflict(decodeURIComponent(resolveMatch[1]), body.choice, body.value);
      return json({ conflict: result });
    } catch (error) {
      return json({ error: { code: "CONFLICT_RESOLVE_FAILED", message: error.message } }, 400);
    }
  }

  const blobMatch = pathname.match(/^\/api\/sync\/blobs\/([^/]+)$/);
  if (blobMatch && request.method === "GET") {
    const bytes = await engine.readBlob(decodeURIComponent(blobMatch[1]));
    if (!bytes) return json({ error: { code: "NOT_FOUND", message: "Blob not found" } }, 404);
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
  }
  if (blobMatch && request.method === "PUT") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    await createR2Blobs(env.ATTACHMENTS).put(decodeURIComponent(blobMatch[1]), bytes);
    return new Response(null, { status: 204 });
  }

  return null;
}

export async function createCloudTaskIdentifier(env, project) {
  await ensureCloudDevice(env);
  return allocateIdentifierAsync(createD1Adapter(env.DB), project);
}

export async function assignCloudProjectPrefix(env, project) {
  return assignProjectPrefixAsync(createD1Adapter(env.DB), project);
}

export async function cloudIdentifiersEnabled(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'v2_identifiers'").first();
    return row?.value === "1";
  } catch {
    return false;
  }
}
