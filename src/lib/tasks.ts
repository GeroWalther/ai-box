// The assistant's tasks. They run on the Mac (src-tauri/src/tasks.rs); this is
// only how a window — the Mac's or the phone's — starts, watches and answers
// them. The same calls work over both transports.
import { invokeCmd } from "./transport";
import type { Attached } from "./attachments";

export interface TaskStep {
  at: number;
  /** `user` and `reply` are the conversation; the rest are its work. */
  kind: "user" | "reply" | "note" | "error" | "browser" | "terminal" | "file" | "web" | "ask" | "mac";
  title: string;
  detail?: string;
  /** Unset while the step is still running. */
  ok?: boolean | null;
  /** A user message's attached images. */
  images?: Attached[];
}

export interface TaskPending {
  id: string;
  kind: "approve" | "question" | "handover";
  title: string;
  body: string;
  shot?: string;
}

export type TaskStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  created: number;
  updated: number;
  rev: number;
  model: string;
  steps: TaskStep[];
  pending?: TaskPending;
  result?: string;
  error?: string;
  shot?: string;
}

export type TaskSummary = Pick<Task, "id" | "goal" | "status" | "created" | "updated" | "rev">;

/** A new conversation. `history` is plain text turns from before it became a
 *  task, so an older chat carries on rather than starting cold. */
export const startTask = (
  goal: string,
  images: Attached[],
  baseUrl: string,
  model: string,
  history: { role: "user" | "assistant"; content: string }[] = []
) => invokeCmd<Task>("task_start", { goal, images, baseUrl, model, history });

/** Say more: steers it while it works, answers what it waits on, or carries
 *  the conversation on once it has finished. */
export const sendToTask = (id: string, text: string, images: Attached[], baseUrl: string, model: string) =>
  invokeCmd<void>("task_send", { id, text, images, baseUrl, model });

export const listTasks = () => invokeCmd<TaskSummary[]>("task_list");

/** The task, or null when nothing changed since `since`. */
export const getTask = (id: string, since?: number) =>
  invokeCmd<Task | null>("task_get", { id, since: since ?? null });

export const approveTask = (pendingId: string, approved: boolean) =>
  invokeCmd<void>("task_answer", { pendingId, approved, text: null });

export const replyTask = (pendingId: string, text: string) =>
  invokeCmd<void>("task_answer", { pendingId, approved: null, text });

export const stopTask = (id: string) => invokeCmd<void>("task_stop", { id });
export const deleteTask = (id: string) => invokeCmd<void>("task_delete", { id });

export const isLive = (s: TaskStatus) => s === "running" || s === "waiting";
