import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import {
  prepareTaskContext,
  setTaskContextEntry,
  type TaskContextKind,
  type TaskContextScope,
} from "./task-context-harness.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const TASK_CONTEXT_SERVER_INSTRUCTION =
  " For each new substantive user task in an open workspace, call prepare_task_context once before reading or changing project files, passing the current user request and any already-known workspace-relative path hints. Call it again only when the task materially changes or newly discovered paths could change context selection. Apply only the matched context returned by the tool; do not infer, enumerate, or retrieve unmatched harness entries. An empty selection means proceed normally with repository instructions and workspace inspection.";

const taskContextKindSchema = z.enum(["rule", "decision", "knowledge", "procedure", "note"]);
const taskContextScopeSchema = z.enum(["global", "project"]);
const taskContextWhenSchema = z.object({
  always: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(128)).max(64).optional(),
  allKeywords: z.array(z.string().min(1).max(128)).max(64).optional(),
  patterns: z.array(z.string().min(1).max(512)).max(64).optional(),
  paths: z.array(z.string().min(1).max(512)).max(64).optional(),
});
const matchedEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: taskContextKindSchema,
  scope: taskContextScopeSchema,
  source: z.string(),
  priority: z.number(),
  truncated: z.boolean(),
});

const READ_TOOL_META = {
  _meta: {
    "openai/toolInvocation/invoking": "Selecting task context...",
    "openai/toolInvocation/invoked": "Task context ready",
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const WRITE_TOOL_META = {
  _meta: {
    "openai/toolInvocation/invoking": "Saving task context...",
    "openai/toolInvocation/invoked": "Task context saved",
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function registerTaskContextTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  registerAppTool(
    server,
    "prepare_task_context",
    {
      title: "Prepare task context",
      description:
        "Select only the DevSpace harness rules, decisions, knowledge, and procedures relevant to the current task. Call this once before substantive work in an open workspace and again only when the task materially changes or newly discovered paths could affect selection. Unmatched harness entries are never returned.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace to prepare context for."),
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe("The current user request, preserved closely enough for positive trigger matching."),
        paths: z
          .array(z.string().min(1).max(1_024))
          .max(50)
          .optional()
          .describe("Already-known workspace-relative paths that may narrow context selection."),
      },
      outputSchema: {
        result: z.string(),
        context: z.string(),
        projectKey: z.string(),
        scopes: z.array(taskContextScopeSchema),
        matchedEntries: z.array(matchedEntrySchema),
        diagnostics: z.array(z.string()),
        truncated: z.boolean(),
      },
      ...READ_TOOL_META,
    },
    async ({ workspaceId, task, paths }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        const prepared = await prepareTaskContext(config, workspace, { task, paths });
        const result = prepared.context || [
          "[DevSpace selected task context]",
          "No matching task-context entries were selected. Continue with repository instructions and normal workspace inspection.",
        ].join("\n");
        logTaskContextTool(config, {
          tool: "prepare_task_context",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          matchedEntries: prepared.matchedEntries.length,
          scopes: prepared.scopes,
          diagnostics: prepared.diagnostics.length,
          truncated: prepared.truncated,
        });
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: {
            result,
            context: prepared.context,
            projectKey: prepared.projectKey,
            scopes: prepared.scopes,
            matchedEntries: prepared.matchedEntries,
            diagnostics: prepared.diagnostics,
            truncated: prepared.truncated,
          },
        };
      } catch (error) {
        const message = `Task context could not be prepared: ${errorMessage(error)}. Continue normally with repository instructions.`;
        logTaskContextTool(config, {
          tool: "prepare_task_context",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: errorMessage(error),
        });
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: {
            result: message,
            context: "",
            projectKey: "unavailable",
            scopes: [],
            matchedEntries: [],
            diagnostics: [errorMessage(error)],
            truncated: false,
          },
        };
      }
    },
  );

  registerAppTool(
    server,
    "set_task_context_entry",
    {
      title: "Set task context entry",
      description:
        "Create or replace one DevSpace harness entry in global or project scope. Use this only when the user explicitly asks to persist context or explicitly approves the exact title, triggers, and content. Do not infer persistence from an ordinary task, correction, or implementation decision.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace whose project identity owns the entry."),
        scope: taskContextScopeSchema
          .optional()
          .describe("Defaults to project. Global entries affect every workspace and require explicit approval."),
        entry: z.object({
          id: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
            .describe("Stable entry identifier."),
          title: z.string().min(1).max(200),
          kind: taskContextKindSchema,
          priority: z.number().int().min(-1_000).max(1_000).optional(),
          when: taskContextWhenSchema.describe("Positive task or path triggers. At least one is required."),
          content: z.string().min(1).max(64_000),
        }),
      },
      outputSchema: {
        result: z.string(),
        projectKey: z.string(),
        scope: taskContextScopeSchema,
        id: z.string(),
        title: z.string(),
        kind: taskContextKindSchema,
        source: z.string(),
      },
      ...WRITE_TOOL_META,
    },
    async ({ workspaceId, scope, entry }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        const stored = await setTaskContextEntry(config, workspace, {
          scope: scope as TaskContextScope | undefined,
          entry: {
            ...entry,
            kind: entry.kind as TaskContextKind,
          },
        });
        const result = `Stored ${stored.scope} task-context entry "${stored.id}" at ${stored.source}.`;
        logTaskContextTool(config, {
          tool: "set_task_context_entry",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          scope: stored.scope,
          entryId: stored.id,
        });
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: {
            result,
            ...stored,
          },
        };
      } catch (error) {
        const message = `Task-context entry was not stored: ${errorMessage(error)}`;
        logTaskContextTool(config, {
          tool: "set_task_context_entry",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: errorMessage(error),
        });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
}

function logTaskContextTool(
  config: ServerConfig,
  fields: Record<string, unknown> & {
    tool: string;
    workspaceId: string;
    success: boolean;
    durationMs: number;
  },
): void {
  if (!config.logging.toolCalls) return;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", fields);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
