import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const serverScript = path.resolve(import.meta.dirname, "../scripts/covspace-http.mjs");
const issuer = "http://127.0.0.1";
const resource = `${issuer}/mcp`;

async function freePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer({ port, stateDir, root, extraEnv = {} }) {
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      COVSPACE_BIND: "127.0.0.1",
      COVSPACE_PORT: String(port),
      COVSPACE_ROOT: root,
      COVSPACE_OAUTH_ISSUER: issuer,
      COVSPACE_OAUTH_STATE_DIR: stateDir,
      COVSPACE_OAUTH_OWNER_TOKEN: "owner-secret",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${issuer}:${port}/healthz`);
      if (response.ok) return { child, baseUrl: `${issuer}:${port}` };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function registerClient(baseUrl) {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector/oauth/test"] }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorize(baseUrl, clientId, scope = "covspace.read covspace.write covspace.exec covspace.git") {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/test",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope,
  });
  const page = await fetch(`${baseUrl}/oauth/authorize?${query}`);
  assert.equal(page.status, 200);
  const approval = (await page.text()).match(/name=approval value="([^"]+)"/)?.[1];
  assert.ok(approval);
  const consent = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ approval, owner_token: "owner-secret" }),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  return { code, verifier };
}

async function exchangeCode(baseUrl, clientId, code, verifier) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function refresh(baseUrl, clientId, refreshToken) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function callMcp(baseUrl, accessToken) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
}

async function initializeMcp(baseUrl, accessToken) {
  const response = await callMcp(baseUrl, accessToken);
  return { response, sessionId: response.headers.get("mcp-session-id") };
}

async function callTool(baseUrl, accessToken, sessionId, name, args = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
}

test("rotates refresh tokens, rejects reuse, and survives a server restart", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-"));
  const stateDir = path.join(temp, "state");
  const root = path.join(temp, "projects");
  await fs.promises.mkdir(root, { recursive: true });
  const port = await freePort();
  let server = await startServer({ port, stateDir, root });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });

  const client = await registerClient(server.baseUrl);
  const auth = await authorize(server.baseUrl, client.client_id);
  const initial = await exchangeCode(server.baseUrl, client.client_id, auth.code, auth.verifier);
  assert.ok(initial.access_token);
  assert.ok(initial.refresh_token);
  assert.equal((await callMcp(server.baseUrl, initial.access_token)).status, 200);

  const rotated = await refresh(server.baseUrl, client.client_id, initial.refresh_token);
  assert.equal(rotated.status, 200);
  assert.ok(rotated.body.access_token);
  assert.ok(rotated.body.refresh_token);
  assert.notEqual(rotated.body.refresh_token, initial.refresh_token);
  assert.equal((await refresh(server.baseUrl, client.client_id, initial.refresh_token)).status, 400);
  assert.equal((await refresh(server.baseUrl, client.client_id, rotated.body.refresh_token)).status, 400);

  const secondAuth = await authorize(server.baseUrl, client.client_id);
  const restartCandidate = await exchangeCode(server.baseUrl, client.client_id, secondAuth.code, secondAuth.verifier);

  await stopServer(server.child);
  server = await startServer({ port, stateDir, root });
  assert.equal((await callMcp(server.baseUrl, restartCandidate.access_token)).status, 200);
  const afterRestart = await refresh(server.baseUrl, client.client_id, restartCandidate.refresh_token);
  assert.equal(afterRestart.status, 200);
  assert.ok(afterRestart.body.refresh_token);

  const stored = JSON.parse(await fs.promises.readFile(path.join(stateDir, "oauth-tokens.json"), "utf8"));
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes(initial.access_token), false);
  assert.equal(serialized.includes(initial.refresh_token), false);
  assert.equal(serialized.includes(afterRestart.body.refresh_token), false);
});

test("advertises refresh_token support in OAuth metadata and DCR", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-meta-"));
  const port = await freePort();
  const server = await startServer({ port, stateDir: path.join(temp, "state"), root: path.join(temp, "projects") });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const metadata = await (await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  const client = await registerClient(server.baseUrl);
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
});

test("serializes concurrent refresh attempts and revokes the token family on replay", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-race-"));
  const port = await freePort();
  const server = await startServer({ port, stateDir: path.join(temp, "state"), root: path.join(temp, "projects") });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const client = await registerClient(server.baseUrl);
  const auth = await authorize(server.baseUrl, client.client_id);
  const initial = await exchangeCode(server.baseUrl, client.client_id, auth.code, auth.verifier);
  const attempts = await Promise.all([
    refresh(server.baseUrl, client.client_id, initial.refresh_token),
    refresh(server.baseUrl, client.client_id, initial.refresh_token),
  ]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 400]);
  const successor = attempts.find(({ status }) => status === 200).body.refresh_token;
  assert.equal((await refresh(server.baseUrl, client.client_id, successor)).status, 400);
});

test("rejects malformed PKCE without crashing the token endpoint", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-pkce-"));
  const port = await freePort();
  const server = await startServer({ port, stateDir: path.join(temp, "state"), root: path.join(temp, "projects") });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const client = await registerClient(server.baseUrl);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/test",
    response_type: "code",
    code_challenge: "too-short",
    code_challenge_method: "S256",
    resource,
  });
  const page = await fetch(`${server.baseUrl}/oauth/authorize?${query}`);
  const approval = (await page.text()).match(/name=approval value="([^"]+)"/)?.[1];
  const consent = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ approval, owner_token: "owner-secret" }),
  });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const token = await fetch(`${server.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, resource }),
  });
  assert.equal(token.status, 400);
  assert.deepEqual(await token.json(), { error: "invalid_grant" });
  assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 200);
});

test("refresh tokens outlive authorization codes and keep their original expiry across rotation", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-ttl-"));
  const port = await freePort();
  const stateDir = path.join(temp, "state");
  const server = await startServer({
    port,
    stateDir,
    root: path.join(temp, "projects"),
    extraEnv: { COVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "3600" },
  });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const client = await registerClient(server.baseUrl);
  const auth = await authorize(server.baseUrl, client.client_id);
  const initial = await exchangeCode(server.baseUrl, client.client_id, auth.code, auth.verifier);
  const storedBefore = JSON.parse(await fs.promises.readFile(path.join(stateDir, "oauth-tokens.json"), "utf8"));
  const firstExpiry = storedBefore.refreshTokens[0].expiresAt;
  assert.ok(firstExpiry > Date.now() + 30 * 60 * 1000);
  const rotated = await refresh(server.baseUrl, client.client_id, initial.refresh_token);
  assert.equal(rotated.status, 200);
  const storedAfter = JSON.parse(await fs.promises.readFile(path.join(stateDir, "oauth-tokens.json"), "utf8"));
  assert.equal(storedAfter.refreshTokens[0].expiresAt, firstExpiry);
});

test("enforces the scope assigned to the access token", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-scope-"));
  const port = await freePort();
  const server = await startServer({ port, stateDir: path.join(temp, "state"), root: path.join(temp, "projects") });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const client = await registerClient(server.baseUrl);
  const auth = await authorize(server.baseUrl, client.client_id, "covspace.read");
  const tokens = await exchangeCode(server.baseUrl, client.client_id, auth.code, auth.verifier);
  const initialized = await initializeMcp(server.baseUrl, tokens.access_token);
  assert.equal(initialized.response.status, 200);
  assert.equal((await callTool(server.baseUrl, tokens.access_token, initialized.sessionId, "covspace_projects")).status, 200);
  const denied = await callTool(server.baseUrl, tokens.access_token, initialized.sessionId, "write", { workspaceId: "ws_opencodex", path: "x", content: "x" });
  assert.equal(denied.status, 403);
  assert.match(JSON.stringify(await denied.json()), /Missing required scope: covspace\.write/);
});

test("rejects oversized unauthenticated OAuth bodies without terminating the server", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "covspace-oauth-body-"));
  const port = await freePort();
  const server = await startServer({
    port,
    stateDir: path.join(temp, "state"),
    root: path.join(temp, "projects"),
    extraEnv: { COVSPACE_MAX_BODY_BYTES: "128" },
  });
  t.after(async () => {
    await stopServer(server.child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  const response = await fetch(`${server.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://example.com/"], padding: "x".repeat(256) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 200);
});
