import type { Project, TaskStatus } from "./types";

export type ProjectSectionId =
  | "in-progress"
  | "needs-next"
  | "on-hold"
  | "system"
  | "to-sort"
  | "completed"
  | "archived";
export type ProjectDomain = "chargespot" | "personal";

// Explicit project metadata lives in namespaced project labels so it syncs with
// the existing local SQLite / cloud D1 schema without a migration:
//   domain:chargespot | domain:personal
//   kind:system | kind:schedule | kind:project
//   lifecycle:active | lifecycle:paused | lifecycle:completed | lifecycle:cancelled
export const PROJECT_META_LABEL_PREFIXES = ["domain:", "kind:", "lifecycle:"] as const;

export function isProjectMetaLabel(label: string): boolean {
  return PROJECT_META_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

const CHARGESPOT_PROJECT_IDS = new Set([
  "chargespot-design-leo",
  "2026-07-21-chargespot-creative-canvas-9bf4f4ee",
  "2026-07-25-chargespot-30-4dd5b18d",
  "2026-08-04-chargespot-2026-6e6d888a",
  "2026-07-mkt-dashboard-4d78e6bd",
]);

// Fallback for projects that do not carry kind:* yet. Only Hermes / Taskboard
// infrastructure belongs here; production and research projects do not.
const SYSTEM_PROJECT_IDS = new Set([
  "dashi-taskboard",
  "hermes-system",
  "hermes-automation-schedules",
  "hermes-knowledge-skill-review",
  "2026-08-27-hermes-project-control-plane",
  "2026-08-27-dashi-taskboard-e0d85e33",
  "2026-08-01-hermes-50e9290a",
]);

const SCHEDULE_PROJECT_IDS = new Set(["hermes-automation-schedules"]);

export function projectDomain(project: ProjectOrganizationInput): ProjectDomain {
  if (project.labels?.includes("domain:personal")) return "personal";
  return project.labels?.includes("domain:chargespot") || CHARGESPOT_PROJECT_IDS.has(project.id)
    ? "chargespot" : "personal";
}

export function tasksForDomain<T extends { projectId: string }>(
  tasks: T[], projects: ProjectOrganizationInput[], domain: ProjectDomain,
): T[] {
  const ids = new Set(projects.filter(project => projectDomain(project) === domain).map(project => project.id));
  return tasks.filter(task => ids.has(task.projectId));
}

export interface ProjectOrganizationInput {
  id: string;
  name: string;
  labels?: string[];
  startDate?: string | null;
}

export interface ProjectSection {
  id: ProjectSectionId;
  label: string;
}

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  { id: "in-progress", label: "進行中" },
  { id: "needs-next", label: "待定下一步／待結案" },
  { id: "on-hold", label: "擱置" },
  { id: "to-sort", label: "待整理" },
  { id: "system", label: "系統與工具" },
  { id: "completed", label: "已完成" },
  { id: "archived", label: "封存" },
];

export interface ProjectTaskStats {
  total: number;
  open: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  blocked: number;
  done: number;
  canceled: number;
  lastActivityAt: string | null;
}

export type ProjectTaskStatsMap = Record<string, ProjectTaskStats>;

const OPEN_STATUSES = new Set<TaskStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export function emptyProjectTaskStats(): ProjectTaskStats {
  return {
    total: 0, open: 0, backlog: 0, todo: 0, inProgress: 0, inReview: 0, blocked: 0, done: 0, canceled: 0,
    lastActivityAt: null,
  };
}

export function buildProjectTaskStats(
  tasks: Array<{ projectId: string; status: TaskStatus; archivedAt?: string | null; updatedAt?: string; activityUpdatedAt?: string | null }>,
): ProjectTaskStatsMap {
  const stats: ProjectTaskStatsMap = {};
  for (const task of tasks) {
    if (task.archivedAt) continue;
    const entry = stats[task.projectId] ??= emptyProjectTaskStats();
    entry.total += 1;
    if (OPEN_STATUSES.has(task.status)) entry.open += 1;
    switch (task.status) {
      case "backlog": entry.backlog += 1; break;
      case "todo": entry.todo += 1; break;
      case "in_progress": entry.inProgress += 1; break;
      case "in_review": entry.inReview += 1; break;
      case "blocked": entry.blocked += 1; break;
      case "done": entry.done += 1; break;
      case "canceled": entry.canceled += 1; break;
    }
    const activity = task.activityUpdatedAt ?? task.updatedAt ?? null;
    if (activity && (!entry.lastActivityAt || activity > entry.lastActivityAt)) entry.lastActivityAt = activity;
  }
  return stats;
}

function labelValue(project: ProjectOrganizationInput, prefix: string): string | null {
  const label = project.labels?.find((candidate) => candidate.startsWith(prefix));
  return label ? label.slice(prefix.length) : null;
}

export type ProjectMetaKey = "domain" | "kind" | "lifecycle";

/** Explicit value of a namespaced project option, or null when it is left automatic. */
export function projectMetaValue(project: ProjectOrganizationInput, key: ProjectMetaKey): string | null {
  return labelValue(project, `${key}:`);
}

/** Labels to remove and add so that `key` ends up as `value` (null = back to automatic). */
export function projectMetaLabelChanges(
  project: ProjectOrganizationInput,
  key: ProjectMetaKey,
  value: string | null,
): { remove: string[]; add: string[] } {
  const prefix = `${key}:`;
  const target = value ? `${prefix}${value}` : null;
  const remove = (project.labels ?? []).filter((label) => label.startsWith(prefix) && label !== target);
  const add = target && !(project.labels ?? []).includes(target) ? [target] : [];
  return { remove, add };
}

export function isSystemProject(project: ProjectOrganizationInput): boolean {
  const kind = labelValue(project, "kind:");
  if (kind) return kind === "system" || kind === "schedule";
  return SYSTEM_PROJECT_IDS.has(project.id);
}

export function isScheduleProject(project: ProjectOrganizationInput): boolean {
  const kind = labelValue(project, "kind:");
  if (kind) return kind === "schedule";
  return SCHEDULE_PROJECT_IDS.has(project.id);
}

/**
 * Section precedence:
 * 1. unsorted containers (global / temp imports)
 * 2. explicit lifecycle:* label (Leo's decision, mirrors Vault INDEX)
 * 3. kind:system (infrastructure stays together whatever its task state); lifecycle:active pins 進行中
 * 4. legacy import snapshot labels for closed projects
 * 5. derived from live task state: open work → 進行中, none → 待定下一步／待結案
 */
export function projectSection(
  project: ProjectOrganizationInput,
  stats?: ProjectTaskStats | null,
): ProjectSectionId {
  if (project.id === "local" || project.id.startsWith("temp-")) return "to-sort";
  const lifecycle = labelValue(project, "lifecycle:");
  if (lifecycle === "cancelled" || lifecycle === "canceled" || lifecycle === "archived") return "archived";
  if (lifecycle === "completed") return "completed";
  if (lifecycle === "paused") return "on-hold";
  if (isSystemProject(project)) return "system";
  if (lifecycle === "active") return "in-progress";
  if (!lifecycle) {
    if (project.labels?.includes("hermes-cancelled")) return "archived";
    if (project.labels?.includes("hermes-completed")) return "completed";
  }
  if (!stats) return "in-progress";
  return stats.open > 0 ? "in-progress" : "needs-next";
}

export function projectSectionLabel(sectionId: ProjectSectionId): string {
  return PROJECT_SECTIONS.find((section) => section.id === sectionId)?.label ?? "待整理";
}

export function projectStartDate(project: Pick<Project, "startDate" | "id">): string | null {
  if (project.startDate) return project.startDate;
  const match = project.id.match(/^(\d{4}-\d{2}(?:-\d{2})?)/);
  if (!match) return null;
  return match[1].length === 7 ? `${match[1]}-01` : match[1];
}

function startDateOf(project: ProjectOrganizationInput): string {
  return projectStartDate(project as Pick<Project, "startDate" | "id">) ?? "0000-00-00";
}

export function sortProjectsForSection<T extends ProjectOrganizationInput>(
  projects: T[],
  stats?: ProjectTaskStatsMap,
): T[] {
  return [...projects].sort((left, right) => (
    (stats?.[right.id]?.lastActivityAt ?? "").localeCompare(stats?.[left.id]?.lastActivityAt ?? "")
    || startDateOf(right).localeCompare(startDateOf(left))
    || left.name.localeCompare(right.name, "zh-Hant")
    || left.id.localeCompare(right.id)
  ));
}

export function groupProjects<T extends ProjectOrganizationInput>(projects: T[], stats?: ProjectTaskStatsMap) {
  return PROJECT_SECTIONS.map((section) => ({
    ...section,
    projects: sortProjectsForSection(
      projects.filter((project) => projectSection(project, stats ? stats[project.id] ?? emptyProjectTaskStats() : null) === section.id),
      stats,
    ),
  })).filter((section) => section.projects.length > 0);
}

/** Short, human summary of what is still open in a project. */
export function projectStatsSummary(stats: ProjectTaskStats | null | undefined): string {
  if (!stats || stats.total === 0) return "無任務";
  if (stats.open === 0) {
    const closed: string[] = [];
    if (stats.done) closed.push(`${stats.done} 項已完成`);
    if (stats.canceled) closed.push(`${stats.canceled} 項取消`);
    return closed.join(" · ");
  }
  const parts: string[] = [];
  if (stats.inProgress) parts.push(`處理中 ${stats.inProgress}`);
  if (stats.inReview) parts.push(`待確認 ${stats.inReview}`);
  if (stats.blocked) parts.push(`阻礙 ${stats.blocked}`);
  const queued = stats.backlog + stats.todo;
  if (queued) parts.push(`待辦 ${queued}`);
  return parts.join(" · ");
}
