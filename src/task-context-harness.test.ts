import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  inspectTaskContextHarness,
  prepareTaskContext,
  setTaskContextEntry,
  taskContextProjectKey,
  type TaskContextConfig,
  type TaskContextWorkspace,
} from "./task-context-harness.js";

interface Fixture {
  root: string;
  stateDir: string;
  projectRoot: string;
  worktreeRoot: string;
  config: TaskContextConfig;
  workspace: TaskContextWorkspace;
}

test("selects only matching entries and project entries override global entries", async (t) => {
  const fixture = await createFixture(t);
  await writeScope(fixture, "global", {
    version: 1,
    entries: [
      {
        id: "package-truth",
        title: "Global package truth",
        kind: "rule",
        path: "entries/package-truth.md",
        priority: 10,
        when: { keywords: ["package", "release"] },
      },
      {
        id: "subtitle-flow",
        title: "Subtitle flow",
        kind: "knowledge",
        path: "entries/subtitle-flow.md",
        when: { keywords: ["subtitle"] },
      },
    ],
  }, {
    "entries/package-truth.md": "Use the packaged output as evidence.",
    "entries/subtitle-flow.md": "Unrelated subtitle context must stay out.",
  });
  await writeScope(fixture, "project", {
    version: 1,
    entries: [
      {
        id: "package-truth",
        title: "Project package truth",
        kind: "decision",
        path: "entries/package-truth.md",
        priority: 50,
        when: { keywords: ["package"] },
      },
    ],
  }, {
    "entries/package-truth.md": "Use this project's deterministic package result.",
  });

  const prepared = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Build and verify the release package.",
  });

  assert.equal(prepared.available, true);
  assert.deepEqual(prepared.scopes, ["global", "project"]);
  assert.equal(prepared.matchedEntries.length, 1);
  assert.equal(prepared.matchedEntries[0]?.scope, "project");
  assert.match(prepared.context, /Project package truth/);
  assert.match(prepared.context, /deterministic package result/);
  assert.doesNotMatch(prepared.context, /Global package truth/);
  assert.doesNotMatch(prepared.context, /subtitle/i);
});

test("uses the source checkout identity for worktrees and matches positive path hints", async (t) => {
  const fixture = await createFixture(t);
  const projectKey = await taskContextProjectKey(fixture.config, fixture.workspace);
  assert.equal(projectKey, "media-project");

  await writeScope(fixture, "project", {
    version: 1,
    entries: [
      {
        id: "packaging-path",
        title: "Packaging path",
        kind: "procedure",
        path: "entries/packaging-path.md",
        when: { paths: ["scripts/**", "store/**"] },
      },
    ],
  }, {
    "entries/packaging-path.md": "Run the package verifier for packaging changes.",
  });

  const prepared = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Update this helper.",
    paths: ["scripts/build-store-package.ps1"],
  });
  const unsafe = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Update this helper.",
    paths: ["../scripts/build-store-package.ps1"],
  });

  assert.equal(prepared.matchedEntries.length, 1);
  assert.match(prepared.context, /package verifier/);
  assert.equal(unsafe.matchedEntries.length, 0);
  assert.ok(unsafe.diagnostics.some((diagnostic) => diagnostic.includes("unsafe")));
});

test("fails open on malformed indexes without leaking unrelated entries", async (t) => {
  const fixture = await createFixture(t);
  const globalRoot = scopeRoot(fixture, "global");
  await mkdir(globalRoot, { recursive: true });
  await writeFile(join(globalRoot, "index.json"), "{not-json", "utf8");

  const descriptor = await inspectTaskContextHarness(fixture.config, fixture.workspace);
  const prepared = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Any normal coding task",
  });

  assert.equal(descriptor.available, false);
  assert.equal(prepared.context, "");
  assert.equal(prepared.matchedEntries.length, 0);
  assert.ok(prepared.diagnostics.some((diagnostic) => diagnostic.includes("Unable to read")));
});

test("rejects source files that resolve outside their harness scope", async (t) => {
  const fixture = await createFixture(t);
  const projectRoot = scopeRoot(fixture, "project");
  const outside = join(fixture.root, "outside.md");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(outside, "outside content", "utf8");
  await mkdir(join(projectRoot, "entries"), { recursive: true });
  await symlink(outside, join(projectRoot, "entries", "linked.md"));
  await writeFile(join(projectRoot, "index.json"), JSON.stringify({
    version: 1,
    entries: [
      {
        id: "linked",
        title: "Linked",
        kind: "rule",
        path: "entries/linked.md",
        when: { always: true },
      },
    ],
  }), "utf8");

  const prepared = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Any task",
  });

  assert.equal(prepared.context, "");
  assert.ok(prepared.diagnostics.some((diagnostic) => diagnostic.includes("resolves outside")));
});

test("diagnostics do not expose identifiers or content from unmatched entries", async (t) => {
  const fixture = await createFixture(t);
  await writeScope(fixture, "project", {
    version: 1,
    entries: [
      {
        id: "unmatched-private-concept",
        title: "Unmatched private concept",
        kind: "note",
        path: "entries/unmatched.md",
        when: { patterns: ["UNMATCHED_PRIVATE_PATTERN["] },
      },
    ],
  }, {
    "entries/unmatched.md": "This content must not enter the selected task context.",
  });

  const prepared = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Adjust popup spacing.",
  });
  const diagnostics = prepared.diagnostics.join("\n");

  assert.equal(prepared.context, "");
  assert.doesNotMatch(diagnostics, /unmatched-private-concept/);
  assert.doesNotMatch(diagnostics, /Unmatched private concept/);
  assert.doesNotMatch(diagnostics, /This content must not enter/);
  assert.doesNotMatch(diagnostics, /UNMATCHED_PRIVATE_PATTERN/);
  assert.match(diagnostics, /invalid pattern/);
});

test("persists an explicitly supplied entry and retrieves it selectively", async (t) => {
  const fixture = await createFixture(t);
  const stored = await setTaskContextEntry(fixture.config, fixture.workspace, {
    scope: "project",
    entry: {
      id: "regression-evidence",
      title: "Regression evidence",
      kind: "rule",
      priority: 40,
      when: {
        keywords: ["regression"],
        paths: ["**/*.test.mjs"],
      },
      content: "Pair behavioral changes with focused deterministic evidence.",
    },
  });

  assert.equal(stored.projectKey, "media-project");
  assert.match(
    stored.source,
    /^project:media-project\/entries\/regression-evidence\.[a-f0-9]{16}\.md$/,
  );

  const selected = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Fix the regression and verify it.",
  });
  const unrelated = await prepareTaskContext(fixture.config, fixture.workspace, {
    task: "Adjust popup spacing.",
  });

  assert.match(selected.context, /deterministic evidence/);
  assert.equal(unrelated.context, "");
  assert.equal(unrelated.matchedEntries.length, 0);

  const index = JSON.parse(
    await readFile(join(scopeRoot(fixture, "project"), "index.json"), "utf8"),
  ) as { entries: Array<{ id: string }> };
  assert.deepEqual(index.entries.map((entry) => entry.id), ["regression-evidence"]);
});

test("serializes concurrent writes without dropping index entries", async (t) => {
  const fixture = await createFixture(t);
  const entryCount = 32;

  await Promise.all(
    Array.from({ length: entryCount }, (_, index) => setTaskContextEntry(
      fixture.config,
      fixture.workspace,
      {
        entry: {
          id: `concurrent-${index}`,
          title: `Concurrent ${index}`,
          kind: "note",
          when: { keywords: [`trigger-${index}`] },
          content: `Concurrent content ${index}.`,
        },
      },
    )),
  );

  const index = JSON.parse(
    await readFile(join(scopeRoot(fixture, "project"), "index.json"), "utf8"),
  ) as { entries: Array<{ id: string }> };
  assert.equal(index.entries.length, entryCount);
  assert.deepEqual(
    index.entries.map((entry) => entry.id).sort(),
    Array.from({ length: entryCount }, (_, entryIndex) => `concurrent-${entryIndex}`).sort(),
  );
});

test("publishes replacement content by swapping the index last", async (t) => {
  const fixture = await createFixture(t);
  const first = await setTaskContextEntry(fixture.config, fixture.workspace, {
    entry: {
      id: "replace-me",
      title: "Replace me",
      kind: "decision",
      when: { keywords: ["replace"] },
      content: "First content.",
    },
  });
  const second = await setTaskContextEntry(fixture.config, fixture.workspace, {
    entry: {
      id: "replace-me",
      title: "Replace me",
      kind: "decision",
      when: { keywords: ["replace"] },
      content: "Second content.",
    },
  });

  assert.notEqual(first.source, second.source);
  const projectPrefix = "project:media-project/";
  const firstPath = join(scopeRoot(fixture, "project"), first.source.slice(projectPrefix.length));
  const secondPath = join(scopeRoot(fixture, "project"), second.source.slice(projectPrefix.length));
  await assert.rejects(readFile(firstPath, "utf8"), /ENOENT/);
  assert.equal(await readFile(secondPath, "utf8"), "Second content.\n");

  const index = JSON.parse(
    await readFile(join(scopeRoot(fixture, "project"), "index.json"), "utf8"),
  ) as { entries: Array<{ id: string; path: string }> };
  assert.deepEqual(index.entries, [{
    id: "replace-me",
    title: "Replace me",
    kind: "decision",
    path: second.source.slice(projectPrefix.length),
    priority: 0,
    when: { keywords: ["replace"] },
  }]);
});

test("requires a positive trigger before persisting an entry", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    setTaskContextEntry(fixture.config, fixture.workspace, {
      entry: {
        id: "invalid",
        title: "Invalid",
        kind: "note",
        when: {},
        content: "This must not be stored.",
      },
    }),
    /positive trigger/,
  );
});

async function createFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-task-context-test-"));
  const stateDir = join(root, "state");
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktree");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    stateDir,
    projectRoot,
    worktreeRoot,
    config: {
      stateDir,
      workspaceAliases: {
        "media-project": projectRoot,
      },
    },
    workspace: {
      root: worktreeRoot,
      sourceRoot: projectRoot,
    },
  };
}

function scopeRoot(fixture: Fixture, scope: "global" | "project"): string {
  return scope === "global"
    ? join(fixture.stateDir, "harness", "global")
    : join(fixture.stateDir, "harness", "projects", "media-project");
}

async function writeScope(
  fixture: Fixture,
  scope: "global" | "project",
  index: unknown,
  files: Record<string, string>,
): Promise<void> {
  const root = scopeRoot(fixture, scope);
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await writeFile(join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}
