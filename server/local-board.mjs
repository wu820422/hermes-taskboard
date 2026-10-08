import { agentProfile, parseExecutionIdentity } from "../shared/execution-identity.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { toolDefs } from "../cloud/src/oauth-mcp.mjs";
import { enableV2Identifiers } from "../shared/sync/allocate.mjs";
import { conflictsPage } from "../shared/sync/conflicts-page.mjs";
import { createSyncEngine } from "../shared/sync/engine.mjs";
import { createClock } from "../shared/sync/hlc.mjs";
import { createSqliteAdapter } from "../shared/sync/sqlite.js";
import { createFileBlobs } from "./file-blobs.mjs";
import { runSyncOnce } from "./sync-client.mjs";
import { createSyncCoordinator } from "./sync-coordinator.mjs";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function meta(database, key) {
  return database.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key)?.value ?? null;
}

function upsertMeta(database, key, value) {
  database.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function createLocalBoard({ database, store, attachmentsDirectory, env = process.env }) {
  const existingDevice = meta(database, "device_id");
  const deviceId = existingDevice || env.TASKBOARD_DEVICE_ID || randomUUID();
  const deviceSlot = env.TASKBOARD_DEVICE_SLOT || meta(database, "device_slot") || "0";
  if (!existingDevice) upsertMeta(database, "device_id", deviceId);
  upsertMeta(database, "device_slot", String(deviceSlot));
  if (env.TASKBOARD_SYNC_URL || env.TASKBOARD_SYNC_V2 === "1") {
    enableV2Identifiers(database, { deviceId, deviceSlot: Number(deviceSlot) });
  }
  const blobs = createFileBlobs(attachmentsDirectory);
  const engine = createSyncEngine(createSqliteAdapter(database), {
    deviceId,
    clock: createClock(deviceId),
    blobs,
  });
  const sync = createSyncCoordinator({
    enabled: Boolean(env.TASKBOARD_SYNC_URL),
    intervalMs: Number(env.TASKBOARD_SYNC_INTERVAL_MS) || 300_000,
    run: () => runSyncOnce({
      engine,
      remoteUrl: env.TASKBOARD_SYNC_URL,
      authorization: env.TASKBOARD_SYNC_AUTHORIZATION || (env.TASKBOARD_SYNC_ACTOR && env.TASKBOARD_SYNC_KEY
        ? `Basic ${Buffer.from(`${env.TASKBOARD_SYNC_ACTOR}:${env.TASKBOARD_SYNC_KEY}`).toString("base64")}` : undefined),
    }),
  });
  return { database, store: store ?? null, engine, blobs, deviceId, env, sync };
}

export function authenticateLocalBearer(database, authorization) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const row = database.prepare(`
    SELECT id, name, scopes, revoked_at FROM api_clients WHERE token_hash = ?
  `).get(hashToken(token));
  if (!row || row.revoked_at) return null;
  return row;
}

function actorFromClient(client) {
  return {
    type: "agent",
    id: `local:${client?.id ?? "loopback"}`,
    name: client?.name ?? "Local agent",
    avatarUrl: null,
  };
}

function jsonResult(status, body) {
  return { type: "json", status, body };
}

async function dispatchTool(board, name, args, actor) {
  const { store: database, engine, blobs } = board;
  if (!database) throw new Error("Local task store is not configured");
  if (name === "whoami") return { actor, environment: "local", model: null, modelVerification: "not_provided" };
  if (name === "register_agent") {
    const profile = agentProfile(actor, args.executionIdentity, "local");
    const comment = database.createComment(args.id, { body: profile.markdown, executionIdentity: profile.executionIdentity, actor });
    const bytes = Buffer.from(profile.markdown, "utf8");
    const id = randomUUID();
    await blobs.put(id, bytes);
    const attachment = database.createAttachment(args.id, { id, kind: "attachment", filename: profile.filename, contentType: "text/markdown; charset=utf-8", size: bytes.byteLength });
    return { ...profile, comment, attachment };
  }
  if (name === "search") {
    const query = String(args.query ?? "").toLowerCase();
    const tasks = database.listTasks({ archived: "all" }).filter((task) => (
      task.title.toLowerCase().includes(query)
      || task.identifier.toLowerCase().includes(query)
      || (task.description ?? "").toLowerCase().includes(query)
    ));
    return { results: tasks.slice(0, 50).map((task) => ({ id: task.id, title: `${task.identifier} ${task.title}`, url: `/?issue=${encodeURIComponent(task.identifier)}` })) };
  }
  if (name === "fetch" || name === "list_relations") {
    const task = database.getTask(args.id);
    if (!task) throw new Error("Issue not found");
    if (name === "list_relations") return { relations: task.relations };
    return { id: task.id, title: `${task.identifier} ${task.title}`, text: JSON.stringify(task), url: `/?issue=${encodeURIComponent(task.identifier)}` };
  }
  if (name === "list_projects") return { projects: database.listProjects() };
  if (name === "list_issues") return { tasks: database.listTasks({ projectId: args.projectId, status: args.status, archived: args.archived ?? "false" }) };
  if (name === "create_issue") {
    return { task: database.createTask({
      projectId: args.projectId,
      title: args.title,
      description: args.description ?? "",
      status: args.status ?? "backlog",
      priority: args.priority ?? "none",
      labels: args.labels ?? [],
      startDate: args.startDate ?? null,
      dueDate: args.dueDate ?? null,
      actor,
      assignee: actor,
    }) };
  }
  if (name === "update_issue") {
    const { id, version, ...changes } = args;
    return { task: database.updateTask(id, version, changes, null, undefined, actor) };
  }
  if (name === "move_issue") return { task: database.moveTask(args.id, args.version, args.status, undefined, null, undefined, actor) };
  if (name === "archive_issue") return { task: database.archiveTask(args.id, args.version, null, undefined, actor) };
  if (name === "restore_issue") return { task: database.restoreTask(args.id, args.version, null, undefined, actor) };
  if (name === "list_comments") return { comments: database.listComments(args.id) };
  if (name === "add_comment") return { comment: database.createComment(args.id, { body: args.body, executionIdentity: parseExecutionIdentity(args.executionIdentity), actor }) };
  if (name === "update_comment") return { comment: database.updateComment(args.id, args.version, args.body, null, undefined) };
  if (name === "delete_comment") {
    database.deleteComment(args.id, args.version);
    return { deleted: true };
  }
  if (name === "get_project_readme") return { readme: database.getProjectReadme(args.projectId) };
  if (name === "set_project_readme") return { readme: database.saveProjectReadme(args.projectId, args.content, args.version) };
  if (name === "add_relation") return database.addTaskRelation(args.id, args.version, args.type, args.relatedId, null, undefined, actor);
  if (name === "remove_relation") return database.removeTaskRelation(args.id, args.version, args.type, args.relatedId, null, undefined, actor);
  if (name === "list_conflicts") return { conflicts: await engine.listConflicts() };
  if (name === "resolve_conflict") return { conflict: await engine.resolveConflict(args.id, args.choice, args.value) };
  if (name === "add_attachment") {
    const bytes = Buffer.from(args.contentBase64, "base64");
    const id = randomUUID();
    const attachment = database.createAttachment(args.id, {
      id,
      kind: args.kind || "attachment",
      filename: args.filename,
      contentType: args.contentType || "application/octet-stream",
      size: bytes.byteLength,
    });
    await blobs.put(id, bytes);
    return { attachment };
  }
  if (name === "get_attachment") {
    const attachment = database.getAttachment(args.id);
    if (!attachment) throw new Error("Attachment not found");
    const bytes = await blobs.get(args.id);
    return {
      attachment,
      contentBase64: bytes && bytes.byteLength <= 1_000_000 ? Buffer.from(bytes).toString("base64") : null,
    };
  }
  if (name === "delete_attachment") {
    const attachment = database.deleteAttachment(args.id);
    await blobs.delete(args.id);
    return { deleted: true, attachment };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const WRITE_TOOLS = new Set([
  "register_agent", "create_issue", "update_issue", "add_comment", "move_issue", "archive_issue", "restore_issue",
  "update_comment", "delete_comment", "add_attachment", "delete_attachment", "set_project_readme",
  "add_relation", "remove_relation", "resolve_conflict",
]);

export async function dispatchLocalBoard({ board, request, url, readJson }) {
  const { pathname } = url;
  const { database, engine } = board;
  if (pathname === "/conflicts" && request.method === "GET") {
    return { type: "html", status: 200, body: conflictsPage() };
  }
  if (pathname === "/api/local/api-clients" && request.method === "POST") {
    const body = await readJson(request);
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResult(400, { error: { code: "INVALID_FIELD", message: "name is required" } });
    const id = randomUUID();
    const token = `htb_${randomBytes(24).toString("hex")}`;
    const scopes = String(body.scopes ?? "taskboard:read taskboard:write");
    database.prepare(`
      INSERT INTO api_clients (id, name, token_hash, scopes, revoked_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(id, name, hashToken(token), scopes, new Date().toISOString());
    return jsonResult(201, { client: { id, name, scopes, token } });
  }
  if (pathname === "/api/local/api-clients" && request.method === "GET") {
    const clients = database.prepare(`
      SELECT id, name, scopes, revoked_at, created_at FROM api_clients ORDER BY created_at
    `).all();
    return jsonResult(200, { clients });
  }
  const revoke = pathname.match(/^\/api\/local\/api-clients\/([^/]+)$/);
  if (revoke && request.method === "DELETE") {
    database.prepare(`
      UPDATE api_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), decodeURIComponent(revoke[1]));
    return { type: "empty", status: 204 };
  }
  if (pathname === "/api/sync/conflicts" && request.method === "GET") {
    return jsonResult(200, {
      conflicts: await engine.listConflicts(url.searchParams.get("status") ?? "open"),
      rejected: await engine.listRejected("pending"),
    });
  }
  if (pathname === "/api/sync/status" && request.method === "GET") {
    const conflicts = await engine.listConflicts("open");
    const rejected = await engine.listRejected("pending");
    const ack = await engine.getCursor("remote-ack");
    const latest = await engine.latestSeq();
    return jsonResult(200, { openConflicts: conflicts.length, rejected, pendingOutbound: Math.max(0, latest - ack), remoteCursor: await engine.getCursor("remote"), ...board.sync.status() });
  }
  const resolve = pathname.match(/^\/api\/sync\/conflicts\/([^/]+)\/resolve$/);
  if (resolve && request.method === "POST") {
    const body = await readJson(request);
    const conflict = await engine.resolveConflict(decodeURIComponent(resolve[1]), body.choice, body.value);
    return jsonResult(200, { conflict });
  }
  if (pathname === "/api/sync/run" && request.method === "POST") {
    const result = await board.sync.run();
    return jsonResult(200, result);
  }
  if (pathname === "/api/mcp" && request.method === "POST") {
    const client = authenticateLocalBearer(database, request.headers.authorization);
    if (!client) {
      return jsonResult(401, { error: { code: "UNAUTHORIZED", message: "Local MCP requires a bearer token" } });
    }
    const body = await readJson(request);
    if (body.method === "initialize") {
      return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hermes-taskboard-local", version: "2.0.0" } } });
    }
    if (body.method === "tools/list") {
      return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, result: { tools: toolDefs } });
    }
    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      const scopes = String(client.scopes ?? "").split(/\s+/);
      const needed = WRITE_TOOLS.has(toolName) ? "taskboard:write" : "taskboard:read";
      if (!scopes.includes(needed) && !(needed === "taskboard:read" && scopes.includes("taskboard:write"))) {
        return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, result: { isError: true, content: [{ type: "text", text: "insufficient_scope" }] } });
      }
      try {
        const output = await dispatchTool(board, toolName, body.params?.arguments ?? {}, actorFromClient(client));
        return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output } });
      } catch (error) {
        return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, result: { isError: true, content: [{ type: "text", text: error.message }] } });
      }
    }
    return jsonResult(200, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } });
  }
  return null;
}
