import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
const processSessions = new ProcessSessionManager();
let server: ReturnType<typeof createMcpServer> | undefined;
let client: Client | undefined;

try {
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await mkdir(join(root, ".agents", "skills", "project-skill"), { recursive: true });
  await mkdir(join(root, ".empty-agent"));
  await writeFile(
    join(root, ".agents", "skills", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: join(root, ".empty-agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_WIDGETS: "off",
    PORT: "1",
  });
  server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    processSessions,
  );
  client = new Client({ name: "devspace-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  const output = result.structuredContent as Record<string, unknown>;
  assert.equal("agentProviders" in output, false);
  assert.equal("agents" in output, false);
  assert.deepEqual(output.agentsFiles, [{ path: "AGENTS.md", content: "root instructions\n" }]);
  assert.deepEqual(output.availableAgentsFiles, [{ path: "nested/AGENTS.md" }]);
  assert.equal(
    (output.skills as Array<{ name: string }>).some((skill) => skill.name === "project-skill"),
    true,
  );

} finally {
  await Promise.allSettled([client?.close(), server?.close()]);
  processSessions.shutdown();
  await rm(root, { recursive: true, force: true });
}
