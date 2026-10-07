import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  getProjectReadme,
  saveProjectReadme,
  uploadProjectReadmeAttachment,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { Project, ProjectReadme, Task, TaskRelationSummary } from "../types";
import { DescriptionDocument } from "./DescriptionDocument";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import { LinearIcon } from "./LinearIcon";
import "./ProjectReadmeView.css";

type ProjectReadmeError = string | readonly [string, string];

export interface ProjectLocationMetadata {
  governancePath: string | null;
  materialsPath: string | null;
  workspaceRole: "materials" | "governance" | "system" | "code" | null;
}

export function parseProjectLocationMetadata(content: string): ProjectLocationMetadata {
  const block = content.match(/<!--\s*hermes-project-location:v1\s*([\s\S]*?)-->/i)?.[1] ?? "";
  const values = new Map<string, string>();
  for (const line of block.split("\\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) values.set(key, value);
  }
  const normalizePath = (value: string | undefined) => (
    !value || value === "none" ? null : value
  );
  const role = values.get("workspaceRole");
  return {
    governancePath: normalizePath(values.get("governancePath")),
    materialsPath: normalizePath(values.get("materialsPath")),
    workspaceRole: role === "materials" || role === "governance" || role === "system" || role === "code"
      ? role
      : null,
  };
}

interface ProjectReadmeViewProps {
  project: Project;
  tasks: Task[];
  referenceTasks: Task[];
  revision: number;
  onOpenTask: (task: TaskRelationSummary) => void;
  onError?: (error: ProjectReadmeError | null) => void;
}

export function ProjectReadmeView({
  project,
  tasks,
  referenceTasks,
  revision,
  onOpenTask,
  onError,
}: ProjectReadmeViewProps) {
  const { text } = useTaskboardI18n();
  const [readme, setReadme] = useState<ProjectReadme | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequest, setLoadRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments("", referenceTasks),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);

  useEffect(() => {
    if (editing) return;
    let active = true;
    setSaveError(null);
    setLoadError(null);

    getProjectReadme(project.id)
      .then((data) => {
        if (!active) return;
        setReadme(data);
        setSegments(createInlineMediaSegments(data.content, referenceTasks));
      })
      .catch((err) => {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editing, loadRequest, project.id, revision]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, [editing]);

  function startEditing() {
    if (!readme) return;
    setSegments(createInlineMediaSegments(readme.content, referenceTasks));
    setEditing(true);
    setSaveError(null);
  }

  function cancelEditing() {
    setSegments(createInlineMediaSegments(readme?.content ?? "", referenceTasks));
    setEditing(false);
    setSaveError(null);
  }

  async function save() {
    if (saving || !readme) return;
    const draftContent = serializeInlineMedia(segments);
    const inlineImages = inlineMediaImages(segments);
    if (draftContent === readme.content && inlineImages.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setSaveError(null);
    onError?.(null);

    try {
      const uploaded = await Promise.all(
        inlineImages.map((image) => uploadProjectReadmeAttachment(project.id, image.file)),
      );
      const resolvedContent = resolveInlineMediaMarkdown(
        draftContent,
        inlineImages,
        uploaded,
      );
      const updated = await saveProjectReadme(project.id, resolvedContent, readme.version);
      setReadme(updated);
      setSegments(createInlineMediaSegments(updated.content, referenceTasks));
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setSaveError(text(
          "项目文档已被其他协作者或 Agent 更新，请刷新后重试。",
          "Project Docs were modified elsewhere. Please refresh and try again.",
        ));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message);
        onError?.(message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="project-readme-loading">
        <div className="project-readme-spinner" />
        <p>{text("正在加载项目文档…", "Loading Project Docs…")}</p>
      </div>
    );
  }

  if (loadError && !readme) {
    return (
      <div className="project-readme-loading" role="alert">
        <p>{loadError}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setLoading(true);
            setLoadRequest((current) => current + 1);
          }}
        >
          {text("重试", "Try again")}
        </button>
      </div>
    );
  }

  const content = readme?.content ?? "";
  const location = parseProjectLocationMetadata(content);
  const governancePath = location.governancePath
    ?? (project.workspacePath?.includes("/Hermes Vault/projects/") ? project.workspacePath : null);
  const materialsPath = location.materialsPath
    ?? (project.workspacePath?.includes("/01_進行中專案/") || project.workspacePath?.includes("/02_已完工專案/")
      ? project.workspacePath
      : null);
  const workspaceRole = location.workspaceRole
    ?? (materialsPath ? "materials" : governancePath ? "governance" : "system");

  return (
    <div className="project-readme-container">
      <div className="project-readme-content">
        <section className="project-location-panel" aria-labelledby="project-location-title">
          <div className="project-location-heading">
            <LinearIcon name="folder" />
            <div>
              <h2 id="project-location-title">{text("專案資料位置", "Project data locations")}</h2>
              <p>{text(
                "主系統規則與 2026 實際素材／成品分開保存；本頁顯示這個 Project 的對應位置。",
                "Governance rules and 2026 working assets are separate. These are this Project's authoritative locations.",
              )}</p>
            </div>
          </div>
          <div className="project-location-grid">
            <div className="project-location-item">
              <span>{text("主系統／治理資料夾", "System / governance folder")}</span>
              <code>{governancePath ?? text("未建立", "Not assigned")}</code>
            </div>
            <div className="project-location-item">
              <span>{text("2026 素材／製作／成品資料夾", "2026 assets / production / deliverables")}</span>
              <code>{materialsPath ?? text("目前沒有獨立 2026 素材資料夾", "No separate 2026 asset folder yet")}</code>
            </div>
            <div className="project-location-item project-location-workspace">
              <span>{text("Taskboard 執行工作區", "Taskboard execution workspace")}</span>
              <code>{project.workspacePath ?? text("未設定", "Not assigned")}</code>
            </div>
          </div>
          <div className={`project-location-role role-${workspaceRole}`}>
            {workspaceRole === "materials"
              ? text("目前以 2026 實際素材資料夾執行", "Runs against the 2026 working-assets folder")
              : workspaceRole === "code"
                ? text("目前以系統程式碼工作區執行", "Runs against the system code workspace")
                : workspaceRole === "system"
                  ? text("目前以 Hermes 系統工作區執行", "Runs against the Hermes system workspace")
                  : text("目前以主系統治理資料夾執行", "Runs against the governance folder")}
          </div>
        </section>

        {saveError && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{saveError}</span>
          </div>
        )}

        {loadError && !editing && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{loadError}</span>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setLoading(true);
                setLoadRequest((current) => current + 1);
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {editing ? (
          <div
            className="issue-description-composer"
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              void save();
            }}
          >
            <InlineMediaComposer
              ref={composerRef}
              segments={segments}
              mentionTasks={tasks}
              referenceTasks={referenceTasks}
              completionContext={{
                projectId: project.id,
                surface: "issue-description",
              }}
              placeholder={text("添加说明...", "Add notes...")}
              ariaLabel={text("项目文档", "Project Docs")}
              disabled={saving}
              onChange={setSegments}
              onError={(message) => onError?.(message)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelEditing();
                }
              }}
            />
          </div>
        ) : (
          <div
            className={`issue-description-read${content ? "" : " empty"}`}
            role="button"
            tabIndex={0}
            aria-label={text("编辑项目文档", "Edit Project Docs")}
            onClick={() => {
              if (window.getSelection()?.isCollapsed === false) return;
              startEditing();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                startEditing();
              }
            }}
          >
            {content
              ? <DescriptionDocument
                  value={content}
                  referenceTasks={referenceTasks}
                  onOpenTask={onOpenTask}
                />
              : text("添加说明...", "Add notes...")}
          </div>
        )}
      </div>
    </div>
  );
}
