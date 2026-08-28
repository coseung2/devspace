# GPT agent workers

DevSpace can use a ChatGPT Workspace Agent as a subordinate coding worker while the parent ChatGPT session remains the reviewer and control plane.

The worker conversation itself is not authoritative. DevSpace owns the durable task, workspace/worktree, and review state; the parent approves only after inspecting the real repository state.

## Flow

```text
Parent ChatGPT
    |
    | agent.spawn
    v
DevSpace task
    |
    +-- auto/shared checkout for read-only work
    |
    +-- managed Git worktree for write-capable work
    |
    v
Workspace Agent
    |
    | DevSpace tools in assigned workspaceId
    |
    | agent_complete / agent_fail callback
    v
DevSpace task: input_required
    |
    v
Parent ChatGPT
    +-- inspect diff / tests / git state
    +-- agent.approve
    `-- agent.revise -> same workspace/worktree, new callback capability
```

## Tools

Canonical MCP tools:

- `agent.spawn`
- `agent.get`
- `agent.revise`
- `agent.approve`
- `agent.cancel`
- `agent.complete`
- `agent.fail`

ChatGPT Apps-compatible aliases use underscores instead of dots, for example `agent_spawn` and `agent_complete`.

`agent.spawn` also participates in the MCP Tasks extension when the client advertises task support, so a parent host can treat a long-running GPT worker like the existing `worker.spawn` task lifecycle.

## Isolation

`agent.spawn` accepts `isolation` with `auto`, `worktree`, or `shared`.

The default is `auto`:

- `readOnly: true` uses the existing checkout/workspace.
- write-capable work creates a managed detached Git worktree automatically.

The parent does not allocate worktrees manually. A revision reuses the same workspace/worktree so the next GPT pass sees the previous changes.

## Workspace Agent setup

Create or publish a ChatGPT Workspace Agent intended for coding work and connect the same DevSpace MCP server to that agent.

The worker must be allowed to use the DevSpace tools required for its job, including the `agent_complete` and `agent_fail` callback tools. Keep its external tools constrained to the minimum needed for development work.

Add an API trigger channel to the Workspace Agent and copy the trigger endpoint and access token supplied by Agent Studio. Configure both values on the DevSpace server:

```bash
export DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL='https://api.chatgpt.com/v1/workspace_agents/<trigger-id>/trigger'
export DEVSPACE_WORKSPACE_AGENT_ACCESS_TOKEN='<access-token>'
```

Both variables are required together. If neither is set, agent workers remain provider-neutral: `agent.spawn` creates the DevSpace task/workspace and returns `dispatch: "manual"` plus the generated child prompt without making an external request.

When configured, `agent.spawn` posts the generated prompt to the Workspace Agent trigger and returns `dispatch: "automatic"` after HTTP 202 is accepted.

The trigger URL is restricted to HTTPS on `api.chatgpt.com` and the Workspace Agent trigger path. Tokens are never included in task state, tool output, or normal error text.

Transient Workspace Agent trigger failures are retried up to three times with 2s, 5s, and 10s delays. HTTP 409, 429, and 5xx responses, plus request-level failures such as timeouts or connection errors, are retryable. Authentication/authorization failures and other non-retryable 4xx responses fail immediately.

All attempts for one dispatch use the same `Idempotency-Key`, so a retry cannot enqueue a duplicate trigger event if the previous attempt was accepted but its response was lost. Retry logs include the DevSpace task/workspace IDs, attempt number, status or sanitized request error, and delay; the Workspace Agent access token is redacted.

## Callback capability

A worker pass receives a random one-use-style callback capability in its dispatch prompt. DevSpace persists only the SHA-256 hash in task history.

The callback is required by `agent.complete` and `agent.fail`, which allows a worker running under a different ChatGPT conversation or OAuth caller to report into the parent-owned task without giving it unrestricted ownership of that task.

When the parent requests a revision, DevSpace rotates the callback capability. A stale worker cannot complete the revised pass with the previous token.

## Parent review contract

A worker calling `agent.complete` does **not** mean the development task is approved. It moves the DevSpace task to `input_required`.

The parent should then inspect the assigned `workspaceId` directly using DevSpace:

1. inspect `git status` and the actual diff;
2. read changed files where needed;
3. run or re-run relevant tests/checks independently;
4. compare the implementation against the original task;
5. call `agent.approve` only when the repository evidence is acceptable;
6. otherwise call `agent.revise` with concrete review feedback.

The worker's `summary`, `changedFiles`, `tests`, and optional `commit` fields are navigation hints, not trusted proof.

## Failure and recovery

If the Workspace Agent trigger request fails, DevSpace records the agent task as `failed` and preserves the assigned workspace/worktree for inspection.

If a worker fails after dispatch, it should call `agent.fail` with its callback capability and a concise error.

A cancelled or failed task does not automatically delete a managed worktree. Cleanup should remain a separate explicit workspace lifecycle operation so unfinished changes are not destroyed implicitly.
