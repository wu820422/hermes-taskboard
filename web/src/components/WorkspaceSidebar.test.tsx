import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar", () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
  });

  it("shows domain sections and project titles instead of internal ids", () => {
    render(
      <WorkspaceSidebar
        projects={[
          { id: "chargespot-design-leo", name: "CHARGESPOT 設計需求", labels: [], issueCount: 3, startDate: "2026-07-25" },
          { id: "private-1", name: "我的私人研究", labels: ["domain:personal"], issueCount: 2, startDate: "2026-08-01" },
        ]}
        activeDomain="chargespot"
        selectedProjectId="chargespot-design-leo"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={vi.fn()}
        onSelectProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("complementary", { name: "任務面板" })).toBeTruthy();
    expect(screen.getAllByText("CHARGESPOT 公司專案").length).toBeGreaterThan(0);
    expect(screen.getAllByText("我的私人專案").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "CHARGESPOT 設計需求" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的私人研究" })).toBeTruthy();
    expect(screen.queryByText("chargespot-design-leo")).toBeNull();
  });

  it("marks the active project and keeps all projects as a real navigation target", () => {
    const onSelectAllProjects = vi.fn();
    render(
      <WorkspaceSidebar
        projects={[{ id: "p1", name: "專案一", labels: [], issueCount: 1, startDate: null }]}
        activeDomain="personal"
        selectedProjectId="__all_projects__"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={onSelectAllProjects}
        onSelectProject={vi.fn()}
      />,
    );

    const allProjects = screen.getByRole("button", { name: /全部私人任務/ });
    expect(allProjects.getAttribute("aria-current")).toBe("page");
    allProjects.click();
    expect(onSelectAllProjects).toHaveBeenCalledTimes(1);
  });
  it("groups by live task state and shows open-work counts when task stats are provided", () => {
    const stats = {
      active: { total: 3, open: 2, backlog: 0, todo: 0, inProgress: 1, inReview: 1, blocked: 0, done: 1, canceled: 0, lastActivityAt: "2026-09-30" },
      finished: { total: 2, open: 0, backlog: 0, todo: 0, inProgress: 0, inReview: 0, blocked: 0, done: 2, canceled: 0, lastActivityAt: "2026-09-01" },
    };
    const { container } = render(
      <WorkspaceSidebar
        projects={[
          { id: "active", name: "進行案", labels: [], issueCount: 3, startDate: "2026-09-01" },
          { id: "finished", name: "做完案", labels: ["hermes-active"], issueCount: 2, startDate: "2026-08-01" },
          { id: "closed", name: "結案", labels: ["lifecycle:completed"], issueCount: 1, startDate: "2026-07-01" },
        ]}
        activeDomain="personal"
        selectedProjectId="__all_projects__"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={vi.fn()}
        onSelectProject={vi.fn()}
        taskStats={stats}
      />,
    );
    const view = within(container);
    expect(view.getByText("2026-09-01 · 處理中 1 · 待確認 1")).toBeTruthy();
    expect(view.getByText("2026-08-01 · 2 項已完成")).toBeTruthy();
    expect(view.getByText("待定下一步／待結案")).toBeTruthy();
    const completed = container.querySelector("details.sidebar-project-group-completed");
    expect(completed).toBeTruthy();
    expect(completed?.hasAttribute("open")).toBe(false);
    expect(view.getByRole("button", { name: /全部私人任務/ }).textContent).toContain("2");
  });

  it("collapses to a rail and expands again", () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <WorkspaceSidebar
        projects={[{ id: "p1", name: "專案一", labels: [] }]}
        activeDomain="personal"
        selectedProjectId="p1"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={vi.fn()}
        onSelectProject={vi.fn()}
        onToggleCollapsed={onToggle}
      />,
    );
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "收合左側面板" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <WorkspaceSidebar
        projects={[{ id: "p1", name: "專案一", labels: [] }]}
        activeDomain="personal"
        selectedProjectId="p1"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={vi.fn()}
        onSelectProject={vi.fn()}
        onToggleCollapsed={onToggle}
        collapsed
      />,
    );
    expect(view.queryByRole("button", { name: "專案一" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "展開左側面板" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("lets every section collapse and remembers the choice", () => {
    const stats = {
      a: { total: 1, open: 1, backlog: 0, todo: 0, inProgress: 1, inReview: 0, blocked: 0, done: 0, canceled: 0, lastActivityAt: null },
      b: { total: 1, open: 0, backlog: 0, todo: 0, inProgress: 0, inReview: 0, blocked: 0, done: 1, canceled: 0, lastActivityAt: null },
    };
    const props = {
      projects: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
      activeDomain: "personal" as const,
      selectedProjectId: "__all_projects__",
      allProjectsId: "__all_projects__",
      onSelectDomain: vi.fn(),
      onSelectAllProjects: vi.fn(),
      onSelectProject: vi.fn(),
      taskStats: stats,
    };
    const first = render(<WorkspaceSidebar {...props} />);
    const inProgress = first.container.querySelector("details.sidebar-project-group-in-progress") as HTMLDetailsElement;
    expect(inProgress.open).toBe(true);
    inProgress.open = false;
    fireEvent(inProgress, new Event("toggle"));
    first.unmount();
    const second = render(<WorkspaceSidebar {...props} />);
    const again = second.container.querySelector("details.sidebar-project-group-in-progress") as HTMLDetailsElement;
    expect(again.open).toBe(false);
    second.unmount();
  });

  it("opens a project options menu and applies the chosen grouping", async () => {
    const onSetProjectMeta = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <WorkspaceSidebar
        projects={[{ id: "p1", name: "專案一", labels: ["lifecycle:paused"] }]}
        activeDomain="personal"
        selectedProjectId="__all_projects__"
        allProjectsId="__all_projects__"
        onSelectDomain={vi.fn()}
        onSelectAllProjects={vi.fn()}
        onSelectProject={vi.fn()}
        onSetProjectMeta={onSetProjectMeta}
      />,
    );
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "專案選項：專案一" }));
    const menu = view.getByRole("menu", { name: "專案選項：專案一" });
    expect(within(menu).getByRole("menuitemradio", { name: /擱置/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemradio", { name: /我的私人專案/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /已完成/ }));
    expect(onSetProjectMeta).toHaveBeenCalledWith("p1", "lifecycle", "completed");
    await vi.waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  });
});
