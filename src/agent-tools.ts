import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { TaskRecord, TaskStore } from "./tasks.js";
import {
  workspaceAgentDispatcherFromEnv,
  type AgentDispatcher,
} from "./workspace-agent-dispatch.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

const CALLBACK_HASH_PREFIX = "__agent_callback_sha256:";

const readMeta = {
  _meta: {
    "openai/toolInvocation/invoking": "Reading GPT worker state...",
    "openai/toolInvocation/invoked": "GPT worker state ready",
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

const writeMeta = {
  _meta: {
    "openai/toolInvocation/invoking": "Updating GPT worker...",
    "openai/toolInvocation/invoked": "GPT worker updated",
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
} as const;

export type AgentIsolation = "auto" | "worktree" | "shared";

export interface AgentSpawnInput {
  workspaceId: string;
  task: string;
  isolation?: AgentIsolation;
  readOnly?: boolean;
  baseRef?: string;
}

export interface AgentCompletionInput {
  taskId: string;
  callbackToken: string;
  summary: string;
  changedFiles?: string[];
  tests?: string[];
  commit?: string;
}

export interface AgentFailureInput {
  taskId: string;
  callbackToken: string;
  error: string;
}

export interface AgentRevisionInput {
  taskId: string;
  instruction: string;
}

export interface AgentTaskView {
  taskId: string;
  agentId?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  sourceRoot?: string;
  status: TaskRecord["status"];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  result?: unknown;
  error?: string;
}

export interface AgentSpawnResult extends AgentTaskView {
  callbackToken: string;
  dispatchPrompt: string;
  dispatch: "automatic" | "manual";
  isolation: "worktree" | "shared";
}

export class AgentTaskCoordinator {
  constructor(
    private readonly store: TaskStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly callerKey = "anonymous",
    private readonly dispatcher?: AgentDispatcher,
  ) {}

  async spawn(input: AgentSpawnInput): Promise<AgentSpawnResult> {
    const source = this.workspaces.getWorkspace(input.workspaceId);
    const isolation = resolveIsolation(input);
    const workerWorkspace = isolation === "worktree"
      ? (await this.workspaces.openWorkspace({
          path: source.sourceRoot ?? source.root,
          mode: "worktree",
          baseRef: input.baseRef,
        })).workspace
      : source;

    const callbackToken = randomBytes(32).toString("base64url");
    const record = this.store.create({
      callerKey: this.callerKey,
      operation: "agent.spawn",
      workspaceId: workerWorkspace.id,
      agentId: `gpt_${randomUUID()}`,
      status: "working",
      statusMessage: "GPT worker dispatch pending.",
      approvalRequired: true,
      pollIntervalMs: 1_000,
    });

    this.store.update(record.taskId, this.callerKey, {
      inputResponse: `${CALLBACK_HASH_PREFIX}${hashToken(callbackToken)}`,
    });

    const updated = this.requireOwned(record.taskId);
    const dispatchPrompt = buildDispatchPrompt({
      taskId: updated.taskId,
      callbackToken,
      workspaceId: workerWorkspace.id,
      task: input.task,
    });
    const dispatchResult = await this.maybeDispatch(updated, dispatchPrompt);

    return {
      ...this.view(dispatchResult.record, workerWorkspace),
      callbackToken,
      dispatchPrompt,
      dispatch: dispatchResult.dispatch,
      isolation,
    };
  }

  get(taskId: string): AgentTaskView {
    const record = this.requireOwned(taskId);
    return this.view(record, this.workspaceFor(record));
  }

  async revise(input: AgentRevisionInput): Promise<AgentSpawnResult> {
    const record = this.requireOwned(input.taskId);
    if (record.status !== "input_required") {
      throw new Error("Only GPT workers waiting for review can be revised.");
    }

    const callbackToken = randomBytes(32).toString("base64url");
    const updated = this.store.update(record.taskId, this.callerKey, {
      status: "working",
      statusMessage: "Revision requested; GPT worker dispatch pending.",
      inputResponse: `${CALLBACK_HASH_PREFIX}${hashToken(callbackToken)}`,
    });
    const workspace = this.workspaceFor(updated);
    const dispatchPrompt = buildDispatchPrompt({
      taskId: updated.taskId,
      callbackToken,
      workspaceId: updated.workspaceId!,
      task: input.instruction,
    });
    const dispatchResult = await this.maybeDispatch(updated, dispatchPrompt);

    return {
      ...this.view(dispatchResult.record, workspace),
      callbackToken,
      dispatchPrompt,
      dispatch: dispatchResult.dispatch,
      isolation: workspace.mode === "worktree" ? "worktree" : "shared",
    };
  }

  complete(input: AgentCompletionInput): AgentTaskView {
    const record = this.requireCallback(input.taskId, input.callbackToken);
    const result = {
      summary: input.summary,
      changedFiles: input.changedFiles ?? [],
      tests: input.tests ?? [],
      commit: input.commit,
    };
    const updated = this.store.update(record.taskId, record.callerKey, {
      status: "input_required",
      statusMessage: "GPT worker finished. Parent diff/test review is required.",
      result,
    });
    return this.view(updated, this.workspaceFor(updated));
  }

  fail(input: AgentFailureInput): AgentTaskView {
    const record = this.requireCallback(input.taskId, input.callbackToken);
    const updated = this.store.update(record.taskId, record.callerKey, {
      status: "failed",
      statusMessage: "GPT worker failed.",
      error: input.error,
    });
    return this.view(updated, this.workspaceFor(updated));
  }

  cancel(taskId: string): AgentTaskView {
    const record = this.requireOwned(taskId);
    const updated = this.store.requestCancel(taskId, record.callerKey);
    return this.view(updated, this.workspaceFor(updated));
  }

  approve(taskId: string): AgentTaskView {
    const record = this.requireOwned(taskId);
    if (record.status !== "input_required") {
      throw new Error("Only GPT workers waiting for review can be approved.");
    }
    const updated = this.store.update(taskId, record.callerKey, {
      status: "completed",
      statusMessage: "Parent review approved.",
    });
    return this.view(updated, this.workspaceFor(updated));
  }

  private async maybeDispatch(
    record: TaskRecord,
    prompt: string,
  ): Promise<{ record: TaskRecord; dispatch: "automatic" | "manual" }> {
    if (!this.dispatcher) return { record, dispatch: "manual" };
    if (!record.workspaceId) throw new Error(`GPT worker task ${record.taskId} has no workspace.`);

    try {
      await this.dispatcher({
        taskId: record.taskId,
        workspaceId: record.workspaceId,
        prompt,
      });
      return { record, dispatch: "automatic" };
    } catch (error) {
      const failed = this.store.update(record.taskId, record.callerKey, {
        status: "failed",
        statusMessage: "GPT worker dispatch failed.",
        error: error instanceof Error ? error.message : String(error),
      });
      return { record: failed, dispatch: "automatic" };
    }
  }

  private requireOwned(taskId: string): TaskRecord {
    const record = this.store.get(taskId, this.callerKey);
    if (!record || record.operation !== "agent.spawn") {
      throw new Error(`GPT worker task ${taskId} not found.`);
    }
    return record;
  }

  private requireCallback(taskId: string, callbackToken: string): TaskRecord {
    const record = this.store.get(taskId);
    if (!record || record.operation !== "agent.spawn") {
      throw new Error(`GPT worker task ${taskId} not found.`);
    }
    if (record.status !== "working") {
      throw new Error(`GPT worker task ${taskId} is not accepting callbacks while ${record.status}.`);
    }

    const expected = latestCallbackHash(record);
    const actual = hashToken(callbackToken);
    if (!expected || !safeEqualHex(expected, actual)) {
      throw new Error("Invalid GPT worker callback capability.");
    }
    return record;
  }

  private workspaceFor(record: TaskRecord): Workspace {
    if (!record.workspaceId) throw new Error(`GPT worker task ${record.taskId} has no workspace.`);
    return this.workspaces.getWorkspace(record.workspaceId);
  }

  private view(record: TaskRecord, workspace: Workspace): AgentTaskView {
    return {
      taskId: record.taskId,
      agentId: record.agentId,
      workspaceId: record.workspaceId,
      workspaceRoot: workspace.root,
      sourceRoot: workspace.sourceRoot,
      status: record.status,
      statusMessage: record.statusMessage,
      createdAt: record.createdAt,
      lastUpdatedAt: record.updatedAt,
      result: record.result,
      error: record.error,
    };
  }
}

export function registerAgentTools(
  server: McpServer,
  options: {
    taskStore: TaskStore;
    workspaces: WorkspaceRegistry;
    callerKey?: string;
  },
): void {
  const coordinator = new AgentTaskCoordinator(
    options.taskStore,
    options.workspaces,
    options.callerKey,
    workspaceAgentDispatcherFromEnv(),
  );

  const spawnSchema = {
    workspaceId: z.string().min(1),
    task: z.string().min(1),
    isolation: z.enum(["auto", "worktree", "shared"]).optional(),
    readOnly: z.boolean().optional(),
    baseRef: z.string().optional(),
  };
  const taskIdSchema = { taskId: z.string().min(1) };
  const completionSchema = {
    taskId: z.string().min(1),
    callbackToken: z.string().min(1),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
    commit: z.string().optional(),
  };
  const failureSchema = {
    taskId: z.string().min(1),
    callbackToken: z.string().min(1),
    error: z.string().min(1),
  };
  const revisionSchema = {
    taskId: z.string().min(1),
    instruction: z.string().min(1),
  };

  server.registerTool("agent.spawn", {
    title: "Spawn GPT worker task",
    description: "Create a DevSpace-owned GPT worker task and automatically isolate write-capable work in a managed Git worktree. If the Workspace Agent trigger environment is configured, dispatch happens automatically; otherwise a dispatch prompt is returned for manual/native triggering.",
    inputSchema: spawnSchema,
  }, async (input) => textResult(await coordinator.spawn(input)));

  server.registerTool("agent.get", {
    title: "Get GPT worker task",
    description: "Read DevSpace-owned GPT worker state. Parent ChatGPT should inspect the returned worktree and real Git/test state before approval.",
    inputSchema: taskIdSchema,
  }, async ({ taskId }) => textResult(coordinator.get(taskId)));

  server.registerTool("agent.revise", {
    title: "Revise GPT worker task",
    description: "Move a worker from review back to working and create a fresh dispatch capability for another GPT pass in the same workspace/worktree.",
    inputSchema: revisionSchema,
  }, async (input) => textResult(await coordinator.revise(input)));

  server.registerTool("agent.approve", {
    title: "Approve GPT worker task",
    description: "Mark a reviewed GPT worker task completed after the parent has independently inspected its diff and tests.",
    inputSchema: taskIdSchema,
  }, async ({ taskId }) => textResult(coordinator.approve(taskId)));

  server.registerTool("agent.cancel", {
    title: "Cancel GPT worker task",
    description: "Cancel a DevSpace-owned GPT worker task. The managed worktree remains available for inspection until normal workspace cleanup.",
    inputSchema: taskIdSchema,
  }, async ({ taskId }) => textResult(coordinator.cancel(taskId)));

  server.registerTool("agent.complete", {
    title: "Complete GPT worker pass",
    description: "Worker-only callback. Report a GPT coding pass as ready for parent review using the callback capability supplied in its dispatch prompt.",
    inputSchema: completionSchema,
  }, async (input) => textResult(coordinator.complete(input)));

  server.registerTool("agent.fail", {
    title: "Fail GPT worker pass",
    description: "Worker-only callback. Report a failed GPT coding pass using the callback capability supplied in its dispatch prompt.",
    inputSchema: failureSchema,
  }, async (input) => textResult(coordinator.fail(input)));

  registerAppTool(server, "agent_spawn", {
    title: "Spawn GPT worker task",
    description: "ChatGPT-compatible alias for agent.spawn.",
    inputSchema: spawnSchema,
    ...writeMeta,
  }, async (input) => textResult(await coordinator.spawn(input)));
  registerAppTool(server, "agent_get", {
    title: "Get GPT worker task",
    description: "ChatGPT-compatible alias for agent.get.",
    inputSchema: taskIdSchema,
    ...readMeta,
  }, async ({ taskId }) => textResult(coordinator.get(taskId)));
  registerAppTool(server, "agent_revise", {
    title: "Revise GPT worker task",
    description: "ChatGPT-compatible alias for agent.revise.",
    inputSchema: revisionSchema,
    ...writeMeta,
  }, async (input) => textResult(await coordinator.revise(input)));
  registerAppTool(server, "agent_approve", {
    title: "Approve GPT worker task",
    description: "ChatGPT-compatible alias for agent.approve.",
    inputSchema: taskIdSchema,
    ...writeMeta,
  }, async ({ taskId }) => textResult(coordinator.approve(taskId)));
  registerAppTool(server, "agent_cancel", {
    title: "Cancel GPT worker task",
    description: "ChatGPT-compatible alias for agent.cancel.",
    inputSchema: taskIdSchema,
    ...writeMeta,
  }, async ({ taskId }) => textResult(coordinator.cancel(taskId)));
  registerAppTool(server, "agent_complete", {
    title: "Complete GPT worker pass",
    description: "Worker-only ChatGPT-compatible callback alias for agent.complete.",
    inputSchema: completionSchema,
    ...writeMeta,
  }, async (input) => textResult(coordinator.complete(input)));
  registerAppTool(server, "agent_fail", {
    title: "Fail GPT worker pass",
    description: "Worker-only ChatGPT-compatible callback alias for agent.fail.",
    inputSchema: failureSchema,
    ...writeMeta,
  }, async (input) => textResult(coordinator.fail(input)));
}

function resolveIsolation(input: AgentSpawnInput): "worktree" | "shared" {
  if (input.isolation === "worktree") return "worktree";
  if (input.isolation === "shared") return "shared";
  return input.readOnly ? "shared" : "worktree";
}

function buildDispatchPrompt(input: {
  taskId: string;
  callbackToken: string;
  workspaceId: string;
  task: string;
}): string {
  return [
    "You are a subordinate coding worker launched by a parent ChatGPT session.",
    `DevSpace task ID: ${input.taskId}`,
    `DevSpace workspace ID: ${input.workspaceId}`,
    "Work only in that DevSpace workspace. Do not open or switch to the parent checkout.",
    "Follow the workspace instructions returned by DevSpace and perform the requested work, including appropriate tests.",
    "When the pass is ready for parent review, call DevSpace agent_complete with the task ID, callback token, concise summary, changed files, tests, and commit SHA if one exists.",
    "If the pass cannot be completed, call DevSpace agent_fail with the task ID, callback token, and error.",
    `Callback token: ${input.callbackToken}`,
    "Task:",
    input.task,
  ].join("\n");
}

function latestCallbackHash(record: TaskRecord): string | undefined {
  for (let index = record.inputRequests.length - 1; index >= 0; index -= 1) {
    const value = record.inputRequests[index];
    if (value.startsWith(CALLBACK_HASH_PREFIX)) {
      return value.slice(CALLBACK_HASH_PREFIX.length);
    }
  }
  return undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqualHex(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}
