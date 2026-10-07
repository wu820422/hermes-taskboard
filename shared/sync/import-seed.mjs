import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { legacyPrefix } from "./allocate.mjs";
import { encodeValue, formatHlc } from "./hlc.mjs";
import { TaskboardDatabase } from "../../server/database.mjs";

const TASK_FIELDS = [
  "title", "description", "status", "priority", "project_id", "identifier", "archived_at",
];

const LOCAL_COLUMNS = {
  projects: ["id", "name", "labels", "start_date", "identifier_prefix", "created_at", "updated_at"],
  tasks: [
    "id", "identifier", "project_id", "title", "description", "status", "priority", "labels",
    "archived_at", "created_at", "updated_at", "sort_order",
  ],
  comments: ["id", "task_id", "body", "author_type", "author_id", "author_name", "created_at", "updated_at"],
  project_readmes: ["project_id", "content", "created_at", "updated_at"],
  task_relations: ["relation_type", "source_task_id", "target_task_id", "origin", "created_at"],
};

const DECISION_FIELDS = new Set(["dropTaskIds", "reassignIdentifiers", "mergeLabels"]);

function asArray(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.values(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function pick(record, names) {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function text(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function stamp(row) {
  const value = row?.updated_at ?? row?.created_at ?? "";
  return value ? String(value) : "";
}

function newer(left, right) {
  return stamp(left) >= stamp(right);
}

function isCommentRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    value.title !== undefined
    || value.identifier !== undefined
    || value.projectId !== undefined
    || value.project_id !== undefined
  ) {
    return false;
  }
  return value.body !== undefined
    || value.authorId !== undefined
    || value.author_id !== undefined
    || value.authorName !== undefined
    || value.author_name !== undefined;
}

function stampComment(record, taskIdHint) {
  if (!taskIdHint || record.task_id || record.taskId) return record;
  return { ...record, taskId: taskIdHint };
}

// comments.json from the old cloud backup is {"<taskId>": [comment, ...]}.
// A plain array and {comments: [...]} are also accepted. Task objects are not comments.
export function flattenComments(value, taskIdHint = null) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const comments = [];
    for (const item of value) {
      if (Array.isArray(item)) comments.push(...flattenComments(item, taskIdHint));
      else if (isCommentRecord(item)) comments.push(stampComment(item, taskIdHint));
    }
    return comments;
  }
  if (typeof value !== "object") return [];
  if (isCommentRecord(value)) return [stampComment(value, taskIdHint)];
  if (Array.isArray(value.comments)) return flattenComments(value.comments, taskIdHint);
  const comments = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === "comments") continue;
    if (Array.isArray(entry)) comments.push(...flattenComments(entry, key));
    else if (isCommentRecord(entry)) comments.push(stampComment(entry, null));
  }
  return comments;
}

export function normalizeProject(record) {
  const nested = record.project && typeof record.project === "object" ? record.project : record;
  return {
    id: String(pick(nested, ["id", "projectId"])),
    name: String(pick(nested, ["name", "title"]) ?? ""),
    created_at: pick(nested, ["created_at", "createdAt"]) ?? null,
    updated_at: pick(nested, ["updated_at", "updatedAt"]) ?? pick(nested, ["created_at", "createdAt"]) ?? null,
    labels: text(pick(nested, ["labels"])) ?? "[]",
    start_date: pick(nested, ["start_date", "startDate"]) ?? null,
    identifier_prefix: pick(nested, ["identifier_prefix", "identifierPrefix"]) ?? null,
  };
}

export function normalizeTask(record) {
  const nested = record.task && typeof record.task === "object" ? record.task : record;
  const labels = pick(nested, ["labels"]);
  return {
    id: String(pick(nested, ["id"])),
    identifier: String(pick(nested, ["identifier"]) ?? ""),
    project_id: String(pick(nested, ["project_id", "projectId"]) ?? ""),
    title: String(pick(nested, ["title"]) ?? ""),
    description: String(pick(nested, ["description"]) ?? ""),
    status: pick(nested, ["status"]) ?? "backlog",
    priority: pick(nested, ["priority"]) ?? "none",
    labels: typeof labels === "string" ? labels : JSON.stringify(labels ?? []),
    archived_at: pick(nested, ["archived_at", "archivedAt"]) ?? null,
    created_at: pick(nested, ["created_at", "createdAt"]) ?? null,
    updated_at: pick(nested, ["updated_at", "updatedAt"]) ?? pick(nested, ["created_at", "createdAt"]) ?? null,
    sort_order: pick(nested, ["sort_order", "sortOrder"]) ?? 1000,
  };
}

export function normalizeComment(record) {
  return {
    id: String(pick(record, ["id"])),
    task_id: String(pick(record, ["task_id", "taskId"]) ?? ""),
    body: String(pick(record, ["body"]) ?? ""),
    author_type: pick(record, ["author_type", "authorType"]) ?? "user",
    author_id: pick(record, ["author_id", "authorId"]) ?? "import",
    author_name: pick(record, ["author_name", "authorName"]) ?? "Import",
    created_at: pick(record, ["created_at", "createdAt"]) ?? null,
    updated_at: pick(record, ["updated_at", "updatedAt"]) ?? null,
  };
}

function parseLabels(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      return [trimmed];
    }
  }
  return [];
}

function cloneRows(rows) {
  return (rows ?? []).map((row) => ({ ...row }));
}

function mergeById(entityType, localRows, cloudRows, fields) {
  const local = new Map(localRows.filter((row) => row.id).map((row) => [row.id, row]));
  const cloud = new Map(cloudRows.filter((row) => row.id).map((row) => [row.id, row]));
  const conflicts = [];
  const merged = [];
  for (const id of new Set([...local.keys(), ...cloud.keys()])) {
    const left = local.get(id);
    const right = cloud.get(id);
    if (!left || !right) {
      merged.push({ ...(left ?? right), source: left ? "local" : "cloud" });
      continue;
    }
    const winner = newer(left, right) ? left : right;
    const row = { ...winner, source: "merged" };
    for (const field of fields) {
      if (JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null)) {
        conflicts.push({
          kind: "field",
          entityType,
          entityId: id,
          field,
          local: left[field] ?? null,
          cloud: right[field] ?? null,
          kept: row[field] ?? null,
          keptFrom: winner === left ? "local" : "cloud",
          discardedFrom: winner === left ? "cloud" : "local",
        });
      }
    }
    merged.push(row);
  }
  return { merged, conflicts };
}

function projectName(projects, projectId) {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

export function normalizeDecisions(raw) {
  if (raw == null) {
    return { dropTaskIds: [], reassignIdentifiers: [], mergeLabels: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("decisions must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!DECISION_FIELDS.has(key)) throw new Error(`Unknown decisions field: ${key}`);
  }
  const dropTaskIds = raw.dropTaskIds ?? [];
  if (!Array.isArray(dropTaskIds) || dropTaskIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("dropTaskIds must be an array of task ids");
  }
  const seenDrops = new Set();
  for (const id of dropTaskIds) {
    if (seenDrops.has(id)) throw new Error(`Duplicate task id in dropTaskIds: ${id}`);
    seenDrops.add(id);
  }
  const reassignIdentifiers = raw.reassignIdentifiers ?? [];
  if (!Array.isArray(reassignIdentifiers)) throw new Error("reassignIdentifiers must be an array");
  const seenReassign = new Set();
  for (const item of reassignIdentifiers) {
    if (!item || typeof item !== "object" || typeof item.taskId !== "string" || !item.taskId
      || typeof item.from !== "string" || !item.from || typeof item.to !== "string" || !item.to) {
      throw new Error("reassignIdentifiers items must include taskId, from, and to");
    }
    if (item.from === item.to) {
      throw new Error(`reassignIdentifiers from and to are the same for task ${item.taskId}: ${item.from}`);
    }
    if (seenReassign.has(item.taskId)) throw new Error(`Duplicate task id in reassignIdentifiers: ${item.taskId}`);
    seenReassign.add(item.taskId);
  }
  const mergeLabels = raw.mergeLabels ?? [];
  if (!Array.isArray(mergeLabels)) throw new Error("mergeLabels must be an array");
  const seenLabels = new Set();
  for (const item of mergeLabels) {
    if (!item || typeof item !== "object" || typeof item.from !== "string" || !item.from
      || typeof item.to !== "string" || !item.to) {
      throw new Error("mergeLabels items must include from and to");
    }
    if (item.from === item.to) throw new Error(`mergeLabels from and to are the same: ${item.from}`);
    if (seenLabels.has(item.from)) throw new Error(`Duplicate mergeLabels from: ${item.from}`);
    seenLabels.add(item.from);
  }
  return { dropTaskIds, reassignIdentifiers, mergeLabels };
}

function applyLabelMerges(projects, tasks, merges) {
  if (merges.length === 0) return [];
  const present = new Set();
  for (const row of [...projects, ...tasks]) {
    for (const label of parseLabels(row.labels)) present.add(label);
  }
  for (const merge of merges) {
    if (!present.has(merge.from)) throw new Error(`Unknown label in mergeLabels: ${merge.from}`);
  }
  const effects = merges.map((merge) => ({
    action: "mergeLabels",
    from: merge.from,
    to: merge.to,
    projects: 0,
    tasks: 0,
  }));
  const rewrite = (row, bucket) => {
    let next = parseLabels(row.labels);
    let changed = false;
    merges.forEach((merge, index) => {
      if (!next.includes(merge.from)) return;
      changed = true;
      effects[index][bucket] += 1;
      const at = next.indexOf(merge.from);
      const removed = next.filter((label) => label !== merge.from);
      if (!removed.includes(merge.to)) removed.splice(Math.min(at, removed.length), 0, merge.to);
      next = [...new Set(removed)];
    });
    if (changed || Array.isArray(row.labels)) row.labels = JSON.stringify(next);
  };
  for (const project of projects) rewrite(project, "projects");
  for (const task of tasks) rewrite(task, "tasks");
  return effects;
}

function applyTaskDecisions(tasks, decisions) {
  const byId = new Map(tasks.filter((task) => task.id).map((task) => [task.id, task]));
  for (const taskId of decisions.dropTaskIds) {
    if (!byId.has(taskId)) throw new Error(`Unknown task id in dropTaskIds: ${taskId}`);
  }
  const drop = new Set(decisions.dropTaskIds);
  const effects = [];
  const kept = [];
  for (const task of tasks) {
    if (!drop.has(task.id)) {
      kept.push(task);
      continue;
    }
    effects.push({
      action: "dropTaskIds",
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      commentsRemoved: 0,
      relationsRemoved: 0,
    });
  }
  const keptById = new Map(kept.map((task) => [task.id, task]));
  for (const item of decisions.reassignIdentifiers) {
    if (drop.has(item.taskId) || !keptById.has(item.taskId)) {
      throw new Error(`Unknown task id in reassignIdentifiers: ${item.taskId}`);
    }
    const task = keptById.get(item.taskId);
    if (task.identifier !== item.from) {
      throw new Error(`Task ${item.taskId} identifier is ${task.identifier || "(empty)"}, not ${item.from}`);
    }
  }
  const finals = new Map(kept.map((task) => [task.id, task.identifier]));
  for (const item of decisions.reassignIdentifiers) finals.set(item.taskId, item.to);
  for (const item of decisions.reassignIdentifiers) {
    const holder = [...finals.entries()].find(([id, identifier]) => identifier === item.to && id !== item.taskId);
    if (holder) throw new Error(`Identifier ${item.to} is already used by task ${holder[0]}`);
  }
  for (const item of decisions.reassignIdentifiers) {
    const task = keptById.get(item.taskId);
    task.identifier = item.to;
    delete task.aliasOf;
    effects.push({ action: "reassignIdentifiers", taskId: item.taskId, from: item.from, to: item.to });
  }
  return { tasks: kept, effects, droppedIds: drop };
}

function addEdge(bucket, edge) {
  const type = edge?.relation_type;
  if (type !== "parent" && type !== "blocks" && type !== "related") return false;
  let source = String(edge.source_task_id ?? "");
  let target = String(edge.target_task_id ?? "");
  if (!source || !target || source === "undefined" || target === "undefined" || source === target) return false;
  if (type === "related" && source > target) [source, target] = [target, source];
  const key = `${type}|${source}|${target}`;
  if (bucket.has(key)) return false;
  bucket.set(key, {
    relation_type: type,
    source_task_id: source,
    target_task_id: target,
    origin: edge.origin === "mention" || edge.origin === "manual" ? edge.origin : null,
    created_at: edge.created_at ?? null,
  });
  return true;
}

function dedupeRelations(relations) {
  const bucket = new Map();
  for (const edge of relations ?? []) addEdge(bucket, edge);
  return [...bucket.values()];
}

function absorbTree(value, bucket, parentHint) {
  if (!value) return;
  if (Array.isArray(value)) {
    if (parentHint && value.every((item) => typeof item === "string")) {
      for (const child of value) {
        addEdge(bucket, { relation_type: "parent", source_task_id: parentHint, target_task_id: child });
      }
      return;
    }
    for (const item of value) absorbTree(item, bucket, parentHint);
    return;
  }
  if (typeof value !== "object") return;
  const explicitType = value.relation_type || value.relationType || null;
  const explicitSource = value.source_task_id || value.sourceTaskId || value.source || null;
  const explicitTarget = value.target_task_id || value.targetTaskId || value.target || null;
  if (explicitType && explicitSource && explicitTarget) {
    addEdge(bucket, {
      relation_type: explicitType,
      source_task_id: explicitSource,
      target_task_id: explicitTarget,
      origin: value.origin,
      created_at: value.created_at ?? value.createdAt ?? null,
    });
  } else if (value.id && (value.parentId || value.parent_id)) {
    addEdge(bucket, {
      relation_type: "parent",
      source_task_id: value.parentId || value.parent_id,
      target_task_id: value.id,
    });
  } else if ((value.childId || value.child_id) && (value.parentId || value.parent_id || parentHint)) {
    addEdge(bucket, {
      relation_type: "parent",
      source_task_id: value.parentId || value.parent_id || parentHint,
      target_task_id: value.childId || value.child_id,
    });
  } else if (
    parentHint
    && value.id
    && parentHint !== value.id
    && !value.parentId
    && !value.parent_id
    && value.body === undefined
    && value.title === undefined
    && !value.tree
    && !value.nodes
  ) {
    addEdge(bucket, { relation_type: "parent", source_task_id: parentHint, target_task_id: value.id });
  }
  if (Array.isArray(value.children) && (value.id || parentHint)) {
    absorbTree(value.children, bucket, value.id || parentHint);
  }
  if (value.tree) absorbTree(value.tree, bucket, parentHint);
  if (Array.isArray(value.nodes)) absorbTree(value.nodes, bucket, parentHint);
  if (Array.isArray(value.edges)) absorbTree(value.edges, bucket, parentHint);
  if (Array.isArray(value.descendants)) absorbTree(value.descendants, bucket, value.id || parentHint);
  const structural = new Set([
    "tree", "nodes", "edges", "children", "descendants", "summary", "path",
    "parent", "subIssues", "blockedBy", "blocks", "related",
  ]);
  const looksLikeNode = Boolean(value.id && (
    value.parentId !== undefined || value.parent_id !== undefined || value.depth !== undefined || value.summary
  ));
  const looksLikeEdge = Boolean(explicitType && explicitSource && explicitTarget);
  if (looksLikeNode || looksLikeEdge) return;
  for (const [key, entry] of Object.entries(value)) {
    if (structural.has(key)) continue;
    if (Array.isArray(entry) || (entry && typeof entry === "object")) absorbTree(entry, bucket, key);
  }
}

function relationId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id ? String(value.id) : null;
}

function addRelationList(bucket, type, sourceId, targetId) {
  if (!sourceId || !targetId) return;
  addEdge(bucket, { relation_type: type, source_task_id: sourceId, target_task_id: targetId });
}

function addRelationsObject(bucket, taskId, relations) {
  if (!relations || !taskId) return;
  if (Array.isArray(relations)) {
    absorbTree(relations, bucket, null);
    return;
  }
  if (typeof relations !== "object") return;
  const parentId = relationId(relations.parent);
  if (parentId) addRelationList(bucket, "parent", parentId, taskId);
  for (const child of relations.subIssues ?? relations.children ?? []) {
    addRelationList(bucket, "parent", taskId, relationId(child));
  }
  for (const blocker of relations.blockedBy ?? []) {
    addRelationList(bucket, "blocks", relationId(blocker), taskId);
  }
  for (const blocked of relations.blocks ?? []) {
    addRelationList(bucket, "blocks", taskId, relationId(blocked));
  }
  for (const related of relations.related ?? []) {
    addRelationList(bucket, "related", taskId, relationId(related));
  }
}

function eachDetail(value, visit) {
  if (!value || typeof value !== "object") return;
  const visitOne = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    visit(entry);
  };
  if (Array.isArray(value)) {
    for (const entry of value) visitOne(entry);
    return;
  }
  if (Array.isArray(value.tasks)) for (const entry of value.tasks) visitOne(entry);
  if (Array.isArray(value.taskDetails)) for (const entry of value.taskDetails) visitOne(entry);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "tasks" || key === "taskDetails" || key === "comments") continue;
    visitOne(entry);
  }
}

function loadReadmes(value) {
  if (!value) return [];
  const rows = [];
  const push = (projectId, entry) => {
    if (entry == null) return;
    let content = "";
    let createdAt = null;
    let updatedAt = null;
    if (typeof entry === "string") {
      content = entry;
    } else if (typeof entry === "object" && !Array.isArray(entry)) {
      content = String(entry.content ?? entry.body ?? entry.readme ?? entry.markdown ?? "");
      createdAt = entry.created_at ?? entry.createdAt ?? null;
      updatedAt = entry.updated_at ?? entry.updatedAt ?? createdAt;
      projectId = entry.project_id ?? entry.projectId ?? projectId;
    } else {
      return;
    }
    if (!projectId) return;
    const id = String(projectId);
    rows.push({
      id,
      project_id: id,
      content,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  };
  if (Array.isArray(value)) {
    for (const entry of value) push(entry?.project_id ?? entry?.projectId, entry);
    return rows;
  }
  if (Array.isArray(value.readmes)) return loadReadmes(value.readmes);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "readmes") continue;
    push(key, entry);
  }
  return rows;
}

function createsParentCycle(parentOf, source, target) {
  let cursor = source;
  const seen = new Set();
  while (cursor) {
    if (cursor === target || seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

function finalizeRelations(relations, tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  const projects = new Map(tasks.map((task) => [task.id, task.project_id]));
  const kept = [];
  const parentOf = new Map();
  let skipped = 0;
  for (const edge of relations) {
    if (!ids.has(edge.source_task_id) || !ids.has(edge.target_task_id)) {
      skipped += 1;
      continue;
    }
    const left = projects.get(edge.source_task_id);
    const right = projects.get(edge.target_task_id);
    if (!left || !right || left !== right) {
      skipped += 1;
      continue;
    }
    if (edge.relation_type === "parent") {
      if (parentOf.has(edge.target_task_id) && parentOf.get(edge.target_task_id) !== edge.source_task_id) {
        skipped += 1;
        continue;
      }
      if (createsParentCycle(parentOf, edge.source_task_id, edge.target_task_id)) {
        skipped += 1;
        continue;
      }
      parentOf.set(edge.target_task_id, edge.source_task_id);
    }
    kept.push(edge);
  }
  return { relations: kept, skipped };
}

function countSide(snapshot) {
  return {
    projects: (snapshot?.projects ?? []).length,
    tasks: (snapshot?.tasks ?? []).length,
    comments: (snapshot?.comments ?? []).length,
    readmes: (snapshot?.readmes ?? []).length,
    relations: (snapshot?.relations ?? []).length,
  };
}

export function planImport({ local, cloud, decisions = null }) {
  const decisionSet = normalizeDecisions(decisions);
  const localProjects = cloneRows(local.projects);
  const cloudProjects = cloneRows(cloud.projects);
  const localTasks = cloneRows(local.tasks);
  const cloudTasks = cloneRows(cloud.tasks);
  const labelEffects = applyLabelMerges(
    [...localProjects, ...cloudProjects],
    [...localTasks, ...cloudTasks],
    decisionSet.mergeLabels,
  );
  const projects = mergeById("project", localProjects, cloudProjects, ["name", "labels"]);
  const taskMerge = mergeById("task", localTasks, cloudTasks, TASK_FIELDS);
  const commentMerge = mergeById("comment", cloneRows(local.comments), cloneRows(cloud.comments), ["body", "task_id"]);
  const readmeMerge = mergeById(
    "project_readme",
    cloneRows(local.readmes),
    cloneRows(cloud.readmes),
    ["content"],
  );
  const taskDecision = applyTaskDecisions(taskMerge.merged, decisionSet);
  const droppedCommentIds = new Set(
    commentMerge.merged.filter((comment) => taskDecision.droppedIds.has(comment.task_id)).map((comment) => comment.id),
  );
  const conflicts = [
    ...projects.conflicts,
    ...taskMerge.conflicts.filter((conflict) => !taskDecision.droppedIds.has(conflict.entityId)),
    ...commentMerge.conflicts.filter((conflict) => !droppedCommentIds.has(conflict.entityId)),
    ...readmeMerge.conflicts,
  ];
  const identifierCollisions = [];
  const groups = new Map();
  for (const task of taskDecision.tasks) {
    task.originalIdentifier = task.identifier;
    const list = groups.get(task.identifier) ?? [];
    list.push(task);
    groups.set(task.identifier, list);
  }
  for (const [identifier, group] of groups) {
    if (!identifier || group.length < 2) continue;
    group.sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""))
      || String(left.id).localeCompare(String(right.id)));
    for (const other of group.slice(1)) {
      const moved = `${identifier}#${String(other.id).replace(/-/g, "").slice(0, 8)}`;
      identifierCollisions.push({
        kind: "identifier_collision",
        identifier,
        keptTaskId: group[0].id,
        movedTaskId: other.id,
        storedIdentifier: moved,
        localTitle: group.find((item) => item.source !== "cloud")?.title ?? group[0].title,
        titles: group.map((item) => ({ id: item.id, title: item.title, source: item.source })),
      });
      other.identifier = moved;
      other.aliasOf = identifier;
    }
  }
  const duplicates = [];
  const byTitle = new Map();
  for (const task of taskDecision.tasks) {
    const key = `${projectName(projects.merged, task.project_id).trim().toLowerCase()}|${task.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (!task.title.trim()) continue;
    const list = byTitle.get(key) ?? [];
    list.push(task);
    byTitle.set(key, list);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const identifiers = new Set(group.map((task) => task.originalIdentifier));
    const ids = new Set(group.map((task) => task.id));
    if (identifiers.size < 2 || ids.size < 2) continue;
    duplicates.push({
      kind: "possible_duplicate",
      title: group[0].title,
      projectId: group[0].project_id,
      tasks: group.map((task) => ({
        id: task.id,
        identifier: task.originalIdentifier,
        storedIdentifier: task.identifier,
      })),
    });
  }
  const prefixOwners = new Map();
  for (const project of projects.merged) {
    const prefix = (project.identifier_prefix || legacyPrefix(project)).toUpperCase();
    const list = prefixOwners.get(prefix) ?? [];
    list.push({ id: project.id, name: project.name });
    prefixOwners.set(prefix, list);
  }
  const sharedPrefixes = [...prefixOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([prefix, owners]) => ({ kind: "shared_prefix", prefix, projects: owners }));
  const relationPool = dedupeRelations([...(local.relations ?? []), ...(cloud.relations ?? [])]);
  for (const effect of taskDecision.effects) {
    if (effect.action !== "dropTaskIds") continue;
    effect.commentsRemoved = commentMerge.merged.filter((comment) => comment.task_id === effect.taskId).length;
    effect.relationsRemoved = relationPool.filter((edge) => (
      edge.source_task_id === effect.taskId || edge.target_task_id === effect.taskId
    )).length;
  }
  const liveIds = new Set(taskDecision.tasks.map((task) => task.id));
  const comments = [];
  let commentsSkipped = 0;
  let commentsRemovedByDrop = 0;
  for (const comment of commentMerge.merged) {
    if (taskDecision.droppedIds.has(comment.task_id)) {
      commentsRemovedByDrop += 1;
      continue;
    }
    if (!liveIds.has(comment.task_id)) {
      commentsSkipped += 1;
      continue;
    }
    comments.push(comment);
  }
  const finalized = finalizeRelations(relationPool, taskDecision.tasks);
  const keptProjectIds = new Set(projects.merged.map((project) => project.id).filter((id) => id && id !== "local"));
  const readmes = readmeMerge.merged.filter((readme) => keptProjectIds.has(readme.project_id));
  return {
    projects: projects.merged,
    tasks: taskDecision.tasks,
    comments,
    readmes,
    relations: finalized.relations,
    conflicts,
    identifierCollisions,
    possibleDuplicates: duplicates,
    sharedPrefixes,
    decisions: [...taskDecision.effects, ...labelEffects],
    relationsSkipped: finalized.skipped,
    commentsSkipped,
    commentsRemovedByDrop,
    counts: {
      local: countSide(local),
      cloud: countSide(cloud),
      merged: {
        projects: projects.merged.length,
        tasks: taskDecision.tasks.length,
        comments: comments.length,
        readmes: readmes.length,
        relations: finalized.relations.length,
      },
      relationsSkipped: finalized.skipped,
      commentsSkipped,
      commentsRemovedByDrop,
    },
  };
}

function readJson(directory, name) {
  try {
    return JSON.parse(readFileSync(path.join(directory, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function loadJsonBackup(directory) {
  const projects = asArray(readJson(directory, "projects.json"), ["projects"]).map(normalizeProject);
  const detail = readJson(directory, "task_details.json");
  const tasks = [
    ...asArray(readJson(directory, "tasks.json"), ["tasks"]),
    ...asArray(detail, ["tasks", "taskDetails"]),
  ].map(normalizeTask).filter((task) => task.id && task.id !== "undefined");
  const taskMap = new Map();
  for (const task of tasks) taskMap.set(task.id, { ...taskMap.get(task.id), ...task });
  const comments = flattenComments(readJson(directory, "comments.json")).map(normalizeComment);
  const relationBucket = new Map();
  absorbTree(readJson(directory, "task_trees_descendants_depth1.json"), relationBucket, null);
  eachDetail(detail, (entry) => {
    const task = entry.task && typeof entry.task === "object" ? entry.task : entry;
    const normalized = normalizeTask(task);
    if (normalized.id && normalized.id !== "undefined") {
      taskMap.set(normalized.id, { ...taskMap.get(normalized.id), ...normalized });
    }
    if (Array.isArray(entry.comments)) comments.push(...flattenComments(entry.comments, normalized.id).map(normalizeComment));
    if (task !== entry && Array.isArray(task.comments)) {
      comments.push(...flattenComments(task.comments, normalized.id).map(normalizeComment));
    }
    if (entry.relations) addRelationsObject(relationBucket, normalized.id, entry.relations);
    if (task !== entry && task.relations) addRelationsObject(relationBucket, normalized.id, task.relations);
  });
  const commentMap = new Map();
  for (const comment of comments) {
    if (!comment.id || comment.id === "undefined") continue;
    commentMap.set(comment.id, { ...commentMap.get(comment.id), ...comment });
  }
  return {
    projects,
    tasks: [...taskMap.values()],
    comments: [...commentMap.values()],
    readmes: loadReadmes(readJson(directory, "project_readmes.json")),
    relations: [...relationBucket.values()],
    manifest: readJson(directory, "manifest.json"),
  };
}

function tableNames(database) {
  return new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
}

function readTable(database, tables, table, columns) {
  if (!tables.has(table)) return [];
  const present = new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
  const selected = columns.filter((column) => present.has(column));
  if (selected.length === 0) return [];
  const rows = database.prepare(`SELECT ${selected.map((column) => `"${column}"`).join(", ")} FROM "${table}"`).all();
  return rows.map((row) => {
    const full = {};
    for (const column of columns) full[column] = Object.hasOwn(row, column) ? row[column] : null;
    return full;
  });
}

export function loadLocalSnapshot(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = tableNames(database);
    const projects = readTable(database, tables, "projects", LOCAL_COLUMNS.projects);
    const tasks = readTable(database, tables, "tasks", LOCAL_COLUMNS.tasks);
    const comments = readTable(database, tables, "comments", LOCAL_COLUMNS.comments);
    const readmes = readTable(database, tables, "project_readmes", LOCAL_COLUMNS.project_readmes).map((row) => ({
      id: row.project_id,
      project_id: row.project_id,
      content: row.content ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    const relations = dedupeRelations(readTable(database, tables, "task_relations", LOCAL_COLUMNS.task_relations));
    return { projects, tasks, comments, readmes, relations };
  } finally {
    database.close();
  }
}

export function applyImport(targetPath, plan) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const board = new TaskboardDatabase(targetPath);
  const database = board.database;
  const timestamp = "2026-01-01T00:00:00.000Z";
  const projectIds = new Set();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const project of plan.projects) {
      if (!project.id || project.id === "local") continue;
      projectIds.add(project.id);
      database.prepare(`
        INSERT INTO projects (
          id, name, workspace_path, start_date, labels, identifier_prefix, next_task_number, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          identifier_prefix = excluded.identifier_prefix,
          updated_at = excluded.updated_at
      `).run(
        project.id,
        project.name,
        project.start_date,
        typeof project.labels === "string" ? project.labels : JSON.stringify(project.labels ?? []),
        project.identifier_prefix,
        project.created_at ?? timestamp,
        project.updated_at ?? timestamp,
      );
    }
    const taskIds = new Set();
    for (const task of plan.tasks) {
      taskIds.add(task.id);
      database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels, sort_order,
          creator_type, creator_id, creator_name, assignee_type, assignee_id, assignee_name,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 'import', 'Import', 'user', 'import', 'Import', ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          identifier = excluded.identifier,
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          labels = excluded.labels,
          archived_at = excluded.archived_at,
          updated_at = excluded.updated_at
      `).run(
        task.id,
        task.identifier,
        task.project_id,
        task.title,
        task.description ?? "",
        task.status ?? "backlog",
        task.priority ?? "none",
        typeof task.labels === "string" ? task.labels : "[]",
        task.sort_order ?? 1000,
        task.archived_at,
        task.created_at ?? timestamp,
        task.updated_at ?? timestamp,
      );
      if (task.aliasOf) {
        database.prepare(`
          INSERT INTO identifier_aliases (alias, task_id, stored_identifier, reason, created_at)
          VALUES (?, ?, ?, 'identifier_collision', ?)
          ON CONFLICT(alias, task_id) DO NOTHING
        `).run(task.aliasOf, task.id, task.identifier, timestamp);
      }
    }
    for (const readme of plan.readmes ?? []) {
      if (!projectIds.has(readme.project_id)) continue;
      database.prepare(`
        INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at
      `).run(
        readme.project_id,
        readme.content ?? "",
        readme.created_at ?? timestamp,
        readme.updated_at ?? readme.created_at ?? timestamp,
      );
    }
    for (const comment of plan.comments) {
      if (!taskIds.has(comment.task_id)) continue;
      database.prepare(`
        INSERT INTO comments (
          id, task_id, body, author_type, author_id, author_name, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
      `).run(
        comment.id,
        comment.task_id,
        comment.body,
        comment.author_type ?? "user",
        comment.author_id ?? "import",
        comment.author_name ?? "Import",
        comment.created_at ?? timestamp,
        comment.updated_at ?? comment.created_at ?? timestamp,
      );
    }
    for (const edge of plan.relations ?? []) {
      if (!taskIds.has(edge.source_task_id) || !taskIds.has(edge.target_task_id)) continue;
      database.prepare(`
        INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(relation_type, source_task_id, target_task_id) DO NOTHING
      `).run(
        edge.relation_type,
        edge.source_task_id,
        edge.target_task_id,
        edge.origin === "mention" ? "mention" : "manual",
        edge.created_at ?? timestamp,
      );
    }
    for (const conflict of plan.conflicts ?? []) {
      if (!conflict.entityId || !conflict.field) continue;
      database.prepare(`
        INSERT INTO sync_conflicts (
          id, entity_type, entity_id, field,
          local_value_json, local_hlc, local_device,
          remote_value_json, remote_hlc, remote_device,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, 'cloud', 'open', ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        `import|${conflict.entityType}|${conflict.entityId}|${conflict.field}`,
        conflict.entityType,
        conflict.entityId,
        conflict.field,
        encodeValue(conflict.local ?? null),
        formatHlc(1, 0, "import-local"),
        encodeValue(conflict.cloud ?? null),
        formatHlc(2, 0, "import-cloud"),
        timestamp,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    board.close();
    throw error;
  }
  board.close();
}

export function importSeed({ localPath = null, backupDir = null, targetPath, apply = false, decisions = null }) {
  const empty = { projects: [], tasks: [], comments: [], readmes: [], relations: [] };
  const local = localPath ? loadLocalSnapshot(localPath) : empty;
  const cloud = backupDir ? loadJsonBackup(backupDir) : empty;
  const plan = planImport({ local, cloud, decisions });
  const report = {
    dryRun: !apply,
    counts: plan.counts,
    manifest: cloud.manifest ?? null,
    conflicts: plan.conflicts,
    identifierCollisions: plan.identifierCollisions,
    possibleDuplicates: plan.possibleDuplicates,
    sharedPrefixes: plan.sharedPrefixes,
    decisions: plan.decisions,
    relationsSkipped: plan.relationsSkipped,
    commentsSkipped: plan.commentsSkipped,
    commentsRemovedByDrop: plan.commentsRemovedByDrop,
  };
  if (apply) {
    if (!targetPath) throw new Error("targetPath is required when apply is true");
    applyImport(targetPath, plan);
    report.targetPath = targetPath;
  }
  return report;
}
