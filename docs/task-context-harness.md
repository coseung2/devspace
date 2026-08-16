# Task-context harness

DevSpace can keep agent-specific working context outside project repositories and select only the parts relevant to the current task.

The harness lives under the DevSpace state directory:

```text
<DEVSPACE_STATE_DIR>/harness/
  global/
    index.json
    entries/
  projects/
    <project-key>/
      index.json
      entries/
```

`global` entries can match work in any workspace. Project entries are isolated by a stable project key. A configured workspace alias is used as the key when possible; otherwise DevSpace derives a non-reversible path hash. Managed worktrees use the source checkout identity, so they share the same project context without copying harness files into each worktree.

Repository instruction files remain authoritative. Harness entries add task-specific context; they do not replace `AGENTS.md`, `CLAUDE.md`, project documentation, code, or tests.

## Task protocol

DevSpace exposes two tools:

- `prepare_task_context` selects matching entries for the current user request and optional workspace-relative path hints. DevSpace instructs the host to call it once before substantive work and again only when the task materially changes or newly discovered paths could alter selection.
- `set_task_context_entry` creates or replaces one entry. It is intended only for cases where the user explicitly asks to persist context or explicitly approves the exact entry. Ordinary implementation work and corrections do not imply permission to persist anything.

An empty selection means the agent proceeds normally. The preparation tool never returns unmatched entries or the complete catalog.

## Index format

Each scope has a versioned `index.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "package-output-evidence",
      "title": "Package output is release evidence",
      "kind": "rule",
      "path": "entries/package-output-evidence.md",
      "priority": 50,
      "when": {
        "keywords": ["package", "release"],
        "paths": ["scripts/**", "store/**"]
      }
    }
  ]
}
```

The referenced Markdown file contains the context body. Project entries override global entries with the same `id`.

Supported positive triggers are:

- `always: true` — matches every task; at most two entries per effective catalog should use this.
- `keywords` — matches when any normalized phrase appears in the current task.
- `allKeywords` — matches only when every normalized phrase appears in the current task.
- `patterns` — case-insensitive regular expressions applied to the task.
- `paths` — glob patterns applied only to path hints supplied to `prepare_task_context`.

Trigger families use OR semantics. For example, an entry with both `keywords` and `paths` matches when either family matches. Prefer narrow, positive descriptions of the work that needs the context. Do not build catalogs from long enumerations of unrelated forbidden topics.

## Limits and failure behavior

The reader is intentionally bounded:

- 256 KiB per index and source file
- 500 entries read per index
- 8 selected entries per task
- 8,000 characters per selected entry
- 24,000 total selected characters
- 50 path hints
- 2 effective `always` entries

Malformed indexes, missing source files, invalid patterns, and entries that resolve outside their scope produce diagnostics and are skipped. Preparation is fail-open: harness failures do not block normal workspace work.

The harness root and scope directories are checked after symlink resolution. Entry paths must remain within their scope. Writes are serialized per scope. `set_task_context_entry` writes content to a versioned body file and publishes it by replacing the index last, so a failed index update does not partially replace an active entry. Written files use owner-only permissions and atomic replacement where the platform supports it.

## Operational guidance

Keep the state directory private and backed up according to the same policy as other DevSpace state. Do not store credentials, access tokens, private keys, raw request data, or other secrets in harness entries.

Use project scope by default. Use global scope only for a rule or procedure that genuinely applies across repositories and only after explicit user approval.
