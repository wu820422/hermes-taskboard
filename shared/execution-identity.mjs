// Execution metadata is attribution, never an authorization credential.
export const executionIdentitySchema = {
  type: "object", additionalProperties: false,
  properties: {
    agent: { type: "string", maxLength: 120 },
    model: { type: "string", maxLength: 120 },
    environment: { enum: ["local", "cloud", "unknown"] },
    sessionId: { type: "string", maxLength: 200 },
    scope: { type: "string", maxLength: 500 },
    state: { enum: ["working", "waiting", "completed", "blocked"] },
  }, required: ["agent", "sessionId", "environment", "state"],
};
export function parseExecutionIdentity(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("executionIdentity must be an object");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(executionIdentitySchema.properties, key)) throw new Error(`Unknown executionIdentity field: ${key}`);
  }
  for (const key of executionIdentitySchema.required) {
    if (!value[key]) throw new Error(`executionIdentity.${key} is required`);
  }
  const result = {};
  for (const [key, spec] of Object.entries(executionIdentitySchema.properties)) {
    const field = value[key];
    if (field == null) continue;
    if (typeof field !== "string" || field.length > (spec.maxLength ?? 500) || (spec.enum && !spec.enum.includes(field))) throw new Error(`Invalid executionIdentity.${key}`);
    result[key] = field.trim();
    if (executionIdentitySchema.required.includes(key) && !result[key]) throw new Error(`executionIdentity.${key} is required`);
  }
  return result;
}
export function executionFromRow(row) {
  return row.execution_identity ? JSON.parse(row.execution_identity) : null;
}
export function executionsFromComments(comments) {
  const sessions = new Map();
  for (const comment of [...comments].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const identity = executionFromRow(comment);
    if (!identity) continue;
    sessions.set(`${comment.author_id}:${identity.agent}:${identity.environment}:${identity.sessionId}`, {
      ...identity, actorId: comment.author_id, commentId: comment.id, observedAt: comment.created_at,
    });
  }
  return [...sessions.values()];
}

export function agentProfile(actor, identity, environment) {
  const executionIdentity = parseExecutionIdentity(identity);
  if (!executionIdentity) throw new Error("executionIdentity is required");
  if (executionIdentity.environment !== environment) throw new Error(`This endpoint records ${environment} execution; use its actual location`);
  const observedAt = new Date().toISOString();
  const profile = { authenticatedActor: { type: actor.type, id: actor.id, name: actor.name }, executionIdentity, observedAt, modelVerification: executionIdentity.model ? "client_reported" : "not_provided" };
  const markdown = `# Hermes Agent 身分紀錄

- 伺服器確認的連線身分：${JSON.stringify(profile.authenticatedActor)}
- 客戶端回報的執行資訊：${JSON.stringify(executionIdentity)}
- 模型確認程度：${profile.modelVerification}
- 執行位置：${environment}
- 記錄時間：${observedAt}

模型由客戶端回報，MCP 授權不證明底層模型。此紀錄不授予權限。每次更換模型或 session，重新登記；後續 add_comment 帶相同 executionIdentity，並更新 scope／state。
`;
  return { ...profile, markdown, filename: `hermes-agent-${executionIdentity.agent.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "agent"}-${observedAt.replace(/[^0-9]/g, "")}.md` };
}
