import { ApiError } from "./database.mjs";

const RETRY_DELAY_MS = 1_500;
const POLL_INTERVAL_MS = 350;
const RUN_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function errorText(error) {
  return String(error?.message ?? error ?? "Unknown Codex dispatch error").slice(0, 65_536);
}

function executionPrompt(task, comment) {
  return [
    "A user posted a new comment from the Taskboard web interface.",
    "Treat the comment as the current execution request for this task.",
    "Read the task description and inspect the mapped workspace before acting.",
    "Execute the requested work when it is actionable; do not only describe a plan.",
    "Verify the result and report files changed, tests run, and any remaining risks.",
    "If the comment explicitly asks to wait, not execute, or only discuss, do not modify files and report that clearly.",
    "",
    `Task: ${task.identifier} — ${task.title}`,
    `Task status: ${task.status}`,
    task.description ? `Task description:\n${task.description}` : "Task description: (empty)",
    "",
    `New web comment by ${comment.authorName} (@${comment.authorId}):`,
    comment.body,
  ].join("\n");
}

export class CommentAgentDispatcher {
  constructor({ database, aiChat, canRun = async () => true, intervalMs = 1_000 }) {
    this.database = database;
    this.aiChat = aiChat;
    this.canRun = canRun;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.processing = false;
    this.closed = false;
    this.kickPromise = null;
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.processPending().catch(() => {}); }, this.intervalMs);
    this.timer.unref();
    void this.processPending().catch(() => {});
  }

  kick() {
    if (this.closed) return Promise.resolve();
    if (!this.kickPromise) {
      this.kickPromise = this.processPending().catch(() => {}).finally(() => {
        this.kickPromise = null;
      });
    }
    return this.kickPromise;
  }

  async processPending() {
    if (this.closed || this.processing) return;
    this.processing = true;
    try {
      if (!(await this.canRun())) return;
      const pending = this.database.listPendingCommentAgentDispatches(10);
      for (const candidate of pending) {
        if (this.closed) return;
        await this.processOne(candidate.comment_id);
      }
    } finally {
      this.processing = false;
    }
  }

  async processOne(commentId) {
    const dispatch = this.database.claimCommentAgentDispatch(commentId);
    if (!dispatch) return;
    const comment = this.database.getComment(commentId);
    const task = comment ? this.database.getTask(comment.taskId) : null;
    if (!comment || !task || task.archivedAt !== null) {
      this.database.completeCommentAgentDispatch(
        commentId,
        "failed",
        "The comment or task no longer exists or the task is archived",
      );
      return;
    }

    try {
      let thread = this.database.findAiChatThreadForIssue(task.id);
      // Web comments are unattended automation. Never reuse a manually-created
      // danger-full-access conversation because every such turn requires an
      // interactive confirmation that the dispatcher cannot provide.
      if (thread?.sandbox === "danger-full-access") thread = null;
      if (thread?.currentRun) {
        this.database.retryCommentAgentDispatch(commentId, "Task AI conversation is already running", RETRY_DELAY_MS);
        return;
      }
      if (!thread) {
        thread = await this.aiChat.createThread({
          projectId: task.projectId,
          issueId: task.id,
          title: `${task.identifier} · Web comment`,
        });
      }
      const run = await this.aiChat.startTurn(thread.id, {
        message: executionPrompt(task, comment),
        skillIds: [],
        attachments: [],
      });
      this.database.setCommentAgentDispatchRun(commentId, thread.id, run.id);
      const completed = await this.waitForRun(run.id);
      if (completed.status === "completed") {
        this.database.completeCommentAgentDispatch(commentId, "completed");
      } else {
        this.database.completeCommentAgentDispatch(
          commentId,
          "failed",
          completed.error ?? `Codex run ended with status '${completed.status}'`,
        );
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "THREAD_BUSY") {
        this.database.retryCommentAgentDispatch(commentId, error.message, RETRY_DELAY_MS);
      } else {
        this.database.completeCommentAgentDispatch(commentId, "failed", errorText(error));
      }
    }
  }

  async waitForRun(runId) {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (!this.closed && Date.now() < deadline) {
      const run = this.aiChat.getRun(runId);
      if (run.status !== "running") return run;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        timer.unref();
      });
    }
    if (this.closed) return this.aiChat.getRun(runId);
    throw new Error("Codex web comment execution timed out after 24 hours");
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.kickPromise) await this.kickPromise.catch(() => {});
  }
}
