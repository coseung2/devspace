import assert from "node:assert/strict";
import test from "node:test";
import { AgentTaskCoordinator } from "./agent-tools.js";
import { InMemoryTaskStore } from "./tasks.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

function workspace(id: string, root: string, mode: "checkout" | "worktree", sourceRoot?: string): Workspace {
  return {
    id,
    root,
    mode,
    sourceRoot,
    worktree: mode === "worktree" ? {
      path: root,
      baseRef: "HEAD",
      baseSha: "abc123",
      dirtySource: false,
      detached: true,
      managed: true,
    } : undefined,
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
}

function fakeRegistry() {
  const checkout = workspace("ws_parent", "/repo", "checkout");
  const worktree = workspace("ws_child", "/worktrees/repo-child", "worktree", "/repo");
  const map = new Map([[checkout.id, checkout], [worktree.id, worktree]]);
  let openCount = 0;

  const registry = {
    getWorkspace(id: string) {
      const value = map.get(id);
      if (!value) throw new Error(`unknown workspace ${id}`);
      return value;
    },
    async openWorkspace(input: { path?: string; mode?: string }) {
      openCount += 1;
      assert.equal(input.path, "/repo");
      assert.equal(input.mode, "worktree");
      return {
        workspace: worktree,
        agentsFiles: [],
        availableAgentsFiles: [],
        workspaceReused: false,
        includeBootstrapContext: true,
      };
    },
  } as unknown as WorkspaceRegistry;

  return { registry, getOpenCount: () => openCount };
}

test("agent spawn auto-isolates write-capable work and waits for parent review", async () => {
  const store = new InMemoryTaskStore();
  const { registry, getOpenCount } = fakeRegistry();
  const coordinator = new AgentTaskCoordinator(store, registry, "parent-conversation");

  const spawned = await coordinator.spawn({
    workspaceId: "ws_parent",
    task: "Fix auth race and run tests",
  });

  assert.equal(getOpenCount(), 1);
  assert.equal(spawned.workspaceId, "ws_child");
  assert.equal(spawned.isolation, "worktree");
  assert.equal(spawned.status, "working");
  assert.match(spawned.dispatchPrompt, /Fix auth race/);
  assert.match(spawned.dispatchPrompt, new RegExp(spawned.taskId));

  assert.throws(() => coordinator.complete({
    taskId: spawned.taskId,
    callbackToken: "wrong-token",
    summary: "not authorized",
  }), /Invalid GPT worker callback capability/);

  const review = coordinator.complete({
    taskId: spawned.taskId,
    callbackToken: spawned.callbackToken,
    summary: "Fixed auth race",
    changedFiles: ["src/auth.ts"],
    tests: ["npm test -- auth"],
  });

  assert.equal(review.status, "input_required");
  assert.deepEqual(review.result, {
    summary: "Fixed auth race",
    changedFiles: ["src/auth.ts"],
    tests: ["npm test -- auth"],
    commit: undefined,
  });

  const approved = coordinator.approve(spawned.taskId);
  assert.equal(approved.status, "completed");
});

test("read-only auto mode shares the checkout", async () => {
  const store = new InMemoryTaskStore();
  const { registry, getOpenCount } = fakeRegistry();
  const coordinator = new AgentTaskCoordinator(store, registry, "parent-conversation");

  const spawned = await coordinator.spawn({
    workspaceId: "ws_parent",
    task: "Inspect architecture only",
    readOnly: true,
  });

  assert.equal(getOpenCount(), 0);
  assert.equal(spawned.workspaceId, "ws_parent");
  assert.equal(spawned.isolation, "shared");
});

test("revision reuses the same worktree and rotates callback capability", async () => {
  const store = new InMemoryTaskStore();
  const { registry } = fakeRegistry();
  const coordinator = new AgentTaskCoordinator(store, registry, "parent-conversation");

  const spawned = await coordinator.spawn({ workspaceId: "ws_parent", task: "First pass" });
  coordinator.complete({
    taskId: spawned.taskId,
    callbackToken: spawned.callbackToken,
    summary: "First pass ready",
  });

  const revised = coordinator.revise({
    taskId: spawned.taskId,
    instruction: "Address review comment",
  });

  assert.equal(revised.workspaceId, spawned.workspaceId);
  assert.notEqual(revised.callbackToken, spawned.callbackToken);
  assert.match(revised.dispatchPrompt, /Address review comment/);

  assert.throws(() => coordinator.complete({
    taskId: spawned.taskId,
    callbackToken: spawned.callbackToken,
    summary: "stale callback",
  }), /Invalid GPT worker callback capability/);

  const secondReview = coordinator.complete({
    taskId: spawned.taskId,
    callbackToken: revised.callbackToken,
    summary: "Revision ready",
  });
  assert.equal(secondReview.status, "input_required");
});
