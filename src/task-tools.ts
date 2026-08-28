import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { registerAgentTools } from "./agent-tools.js";
import type { ServerConfig } from "./config.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import { InMemoryTaskStore, type TaskRecord, type TaskStore } from "./tasks.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const taskIdSchema = z.string().min(1).describe("Durable MCP task identifier.");
const serverDiscoverRequestSchema = z.object({
  method: z.literal("server/discover"),
  params: z.object({}).optional(),
});
const tasksGetRequestSchema = z.object({
  method: z.literal("tasks/get"),
  params: z.object({ taskId: taskIdSchema, _meta: z.record(z.string(), z.unknown()).optional() }),
});
const tasksUpdateRequestSchema = z.object({
  method: z.literal("tasks/update"),
  params: z.object({
    taskId: taskIdSchema,
    inputResponses: z.record(z.string(), z.unknown()),
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
});
const tasksCancelRequestSchema = z.object({
  method: z.literal("tasks/cancel"),
  params: z.object({ taskId: taskIdSchema, _meta: z.record(z.string(), z.unknown()).optional() }),
});

export interface TaskTools {
  snapshot(callerKey?: string): Promise<unknown>;
  close(): void;
}

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
}

export function registerTaskTools(
  server: McpServer,
  options: {
    config: ServerConfig;
    taskStore?: TaskStore;
    workspaces: WorkspaceRegistry;
    processSessions: ProcessSessionManager;
    callerKey?: string;
  },
): TaskTools {
  const store = options.taskStore ?? new InMemoryTaskStore();
  const callerKey = options.callerKey ?? "anonymous";

  registerAgentTools(server, {
    taskStore: store,
    workspaces: options.workspaces,
    callerKey,
  });

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
    error: record.status === "failed" && record.error ? { code: -32603, message: record.error } : undefined,
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
    content: [{ type: "text", text: snapshot.output || `Process exited with code ${snapshot.exitCode ?? "unknown"}.` }],
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

  const spawn = async (input: ProcessInput & { instruction?: string; model?: string; thinking?: string }) => {
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
        status: snapshot.running ? "working" : record.approvalRequired ? "input_required" : "completed",
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
    const owner = callerKey;
    const record = store.get(taskId, owner);
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
        // The process may have exited between the task lookup and interrupt.
      }
    }
    return taskView(store.requestCancel(taskId, owner));
  };

  server.server.registerCapabilities({
    tasks: { requests: { tools: { call: {} } } },
  });
  server.server.setRequestHandler(serverDiscoverRequestSchema as never, async () => ({
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/tasks": {},
      },
    },
  }) as never);
  server.server.setRequestHandler(tasksGetRequestSchema as never, async (request: { params: { taskId: string; _meta?: Record<string, unknown> } }) => {
    assertTasksExtension(request.params._meta);
    return await getTask(request.params.taskId) as never;
  });
  server.server.setRequestHandler(tasksUpdateRequestSchema as never, async (request: { params: { taskId: string; inputResponses: Record<string, unknown>; _meta?: Record<string, unknown> } }) => {
    assertTasksExtension(request.params._meta);
    const record = store.get(request.params.taskId, callerKey);
    if (!record) throw new Error(`Task ${request.params.taskId} not found.`);
    if (record.status === "input_required" && Object.hasOwn(request.params.inputResponses, "review")) {
      store.update(request.params.taskId, callerKey, {
        inputResponse: JSON.stringify({ requestId: "review", response: request.params.inputResponses.review }),
        status: record.approvalRequired && record.result !== undefined ? "completed" : "working",
        statusMessage: "Input accepted.",
      });
    }
    return { resultType: "complete" } as never;
  });
  server.server.setRequestHandler(tasksCancelRequestSchema as never, async (request: { params: { taskId: string; _meta?: Record<string, unknown> } }) => {
    assertTasksExtension(request.params._meta);
    await cancelTask(request.params.taskId);
    return { resultType: "complete" } as never;
  });

  server.registerTool("worker.catalog", {
    title: "List worker runtimes",
    description: "List the execution runtimes exposed by this DevSpace instance.",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify({
      workers: [{ id: "command", label: "Workspace command worker", taskSupport: "optional", durableState: true }],
      contract: ["worker.catalog", "worker.spawn", "worker.get", "worker.send_input", "worker.resume", "worker.approve", "worker.cancel", "worker.close"],
    }) }],
    structuredContent: { workers: [{ id: "command", label: "Workspace command worker", taskSupport: "optional", durableState: true }] },
  }));

  server.registerTool("worker.spawn", {
    title: "Spawn worker",
    description: "Start a workspace command as a durable task-backed worker. DevSpace owns the process session.",
    inputSchema: {
      workspaceId: z.string().min(1),
      cmd: z.string().min(1),
      instruction: z.string().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
      requireApproval: z.boolean().optional().describe("Pause in input_required after a successful command until approved."),
      tty: z.boolean().optional(),
      columns: z.number().int().min(1).max(1_000).optional(),
      rows: z.number().int().min(1).max(1_000).optional(),
      workingDirectory: z.string().optional(),
      yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
      maxOutputTokens: z.number().int().positive().max(options.config.processOutputMaxTokens).optional(),
    },
  }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await spawn(input as ProcessInput & { instruction?: string; model?: string; thinking?: string })) }] }));

  server.registerTool("worker.get", {
    title: "Get worker",
    description: "Read a task-backed worker and its latest process snapshot.",
    inputSchema: { taskId: taskIdSchema },
  }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(await getTask(taskId)) }] }));

  server.registerTool("worker.send_input", {
    title: "Send worker input",
    description: "Send input to a running worker process and append the response to its task history.",
    inputSchema: { taskId: taskIdSchema, chars: z.string() },
  }, async ({ taskId, chars }) => {
    const owner = callerKey;
    const record = store.get(taskId, owner);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.workspaceId === undefined || record.processSessionId === undefined) {
      return { content: [{ type: "text", text: JSON.stringify(taskView(store.update(taskId, owner, { inputResponse: chars }))) }] };
    }
    const snapshot = await options.processSessions.write({
      workspaceId: record.workspaceId,
      sessionId: record.processSessionId,
      chars,
      yieldTimeMs: 250,
      maxOutputTokens: options.config.processOutputMaxTokens,
    });
    const updated = store.update(taskId, owner, {
      inputResponse: chars,
      status: snapshot.running ? "working" : record.approvalRequired ? "input_required" : "completed",
      statusMessage: !snapshot.running && record.approvalRequired
        ? "Review and approval required."
        : record.statusMessage,
      result: snapshot.running ? undefined : processResultPayload(snapshot),
    });
    return { content: [{ type: "text", text: JSON.stringify(taskView(updated, snapshot)) }] };
  });

  server.registerTool("worker.resume", {
    title: "Resume worker",
    description: "Resume a worker after an input checkpoint when a process session is still available.",
    inputSchema: { taskId: taskIdSchema },
  }, async ({ taskId }) => {
    const owner = callerKey;
    const record = store.get(taskId, owner);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status !== "input_required") throw new Error("Only input-required workers can be resumed.");
    const updated = store.update(taskId, owner, { status: "working", statusMessage: "Worker resumed." });
    return { content: [{ type: "text", text: JSON.stringify(taskView(updated)) }] };
  });

  server.registerTool("worker.approve", {
    title: "Approve worker",
    description: "Approve a worker at a review checkpoint and resume its task state.",
    inputSchema: { taskId: taskIdSchema },
  }, async ({ taskId }) => {
    const owner = callerKey;
    const record = store.get(taskId, owner);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status !== "input_required") throw new Error("Only input-required workers can be approved.");
    const updated = store.update(taskId, owner, {
      status: record.approvalRequired && record.result !== undefined ? "completed" : "working",
      statusMessage: "Review approved.",
    });
    return { content: [{ type: "text", text: JSON.stringify(taskView(updated)) }] };
  });

  server.registerTool("worker.cancel", {
    title: "Cancel worker",
    description: "Request cooperative cancellation of a worker and interrupt its process session.",
    inputSchema: { taskId: taskIdSchema },
  }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(await cancelTask(taskId)) }] }));

  server.registerTool("worker.close", {
    title: "Close worker",
    description: "Close a completed or cancelled worker task. Task history remains durable for inspection.",
    inputSchema: { taskId: taskIdSchema },
  }, async ({ taskId }) => {
    const owner = callerKey;
    const record = store.get(taskId, owner);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (record.status === "working" || record.status === "input_required") {
      throw new Error("Only terminal workers can be closed.");
    }
    return { content: [{ type: "text", text: JSON.stringify(taskView(record)) }] };
  });

  installTaskAugmentedToolResult(server, "worker.spawn");

  return {
    snapshot: async (snapshotCallerKey = callerKey) => {
      const tasks = store.list(snapshotCallerKey).map((record) => taskView(record));
      return { tasks, activeTaskIds: tasks.filter((task) => task.status === "working").map((task) => task.taskId) };
    },
    close: () => undefined,
  };
}

function installTaskAugmentedToolResult(server: McpServer, toolName: string): void {
  type RawHandler = (request: {
    params?: {
      name?: string;
      _meta?: Record<string, unknown>;
    };
  }, extra: unknown) => Promise<unknown>;
  const protocol = server.server as unknown as { _requestHandlers?: Map<string, RawHandler> };
  const original = protocol._requestHandlers?.get("tools/call");
  if (!original || !protocol._requestHandlers) {
    throw new Error("The installed MCP SDK no longer exposes the tools/call handler needed by the Tasks extension adapter.");
  }
  protocol._requestHandlers.set("tools/call", async (request, extra) => {
    const result = await original(request, extra) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    if (request.params?.name !== toolName || !hasTasksExtension(request.params._meta)) return result;
    const text = result.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error(`${toolName} did not return the task payload required by the Tasks extension.`);
    const task = JSON.parse(text) as Record<string, unknown>;
    return { ...task, resultType: "task" };
  });
}

function hasTasksExtension(meta: Record<string, unknown> | undefined): boolean {
  const clientCapabilities = meta?.["io.modelcontextprotocol/clientCapabilities"];
  if (!clientCapabilities || typeof clientCapabilities !== "object") return false;
  const extensions = (clientCapabilities as { extensions?: Record<string, unknown> }).extensions;
  return extensions?.["io.modelcontextprotocol/tasks"] !== undefined;
}

function assertTasksExtension(meta: Record<string, unknown> | undefined): void {
  if (!hasTasksExtension(meta)) {
    throw new McpError(-32003, "Missing required client capability: io.modelcontextprotocol/tasks");
  }
}
