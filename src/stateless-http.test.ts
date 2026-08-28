import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

test("trusted proxy mode accepts only loopback proxy hops", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-trust-proxy-test-"));
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_OAUTH_OWNER_TOKEN: randomBytes(32).toString("base64url"),
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1",
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_TRUST_PROXY: "1",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    HOST: "127.0.0.1",
    PORT: "1",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "false",
    DEVSPACE_LOG_TOOL_CALLS: "false",
  });
  const running = createServer(config);

  try {
    assert.equal(running.app.get("trust proxy"), "loopback");
    const trustProxy = running.app.get("trust proxy fn") as
      | ((address: string, hop: number) => boolean)
      | undefined;
    assert.ok(trustProxy);
    assert.equal(trustProxy("127.0.0.1", 0), true);
    assert.equal(trustProxy("::1", 0), true);
    assert.equal(trustProxy("203.0.113.10", 0), false);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stateless authenticated HTTP requests share workspaces without session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-test-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  const agentDir = join(root, "agent");
  let running: ReturnType<typeof createServer> | undefined;
  let httpServer: Server | undefined;

  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "README.md"), "stateless HTTP works\n");

    const config = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: randomBytes(32).toString("base64url"),
      DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1",
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_TOOL_MODE: "full",
      DEVSPACE_WIDGETS: "off",
      DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
      HOST: "127.0.0.1",
      PORT: "1",
      DEVSPACE_LOG_LEVEL: "silent",
      DEVSPACE_LOG_REQUESTS: "false",
      DEVSPACE_LOG_TOOL_CALLS: "false",
    });
    const accessToken = await issueAccessToken(config);

    running = createServer(config);
    httpServer = running.app.listen(0, config.host);
    await waitForListening(httpServer);
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    let endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const workstationEndpoint = `http://127.0.0.1:${address.port}`;
    const taskCapabilityMeta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      },
    };

    const projectionResponse = await fetch(`${workstationEndpoint}/worker.snapshot`, {
      headers: { origin: "chrome-extension://abcdefghijklmnop" },
    });
    assert.equal(projectionResponse.status, 200);
    assert.equal(projectionResponse.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
    const projection = await projectionResponse.json() as { connected?: boolean; tasks?: unknown[] };
    assert.equal(projection.connected, true);
    assert.deepEqual(projection.tasks, []);

    const initializeResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "devspace-stateless-http-test",
          version: "1.0.0",
        },
      },
    });
    assert.equal(initializeResponse.status, 200);
    assert.equal(initializeResponse.headers.get("mcp-session-id"), null);
    const initializeBody = await readJsonRpc(initializeResponse);
    assert.equal(initializeBody.id, 1);
    assert.ok(initializeBody.result);

    // The former stateful route rejects this request with 400 because it has no session header.
    const openResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "open_workspace",
        arguments: { path: project },
      },
    });
    assert.equal(openResponse.status, 200);
    assert.equal(openResponse.headers.get("mcp-session-id"), null);
    const openBody = await readJsonRpc(openResponse);
    assert.equal(openBody.id, 2);
    assert.ok(openBody.result);
    const workspaceId = getStructuredContent(openBody).workspaceId;
    assert.equal(typeof workspaceId, "string");

    const discoverResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 20,
      method: "server/discover",
      params: {},
    });
    const discoverBody = await readJsonRpc(discoverResponse);
    assert.deepEqual(
      (discoverBody.result?.capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions?.["io.modelcontextprotocol/tasks"],
      {},
    );

    const spawnResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "worker.spawn",
        arguments: {
          workspaceId,
          cmd: "node -e \"console.log('READY_FOR_HTTP_REVIEW')\"",
          instruction: "Wait for approval",
          requireApproval: true,
          yieldTimeMs: 30_000,
        },
        _meta: taskCapabilityMeta,
      },
    });
    const spawnBody = await readJsonRpc(spawnResponse);
    assert.equal(spawnBody.result?.resultType, "task");
    assert.equal(spawnBody.result?.status, "input_required");
    const taskId = String(spawnBody.result?.taskId);

    const missingCapabilityResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 28,
      method: "tasks/get",
      params: { taskId },
    });
    assert.equal((await readJsonRpc(missingCapabilityResponse, true)).error?.code, -32003);

    const taskResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 22,
      method: "tasks/get",
      params: { taskId, _meta: taskCapabilityMeta },
    });
    const taskBody = await readJsonRpc(taskResponse);
    assert.equal(taskBody.result?.taskId, taskId);
    assert.equal(taskBody.result?.status, "input_required");
    assert.equal(taskBody.result?.resultType, "complete");

    const updateResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 23,
      method: "tasks/update",
      params: { taskId, inputResponses: { review: { action: "approve" } }, _meta: taskCapabilityMeta },
    });
    assert.deepEqual((await readJsonRpc(updateResponse)).result, { resultType: "complete" });

    const cancelResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 24,
      method: "tasks/cancel",
      params: { taskId, _meta: taskCapabilityMeta },
    });
    assert.deepEqual((await readJsonRpc(cancelResponse)).result, { resultType: "complete" });

    const commandSpawnResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "worker.spawn",
        arguments: {
          workspaceId,
          cmd: "node -e \"setTimeout(() => console.log('HTTP_TASK_DONE'), 50)\"",
          yieldTimeMs: 0,
        },
        _meta: taskCapabilityMeta,
      },
    });
    const commandSpawnBody = await readJsonRpc(commandSpawnResponse);
    const commandTaskId = String(commandSpawnBody.result?.taskId);
    let commandGetBody: JsonRpcBody | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const commandGetResponse = await postMcp(endpoint, accessToken, {
        jsonrpc: "2.0",
        id: 27,
        method: "tasks/get",
        params: { taskId: commandTaskId, _meta: taskCapabilityMeta },
      });
      commandGetBody = await readJsonRpc(commandGetResponse);
      if (commandGetBody.result?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(commandGetBody?.result?.status, "completed");
    assert.match(JSON.stringify(commandGetBody?.result?.result), /HTTP_TASK_DONE/);

    // A stale stateful session would be rejected with 404; stateless requests ignore it.
    const readResponse = await postMcp(
      endpoint,
      accessToken,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read",
          arguments: { workspaceId, path: "README.md" },
        },
      },
      "deliberately-stale-session-id",
    );
    assert.equal(readResponse.status, 200);
    assert.equal(readResponse.headers.get("mcp-session-id"), null);
    const readBody = await readJsonRpc(readResponse);
    assert.equal(readBody.id, 3);
    assert.ok(readBody.result);
    assert.equal(getStructuredContent(readBody).result, "stateless HTTP works\n");

    await closeHttpServer(httpServer);
    httpServer = undefined;
    await running.close();
    running = undefined;

    running = createServer(config);
    httpServer = running.app.listen(0, config.host);
    await waitForListening(httpServer);
    const restoredAddress = httpServer.address();
    assert.ok(restoredAddress && typeof restoredAddress === "object");
    endpoint = `http://127.0.0.1:${restoredAddress.port}/mcp`;
    const restoredTaskResponse = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 25,
      method: "tasks/get",
      params: { taskId, _meta: taskCapabilityMeta },
    });
    const restoredTaskBody = await readJsonRpc(restoredTaskResponse);
    assert.equal(restoredTaskBody.result?.taskId, taskId);
    assert.equal(restoredTaskBody.result?.status, "completed");

    const getResponse = await fetch(endpoint, {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
    });
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get("allow"), "POST");
    assert.equal(getResponse.headers.get("mcp-session-id"), null);
  } finally {
    if (httpServer) await closeHttpServer(httpServer);
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function issueAccessToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const provider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  try {
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "DevSpace stateless HTTP test",
    });
    assert.ok(client);

    const authorizationCode = `code-${randomUUID()}`;
    provider["codes"].set(authorizationCode, {
      clientId: client.client_id,
      params: {
        redirectUri,
        codeChallenge: "test-code-challenge",
        scopes: config.oauth.scopes,
        resource: mcpUrl,
      },
      expiresAtMs: Date.now() + 60_000,
    });
    const issued = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      redirectUri,
      mcpUrl,
    );
    return issued.access_token;
  } finally {
    provider.close();
  }
}

async function postMcp(
  endpoint: string,
  accessToken: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  const method = typeof body.method === "string" ? body.method : undefined;
  const params = body.params as { taskId?: unknown } | undefined;
  if (method?.startsWith("tasks/") && typeof params?.taskId === "string") {
    headers.set("mcp-method", method);
    headers.set("mcp-name", params.taskId);
  }
  if (sessionId !== undefined) headers.set("mcp-session-id", sessionId);

  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface JsonRpcBody {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

async function readJsonRpc(response: Response, allowError = false): Promise<JsonRpcBody> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const sseData = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice("data: ".length)
    : undefined;
  const body = JSON.parse(sseData ?? text) as JsonRpcBody;
  assert.equal(body.jsonrpc, "2.0");
  if (!allowError) assert.equal(body.error, undefined);
  return body;
}

function getStructuredContent(body: JsonRpcBody): Record<string, unknown> {
  const structuredContent = body.result?.structuredContent;
  assert.ok(structuredContent && typeof structuredContent === "object");
  return structuredContent as Record<string, unknown>;
}

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}