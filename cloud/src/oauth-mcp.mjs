import { executionIdentitySchema, agentProfile } from "../../shared/execution-identity.mjs";
const enc = new TextEncoder();
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const random = (size = 32) => { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return b64url(bytes); };
const hash = async (value) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
const now = () => Math.floor(Date.now() / 1000);

function metadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["taskboard:read", "taskboard:write"],
  };
}

function resourceMetadata(origin) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["taskboard:read", "taskboard:write"],
    resource_name: "Hermes Taskboard",
  };
}

function oauthError(code, description, status = 400) {
  return json({ error: code, error_description: description }, status);
}

async function readBody(request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json();
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function validRedirect(uri) {
  try { return new URL(uri).protocol === "https:"; } catch { return false; }
}

async function register(request, env) {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  const body = await readBody(request);
  const redirects = body.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(validRedirect)) {
    return oauthError("invalid_redirect_uri", "At least one HTTPS redirect URI is required");
  }
  if ((body.token_endpoint_auth_method ?? "none") !== "none") {
    return oauthError("invalid_client_metadata", "Only public PKCE clients are supported");
  }
  const clientId = random(24);
  await env.DB.prepare(`INSERT INTO oauth_clients
    (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)`)
    .bind(clientId, String(body.client_name ?? "MCP Client").slice(0, 120), JSON.stringify(redirects), new Date().toISOString()).run();
  return json({
    client_id: clientId,
    client_name: String(body.client_name ?? "MCP Client").slice(0, 120),
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function authorize(request, env, url) {
  const params = request.method === "POST" ? await readBody(request) : Object.fromEntries(url.searchParams);
  const client = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").bind(params.client_id ?? "").first();
  let redirects = [];
  try { redirects = JSON.parse(client?.redirect_uris_json ?? "[]"); } catch {}
  if (!client || !redirects.includes(params.redirect_uri) || params.response_type !== "code"
    || params.code_challenge_method !== "S256" || !params.code_challenge) {
    return oauthError("invalid_request", "Invalid OAuth authorization request");
  }
  if (request.method === "GET") {
    const hidden = Object.entries(params).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
    return new Response(`<!doctype html><meta charset="utf-8"><title>連接 Hermes Taskboard</title><style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh}form{width:min(420px,90vw);padding:28px;background:#1d1d1d;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;border-radius:8px}button{background:#00cdd7;border:0;font-weight:700}</style><form method="post"><h1>連接 Hermes Taskboard</h1><p>授權 ${escapeHtml(client.client_name)} 讀寫你的任務面板。</p>${hidden}<input name="username" value="Leo" required aria-label="名稱"><input name="password" type="password" required placeholder="Taskboard 密碼" aria-label="Taskboard 密碼"><button>核准連接</button></form>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const supplied = await hash(String(params.password ?? ""));
  const expected = await hash(String(env.TASKBOARD_SHARED_SECRET ?? ""));
  if (supplied !== expected) return oauthError("access_denied", "Invalid Taskboard password", 401);
  const code = random();
  await env.DB.prepare(`INSERT INTO oauth_codes
    (code_hash, client_id, redirect_uri, code_challenge, scope, username, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await hash(code), client.client_id, params.redirect_uri, params.code_challenge,
      params.scope ?? "taskboard:read taskboard:write", String(params.username || "Leo").slice(0, 120), now() + 300, new Date().toISOString()).run();
  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  redirect.searchParams.set("iss", url.origin);
  return Response.redirect(redirect, 302);
}

async function issueToken(request, env) {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  const body = await readBody(request);
  if (body.grant_type === "authorization_code") {
    const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").bind(await hash(String(body.code ?? ""))).first();
    if (!row || row.expires_at < now() || row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri
      || await hash(String(body.code_verifier ?? "")) !== row.code_challenge) return oauthError("invalid_grant", "Invalid or expired authorization code");
    await env.DB.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").bind(await hash(String(body.code))).run();
    return createTokens(env, row.client_id, row.username, row.scope);
  }
  if (body.grant_type === "refresh_token") {
    const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh'").bind(await hash(String(body.refresh_token ?? ""))).first();
    if (!row || row.expires_at < now() || row.client_id !== body.client_id) return oauthError("invalid_grant", "Invalid or expired refresh token");
    await env.DB.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").bind(await hash(String(body.refresh_token))).run();
    return createTokens(env, row.client_id, row.username, row.scope);
  }
  return oauthError("unsupported_grant_type", "Unsupported grant type");
}

async function createTokens(env, clientId, username, scope) {
  const access = random(36), refresh = random(40), created = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, 'access', ?, ?)").bind(await hash(access), clientId, username, scope, now() + 3600, created),
    env.DB.prepare("INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, 'refresh', ?, ?)").bind(await hash(refresh), clientId, username, scope, now() + 30 * 86400, created),
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope });
}

export async function routeOAuth(request, env, url) {
  if (url.pathname === "/.well-known/oauth-authorization-server") return json(metadata(url.origin));
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource/api/mcp") return json(resourceMetadata(url.origin));
  if (url.pathname === "/oauth/register") return register(request, env);
  if (url.pathname === "/oauth/token") return issueToken(request, env);
  if (url.pathname === "/authorize") return authorize(request, env, url);
  return null;
}

const oauthSecurity = [{ type: "oauth2", scopes: ["taskboard:read", "taskboard:write"] }];
const objectOutput = { type: "object", additionalProperties: true };
export const toolDefs = [
  { name: "whoami", title: "Confirm Hermes connection identity", description: "Call first on entering Hermes. Returns authenticated connection actor and endpoint environment; does not infer the model.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, annotations: { readOnlyHint: true } },
  { name: "register_agent", title: "Register agent and write identity Markdown", description: "After whoami, record your actual client model/session and work scope for this task. Saves a Markdown attachment and comment. Use the returned executionIdentity on subsequent add_comment calls. Omit unknown model; never guess.", inputSchema: { type: "object", properties: { id: { type: "string" }, executionIdentity: executionIdentitySchema }, required: ["id", "executionIdentity"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "search", title: "Search Taskboard", description: "Use this when the user wants to find Hermes Taskboard projects or issues.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, outputSchema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, text: { type: "string" } }, required: ["id", "title", "url"], additionalProperties: false } } }, required: ["results"], additionalProperties: false }, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "fetch", title: "Fetch Taskboard issue", description: "Use this when the user wants to read one Hermes Taskboard issue and its comments by ID or identifier.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" } }, required: ["id", "title", "text", "url"], additionalProperties: false }, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "create_issue", title: "Create Taskboard issue", description: "Use this when the user wants to create an issue in a specific Hermes Taskboard project.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "update_issue", title: "Update Taskboard issue", description: "Use this when the user wants to update an existing Hermes Taskboard issue after its current version is known.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" } }, required: ["id", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "add_comment", title: "Add Taskboard comment", description: "Use this when the user wants to add a comment to an existing Hermes Taskboard issue.", inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, executionIdentity: executionIdentitySchema }, required: ["id", "body"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "list_projects", title: "List projects", description: "List Hermes Taskboard projects.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "list_issues", title: "List issues", description: "List issues, optionally filtered by project, status, or archive state.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string" }, archived: { type: "string" } }, additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "move_issue", title: "Move issue status", description: "Move an issue to another status. Requires the current version.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" }, status: { type: "string" } }, required: ["id", "version", "status"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "archive_issue", title: "Archive issue", description: "Archive an issue. Requires the current version.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" } }, required: ["id", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "restore_issue", title: "Restore issue", description: "Restore an archived issue. Requires the current version.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" } }, required: ["id", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "list_comments", title: "List comments", description: "List comments on an issue.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "update_comment", title: "Update comment", description: "Update a comment. Requires the current comment version.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" }, body: { type: "string" } }, required: ["id", "version", "body"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "delete_comment", title: "Delete comment", description: "Delete a comment. Requires the current comment version.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" } }, required: ["id", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "add_attachment", title: "Add attachment", description: "Attach a small base64 file to an issue.", inputSchema: { type: "object", properties: { id: { type: "string" }, filename: { type: "string" }, contentType: { type: "string" }, contentBase64: { type: "string" }, kind: { type: "string" } }, required: ["id", "filename", "contentBase64"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "get_attachment", title: "Get attachment", description: "Read attachment metadata and, when small, its base64 bytes.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "delete_attachment", title: "Delete attachment", description: "Delete an attachment by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "get_project_readme", title: "Get project README", description: "Read a project README.", inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "set_project_readme", title: "Set project README", description: "Replace a project README. Pass version for optimistic concurrency.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, content: { type: "string" }, version: { type: "integer" } }, required: ["projectId", "content"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "list_relations", title: "List issue relations", description: "List parent, sub-issue, blocks, and related links for an issue.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "add_relation", title: "Add issue relation", description: "Add a parent, blocks, or related link. Requires the issue version.", inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, relatedId: { type: "string" }, version: { type: "integer" } }, required: ["id", "type", "relatedId", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "remove_relation", title: "Remove issue relation", description: "Remove a relation. Requires the issue version.", inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, relatedId: { type: "string" }, version: { type: "integer" } }, required: ["id", "type", "relatedId", "version"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "list_conflicts", title: "List sync conflicts", description: "List unresolved same-field sync conflicts.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "resolve_conflict", title: "Resolve sync conflict", description: "Resolve a sync conflict by choosing local, remote, or custom.", inputSchema: { type: "object", properties: { id: { type: "string" }, choice: { type: "string" }, value: {} }, required: ["id", "choice"], additionalProperties: false }, outputSchema: objectOutput, securitySchemes: oauthSecurity, _meta: { securitySchemes: oauthSecurity }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

const WRITE_TOOLS = new Set([
  "register_agent", "create_issue", "update_issue", "add_comment", "move_issue", "archive_issue", "restore_issue",
  "update_comment", "delete_comment", "add_attachment", "delete_attachment", "set_project_readme",
  "add_relation", "remove_relation", "resolve_conflict",
]);

async function apiJson(routeApi, env, actor, origin, path, method = "GET", body) {
  const req = new Request(`${origin}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const response = await routeApi(req, env, actor, new URL(req.url));
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(value?.error?.message ?? `Taskboard API ${response.status}`);
  return value;
}

function requireToolScope(token, name) {
  const scopes = String(token?.scope ?? "").split(/\s+/);
  const needed = WRITE_TOOLS.has(name) ? "taskboard:write" : "taskboard:read";
  if (!scopes.includes(needed) && !scopes.includes("taskboard:write")) {
    throw new Error("insufficient_scope");
  }
}

async function callTool(name, args, ctx) {
  const { env, actor, origin, routeApi, token } = ctx;
  requireToolScope(token, name);
  if (name === "whoami") return { actor: { type: actor.type, id: actor.id, name: actor.name }, environment: "cloud", model: null, modelVerification: "not_provided" };
  if (name === "register_agent") {
    const profile = agentProfile(actor, args.executionIdentity, "cloud");
    const commentResult = await apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/comments`, "POST", { body: profile.markdown, executionIdentity: profile.executionIdentity });
    const request = new Request(`${origin}/api/tasks/${encodeURIComponent(args.id)}/attachments`, { method: "POST", headers: { "content-type": "text/markdown; charset=utf-8", "x-taskboard-filename": encodeURIComponent(profile.filename), "x-taskboard-attachment-kind": "attachment" }, body: profile.markdown });
    const response = await routeApi(request, env, actor, new URL(request.url));
    const result = await response.json();
    if (!response.ok) throw new Error(`Identity comment saved (${commentResult.comment.id}), Markdown attachment failed: ${result.error?.message ?? response.status}`);
    return { ...profile, comment: commentResult.comment, attachment: result.attachment };
  }
  if (name === "search") {
    const q = `%${String(args.query).slice(0, 200)}%`;
    const rows = await env.DB.prepare(`SELECT t.id, t.identifier, t.title, t.status, t.priority, t.project_id AS projectId, p.name AS projectName
      FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.title LIKE ? OR t.description LIKE ? OR t.identifier LIKE ? OR p.name LIKE ?
      ORDER BY t.updated_at DESC LIMIT 50`).bind(q, q, q, q).all();
    return { results: rows.results.map((r) => ({ id: r.id, title: `${r.identifier} ${r.title}`, url: `${origin}/?project=${encodeURIComponent(r.projectId)}&issue=${encodeURIComponent(r.identifier)}`, text: `${r.projectName} · ${r.status} · ${r.priority}` })) };
  }
  if (name === "fetch") {
    let id = args.id;
    if (!/^[0-9a-f-]{20,}$/i.test(id)) id = (await env.DB.prepare("SELECT id FROM tasks WHERE identifier = ?").bind(id).first())?.id;
    if (!id) throw new Error("Issue not found");
    const task = (await apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(id)}`)).task;
    const comments = (await apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(id)}/comments`)).comments;
    return { id: task.id, title: `${task.identifier} ${task.title}`, text: JSON.stringify({ task, comments }, null, 2), url: `${origin}/?project=${encodeURIComponent(task.projectId)}&issue=${encodeURIComponent(task.identifier)}` };
  }
  if (name === "create_issue") return apiJson(routeApi, env, actor, origin, "/api/tasks", "POST", { description: "", status: "backlog", priority: "none", labels: [], ...args });
  if (name === "update_issue") { const { id, ...patch } = args; return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(id)}`, "PATCH", patch); }
  if (name === "add_comment") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/comments`, "POST", { body: args.body, executionIdentity: args.executionIdentity });
  if (name === "list_projects") return apiJson(routeApi, env, actor, origin, "/api/projects");
  if (name === "list_issues") {
    const search = new URLSearchParams();
    if (args.projectId) search.set("projectId", args.projectId);
    if (args.status) search.set("status", args.status);
    if (args.archived) search.set("archived", args.archived);
    const query = search.toString();
    return apiJson(routeApi, env, actor, origin, `/api/tasks${query ? `?${query}` : ""}`);
  }
  if (name === "move_issue") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/move`, "POST", { version: args.version, status: args.status });
  if (name === "archive_issue") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/archive`, "POST", { version: args.version });
  if (name === "restore_issue") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/restore`, "POST", { version: args.version });
  if (name === "list_comments") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/comments`);
  if (name === "update_comment") return apiJson(routeApi, env, actor, origin, `/api/comments/${encodeURIComponent(args.id)}`, "PATCH", { version: args.version, body: args.body });
  if (name === "delete_comment") return apiJson(routeApi, env, actor, origin, `/api/comments/${encodeURIComponent(args.id)}`, "DELETE", { version: args.version });
  if (name === "get_project_readme") return apiJson(routeApi, env, actor, origin, `/api/projects/${encodeURIComponent(args.projectId)}/readme`);
  if (name === "set_project_readme") return apiJson(routeApi, env, actor, origin, `/api/projects/${encodeURIComponent(args.projectId)}/readme`, "PUT", { content: args.content, ...(args.version === undefined ? {} : { version: args.version }) });
  if (name === "list_relations") {
    const task = await apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}`);
    return { relations: task.task.relations };
  }
  if (name === "add_relation") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/relations/${encodeURIComponent(args.type)}/${encodeURIComponent(args.relatedId)}`, "POST", { version: args.version });
  if (name === "remove_relation") return apiJson(routeApi, env, actor, origin, `/api/tasks/${encodeURIComponent(args.id)}/relations/${encodeURIComponent(args.type)}/${encodeURIComponent(args.relatedId)}`, "DELETE", { version: args.version });
  if (name === "list_conflicts") return apiJson(routeApi, env, actor, origin, "/api/sync/conflicts");
  if (name === "resolve_conflict") return apiJson(routeApi, env, actor, origin, `/api/sync/conflicts/${encodeURIComponent(args.id)}/resolve`, "POST", { choice: args.choice, value: args.value });
  if (name === "add_attachment") {
    const bytes = Uint8Array.from(atob(args.contentBase64), (character) => character.charCodeAt(0));
    const request = new Request(`${origin}/api/tasks/${encodeURIComponent(args.id)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": args.contentType || "application/octet-stream",
        "x-taskboard-filename": encodeURIComponent(args.filename),
        "x-taskboard-attachment-kind": args.kind || "attachment",
      },
      body: bytes,
    });
    const response = await routeApi(request, env, actor, new URL(request.url));
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message ?? `Taskboard API ${response.status}`);
    return value;
  }
  if (name === "get_attachment") {
    const request = new Request(`${origin}/api/attachments/${encodeURIComponent(args.id)}/content`);
    const response = await routeApi(request, env, actor, new URL(request.url));
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value?.error?.message ?? `Taskboard API ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      id: args.id,
      contentType: response.headers.get("content-type"),
      size: bytes.byteLength,
      contentBase64: bytes.byteLength <= 1_000_000 ? btoa(binary) : null,
    };
  }
  if (name === "delete_attachment") {
    const request = new Request(`${origin}/api/attachments/${encodeURIComponent(args.id)}`, { method: "DELETE" });
    const response = await routeApi(request, env, actor, new URL(request.url));
    if (!response.ok && response.status !== 204) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value?.error?.message ?? `Taskboard API ${response.status}`);
    }
    return { deleted: true, id: args.id };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function routeMcp(request, env, url, routeApi) {
  if (url.pathname !== "/api/mcp") return null;
  const challenge = `Bearer realm="Hermes Taskboard", resource_metadata="${url.origin}/.well-known/oauth-protected-resource/api/mcp"`;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return json({ error: "unauthorized" }, 401, { "www-authenticate": challenge });
  let token = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND token_type = 'access'").bind(await hash(bearer)).first();
  if (!token || token.expires_at < now()) {
    let client = null;
    try {
      client = await env.DB.prepare("SELECT * FROM api_clients WHERE token_hash = ?").bind(await hash(bearer)).first();
    } catch {
      client = null;
    }
    if (!client || client.revoked_at) return json({ error: "invalid_token" }, 401, { "www-authenticate": challenge });
    token = { client_id: client.id, username: client.name, scope: client.scopes, expires_at: now() + 60 };
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const rpc = await request.json();
  let result;
  if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hermes-taskboard", version: "1.0.0" } };
  else if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  else if (rpc.method === "tools/list") result = { tools: toolDefs };
  else if (rpc.method === "tools/call") {
    try {
      const output = await callTool(rpc.params?.name, rpc.params?.arguments ?? {}, { env, origin: url.origin, routeApi, token, actor: { type: "agent", id: `oauth:${token.client_id}`, name: `MCP Agent (${token.username})`, avatarUrl: null, username: token.username } });
      result = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
  } else return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: "Method not found" } });
  return json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
}
