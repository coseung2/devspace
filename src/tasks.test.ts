import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { InMemoryTaskStore, SqliteTaskStore } from "./tasks.js";

function exerciseStore(create: () => InMemoryTaskStore | SqliteTaskStore): void {
  const store = create();
  const created = store.create({
    taskId: "task_test",
    callerKey: "caller-a",
    operation: "worker.spawn",
    approvalRequired: true,
    workspaceId: "workspace-a",
  });
  if (created.status !== "working") throw new Error("new tasks must be working");
  const inputRequired = store.update(created.taskId, "caller-a", {
    status: "input_required",
    statusMessage: "Need confirmation",
  });
  if (inputRequired.status !== "input_required") throw new Error("status transition was not stored");
  store.update(created.taskId, "caller-a", { inputResponse: "yes", status: "working" });
  const completed = store.update(created.taskId, "caller-a", {
    status: "completed",
    result: { ok: true },
  });
  if (completed.status !== "completed" || completed.result === undefined) throw new Error("result was not stored");
  if (store.get(created.taskId, "caller-b") !== undefined) throw new Error("task leaked across callers");
  if (store.list("caller-a", "workspace-a").length !== 1) throw new Error("task list is incomplete");
  let terminalError = false;
  try {
    store.update(created.taskId, "caller-a", { status: "working" });
  } catch {
    terminalError = true;
  }
  if (!terminalError) throw new Error("terminal tasks must not resume");
}

test("in-memory task store enforces lifecycle and caller isolation", () => {
  exerciseStore(() => new InMemoryTaskStore());
});

test("sqlite task store survives a new store instance", () => {
  const directory = join(tmpdir(), `devspace-tasks-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "tasks.sqlite");
  const firstDatabase = new Database(path);
  const firstStore = new SqliteTaskStore(firstDatabase);
  const created = firstStore.create({
    taskId: "task_persistent",
    callerKey: "caller-a",
    operation: "worker.spawn",
    approvalRequired: true,
  });
  firstStore.update(created.taskId, "caller-a", { status: "input_required", statusMessage: "Review required" });
  firstDatabase.close();

  const secondDatabase = new Database(path);
  const secondStore = new SqliteTaskStore(secondDatabase);
  const restored = secondStore.get(created.taskId, "caller-a");
  if (restored?.status !== "input_required" || !restored.approvalRequired) throw new Error("task state did not survive restart");
  secondDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});
