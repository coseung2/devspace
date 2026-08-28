import { randomUUID } from "node:crypto";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import type { TaskRecord, TaskStore } from "./tasks.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const workerReadAppMeta = {
  _meta: {
    "openai/toolInvocation/invoking": "Reading DevSpace worker state...",
    "openai/toolInvocation/invoked": "DevSpace worker state ready",
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const workerWriteAppMeta = {
  _meta: {
    "openai/toolInvocation/invoking": "Updating DevSpace worker...",
    "openai/toolInvocation/invoked": "DevSpace worker updated",
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

interface ProcessInput {
  workspaceId: string;
  cmd: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  workingDirectory?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  requireApproval?: boolean;
  instruction?: string;
  model?: string;
  thinking?: string;
}

export function registerWorkerAppTools(
  server: McpServer,
  options: {
    config: ServerConfig;
    taskStore: TaskStore;
    workspaces: WorkspaceRegistry;
    processSessions: ProcessSessionManager;
    callerKey?: string;
  },
): void {
  const store = options.taskStore;
  const callerKey = options.callerKey ?? "anonymous";
  const taskIdSchema = z.string().min(1).describe("Durable MCP task identifier.");

  const taskView = (record: TaskRecord, snapshot?: ProcessSnapshot) => ({
    resultType: "complete" as const,
    taskId: record.taskId,
    agentId: record.agentId,
    operation: record.operation,
    workspaceId: record.workspaceId,
    status: record.status,
    statusMessage: record.statusMessage,
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    ttlMs: record.ttlMs,
    pollIntervalMs: record.pollIntervalMs,
    cancelRequested: record.cancelRequested,
    inputRequests: record.status === "input_required" ? {
      review: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: record.statusMessage ?? "Input required",
          requestedSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      },
    } : undefined,
    result: record.status === "completed" ? record.result : undefined,
    error: record.status === "failed" && record.error
      ? { code: -32603, message: record.error }
      : undefined,
    process: snapshot ? {
      sessionId: snapshot.sessionId,
      output: snapshot.output,
      outputTruncated: snapshot.outputTruncated,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
    } : undefined,
  });

  const processResultPayload = (snapshot: ProcessSnapshot) => ({
    content: [{
      type: "text",
      text: snapshot.output || `Process exited with code ${snapshot.exitCode ?? "unknown"}.`,
    }],
    structuredContent: {
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
    isError: snapshot.exitCode !== 0,
  });

  const readProcess = async (record: TaskRecord): Promise<ProcessSnapshot | undefined> => {
    if (!record.workspaceId || record.processSessionId === undefined) return undefined;
    try {
      return await options.processSessions.write({
        workspaceId: record.workspaceId,
        sessionId: record.processSessionId,
        chars: "",
        yieldTimeMs: 0,
        maxOutputTokens: options.config.processOutputMaxTokens,
      });
    } catch {
      return undefined;
    }
  };

  const spawn = async (input: ProcessInput) => {
    const workspace = options.workspaces.getWorkspace(input.workspaceId);
    const cwd = options.workspaces.resolveWorkingDirectory(workspace, input.workingDirectory);
    const record = store.create({
      callerKey,
      operation: "worker.spawn",
      workspaceId: input.workspaceId,
      agentId: `worker_${randomUUID()}`,
      statusMessage: input.instruction ?? "Command worker started.",
      pollIntervalMs: 1_000,
      approvalRequired: input.requireApproval,
    });
    try {
      const snapshot = await options.processSessions.start({
        workspaceId: input.workspaceId,
        command: input.cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty: input.tty,
        columns: input.columns,
        rows: input.rows,
        yieldTimeMs: input.yieldTimeMs,
        maxOutputTokens: input.maxOutputTokens,
      });
      const linked = store.update(record.taskId, callerKey, {
        processSessionId: snapshot.sessionId,
        status: snapshot.running
          ? "working"
          : record.approvalRequired
            ? "input_required"
            : "completed",
        statusMessage: !snapshot.running && record.approvalRequired
          ? "Review and approval required."
          : record.statusMessage,
        result: snapshot.running ? undefined : processResultPayload(snapshot),
      });
      return taskView(linked, snapshot);
    } catch (error) {
      return taskView(store.update(record.taskId, callerKey, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const getTask = async (taskId: string) => {
    let record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    const snapshot = await readProcess(record);
    if (!snapshot && record.processSessionId !== undefined && record.status === "working") {
      record = store.update(taskId, callerKey, {
        status: "failed",
        error: "The process session is unavailable after DevSpace restart.",
      });
    } else if (snapshot && !snapshot.running && record.status === "working") {
      record = store.update(taskId, callerKey, {
        status: record.approvalRequired ? "input_required" : "completed",
        statusMessage: record.approvalRequired
          ? "Review and approval required."
          : record.statusMessage,
        result: processResultPayload(snapshot),
      });
    }
    return taskView(record, snapshot);
  };

  const cancelTask = async (taskId: string) => {
    const record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.workspaceId && record.processSessionId !== undefined) {
      try {
        await options.processSessions.write({
          workspaceId: record.workspaceId,
          sessionId: record.processSessionId,
          chars: "\u0003",
          yieldTimeMs: 0,
          maxOutputTokens: options.config.processOutputMaxTokens,
        });
      } catch {
        // The process may have exited between lookup and interrupt.
      }
    }
    return taskView(store.requestCancel(taskId, callerKey));
  };

  const spawnSchema = {
    workspaceId: z.string().min(1),
    cmd: z.string().min(1),
    instruction: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    requireApproval: z.boolean().optional().describe(
      "Pause in input_required after a successful command until approved.",
    ),
    tty: z.boolean().optional(),
    columns: z.number().int().min(1).max(1_000).optional(),
    rows: z.number().int().min(1).max(1_000).optional(),
    workingDirectory: z.string().optional(),
    yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
    maxOutputTokens: z.number().int().positive().max(options.config.processOutputMaxTokens).optional(),
  };

  registerAppTool(server, "worker_catalog", {
    title: "List worker runtimes",
    description: "ChatGPT-compatible alias for worker.catalog. List the execution runtimes exposed by this DevSpace instance.",
    inputSchema: {},
    ...workerReadAppMeta,
  }, async () => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        workers: [{
          id: "command",
          label: "Workspace command worker",
          taskSupport: "optional",
          durableState: true,
        }],
        contract: [
          "worker_catalog",
          "worker_spawn",
          "worker_get",
          "worker_send_input",
          "worker_resume",
          "worker_approve",
          "worker_cancel",
          "worker_close",
        ],
        canonicalContract: [
          "worker.catalog",
          "worker.spawn",
          "worker.get",
          "worker.send_input",
          "worker.resume",
          "worker.approve",
          "worker.cancel",
          "worker.close",
        ],
      }),
    }],
    structuredContent: {
      workers: [{
        id: "command",
        label: "Workspace command worker",
        taskSupport: "optional",
        durableState: true,
      }],
    },
  }));

  registerAppTool(server, "worker_spawn", {
    title: "Spawn worker",
    description: "ChatGPT-compatible alias for worker.spawn. Start a workspace command as a durable task-backed worker owned by DevSpace.",
    inputSchema: spawnSchema,
    ...workerWriteAppMeta,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await spawn(input)) }],
  }));

  registerAppTool(server, "worker_get", {
    title: "Get worker",
    description: "ChatGPT-compatible alias for worker.get. Read a task-backed worker and its latest process snapshot.",
    inputSchema: { taskId: taskIdSchema },
    ...workerReadAppMeta,
  }, async ({ taskId }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await getTask(taskId)) }],
  }));

  registerAppTool(server, "worker_send_input", {
    title: "Send worker input",
    description: "ChatGPT-compatible alias for worker.send_input. Send input to a running worker process.",
    inputSchema: { taskId: taskIdSchema, chars: z.string() },
    ...workerWriteAppMeta,
  }, async ({ taskId, chars }) => {
    const record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.workspaceId === undefined || record.processSessionId === undefined) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(taskView(store.update(taskId, callerKey, { inputResponse: chars }))),
        }],
      };
    }
    const snapshot = await options.processSessions.write({
      workspaceId: record.workspaceId,
      sessionId: record.processSessionId,
      chars,
      yieldTimeMs: 250,
      maxOutputTokens: options.config.processOutputMaxTokens,
    });
    const updated = store.update(taskId, callerKey, {
      inputResponse: chars,
      status: snapshot.running
        ? "working"
        : record.approvalRequired
          ? "input_required"
          : "completed",
      statusMessage: !snapshot.running && record.approvalRequired
        ? "Review and approval required."
        : record.statusMessage,
      result: snapshot.running ? undefined : processResultPayload(snapshot),
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(taskView(updated, snapshot)) }],
    };
  });

  registerAppTool(server, "worker_resume", {
    title: "Resume worker",
    description: "ChatGPT-compatible alias for worker.resume. Resume a worker after an input checkpoint.",
    inputSchema: { taskId: taskIdSchema },
    ...workerWriteAppMeta,
  }, async ({ taskId }) => {
    const record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status !== "input_required") {
      throw new Error("Only input-required workers can be resumed.");
    }
    const updated = store.update(taskId, callerKey, {
      status: "working",
      statusMessage: "Worker resumed.",
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(taskView(updated)) }],
    };
  });

  registerAppTool(server, "worker_approve", {
    title: "Approve worker",
    description: "ChatGPT-compatible alias for worker.approve. Approve a worker at a review checkpoint.",
    inputSchema: { taskId: taskIdSchema },
    ...workerWriteAppMeta,
  }, async ({ taskId }) => {
    const record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status !== "input_required") {
      throw new Error("Only input-required workers can be approved.");
    }
    const updated = store.update(taskId, callerKey, {
      status: record.approvalRequired && record.result !== undefined ? "completed" : "working",
      statusMessage: "Review approved.",
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(taskView(updated)) }],
    };
  });

  registerAppTool(server, "worker_cancel", {
    title: "Cancel worker",
    description: "ChatGPT-compatible alias for worker.cancel. Request cooperative cancellation of a worker.",
    inputSchema: { taskId: taskIdSchema },
    ...workerWriteAppMeta,
  }, async ({ taskId }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await cancelTask(taskId)) }],
  }));

  registerAppTool(server, "worker_close", {
    title: "Close worker",
    description: "ChatGPT-compatible alias for worker.close. Close a terminal worker while retaining durable task history.",
    inputSchema: { taskId: taskIdSchema },
    ...workerWriteAppMeta,
  }, async ({ taskId }) => {
    const record = store.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status === "working" || record.status === "input_required") {
      throw new Error("Only terminal workers can be closed.");
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(taskView(record)) }],
    };
  });
}
