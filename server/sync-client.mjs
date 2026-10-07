import { orderChangesForApply } from "../shared/sync/engine.mjs";

function poisonMessage(body, status) {
  return String(body?.error?.message ?? "");
}

function isApplyPoison(status, body) {
  if (status !== 500) return false;
  return /FOREIGN KEY|constraint failed|SQLITE_/i.test(poisonMessage(body, status));
}

// Applying one brand-new task costs the cloud ~95 D1 queries, so 6 changes
// per request keeps the worst case near 600 of the 1000 allowed.
const PUSH_CHUNK_DEFAULT = 6;
const PULL_PAGE_DEFAULT = 200;
const PULL_MAX_PAGES = 1000;

export async function runSyncOnce({
  engine,
  remoteUrl,
  authorization,
  fetchImpl = globalThis.fetch,
  pushChunkSize = Number(process.env.TASKBOARD_SYNC_PUSH_CHUNK) || PUSH_CHUNK_DEFAULT,
  pullPageSize = Number(process.env.TASKBOARD_SYNC_PULL_PAGE) || PULL_PAGE_DEFAULT,
}) {
  if (!remoteUrl) throw new Error("TASKBOARD_SYNC_URL is not set");
  await engine.capture();
  const remoteCursor = await engine.getCursor("remote");
  const acked = await engine.getCursor("remote-ack");
  const outgoing = await engine.changesSince(acked);
  const blobs = {};
  for (const change of outgoing.changes) {
    if (change.op !== "upsert") continue;
    if (change.entityType !== "attachment" && change.entityType !== "project_readme_attachment") continue;
    const bytes = await engine.readBlob(change.entityId);
    if (!bytes || bytes.byteLength === 0) continue;
    blobs[change.entityId] = Buffer.from(bytes).toString("base64");
  }
  const headers = {
    accept: "application/json",
    ...(authorization ? { authorization } : {}),
  };
  function blobsFor(changes) {
    const picked = {};
    for (const change of changes) {
      if (blobs[change.entityId]) picked[change.entityId] = blobs[change.entityId];
    }
    return picked;
  }
  async function postChanges(changes) {
    const response = await fetchImpl(new URL("/api/sync/push", remoteUrl), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ changes, blobs: blobsFor(changes) }),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  }
  const skipped = [];
  function skip(change, message) {
    skipped.push({
      seq: change.seq ?? null,
      entityType: change.entityType,
      entityId: change.entityId,
      op: change.op,
      message,
    });
  }
  // The cloud applies each push inside one Worker invocation, which has a
  // hard subrequest cap, so a large backlog (first sync) goes up in chunks.
  // The ack cursor moves after every chunk, so an interrupted run resumes.
  async function pushChunk(chunk, attempt = 0) {
    const first = await postChanges(chunk);
    if (first.ok) return first.body ?? {};
    // 502/503/504: the Worker ran out of CPU or D1 was busy. Nothing in the
    // chunk is half-applied in a way a retry can break (apply is idempotent
    // per clock), so split the chunk and retry, then retry single changes.
    if ([502, 503, 504].includes(first.status) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      if (chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        const left = await pushChunk(chunk.slice(0, middle), attempt + 1);
        const right = await pushChunk(chunk.slice(middle), attempt + 1);
        return {
          conflicts: [...(left.conflicts ?? []), ...(right.conflicts ?? [])],
          rejected: [...(left.rejected ?? []), ...(right.rejected ?? [])],
          accepted: Number(left.accepted ?? 0) + Number(right.accepted ?? 0),
        };
      }
      return pushChunk(chunk, attempt + 1);
    }
    if (!isApplyPoison(first.status, first.body) || chunk.length === 0) {
      throw new Error(first.body?.error?.message ?? `Sync push failed (${first.status})`);
    }
    const conflicts = [];
    let accepted = 0;
    for (const change of orderChangesForApply(chunk)) {
      const one = await postChanges([change]);
      if (one.ok) {
        accepted += one.body?.accepted ?? 1;
        conflicts.push(...(one.body?.conflicts ?? []));
        await engine.clearRejected?.({ direction: "outbound", change });
        continue;
      }
      if (!isApplyPoison(one.status, one.body)) {
        throw new Error(one.body?.error?.message ?? `Sync push failed (${one.status})`);
      }
      const message = one.body?.error?.message ?? `Sync push failed (${one.status})`;
      if (engine.rememberRejected) {
        await engine.rememberRejected({ direction: "outbound", change, reason: message });
      }
      skip(change, message);
    }
    return { conflicts, accepted, recovered: true };
  }
  // Pull in pages. Servers that ignore `limit` return everything with no
  // `more` flag, which ends the loop after one request.
  let cursor = remoteCursor;
  let pulledCount = 0;
  const pulledRejected = [];
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const pulledResponse = await fetchImpl(new URL(`/api/sync/pull?since=${cursor}&limit=${Math.max(1, Math.floor(pullPageSize))}`, remoteUrl), { headers, signal: AbortSignal.timeout(30_000) });
    const pulled = await pulledResponse.json();
    if (!pulledResponse.ok) {
      throw new Error(pulled?.error?.message ?? `Sync pull failed (${pulledResponse.status})`);
    }
    const pulledApplied = await engine.applyRemote(pulled.changes ?? [], {
      getBlob: async (id) => {
        if (blobs[id]) return Buffer.from(blobs[id], "base64");
        const response = await fetchImpl(new URL(`/api/sync/blobs/${encodeURIComponent(id)}`, remoteUrl), { headers, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return null;
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    pulledCount += (pulled.changes ?? []).length;
    pulledRejected.push(...(pulledApplied.rejected ?? []));
    const next = pulled.cursor ?? cursor;
    await engine.setCursor("remote", next);
    if (!pulled.more || !(pulled.changes ?? []).length || next === cursor) break;
    cursor = next;
  }

  const size = Math.max(1, Math.floor(pushChunkSize));
  const pushed = { conflicts: [], rejected: [], accepted: 0 };
  const chunks = [];
  for (let index = 0; index < outgoing.changes.length; index += size) {
    chunks.push(outgoing.changes.slice(index, index + size));
  }
  if (chunks.length === 0) chunks.push([]);
  for (const chunk of chunks) {
    const result = await pushChunk(chunk);
    pushed.conflicts.push(...(result.conflicts ?? []));
    pushed.rejected.push(...(result.rejected ?? []));
    pushed.accepted += Number(result.accepted ?? 0);
    const last = chunk[chunk.length - 1]?.seq;
    if (Number.isFinite(Number(last))) await engine.setCursor("remote-ack", Number(last));
  }
  const held = typeof engine.pendingChanges === "function" ? await engine.pendingChanges("outbound") : [];
  for (const change of orderChangesForApply(held)) {
    const one = await postChanges([change]);
    if (one.ok) {
      await engine.clearRejected({ direction: "outbound", change });
      continue;
    }
    if (!isApplyPoison(one.status, one.body)) {
      throw new Error(one.body?.error?.message ?? `Sync push failed (${one.status})`);
    }
    const message = one.body?.error?.message ?? `Sync push failed (${one.status})`;
    await engine.rememberRejected({ direction: "outbound", change, reason: message });
    skip(change, message);
  }
  pushed.rejected.push(...skipped);
  await engine.setCursor("remote-ack", outgoing.cursor);
  const echoedConflicts = pushed.conflicts;
  for (const conflict of echoedConflicts) await engine.rememberConflict(conflict);
  return {
    pushed: outgoing.changes.length,
    pulled: pulledCount,
    rejected: [...pushed.rejected, ...pulledRejected],
    conflicts: await engine.listConflicts(),
  };
}
