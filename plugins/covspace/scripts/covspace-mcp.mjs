import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const config = {
  host: process.env.COVSPACE_HOST || "129.225.159.251",
  user: process.env.COVSPACE_USER || "ubuntu",
  root: process.env.COVSPACE_ROOT || "/home/ubuntu/covspace",
  key: process.env.COVSPACE_SSH_KEY || "C:\\Users\\malla\\.ssh\\covspace-vm-ed25519",
  port: process.env.COVSPACE_SSH_PORT || "22",
};

const repoNames = ["opencodex", "aura", "aura-board"];

function jsonRpc(result, id) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id, message, code = -32000) {
  jsonRpc({ error: { code, message } }, id);
}

function textResult(text, structuredContent = undefined) {
  const result = { content: [{ type: "text", text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function assertSafeRelativePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("path is required");
  const normalized = rawPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("path must stay inside Covspace and cannot contain empty, '.', or '..' segments");
  }
  if (!repoNames.includes(parts[0])) throw new Error(`path must start with one of: ${repoNames.join(", ")}`);
  return `${config.root}/${parts.join("/")}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runSsh(command, { stdin = undefined, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", config.key,
      "-p", config.port,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      `${config.user}@${config.host}`,
      command,
    ];
    const child = spawn("ssh", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${stderr.trim() || "SSH command failed"} (exit ${code})`));
      else resolve(stdout);
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

function toolDefinitions() {
  return [
    {
      name: "covspace_projects",
      description: "List the Covspace root and all configured repository projects with their remote, branch, commit, and dirty state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "covspace_status",
      description: "Show branch, commit, remote, and worktree status for all Covspace repositories.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "covspace_read",
      description: "Read a UTF-8 text file inside /home/ubuntu/covspace. Paths must begin with opencodex, aura, or aura-board.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "covspace_write",
      description: "Write UTF-8 text to a file inside Covspace. This changes the remote workspace; parent directories are created.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    },
    {
      name: "covspace_exec",
      description: "Run a shell command in a Covspace repository. Use only commands appropriate for the requested development task.",
      inputSchema: { type: "object", properties: { repo: { type: "string", enum: repoNames }, command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["repo", "command"], additionalProperties: false },
    },
    {
      name: "covspace_git",
      description: "Run a Git action in a Covspace repository. Supported actions: status, pull, push, fetch, log.",
      inputSchema: { type: "object", properties: { repo: { type: "string", enum: repoNames }, action: { type: "string", enum: ["status", "pull", "push", "fetch", "log"] } }, required: ["repo", "action"], additionalProperties: false },
    },
  ];
}

async function callTool(name, args) {
  if (name === "covspace_projects") {
    const script = [
      `printf 'COVSPACE_ROOT=%s\\n' ${shellQuote(config.root)}`,
      ...repoNames.map((repo) => {
        const path = `${config.root}/${repo}`;
        return `if [ -d ${shellQuote(`${path}/.git`)} ]; then remote=$(git -C ${shellQuote(path)} remote get-url origin 2>/dev/null || true); branch=$(git -C ${shellQuote(path)} branch --show-current 2>/dev/null || true); commit=$(git -C ${shellQuote(path)} rev-parse --short HEAD 2>/dev/null || true); dirty=$(git -C ${shellQuote(path)} status --porcelain 2>/dev/null | wc -l | tr -d ' '); printf 'PROJECT name=%s path=%s git=true remote=%s branch=%s commit=%s dirty=%s\\n' ${shellQuote(repo)} ${shellQuote(path)} "$remote" "$branch" "$commit" "$dirty"; elif [ -e ${shellQuote(path)} ]; then printf 'PROJECT name=%s path=%s git=false state=non-git\\n' ${shellQuote(repo)} ${shellQuote(path)}; else printf 'PROJECT name=%s path=%s git=false state=missing\\n' ${shellQuote(repo)} ${shellQuote(path)}; fi`;
      }),
    ].join("; ");
    return textResult(await runSsh(script));
  }
  if (name === "covspace_status") {
    const script = repoNames.map((repo) => `echo REPO=${repo}; git -C ${shellQuote(`${config.root}/${repo}`)} remote get-url origin; git -C ${shellQuote(`${config.root}/${repo}`)} rev-parse --short HEAD; git -C ${shellQuote(`${config.root}/${repo}`)} status --short --branch | head -1`).join("; ");
    return textResult(await runSsh(script));
  }
  if (name === "covspace_read") {
    const target = assertSafeRelativePath(args.path);
    return textResult(await runSsh(`cat -- ${shellQuote(target)}`));
  }
  if (name === "covspace_write") {
    const target = assertSafeRelativePath(args.path);
    const encoded = Buffer.from(args.content, "utf8").toString("base64");
    const parent = target.slice(0, target.lastIndexOf("/"));
    await runSsh(`mkdir -p -- ${shellQuote(parent)} && base64 -d > ${shellQuote(target)}`, { stdin: encoded, timeoutMs: 300000 });
    return textResult(`Wrote ${args.path}`);
  }
  if (name === "covspace_exec") {
    if (!repoNames.includes(args.repo)) throw new Error(`repo must be one of: ${repoNames.join(", ")}`);
    if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
    return textResult(await runSsh(`cd -- ${shellQuote(`${config.root}/${args.repo}`)} && ${args.command}`, { timeoutMs: args.timeoutMs || 300000 }));
  }
  if (name === "covspace_git") {
    if (!repoNames.includes(args.repo)) throw new Error(`repo must be one of: ${repoNames.join(", ")}`);
    const commands = { status: "status --short --branch", pull: "pull --ff-only", push: "push", fetch: "fetch --all --prune", log: "log -5 --oneline" };
    return textResult(await runSsh(`cd -- ${shellQuote(`${config.root}/${args.repo}`)} && git ${commands[args.action]}`));
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    return jsonRpc({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "covspace", version: "0.1.0" } }, id);
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") return jsonRpc({ tools: toolDefinitions() }, id);
  if (method === "tools/call") {
    try { return jsonRpc(await callTool(params.name, params.arguments || {}), id); }
    catch (error) { return jsonRpc(toolError(error.message), id); }
  }
  if (id !== undefined) return errorResponse(id, `Unsupported method: ${method}`, -32601);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  const cleanLine = line.replace(/^\uFEFF/, "");
  if (!cleanLine.trim()) return;
  try { await handle(JSON.parse(cleanLine)); }
  catch (error) { errorResponse(null, error.message, -32700); }
});
