import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  groupProjects,
  projectDomain,
  projectMetaValue,
  projectStartDate,
  projectStatsSummary,
  type ProjectDomain,
  type ProjectMetaKey,
  type ProjectSectionId,
  type ProjectTaskStatsMap,
} from "../projectOrganization";
import { taskboardStorage } from "../storage";
import type { Project } from "../types";
import { TaskboardIcon } from "./TaskboardIcon";

type SidebarProject = Pick<Project, "id" | "name"> & Partial<Pick<Project, "labels" | "issueCount" | "startDate">>;

interface WorkspaceSidebarProps {
  projects: SidebarProject[];
  activeDomain: ProjectDomain;
  selectedProjectId: string;
  allProjectsId: string;
  onSelectDomain: (domain: ProjectDomain) => void;
  onSelectAllProjects: (domain: ProjectDomain) => void;
  onSelectProject: (projectId: string) => void;
  /** Live per-project task counts. When absent the sidebar falls back to issueCount only. */
  taskStats?: ProjectTaskStatsMap;
  /** Whole sidebar collapsed to a thin rail. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Persist one project option (domain:/kind:/lifecycle:). value null clears it back to automatic. */
  onSetProjectMeta?: (projectId: string, key: ProjectMetaKey, value: string | null) => Promise<void>;
}

const DOMAIN_LABELS: Record<ProjectDomain, string> = {
  chargespot: "CHARGESPOT 公司專案",
  personal: "我的私人專案",
};

const DEFAULT_CLOSED_SECTIONS = new Set<ProjectSectionId>(["system", "completed", "archived"]);
const SECTION_STATE_KEY = "hermes-sidebar-sections";

interface MenuOption { key: ProjectMetaKey; value: string | null; label: string }
const MENU_GROUPS: Array<{ title: string; key: ProjectMetaKey; options: MenuOption[] }> = [
  {
    title: "分組",
    key: "lifecycle",
    options: [
      { key: "lifecycle", value: null, label: "自動（依任務狀態）" },
      { key: "lifecycle", value: "active", label: "進行中" },
      { key: "lifecycle", value: "paused", label: "擱置" },
      { key: "lifecycle", value: "completed", label: "已完成" },
      { key: "lifecycle", value: "cancelled", label: "封存" },
    ],
  },
  {
    title: "類型",
    key: "kind",
    options: [
      { key: "kind", value: null, label: "自動" },
      { key: "kind", value: "project", label: "一般專案" },
      { key: "kind", value: "system", label: "系統與工具" },
    ],
  },
  {
    title: "歸屬",
    key: "domain",
    options: [
      { key: "domain", value: "chargespot", label: "CHARGESPOT 公司專案" },
      { key: "domain", value: "personal", label: "我的私人專案" },
    ],
  },
];

function domainProjects(projects: SidebarProject[], domain: ProjectDomain) {
  return projects.filter((project) => projectDomain(project) === domain);
}

function readSectionState(): Record<string, boolean> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(SECTION_STATE_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function writeSectionState(value: Record<string, boolean>) {
  try {
    taskboardStorage.setItem(SECTION_STATE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep in-memory state only */
  }
}

function currentMetaValue(project: SidebarProject, key: ProjectMetaKey): string | null {
  if (key === "domain") return projectDomain(project);
  return projectMetaValue(project, key);
}

export function WorkspaceSidebar({
  projects,
  activeDomain,
  selectedProjectId,
  allProjectsId,
  onSelectDomain,
  onSelectAllProjects,
  onSelectProject,
  taskStats,
  collapsed = false,
  onToggleCollapsed,
  onSetProjectMeta,
}: WorkspaceSidebarProps) {
  const [sectionState, setSectionState] = useState<Record<string, boolean>>(readSectionState);
  const [menu, setMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    function close(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setMenu(null);
        return;
      }
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      setMenu(null);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const headerCount = (domain: ProjectDomain) => domainProjects(projects, domain).reduce(
    (sum, project) => sum + (taskStats ? taskStats[project.id]?.open ?? 0 : project.issueCount ?? 0),
    0,
  );

  function sectionOpen(domain: ProjectDomain, sectionId: ProjectSectionId, containsSelection: boolean) {
    const stored = sectionState[`${domain}:${sectionId}`];
    if (typeof stored === "boolean") return stored;
    return !DEFAULT_CLOSED_SECTIONS.has(sectionId) || containsSelection;
  }

  function setSectionOpen(domain: ProjectDomain, sectionId: ProjectSectionId, open: boolean) {
    setSectionState((current) => {
      if (current[`${domain}:${sectionId}`] === open) return current;
      const next = { ...current, [`${domain}:${sectionId}`]: open };
      writeSectionState(next);
      return next;
    });
  }

  function openMenu(projectId: string, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.type === "contextmenu" ? event.clientX : rect.right;
    const y = event.type === "contextmenu" ? event.clientY : rect.bottom;
    setMenu({ projectId, x: Math.min(x, window.innerWidth - 220), y: Math.min(y, window.innerHeight - 360) });
  }

  async function chooseMeta(option: MenuOption) {
    if (!menu || !onSetProjectMeta || savingMeta) return;
    setSavingMeta(true);
    try {
      await onSetProjectMeta(menu.projectId, option.key, option.value);
      setMenu(null);
    } catch {
      /* App surfaces the error banner */
    } finally {
      setSavingMeta(false);
    }
  }

  if (collapsed) {
    return (
      <aside className="app-nav taskboard-sidebar is-collapsed" aria-label="任務面板">
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label="展開左側面板"
          title="展開左側面板"
          aria-expanded="false"
          onClick={onToggleCollapsed}
        >
          <TaskboardIcon name="panel" />
        </button>
        <button
          className={`sidebar-rail-item${selectedProjectId === allProjectsId ? " active" : ""}`}
          type="button"
          aria-label={activeDomain === "chargespot" ? "CHARGESPOT 全部任務" : "全部私人任務"}
          title={activeDomain === "chargespot" ? "CHARGESPOT 全部任務" : "全部私人任務"}
          onClick={() => onSelectAllProjects(activeDomain)}
        >
          <TaskboardIcon name="home" />
        </button>
      </aside>
    );
  }

  const menuProject = menu ? projects.find((project) => project.id === menu.projectId) ?? null : null;

  return (
    <aside className="app-nav taskboard-sidebar" aria-label="任務面板">
      <div className="brand-row taskboard-sidebar-brand">
        <span className="brand-mark"><TaskboardIcon name="panel" /></span>
        <span>任務面板</span>
        {onToggleCollapsed && (
          <button
            className="sidebar-collapse-toggle"
            type="button"
            aria-label="收合左側面板"
            title="收合左側面板"
            aria-expanded="true"
            onClick={onToggleCollapsed}
          >
            ‹
          </button>
        )}
      </div>

      <nav className="primary-nav" aria-label="主要導覽">
        <button
          className={`nav-item${selectedProjectId === allProjectsId ? " active" : ""}`}
          type="button"
          aria-current={selectedProjectId === allProjectsId ? "page" : undefined}
          onClick={() => onSelectAllProjects(activeDomain)}
        >
          <span className="nav-glyph"><TaskboardIcon name="home" /></span>
          <span>{activeDomain === "chargespot" ? "CHARGESPOT 全部任務" : "全部私人任務"}</span>
          <span className="nav-count" title={taskStats ? "未完成任務數" : "任務數"}>{headerCount(activeDomain)}</span>
        </button>
      </nav>

      <div className="sidebar-domain-switcher" role="tablist" aria-label="專案歸屬">
        {(Object.keys(DOMAIN_LABELS) as ProjectDomain[]).map((domain) => {
          const count = domainProjects(projects, domain).length;
          return (
            <button
              key={domain}
              className={`sidebar-domain-tab${activeDomain === domain ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeDomain === domain}
              onClick={() => onSelectDomain(domain)}
            >
              <span>{DOMAIN_LABELS[domain]}</span>
              <small>{count}</small>
            </button>
          );
        })}
      </div>

      {(Object.keys(DOMAIN_LABELS) as ProjectDomain[]).map((domain) => {
        const grouped = groupProjects(domainProjects(projects, domain), taskStats);
        return (
          <section className={`project-nav sidebar-domain-section${activeDomain === domain ? " active" : ""}`} key={domain} aria-label={DOMAIN_LABELS[domain]}>
            <div className="nav-label">{DOMAIN_LABELS[domain]}</div>
            {grouped.map((section) => {
              const containsSelection = section.projects.some((project) => project.id === selectedProjectId);
              const sectionAttention = taskStats
                ? section.projects.reduce((sum, project) => sum + (taskStats[project.id]?.inReview ?? 0) + (taskStats[project.id]?.blocked ?? 0), 0)
                : 0;
              const items = section.projects.map((project) => {
                const stats = taskStats?.[project.id];
                const attention = stats ? stats.inReview + stats.blocked : 0;
                const date = projectStartDate({ id: project.id, startDate: project.startDate ?? null }) ?? "未設定日期";
                const meta = taskStats
                  ? `${date} · ${projectStatsSummary(stats)}`
                  : `${date}${(project.issueCount ?? 0) > 0 ? ` · ${project.issueCount} 項任務` : ""}`;
                return (
                  <div
                    className={`project-nav-row${menu?.projectId === project.id ? " is-menu-open" : ""}`}
                    key={project.id}
                    onContextMenu={onSetProjectMeta ? (event) => openMenu(project.id, event) : undefined}
                  >
                    <button
                      className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                      type="button"
                      aria-label={project.name}
                      aria-current={selectedProjectId === project.id ? "page" : undefined}
                      onClick={() => onSelectProject(project.id)}
                    >
                      <span className="project-dot" aria-hidden="true" />
                      <span className="project-nav-copy">
                        <span>{project.name}</span>
                        <small>{meta}</small>
                      </span>
                      {attention > 0 && (
                        <span
                          className={`project-attention${stats && stats.blocked > 0 ? " is-blocked" : ""}`}
                          title={`待確認 ${stats?.inReview ?? 0} · 阻礙 ${stats?.blocked ?? 0}`}
                        >
                          {attention}
                        </span>
                      )}
                    </button>
                    {onSetProjectMeta && (
                      <button
                        className="project-options-button"
                        type="button"
                        aria-label={`專案選項：${project.name}`}
                        title="專案選項"
                        aria-haspopup="menu"
                        aria-expanded={menu?.projectId === project.id}
                        onClick={(event) => (menu?.projectId === project.id ? setMenu(null) : openMenu(project.id, event))}
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                );
              });
              if (grouped.length <= 1) {
                return (
                  <div className={`sidebar-project-group sidebar-project-group-${section.id}`} key={`${domain}-${section.id}`}>
                    {items}
                  </div>
                );
              }
              const open = sectionOpen(domain, section.id, containsSelection);
              return (
                <details
                  className={`sidebar-project-group sidebar-project-group-${section.id}`}
                  key={`${domain}-${section.id}`}
                  open={open}
                  onToggle={(event) => {
                    const nowOpen = (event.currentTarget as HTMLDetailsElement).open;
                    if (nowOpen !== open) setSectionOpen(domain, section.id, nowOpen);
                  }}
                >
                  <summary className="sidebar-project-section-label">
                    {section.label}<span className="sidebar-section-count">{section.projects.length}</span>
                    {sectionAttention > 0 && (
                      <span className="sidebar-section-attention" title="此分組內待確認＋阻礙任務">{sectionAttention} 待處理</span>
                    )}
                  </summary>
                  {items}
                </details>
              );
            })}
          </section>
        );
      })}

      <div className="nav-spacer" />
      <div className="nav-footer">
        <div className="connection"><span />共用任務資料來源</div>
      </div>

      {menu && menuProject && (
        <div
          ref={menuRef}
          className="project-options-menu"
          role="menu"
          aria-label={`專案選項：${menuProject.name}`}
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="project-options-title">{menuProject.name}</div>
          {MENU_GROUPS.map((group) => {
            const current = currentMetaValue(menuProject, group.key);
            return (
              <div className="project-options-group" key={group.key}>
                <div className="project-options-group-title">{group.title}</div>
                {group.options.map((option) => {
                  const checked = option.value === current
                    || (group.key !== "domain" && option.value === null && current === null);
                  return (
                    <button
                      key={`${option.key}-${option.value ?? "auto"}`}
                      className={`project-options-item${checked ? " is-checked" : ""}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      disabled={savingMeta}
                      onClick={() => void chooseMeta(option)}
                    >
                      <span className="project-options-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
