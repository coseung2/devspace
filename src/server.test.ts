import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const openToolMeta = openTool?._meta as Record<string, unknown> | undefined;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  assert.equal(outputProperties && "agentProviders" in outputProperties, false);
  assert.equal(outputProperties && "agents" in outputProperties, false);
  assert.equal(openToolMeta?.["openai/toolInvocation/invoking"], "Opening workspace...");
  assert.equal(openToolMeta?.["openai/toolInvocation/invoked"], "Workspace ready");

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.equal(
    (firstStructured.agentsFiles as Array<{ content: string }>).some((file) => file.content === "project instructions\n"),
    true,
  );
  assert.equal(
    (firstStructured.availableAgentsFiles as Array<{ path: string }>).some((file) => file.path === "nested/AGENTS.md"),
    true,
  );
  assert.equal(
    (firstStructured.skills as Array<{ name: string }>).some((skill) => skill.name === "project-skill"),
    true,
  );
  assert.equal("agentProviders" in firstStructured, false);
  assert.equal("agents" in firstStructured, false);
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /Continue with this workspaceId/);
  assert.match(repeatedText, /already provided for this workspace/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.equal("agentProviders" in card, false);
  assert.equal("agents" in card, false);
});

test("workspace reuse is the normal model path", async (t) => {
  const context = await fixture(t);
  const instructions = context.client.getInstructions();
  assert.ok(instructions);
  assert.match(instructions, /During continued work in the same project or worktree, do not call open_workspace again/);
  assert.match(instructions, /when the current workspaceId is rejected/);
  assert.match(instructions, /call prepare_task_context once before reading or changing project files/);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  assert.ok(openTool?.description);
  assert.match(openTool.description, /reuse the existing workspaceId instead of calling this tool again/);

  for (const tool of tools.tools.filter((candidate) => candidate.name !== "open_workspace")) {
    const modelContract = JSON.stringify({
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    assert.doesNotMatch(modelContract, /Call open_workspace first/);
    assert.doesNotMatch(modelContract, /Workspace identifier returned by open_workspace/);
  }
});

test("task-context tools persist centrally and return only matching entries", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-1");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "prepare_task_context"));
  assert.ok(tools.tools.some((tool) => tool.name === "set_task_context_entry"));

  await context.client.callTool({
    name: "set_task_context_entry",
    arguments: {
      workspaceId,
      scope: "project",
      entry: {
        id: "release-evidence",
        title: "Release evidence",
        kind: "rule",
        priority: 50,
        when: { keywords: ["release", "package"] },
        content: "Use the deterministic package output as release evidence.",
      },
    },
  });
  await context.client.callTool({
    name: "set_task_context_entry",
    arguments: {
      workspaceId,
      scope: "project",
      entry: {
        id: "subtitle-work",
        title: "Subtitle work",
        kind: "knowledge",
        when: { keywords: ["subtitle"] },
        content: "This unrelated entry must not be selected.",
      },
    },
  });

  const prepared = await context.client.callTool({
    name: "prepare_task_context",
    arguments: {
      workspaceId,
      task: "Build and verify the release package.",
      paths: ["scripts/build-package.ts"],
    },
  });
  const preparedStructured = structuredContent(prepared);
  const matchedEntries = preparedStructured.matchedEntries as Array<{ id: string }>;

  assert.deepEqual(matchedEntries.map((entry) => entry.id), ["release-evidence"]);
  assert.match(responseText(prepared), /deterministic package output/);
  assert.doesNotMatch(responseText(prepared), /Subtitle work/);
  assert.doesNotMatch(responseText(prepared), /unrelated entry/);
  assert.equal(preparedStructured.truncated, false);
});

test("changes mode keeps workspace execution independent from UI resources", async (t) => {
  const context = await fixture(t, { widgets: "changes" });
  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const showChangesTool = tools.tools.find((tool) => tool.name === "show_changes");
  const openMeta = openTool?._meta as Record<string, unknown> | undefined;
  const showChangesMeta = showChangesTool?._meta as Record<string, unknown> | undefined;

  assert.equal(openMeta?.ui, undefined);
  assert.equal(openMeta?.["openai/toolInvocation/invoking"], "Opening workspace...");
  assert.deepEqual(showChangesMeta?.ui, {
    resourceUri: "ui://devspace/workspace-app.html",
    visibility: ["model"],
  });
});

test("web output profile advertises bounded process responses", async (t) => {
  const context = await fixture(t, { outputProfile: "web", toolMode: "codex" });
  const tools = await context.client.listTools();
  const execTool = tools.tools.find((tool) => tool.name === "exec_command");
  const maxOutputTokens = ((execTool?.inputSchema as {
    properties?: { maxOutputTokens?: { maximum?: number } };
  } | undefined)?.properties?.maxOutputTokens?.maximum);

  assert.equal(maxOutputTokens, 12_000);
  assert.match(context.client.getInstructions() ?? "", /3,000-token default and a 12,000-token maximum/);

  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const command = process.platform === "win32"
    ? `"${process.execPath}" -e "console.log('z'.repeat(20000))"`
    : `${JSON.stringify(process.execPath)} -e "console.log('z'.repeat(20000))"`;
  const result = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: command, yieldTimeMs: 2_000 },
  });

  assert.equal(structuredContent(result).outputTruncated, true);
  assert.ok(responseText(result).length <= 13_000);
});

test("non-widget process and read responses omit duplicate card payloads", async (t) => {
  const context = await fixture(t, { git: true, widgets: "changes", toolMode: "codex" });
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "README.md" },
  });
  assert.equal((read._meta as Record<string, unknown> | undefined)?.card, undefined);

  const command = process.platform === "win32"
    ? `"${process.execPath}" -e "console.log('ok')"`
    : `${JSON.stringify(process.execPath)} -e "console.log('ok')"`;
  const exec = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: command, yieldTimeMs: 2_000 },
  });
  assert.equal((exec._meta as Record<string, unknown> | undefined)?.card, undefined);
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.equal("agentProviders" in structured, false);
    assert.equal("agents" in structured, false);
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /Continue with this workspaceId/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /Continue with this workspaceId/);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("open_workspace accepts configured aliases", async (t) => {
  const context = await fixture(t);
  const aliasConfig = { ...context.config, workspaceAliases: { aura: context.project } };
  const aliasServer = createMcpServer(
    aliasConfig,
    new WorkspaceRegistry(aliasConfig),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-alias-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), aliasServer.connect(serverTransport)]);
  t.after(async () => { await client.close(); await aliasServer.close(); });

  const result = await client.callTool({ name: "open_workspace", arguments: { alias: "aura" } });
  assert.doesNotMatch(responseText(result), /Pass either path or alias/);
  assert.match(responseText(result), /Root:/);

  const pathAliasResult = await client.callTool({
    name: "open_workspace",
    arguments: { path: "aura", mode: "checkout" },
  });
  assert.equal(pathAliasResult.isError, undefined);
  assert.match(responseText(pathAliasResult), /Root:/);
  assert.equal(structuredContent(pathAliasResult).root, context.project);

  for (const path of ["~/aura", "/workspace/aura", String.raw`C:\workspace\aura`]) {
    const trailingAliasResult = await client.callTool({
      name: "open_workspace",
      arguments: { path, mode: "checkout" },
    });
    assert.equal(trailingAliasResult.isError, undefined, path);
    assert.equal(structuredContent(trailingAliasResult).root, context.project, path);
  }
});

test("open_workspace failures return visible error card metadata", async (t) => {
  const context = await fixture(t);
  const result = await context.client.callTool({
    name: "open_workspace",
    arguments: { alias: "missing-project" },
  });

  assert.equal(result.isError, true);
  assert.match(responseText(result), /Unknown workspace alias: missing-project/);
  const card = responseCard(result);
  assert.equal(card.status, "error");
  assert.equal(card.path, "missing-project");
  assert.match(String(card.error), /Available aliases|Configure workspaceAliases first/);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /Continue with this workspaceId/);
  } finally {
    await closeRestored();
  }
});

test("worker.spawn returns a durable Tasks extension handle and supports get update cancel", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const taskSchema = z.object({
    resultType: z.enum(["task", "complete"]).optional(),
    taskId: z.string(),
    status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
    lastUpdatedAt: z.string(),
    ttlMs: z.number().nullable(),
  }).passthrough();
  const taskCapabilityMeta = {
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
  };

  const created = await context.client.request({
    method: "tools/call",
    params: {
      name: "worker.spawn",
      arguments: {
        workspaceId,
        cmd: "node -e \"console.log('READY_FOR_REVIEW')\"",
        instruction: "Wait for review input",
        requireApproval: true,
        yieldTimeMs: 30_000,
      },
      _meta: taskCapabilityMeta,
    },
  }, taskSchema);
  assert.equal(created.resultType, "task");
  assert.equal(created.status, "input_required");

  await assert.rejects(
    context.client.request({
      method: "tasks/get",
      params: { taskId: created.taskId },
    }, z.any()),
    /Missing required client capability/,
  );

  const fetched = await context.client.request({
    method: "tasks/get",
    params: { taskId: created.taskId, _meta: taskCapabilityMeta },
  }, taskSchema);
  assert.equal(fetched.taskId, created.taskId);
  assert.equal(fetched.status, "input_required");
  assert.equal(fetched.result, undefined);

  const emptySchema = z.object({ resultType: z.literal("complete") }).passthrough();
  await context.client.request({
    method: "tasks/update",
    params: {
      taskId: created.taskId,
      inputResponses: { unknown: { action: "ignore" } },
      _meta: taskCapabilityMeta,
    },
  }, emptySchema);
  const stillWaiting = await context.client.request({
    method: "tasks/get",
    params: { taskId: created.taskId, _meta: taskCapabilityMeta },
  }, taskSchema);
  assert.equal(stillWaiting.status, "input_required");

  await context.client.request({
    method: "tasks/update",
    params: {
      taskId: created.taskId,
      inputResponses: { review: { action: "approve" } },
      _meta: taskCapabilityMeta,
    },
  }, emptySchema);
  const resumed = await context.client.request({
    method: "tasks/get",
    params: { taskId: created.taskId, _meta: taskCapabilityMeta },
  }, taskSchema);
  assert.equal(resumed.status, "completed");
  assert.ok(resumed.result);

  await context.client.request({
    method: "tasks/cancel",
    params: { taskId: created.taskId, _meta: taskCapabilityMeta },
  }, emptySchema);
  const cancelled = await context.client.request({
    method: "tasks/get",
    params: { taskId: created.taskId, _meta: taskCapabilityMeta },
  }, taskSchema);
  assert.equal(cancelled.status, "completed");

  const cancellable = await context.client.request({
    method: "tools/call",
    params: {
      name: "worker.spawn",
      arguments: {
        workspaceId,
        cmd: "node -e \"setTimeout(() => console.log('TOO_LATE'), 5000)\"",
        yieldTimeMs: 0,
      },
      _meta: taskCapabilityMeta,
    },
  }, taskSchema);
  await context.client.request({
    method: "tasks/cancel",
    params: { taskId: cancellable.taskId, _meta: taskCapabilityMeta },
  }, emptySchema);
  const cooperativelyCancelled = await context.client.request({
    method: "tasks/get",
    params: { taskId: cancellable.taskId, _meta: taskCapabilityMeta },
  }, taskSchema);
  assert.equal(cooperativelyCancelled.status, "cancelled");
});

test("task-backed command worker exposes terminal output and completes through worker.get", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const spawned = await context.client.callTool({
    name: "worker.spawn",
    arguments: {
      workspaceId,
      cmd: "node -e \"setTimeout(() => console.log('TASK_DONE'), 50)\"",
      yieldTimeMs: 0,
    },
  });
  const task = JSON.parse(responseText(spawned)) as { taskId: string };
  await new Promise((resolve) => setTimeout(resolve, 150));
  const fetched = await context.client.callTool({
    name: "worker.get",
    arguments: { taskId: task.taskId },
  });
  const completed = JSON.parse(responseText(fetched)) as {
    status: string;
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(completed.status, "completed");
  assert.match(completed.result?.content?.[0]?.text ?? "", /TASK_DONE/);
});

test("a non-zero worker command is a completed tool result with isError", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const spawned = await context.client.callTool({
    name: "worker.spawn",
    arguments: {
      workspaceId,
      cmd: "node -e \"process.exit(7)\"",
      yieldTimeMs: 30_000,
    },
  });
  const task = JSON.parse(responseText(spawned)) as {
    status: string;
    result?: { isError?: boolean; structuredContent?: { exitCode?: number } };
  };
  assert.equal(task.status, "completed");
  assert.equal(task.result?.isError, true);
  assert.equal(task.result?.structuredContent?.exitCode, 7);
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    widgets?: "off" | "changes" | "full";
    toolMode?: "minimal" | "full" | "codex";
    outputProfile?: "default" | "web";
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, "nested"), { recursive: true });
  await mkdir(join(project, ".agents", "skills", "project-skill"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(project, ".agents", "skills", "project-skill", "SKILL.md"), [
    "---",
    "name: project-skill",
    "description: Project skill description.",
    "---",
    "",
    "# Project Skill",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: options.widgets ?? "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_OUTPUT_PROFILE: options.outputProfile ?? "default",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager({
      defaultMaxOutputTokens: config.processOutputDefaultTokens,
      maxOutputTokens: config.processOutputMaxTokens,
    }),
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
