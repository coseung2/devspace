import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAgentDispatcher,
  workspaceAgentDispatcherFromEnv,
} from "./workspace-agent-dispatch.js";

test("dispatcher is disabled when no Workspace Agent environment is configured", () => {
  assert.equal(workspaceAgentDispatcherFromEnv({}), undefined);
});

test("partial Workspace Agent configuration is rejected", () => {
  assert.throws(
    () => workspaceAgentDispatcherFromEnv({
      DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL:
        "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    }),
    /must be configured together/,
  );
});

test("dispatcher only accepts the ChatGPT Workspace Agent trigger origin and path", () => {
  const accessToken = "workspace-agent-access-token";
  assert.throws(
    () => createWorkspaceAgentDispatcher({
      triggerUrl: "https://example.com/v1/workspace_agents/agtch_test/trigger",
      accessToken,
    }),
    /https:\/\/api\.chatgpt\.com/,
  );
  assert.throws(
    () => createWorkspaceAgentDispatcher({
      triggerUrl: "https://api.chatgpt.com/v1/not_agents/agtch_test/trigger",
      accessToken,
    }),
    /Workspace Agent trigger endpoint/,
  );
});

test("dispatcher posts the child prompt and accepts HTTP 202", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken: "workspace-agent-access-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    },
  });

  await dispatcher({
    taskId: "task_1",
    workspaceId: "ws_1",
    prompt: "Do the requested DevSpace work",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    input: "Do the requested DevSpace work",
  });
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer workspace-agent-access-token");
  assert.equal(headers.get("content-type"), "application/json");
});

test("dispatcher rejects non-202 responses without leaking the access token", async () => {
  const accessToken = "workspace-agent-secret-token";
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken,
    fetchImpl: async () => new Response(`failure ${accessToken}`, { status: 409 }),
  });

  await assert.rejects(
    dispatcher({ taskId: "task_1", workspaceId: "ws_1", prompt: "work" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 409/);
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});
