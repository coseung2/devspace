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
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;

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

async function readJsonRpc(response: Response): Promise<JsonRpcBody> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const sseData = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice("data: ".length)
    : undefined;
  const body = JSON.parse(sseData ?? text) as JsonRpcBody;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error, undefined);
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
