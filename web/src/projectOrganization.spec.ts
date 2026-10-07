import { describe, expect, it } from "vitest";
import {
  buildProjectTaskStats, groupProjects, isScheduleProject, projectMetaLabelChanges, projectSection, projectStartDate, projectStatsSummary,
  projectDomain, tasksForDomain,
} from "./projectOrganization";

describe("project organization", () => {
  it("uses explicit company identities without classifying unrelated names as company", () => {
    expect(projectDomain({ id: "chargespot-design-leo", name: "設計需求" })).toBe("chargespot");
    expect(projectDomain({ id: "2026-07-mkt-dashboard-4d78e6bd", name: "儀表板" })).toBe("chargespot");
    expect(projectDomain({ id: "unrelated", name: "CHARGESPOT 參考研究" })).toBe("personal");
    expect(projectDomain({ id: "new", name: "新案件", labels: ["domain:chargespot"] })).toBe("chargespot");
    expect(projectDomain({ id: "hermes-system", name: "Hermes System" })).toBe("personal");
  });

  it("keeps company and personal task collections disjoint and hides unresolved projects", () => {
    const projects = [{ id: "chargespot-design-leo", name: "公司" }, { id: "private", name: "私人" }];
    const tasks = [{ id: "a", projectId: "chargespot-design-leo" }, { id: "b", projectId: "private" },
      { id: "c", projectId: "not-loaded" }];
    expect(tasksForDomain(tasks, projects, "chargespot").map(t => t.id)).toEqual(["a"]);
    expect(tasksForDomain(tasks, projects, "personal").map(t => t.id)).toEqual(["b"]);
  });
  it("keeps systems separate from production projects and puts temporary imports in review", () => {
    expect(projectSection({ id: "hermes-system", name: "Hermes System" })).toBe("system");
    expect(projectSection({ id: "2026-08-21-yt-0a4d7eb2", name: "2026-08-21_賽特之眼-YT廣告", labels: ["hermes-active"] })).toBe("in-progress");
    expect(projectSection({ id: "temp-123", name: "賽特外掛" })).toBe("to-sort");
    expect(projectSection({ id: "2026-07-26_Hermes-Agen-架構遷移", name: "架構遷移", labels: ["hermes-cancelled"] })).toBe("archived");
  });

  it("uses canonical identity dates instead of import timestamps", () => {
    expect(projectStartDate({ id: "2026-08-27-dashi-taskboard-e0d85e33", startDate: "2026-08-27" })).toBe("2026-08-27");
    expect(projectStartDate({ id: "2026-07-mkt-dashboard-4d78e6bd", startDate: null })).toBe("2026-07-01");
  });

  it("renders every non-empty section in date order", () => {
    const sections = groupProjects([
      { id: "2026-08-01-a", name: "A", startDate: "2026-08-01" },
      { id: "2026-08-27-hermes-project-control-plane", name: "Hermes Project Control Plane", startDate: "2026-08-27" },
      { id: "2026-07-26_Hermes-Agen-架構遷移", name: "Legacy", labels: ["hermes-cancelled"], startDate: "2026-07-26" },
    ]);
    expect(sections.map((section) => section.id)).toEqual(["in-progress", "system", "archived"]);
    expect(sections[0].projects[0].name).toBe("A");
  });
  it("derives the section from live task state instead of stale import labels", () => {
    const stats = buildProjectTaskStats([
      { projectId: "done-project", status: "done" },
      { projectId: "done-project", status: "canceled" },
      { projectId: "open-project", status: "done" },
      { projectId: "open-project", status: "in_review" },
      { projectId: "open-project", status: "blocked", archivedAt: "2026-09-01" },
    ]);
    expect(stats["done-project"]).toMatchObject({ total: 2, open: 0, done: 1, canceled: 1 });
    expect(stats["open-project"]).toMatchObject({ total: 2, open: 1, inReview: 1, blocked: 0 });
    const stale = { id: "2026-08-21-yt-0a4d7eb2", name: "賽特之眼", labels: ["hermes-active"] };
    expect(projectSection(stale, stats["done-project"])).toBe("needs-next");
    expect(projectSection(stale, stats["open-project"])).toBe("in-progress");
    expect(projectSection({ id: "empty", name: "金盈匯" }, buildProjectTaskStats([])["empty"] ?? null)).toBe("in-progress");
    expect(projectSection({ id: "empty", name: "金盈匯" }, { ...stats["done-project"], total: 0, done: 0, canceled: 0 })).toBe("needs-next");
  });

  it("lets explicit lifecycle and kind labels override derived state", () => {
    const open = buildProjectTaskStats([{ projectId: "p", status: "in_progress" }])["p"];
    expect(projectSection({ id: "p", name: "P", labels: ["lifecycle:paused"] }, open)).toBe("on-hold");
    expect(projectSection({ id: "p", name: "P", labels: ["lifecycle:completed"] }, open)).toBe("completed");
    expect(projectSection({ id: "p", name: "P", labels: ["lifecycle:cancelled"] }, open)).toBe("archived");
    expect(projectSection({ id: "p", name: "P", labels: ["kind:system"] }, open)).toBe("system");
    expect(projectSection({ id: "hermes-system", name: "Hermes System", labels: ["kind:project"] }, open)).toBe("in-progress");
  });

  it("no longer files business projects under systems by name", () => {
    expect(projectSection({ id: "2026-07-22-threads-grow-4f734603", name: "2026-07-22_threads-grow" })).toBe("in-progress");
    expect(projectSection({ id: "2026-07-26-futu-price-action-10fb9663", name: "2026-07-26_Futu-Price-Action" })).toBe("in-progress");
    expect(projectSection({ id: "2026-07-mkt-dashboard-4d78e6bd", name: "2026-07-mkt-dashboard優化" })).toBe("in-progress");
    expect(projectSection({ id: "hermes-automation-schedules", name: "Hermes 自動化排程" })).toBe("system");
    expect(isScheduleProject({ id: "hermes-automation-schedules", name: "Hermes 自動化排程" })).toBe(true);
    expect(isScheduleProject({ id: "x", name: "X", labels: ["kind:schedule"] })).toBe(true);
    expect(isScheduleProject({ id: "dashi-taskboard", name: "dashi-taskboard" })).toBe(false);
  });

  it("summarises open work for the sidebar and orders by latest activity", () => {
    const stats = buildProjectTaskStats([
      { projectId: "a", status: "in_progress", updatedAt: "2026-09-01T00:00:00Z" },
      { projectId: "a", status: "in_review", updatedAt: "2026-09-02T00:00:00Z" },
      { projectId: "b", status: "blocked", updatedAt: "2026-09-30T00:00:00Z" },
      { projectId: "c", status: "done" },
    ]);
    expect(projectStatsSummary(stats.a)).toBe("處理中 1 · 待確認 1");
    expect(projectStatsSummary(stats.c)).toBe("1 項已完成");
    expect(projectStatsSummary(undefined)).toBe("無任務");
    expect(projectStatsSummary({ ...stats.c, done: 0, canceled: 2, total: 2 })).toBe("2 項取消");
    const sections = groupProjects([
      { id: "a", name: "A", startDate: "2026-09-10" },
      { id: "b", name: "B", startDate: "2026-08-01" },
      { id: "c", name: "C", startDate: "2026-09-20" },
    ], stats);
    expect(sections.map((section) => section.id)).toEqual(["in-progress", "needs-next"]);
    expect(sections[0].projects.map((project) => project.id)).toEqual(["b", "a"]);
  });

  it("computes label changes for project options and pins lifecycle:active to 進行中", () => {
    const project = { id: "p", name: "P", labels: ["缺陷", "lifecycle:paused", "domain:personal"] };
    expect(projectMetaLabelChanges(project, "lifecycle", "completed")).toEqual({ remove: ["lifecycle:paused"], add: ["lifecycle:completed"] });
    expect(projectMetaLabelChanges(project, "lifecycle", null)).toEqual({ remove: ["lifecycle:paused"], add: [] });
    expect(projectMetaLabelChanges(project, "domain", "personal")).toEqual({ remove: [], add: [] });
    expect(projectMetaLabelChanges(project, "kind", "system")).toEqual({ remove: [], add: ["kind:system"] });
    const done = buildProjectTaskStats([{ projectId: "p", status: "done" }])["p"];
    expect(projectSection({ id: "p", name: "P", labels: ["lifecycle:active"] }, done)).toBe("in-progress");
  });
});
