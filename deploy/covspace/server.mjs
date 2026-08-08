import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const host = process.env.COVSPACE_BIND || "127.0.0.1";
const port = Number(process.env.COVSPACE_PORT || 8788);
const root = path.resolve(process.env.COVSPACE_ROOT || "/home/ubuntu/covspace");
const token = process.env.COVSPACE_TOKEN || (
  process.env.COVSPACE_TOKEN_FILE
    ? fs.readFileSync(process.env.COVSPACE_TOKEN_FILE, "utf8").trim()
    : ""
);
const oauthIssuer = process.env.COVSPACE_OAUTH_ISSUER || "https://testauram-covspace.tail4cbe57.ts.net";
const oauthResource = `${oauthIssuer}/mcp`;
const oauthStateDir = process.env.COVSPACE_OAUTH_STATE_DIR || "/var/lib/covspace-mcp";
const oauthClientId = process.env.COVSPACE_OAUTH_CLIENT_ID || "covspace-chatgpt";
const oauthClientSecret = process.env.COVSPACE_OAUTH_CLIENT_SECRET || "";
const oauthOwnerToken = process.env.COVSPACE_OAUTH_OWNER_TOKEN || "";
const oauthAccessTokenTtlSeconds = Number(process.env.COVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS || 3600);
const oauthRefreshTokenTtlSeconds = Number(process.env.COVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS || 365 * 24 * 60 * 60);
const oauthScopes = ["covspace.read", "covspace.write", "covspace.exec", "covspace.git"];
const oauthCodes = new Map();
const oauthAccessTokens = new Map();
const oauthRefreshTokens = new Map();
const oauthRefreshTokenTombstones = new Map();
const oauthRefreshFamilies = new Map();
const oauthClients = new Map();
let oauthTokenPersistence = Promise.resolve();
let oauthRefreshMutation = Promise.resolve();

function serializeRefreshMutation(operation) {
  const next = oauthRefreshMutation.then(operation);
  oauthRefreshMutation = next.catch(() => {});
  return next;
}

function restoreMap(target, snapshot) {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

async function loadOAuthClients() {
  try {
    const stored = JSON.parse(await fs.promises.readFile(path.join(oauthStateDir, "oauth-clients.json"), "utf8"));
    for (const client of stored) if (client?.clientId && Array.isArray(client.redirectUris)) oauthClients.set(client.clientId, client);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Unable to load OAuth clients: ${error.message}`);
  }
  if (!oauthClients.has(oauthClientId)) oauthClients.set(oauthClientId, {
    clientId: oauthClientId,
    redirectUris: [],
    tokenEndpointAuthMethod: "none",
  });
}

async function persistOAuthClients() {
  await fs.promises.mkdir(oauthStateDir, { recursive: true });
  const clients = Array.from(oauthClients.values()).map(({ clientId, redirectUris, tokenEndpointAuthMethod, clientName }) => ({
    clientId, redirectUris, tokenEndpointAuthMethod, clientName,
  }));
  await fs.promises.writeFile(path.join(oauthStateDir, "oauth-clients.json"), `${JSON.stringify(clients, null, 2)}\n`, { mode: 0o600 });
}

async function loadOAuthTokens() {
  try {
    const stored = JSON.parse(await fs.promises.readFile(path.join(oauthStateDir, "oauth-tokens.json"), "utf8"));
    const now = Date.now();
    for (const grant of stored.accessTokens || []) {
      if (grant?.digest && grant.expiresAt > now) oauthAccessTokens.set(grant.digest, grant);
    }
    for (const grant of stored.refreshTokens || []) {
      if (grant?.digest && grant.expiresAt > now && grant.familyId) oauthRefreshTokens.set(grant.digest, grant);
    }
    for (const tombstone of stored.refreshTokenTombstones || []) {
      if (tombstone?.digest && tombstone.expiresAt > now && tombstone.familyId) oauthRefreshTokenTombstones.set(tombstone.digest, tombstone);
    }
    for (const family of stored.refreshFamilies || []) {
      if (family?.familyId && family.expiresAt > now) oauthRefreshFamilies.set(family.familyId, family);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Unable to load OAuth tokens: ${error.message}`);
  }
}

async function persistOAuthTokens() {
  const operation = oauthTokenPersistence.then(async () => {
    await fs.promises.mkdir(oauthStateDir, { recursive: true });
    const now = Date.now();
    const active = (entries) => Array.from(entries, ([digest, grant]) => ({ digest, ...grant }))
      .filter((grant) => grant.expiresAt > now);
    const target = path.join(oauthStateDir, "oauth-tokens.json");
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, `${JSON.stringify({
      accessTokens: active(oauthAccessTokens),
      refreshTokens: active(oauthRefreshTokens),
      refreshTokenTombstones: active(oauthRefreshTokenTombstones),
      refreshFamilies: Array.from(oauthRefreshFamilies, ([familyId, family]) => ({ familyId, ...family }))
        .filter((family) => family.expiresAt > now),
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, target);
  });
  oauthTokenPersistence = operation.catch(() => {});
  await operation;
}
const repoNames = ["opencodex", "aura", "aura-board"];
const sessions = new Map();
const maxBodyBytes = Number(process.env.COVSPACE_MAX_BODY_BYTES || 16 * 1024 * 1024);

function rpcResult(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(text, extra = {}) {
  return {
    content: [{ type: "text", text: String(text) }],
    structuredContent: { result: String(text), ...extra },
  };
}

function toolError(message) {
  return {
    isError: true,
    ...textResult(message),
    _meta: { "mcp/www_authenticate": [oauthChallenge()] },
  };
}

function oauthToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function oauthJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function oauthHtml(response, status, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
}

function parseForm(requestBody) {
  return Object.fromEntries(new URLSearchParams(requestBody));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("request body is too large");
  }
  return body;
}

async function safeRequestBody(request, response) {
  try {
    return await requestBody(request);
  } catch (error) {
    oauthJson(response, 413, { error: "invalid_request", error_description: error.message });
    return null;
  }
}

function oauthMetadata() {
  return {
    resource: oauthResource,
    authorization_servers: [oauthIssuer],
    scopes_supported: oauthScopes,
  };
}

function oauthServerMetadata() {
  return {
    issuer: oauthIssuer,
    authorization_endpoint: `${oauthIssuer}/oauth/authorize`,
    token_endpoint: `${oauthIssuer}/oauth/token`,
    client_id_metadata_document_supported: false,
    registration_endpoint: `${oauthIssuer}/oauth/register`,
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: oauthMetadata().scopes_supported,
  };
}

function oauthClientFor(clientId) {
  return oauthClients.get(clientId);
}

function oauthRedirectError(response, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  response.writeHead(302, { location: url.toString() });
  response.end();
}

function validPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const encoded = crypto.createHash("sha256").update(verifier).digest("base64url");
  if (encoded.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(encoded), Buffer.from(challenge));
}

function oauthChallenge() {
  return `Bearer resource_metadata=\"${oauthIssuer}/.well-known/oauth-protected-resource\", error=\"invalid_token\", error_description=\"OAuth login required\"`;
}

function requestedResource(value) {
  return value || oauthResource;
}

function validResource(value) {
  return requestedResource(value) === oauthResource;
}

function normalizeScopes(value) {
  const scopes = String(value || "").split(/\s+/).filter(Boolean);
  return scopes.length > 0 && scopes.every((scope) => oauthScopes.includes(scope)) ? scopes.join(" ") : null;
}

function hasScope(grant, requiredScope) {
  return new Set(String(grant.scope || "").split(/\s+/).filter(Boolean)).has(requiredScope);
}

function issueAccessToken(grant) {
  const accessToken = crypto.randomBytes(32).toString("base64url");
  oauthAccessTokens.set(oauthToken(accessToken), {
    clientId: grant.clientId,
    scope: grant.scope,
    resource: grant.resource,
    expiresAt: Date.now() + oauthAccessTokenTtlSeconds * 1000,
  });
  return accessToken;
}

function issueRefreshToken(grant, familyId = crypto.randomUUID()) {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const digest = oauthToken(refreshToken);
  const existingFamily = oauthRefreshFamilies.get(familyId);
  const expiresAt = existingFamily?.expiresAt || grant.refreshExpiresAt || Date.now() + oauthRefreshTokenTtlSeconds * 1000;
  oauthRefreshTokens.set(digest, {
    clientId: grant.clientId,
    scope: grant.scope,
    resource: grant.resource,
    familyId,
    expiresAt,
  });
  oauthRefreshFamilies.set(familyId, { clientId: grant.clientId, currentDigest: digest, expiresAt });
  return refreshToken;
}

function revokeRefreshFamily(familyId) {
  oauthRefreshFamilies.delete(familyId);
  for (const [digest, grant] of oauthRefreshTokens) {
    if (grant.familyId === familyId) oauthRefreshTokens.delete(digest);
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function repoRoot(repo) {
  if (!repoNames.includes(repo)) throw new Error(`repo must be one of: ${repoNames.join(", ")}`);
  return path.join(root, repo);
}

function workspaceFor(id) {
  let workspace = sessions.get(id);
  if (!workspace && typeof id === "string" && id.startsWith("ws_")) {
    const repo = id.slice("ws_".length);
    if (repoNames.includes(repo)) {
      workspace = { id, repo, root: repoRoot(repo), createdAt: Date.now(), lastUsedAt: Date.now() };
      sessions.set(id, workspace);
    }
  }
  if (!workspace) throw new Error(`Unknown workspaceId: ${id}. Call open_workspace first.`);
  workspace.lastUsedAt = Date.now();
  return workspace;
}

function relativePath(rawPath = "") {
  if (typeof rawPath !== "string") throw new Error("path must be a string");
  const normalized = rawPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("path must be relative to the opened workspace");
  }
  const clean = path.posix.normalize(normalized || ".");
  if (clean === ".." || clean.startsWith("../")) throw new Error("path escapes the workspace");
  return clean === "." ? "" : clean;
}

function workspacePath(workspace, rawPath = "") {
  const relative = relativePath(rawPath);
  const target = path.resolve(workspace.root, relative);
  const prefix = `${workspace.root}${path.sep}`;
  if (target !== workspace.root && !target.startsWith(prefix)) {
    throw new Error("path escapes the workspace");
  }
  return { relative, target };
}

async function shell(command, cwd, timeout = 300) {
  const seconds = Math.min(Math.max(Number(timeout) || 30, 1), 300);
  try {
    const result = await execFileAsync("/bin/bash", ["-lc", command], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: seconds * 1000,
    });
    return `${result.stdout}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`;
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr ? `${error.stdout ? "\n" : ""}${error.stderr}` : ""}`.trim();
    throw new Error(`${output || error.message} (exit ${error.code ?? "unknown"})`);
  }
}

async function readFile(workspace, rawPath) {
  const { target } = workspacePath(workspace, rawPath);
  return fs.promises.readFile(target, "utf8");
}

async function writeFile(workspace, rawPath, content) {
  const { target } = workspacePath(workspace, rawPath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, String(content), "utf8");
}

function definitions() {
  const tools = [
    {
      name: "open_workspace",
      title: "Open Covspace workspace",
      description: "Use this before repository-scoped operations to open opencodex, aura, or aura-board and receive a workspaceId.",
      inputSchema: { type: "object", properties: { repo: { type: "string", enum: repoNames } }, required: ["repo"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" }, workspaceId: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["result", "workspaceId", "repo", "path"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "covspace_projects",
      title: "List Covspace projects",
      description: "Use this when the user asks which projects or repositories are available in Covspace. Lists opencodex, aura, and aura-board with branch, commit, remote, and worktree state. No path input is needed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "read",
      title: "Read workspace file",
      description: "Read a UTF-8 file inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, path: { type: "string" } }, required: ["workspaceId", "path"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "write",
      title: "Write workspace file",
      description: "Create or overwrite a UTF-8 file inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, path: { type: "string" }, content: { type: "string" } }, required: ["workspaceId", "path", "content"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.write",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    {
      name: "edit",
      title: "Edit workspace file",
      description: "Replace exact unique text in one file inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["workspaceId", "path", "oldText", "newText"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.write",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    {
      name: "grep",
      title: "Search workspace text",
      description: "Search text inside an opened workspace using rg.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, pattern: { type: "string" }, path: { type: "string" } }, required: ["workspaceId", "pattern"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "glob",
      title: "Find workspace files",
      description: "Find files inside an opened workspace using rg glob.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, pattern: { type: "string" } }, required: ["workspaceId", "pattern"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "ls",
      title: "List workspace directory",
      description: "List a directory inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, path: { type: "string" } }, required: ["workspaceId"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.read",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "bash",
      title: "Run workspace command",
      description: "Run a shell command inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, command: { type: "string" }, workingDirectory: { type: "string" }, timeout: { type: "number" } }, required: ["workspaceId", "command"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.exec",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    {
      name: "git",
      title: "Run workspace Git action",
      description: "Run a supported Git action inside an opened workspace.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, action: { type: "string", enum: ["status", "pull", "push", "fetch", "log"] } }, required: ["workspaceId", "action"], additionalProperties: false },
      outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      scope: "covspace.git",
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
  ];
  return tools.map(({ scope, ...definition }) => {
    const securitySchemes = [{ type: "oauth2", scopes: [scope] }];
    return {
      ...definition,
      securitySchemes,
      _meta: {
        securitySchemes,
        ui: { visibility: ["model", "app"] },
        "openai/visibility": "public",
        "openai/toolInvocation/invoking": `${definition.title}…`,
        "openai/toolInvocation/invoked": `${definition.title} complete`,
      },
    };
  });
}

async function projects() {
  const lines = [`COVSPACE_ROOT=${root}`];
  for (const repo of repoNames) {
    const cwd = repoRoot(repo);
    try {
      const remote = (await shell("git remote get-url origin", cwd)).trim();
      const branch = (await shell("git branch --show-current", cwd)).trim();
      const commit = (await shell("git rev-parse --short HEAD", cwd)).trim();
      const dirty = (await shell("git status --porcelain", cwd)).trim().split("\n").filter(Boolean).length;
      lines.push(`PROJECT name=${repo} path=${cwd} git=true remote=${remote} branch=${branch} commit=${commit} dirty=${dirty}`);
    } catch (error) {
      lines.push(`PROJECT name=${repo} path=${cwd} git=false state=error detail=${error.message}`);
    }
  }
  return lines.join("\n");
}

async function callTool(name, args) {
  if (name === "open_workspace") {
    const repo = args.repo;
    const cwd = repoRoot(repo);
    await fs.promises.access(cwd);
    const workspaceId = `ws_${repo}`;
    sessions.set(workspaceId, { id: workspaceId, repo, root: cwd, createdAt: Date.now(), lastUsedAt: Date.now() });
    return textResult(`Opened ${repo} as workspace ${workspaceId}. Use this workspaceId for all subsequent tools.`, { workspaceId, repo, path: cwd });
  }
  if (name === "covspace_projects") return textResult(await projects());

  const workspace = workspaceFor(args.workspaceId);
  if (name === "read") return textResult(await readFile(workspace, args.path));
  if (name === "write") {
    await writeFile(workspace, args.path, args.content);
    return textResult(`Wrote ${relativePath(args.path)}`);
  }
  if (name === "edit") {
    const original = await readFile(workspace, args.path);
    const occurrences = original.split(args.oldText).length - 1;
    if (occurrences !== 1) throw new Error(`oldText must match exactly once; found ${occurrences}`);
    await writeFile(workspace, args.path, original.replace(args.oldText, args.newText));
    return textResult(`Edited ${relativePath(args.path)}`);
  }
  if (name === "grep") {
    const { relative } = workspacePath(workspace, args.path || "");
    const target = relative ? ` -- ${quote(relative)}` : "";
    return textResult(await shell(`rg --line-number --hidden --glob '!.git' ${quote(args.pattern)}${target} || true`, workspace.root));
  }
  if (name === "glob") {
    return textResult(await shell(`rg --files --hidden --glob '!.git' -g ${quote(args.pattern)}`, workspace.root));
  }
  if (name === "ls") {
    const { target } = workspacePath(workspace, args.path || "");
    return textResult(await shell(`find ${quote(target)} -maxdepth 1 -mindepth 1 -printf '%y %f\n' | sort`, workspace.root));
  }
  if (name === "bash") {
    if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
    const { target: cwd } = workspacePath(workspace, args.workingDirectory || "");
    return textResult(await shell(args.command, cwd, args.timeout));
  }
  if (name === "git") {
    const commands = { status: "status --short --branch", pull: "pull --ff-only", push: "push", fetch: "fetch --all --prune", log: "log -5 --oneline" };
    if (!commands[args.action]) throw new Error("unsupported git action");
    return textResult(await shell(`git ${commands[args.action]}`, workspace.root));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function authorizationGrant(request) {
  if (token && request.headers.authorization === `Bearer ${token}`) return { scope: oauthScopes.join(" "), resource: oauthResource };
  const supplied = request.headers.authorization || "";
  if (!supplied.startsWith("Bearer ")) return null;
  const digest = oauthToken(supplied.slice("Bearer ".length));
  const grant = oauthAccessTokens.get(digest);
  if (!grant || grant.expiresAt < Date.now() || grant.resource !== oauthResource) return null;
  grant.lastUsedAt = Date.now();
  return grant;
}

function send(response, status, payload, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,mcp-session-id", "access-control-allow-methods": "POST,GET,DELETE,OPTIONS" });
    return response.end();
  }
  if (request.url === "/healthz" && request.method === "GET") return send(response, 200, { ok: true, name: "covspace" });
  const requestUrl = new URL(request.url, oauthIssuer);
  if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-protected-resource") return oauthJson(response, 200, oauthMetadata());
  if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-authorization-server") return oauthJson(response, 200, oauthServerMetadata());
  if (request.method === "GET" && requestUrl.pathname === "/oauth/authorize") {
    const clientId = requestUrl.searchParams.get("client_id") || "";
    const redirectUri = requestUrl.searchParams.get("redirect_uri") || "";
    const state = requestUrl.searchParams.get("state") || "";
    const scope = normalizeScopes(requestUrl.searchParams.get("scope") || oauthScopes.join(" "));
    const resource = requestUrl.searchParams.get("resource") || oauthResource;
    const challenge = requestUrl.searchParams.get("code_challenge") || "";
    const method = requestUrl.searchParams.get("code_challenge_method") || "";
    const client = oauthClientFor(clientId);
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri) || !challenge || method !== "S256" || !validResource(resource) || !scope) return oauthHtml(response, 400, "Invalid OAuth request");
    const approval = crypto.randomBytes(24).toString("hex");
    oauthCodes.set(approval, { type: "approval", clientId, redirectUri, state, scope, resource, codeChallenge: challenge, expiresAt: Date.now() + 10 * 60 * 1000 });
    return oauthHtml(response, 200, `<!doctype html><meta charset=utf-8><title>Covspace authorization</title><style>body{font:16px system-ui;max-width:600px;margin:4rem auto;padding:0 1rem}button{padding:.7rem 1rem}input{padding:.6rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}</style><h1>Connect Covspace</h1><p>Approve ChatGPT to access the Covspace workspace on this VM.</p><form method=post action=/oauth/authorize><input type=hidden name=approval value="${htmlEscape(approval)}"><label>Owner approval code<input name=owner_token type=password required autocomplete=one-time-code></label><button>Approve connection</button></form>`);
  }
  if (request.method === "POST" && requestUrl.pathname === "/oauth/register") {
    let form;
    const body = await safeRequestBody(request, response);
    if (body === null) return;
    try { form = JSON.parse(body || "{}"); } catch { return oauthJson(response, 400, { error: "invalid_client_metadata" }); }
    const redirectUris = Array.isArray(form.redirect_uris) ? form.redirect_uris.filter((value) => typeof value === "string") : [];
    if (!redirectUris.length || redirectUris.some((value) => !/^https:\/\//i.test(value))) return oauthJson(response, 400, { error: "invalid_redirect_uri" });
    const clientId = `covspace_${crypto.randomBytes(18).toString("base64url")}`;
    oauthClients.set(clientId, { clientId, redirectUris, tokenEndpointAuthMethod: "none", clientName: form.client_name || "ChatGPT" });
    await persistOAuthClients();
    return oauthJson(response, 201, {
      client_id: clientId,
      client_name: form.client_name || "ChatGPT",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }
  if (request.method === "POST" && requestUrl.pathname === "/oauth/authorize") {
    const body = await safeRequestBody(request, response);
    if (body === null) return;
    const form = parseForm(body);
    const pending = oauthCodes.get(form.approval);
    if (!pending || pending.type !== "approval" || pending.expiresAt < Date.now()) return oauthHtml(response, 400, "Authorization request expired");
    if (!oauthOwnerToken || form.owner_token !== oauthOwnerToken) return oauthHtml(response, 403, "Invalid owner approval code");
    const code = crypto.randomBytes(32).toString("base64url");
    oauthCodes.set(code, { ...pending, type: "code", expiresAt: Date.now() + 60 * 1000 });
    oauthCodes.delete(form.approval);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    response.writeHead(302, { location: redirect.toString() });
    return response.end();
  }
  if (request.method === "POST" && requestUrl.pathname === "/oauth/token") {
    const body = await safeRequestBody(request, response);
    if (body === null) return;
    const form = parseForm(body);
    if (form.grant_type === "refresh_token") {
      const result = await serializeRefreshMutation(async () => {
        const snapshots = {
          accessTokens: new Map(oauthAccessTokens),
          refreshTokens: new Map(oauthRefreshTokens),
          tombstones: new Map(oauthRefreshTokenTombstones),
          families: new Map(oauthRefreshFamilies),
        };
        try {
        const digest = oauthToken(form.refresh_token || "");
        const pending = oauthRefreshTokens.get(digest);
        const tombstone = oauthRefreshTokenTombstones.get(digest);
        if (!pending && tombstone) {
          revokeRefreshFamily(tombstone.familyId);
          await persistOAuthTokens();
          return { status: 400, body: { error: "invalid_grant" } };
        }
        const client = oauthClientFor(form.client_id);
        const family = pending && oauthRefreshFamilies.get(pending.familyId);
        if (!pending || pending.expiresAt < Date.now() || !family || family.currentDigest !== digest || !client || form.client_id !== pending.clientId || !validResource(form.resource) || requestedResource(form.resource) !== pending.resource) {
          return { status: 400, body: { error: "invalid_grant" } };
        }
        oauthRefreshTokens.delete(digest);
        oauthRefreshTokenTombstones.set(digest, { familyId: pending.familyId, expiresAt: pending.expiresAt });
        const accessToken = issueAccessToken(pending);
        const refreshToken = issueRefreshToken(pending, pending.familyId);
        await persistOAuthTokens();
        return { status: 200, body: { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: oauthAccessTokenTtlSeconds, scope: pending.scope } };
        } catch (error) {
          restoreMap(oauthAccessTokens, snapshots.accessTokens);
          restoreMap(oauthRefreshTokens, snapshots.refreshTokens);
          restoreMap(oauthRefreshTokenTombstones, snapshots.tombstones);
          restoreMap(oauthRefreshFamilies, snapshots.families);
          console.error(`Unable to rotate OAuth token: ${error.message}`);
          return { status: 503, body: { error: "temporarily_unavailable" } };
        }
      });
      return oauthJson(response, result.status, result.body);
    }
    if (form.grant_type && form.grant_type !== "authorization_code") return oauthJson(response, 400, { error: "unsupported_grant_type" });
    const pending = oauthCodes.get(form.code);
    if (!pending || pending.type !== "code" || pending.expiresAt < Date.now()) return oauthJson(response, 400, { error: "invalid_grant" });
    const client = oauthClientFor(form.client_id);
    if (!client || form.client_id !== pending.clientId || !validResource(form.resource) || requestedResource(form.resource) !== pending.resource || !validPkce(form.code_verifier, pending.codeChallenge)) return oauthJson(response, 400, { error: "invalid_grant" });
    const accessSnapshot = new Map(oauthAccessTokens);
    const refreshSnapshot = new Map(oauthRefreshTokens);
    const familySnapshot = new Map(oauthRefreshFamilies);
    try {
      const grant = { ...pending, clientId: form.client_id };
      const accessToken = issueAccessToken(grant);
      const refreshToken = issueRefreshToken(grant);
      await persistOAuthTokens();
      oauthCodes.delete(form.code);
      return oauthJson(response, 200, { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: oauthAccessTokenTtlSeconds, scope: pending.scope });
    } catch (error) {
      restoreMap(oauthAccessTokens, accessSnapshot);
      restoreMap(oauthRefreshTokens, refreshSnapshot);
      restoreMap(oauthRefreshFamilies, familySnapshot);
      console.error(`Unable to persist OAuth token: ${error.message}`);
      return oauthJson(response, 503, { error: "temporarily_unavailable" });
    }
  }
  if (request.url !== "/mcp") return send(response, 404, { error: "Not found" });
  const grant = authorizationGrant(request);
  if (!grant) return send(response, 401, { error: "Unauthorized" }, { "www-authenticate": `Bearer resource_metadata=\"${oauthIssuer}/.well-known/oauth-protected-resource\"` });
  if (request.method === "GET") return send(response, 405, rpcError(null, -32000, "GET is not supported; use POST"));
  if (request.method === "DELETE") {
    const sessionId = request.headers["mcp-session-id"];
    sessions.delete(sessionId);
    return send(response, 200, { jsonrpc: "2.0", result: {} });
  }
  if (request.method !== "POST") return send(response, 405, { error: "Method not allowed" });

  try {
    const message = JSON.parse(await requestBody(request) || "{}");
    const sessionId = request.headers["mcp-session-id"];
    if (message.method === "initialize") {
      const nextSessionId = `mcp_${crypto.randomUUID()}`;
      sessions.set(nextSessionId, { id: nextSessionId, protocol: "mcp", createdAt: Date.now(), lastUsedAt: Date.now() });
      return send(response, 200, rpcResult(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "covspace", version: "1.0.0" },
      }), { "mcp-session-id": nextSessionId });
    }
    if (message.method === "notifications/initialized") return response.writeHead(202).end();
    if (!sessionId) return send(response, 400, rpcError(message.id, -32000, "Missing MCP session"));
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { id: sessionId, protocol: "mcp", createdAt: Date.now(), lastUsedAt: Date.now() });
    } else {
      sessions.get(sessionId).lastUsedAt = Date.now();
    }
    if (message.method === "tools/list") return send(response, 200, rpcResult(message.id, { tools: definitions() }), { "mcp-session-id": sessionId });
    if (message.method === "tools/call") {
      try {
        const tool = definitions().find((definition) => definition.name === message.params?.name);
        const requiredScope = tool?.securitySchemes?.[0]?.scopes?.[0];
        if (!tool) return send(response, 200, rpcError(message.id, -32602, `Unknown tool: ${message.params?.name}`), { "mcp-session-id": sessionId });
        if (!hasScope(grant, requiredScope)) return send(response, 403, rpcError(message.id, -32001, `Missing required scope: ${requiredScope}`), { "mcp-session-id": sessionId });
        const value = await callTool(tool.name, message.params?.arguments || {});
        return send(response, 200, rpcResult(message.id, value), { "mcp-session-id": sessionId });
      } catch (error) {
        return send(response, 200, rpcResult(message.id, toolError(error.message)), { "mcp-session-id": sessionId });
      }
    }
    return send(response, 200, rpcError(message.id, -32601, `Unsupported method: ${message.method}`), { "mcp-session-id": sessionId });
  } catch (error) {
    return send(response, 400, rpcError(null, -32700, error.message));
  }
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, session] of sessions) if (session.lastUsedAt < cutoff) sessions.delete(id);
}, 5 * 60 * 1000).unref();

await loadOAuthClients();
await loadOAuthTokens();
server.listen(port, host, () => console.error(`Covspace MCP listening on http://${host}:${port}/mcp`));
