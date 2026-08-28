import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAgentDispatcher,
  workspaceAgentDispatcherFromEnv,
  type WorkspaceAgentRetryEvent,
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
  assert.ok(headers.get("idempotency-key"));
});

test("dispatcher retries transient HTTP failures with one idempotency key", async () => {
  const statuses = [409, 429, 503, 202];
  const idempotencyKeys: string[] = [];
  const sleeps: number[] = [];
  const retries: WorkspaceAgentRetryEvent[] = [];
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken: "workspace-agent-access-token",
    retryDelaysMs: [2, 5, 10],
    sleepImpl: async (delayMs) => {
      sleeps.push(delayMs);
    },
    onRetry: (event) => {
      retries.push(event);
    },
    fetchImpl: async (_url, init) => {
      idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      const status = statuses.shift();
      assert.ok(status);
      return new Response(status === 202 ? null : "temporary failure", { status });
    },
  });

  await dispatcher({ taskId: "task_1", workspaceId: "ws_1", prompt: "work" });

  assert.equal(idempotencyKeys.length, 4);
  assert.ok(idempotencyKeys[0]);
  assert.equal(new Set(idempotencyKeys).size, 1);
  assert.deepEqual(sleeps, [2, 5, 10]);
  assert.deepEqual(retries.map((event) => event.status), [409, 429, 503]);
  assert.deepEqual(retries.map((event) => event.attempt), [1, 2, 3]);
  assert.ok(retries.every((event) => event.taskId === "task_1"));
  assert.ok(retries.every((event) => event.workspaceId === "ws_1"));
  assert.ok(retries.every((event) => event.maxAttempts === 4));
});

test("dispatcher retries request errors without leaking the access token", async () => {
  const accessToken = "workspace-agent-secret-token";
  const retries: WorkspaceAgentRetryEvent[] = [];
  let calls = 0;
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken,
    retryDelaysMs: [0],
    sleepImpl: async () => undefined,
    onRetry: (event) => {
      retries.push(event);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error(`temporary ${accessToken}`);
      return new Response(null, { status: 202 });
    },
  });

  await dispatcher({ taskId: "task_1", workspaceId: "ws_1", prompt: "work" });

  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.error, "temporary [redacted]");
});

test("dispatcher rejects non-retryable responses immediately without leaking the access token", async () => {
  const accessToken = "workspace-agent-secret-token";
  let calls = 0;
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken,
    retryDelaysMs: [0, 0, 0],
    sleepImpl: async () => undefined,
    onRetry: () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return new Response(`failure ${accessToken}`, { status: 403 });
    },
  });

  await assert.rejects(
    dispatcher({ taskId: "task_1", workspaceId: "ws_1", prompt: "work" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /after 1 attempt/);
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("dispatcher reports the final retryable response after exhausting retries", async () => {
  const accessToken = "workspace-agent-secret-token";
  let calls = 0;
  const dispatcher = createWorkspaceAgentDispatcher({
    triggerUrl: "https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger",
    accessToken,
    retryDelaysMs: [0, 0],
    sleepImpl: async () => undefined,
    onRetry: () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return new Response(`not available ${accessToken}`, { status: 409 });
    },
  });

  await assert.rejects(
    dispatcher({ taskId: "task_1", workspaceId: "ws_1", prompt: "work" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 409/);
      assert.match(error.message, /after 3 attempts/);
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.equal(calls, 3);
});
