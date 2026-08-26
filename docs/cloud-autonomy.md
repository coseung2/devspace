# Cloud-autonomous DevSpace

This branch starts from upstream `Waishnav/devspace` v1.0.8 (`fe712e2`) rather than rebasing the old fork in place.

The target is an always-on DevSpace host that lets ChatGPT do routine coding work while the user's PC is offline. ChatGPT owns planning and tool selection. DevSpace owns workspace isolation, filesystem/process access, authentication, and durable session correlation.

## Design principles

1. **Do not make tool annotations lie.** `destructiveHint` and `openWorldHint` stay aligned with actual behavior. Permission friction should be reduced by narrowing capabilities and removing unnecessary soft restrictions, not by marking dangerous tools safe.
2. **Use hard boundaries for safety.** DevSpace should run as an unprivileged Linux account with narrow allowed roots. The shell can do everything that OS account can do, so the OS/container boundary is the real security boundary.
3. **Prefer the upstream Codex-style tool surface.** `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin` are the preferred base. They are smaller and support PTY/process sessions.
4. **Routine workspace-local work should not self-block.** Server instructions may allow inspection, source edits, dependency installation, builds, tests, migrations against development resources, and dev-server/process management when these are necessary to satisfy the user's request.
5. **External side effects stay explicit.** Pushes, deployments, credential/secret mutation, production data changes, destructive environment changes, paid external actions, and privilege escalation require explicit user intent and should use separately identifiable capabilities where practical.
6. **Parallel chats use isolation rather than a global task state machine.** Child ChatGPT conversations should open separate managed worktrees when they may write concurrently. Conversation orchestration can remain a small MCP/mailbox layer outside DevSpace.

## Old fork commit disposition

The old fork diverged after upstream v1.0.6. Re-port only behavior that is still useful on top of current upstream.

| Commit | Disposition | Reason |
| --- | --- | --- |
| `5be76c38` VM-backed Covspace plugin | **Replace** | The always-on host should run current DevSpace directly. Keep deployment knowledge, not a second bespoke MCP implementation. |
| `9823364a` migrate Covspace OAuth refresh tokens | **Drop from runtime** | This migration belongs to the retired Covspace JSON token store. Current upstream DevSpace uses its own persisted OAuth store. If old production state must be moved, use a one-shot migration tool instead. |
| `bbf522ed` workspace aliases + remote previews | **Split** | Re-port workspace aliases. Do not restore the remote-preview subsystem in the first cloud-autonomy version. |
| `16f83082` remove local subagent runtime | **Drop** | It conflicts with the newer upstream agent/provider stack. Keep upstream behavior. |
| `ae41b97a` stateless MCP transport | **Drop** | Current upstream has bounded MCP session/reconnect handling. Do not replace it with the old stateless transport. |
| `e16db924` trim legacy plugin / workspace recovery | **Drop / re-evaluate individual fixes only** | The surrounding upstream code has been substantially rewritten. Port only a bug that can still be reproduced. |
| `a2f7b7a8` remove remote preview runtime | **No port** | Remote previews are not being reintroduced, so this is already satisfied. |
| `775c4019` trust loopback reverse proxies | **Drop** | Current upstream exposes `DEVSPACE_TRUST_PROXY` and applies loopback proxy trust explicitly. |
| `c597a6b5` stabilize workspace tool results | **Re-test before porting** | Upstream structured content/tool-card handling has changed. Port only if the old failure reproduces. |
| `cd8484b4` resolve aliases from path suffixes | **Port with aliases** | Useful for ChatGPT hosts that send a guessed path ending in a known project name. Alias targets remain constrained by allowed roots. |
| `520942a5` decouple workspace opening from widget resources | **Drop unless reproduced** | Upstream widget modes and resource attachment behavior have changed. The old coupling fix should not be blindly reapplied. |
| `b4d11454` task-aware context harness | **Optional later port** | Valuable but large and orthogonal to the minimal cloud-autonomy runtime. Reintroduce after the core host is stable. |

## Cloud-autonomy v1

The first implementation should use current upstream and add only the following behavior.

### 1. Workspace aliases

Restore a small `workspaceAliases` map and allow `open_workspace` to accept either an explicit path or an alias. An alias is only name resolution; the resolved path must still be under `allowedRoots`.

Path-suffix recovery may map `~/aura`, `/workspace/aura`, or `C:\\workspace\\aura` to alias `aura` when that alias exists. This is convenience only and must never expand the allowlist.

### 2. Cloud autonomy profile

Add an opt-in profile, tentatively `DEVSPACE_AUTONOMY_PROFILE=cloud`.

When enabled and not overridden explicitly:

- prefer `DEVSPACE_TOOL_MODE=codex` behavior;
- keep OAuth, allowed roots, worktree root, and Host checks unchanged;
- give the model instructions to complete routine workspace-local development actions without asking for extra confirmation merely because the action uses a shell or changes project files;
- continue to distinguish external publication/deployment/credential/production actions from local development work.

The profile must **not** change a destructive or open-world annotation to `false` unless the underlying tool has been made deterministically non-destructive or closed-world.

### 3. Isolation defaults

For parallel implementation, callers should request `mode="worktree"`. A later revision may default cloud-profile conversations to managed worktrees when a reliable ChatGPT conversation scope is present, but v1 should not silently change checkout semantics until merge/finalization behavior is defined.

Recommended host layout:

```text
/srv/devspace/projects      # approved source repositories
/srv/devspace/worktrees     # managed isolated worktrees
/var/lib/devspace           # persistent DevSpace state
```

Run DevSpace as a dedicated unprivileged `devspace` account. Do not put root credentials, cloud-admin credentials, or unrelated home-directory secrets in that account.

### 4. Process execution

Use upstream `exec_command` + `write_stdin` for builds, tests, package scripts, long-running processes, and PTY sessions.

Do not claim `exec_command` is closed-world: a general process can open the network. If approval friction around ordinary local commands remains material after the cloud profile is deployed, the next step is a separate **deterministically sandboxed local executor** (for example a child process/container with network disabled), rather than relabeling the general executor.

### 5. Explicit external capability later

If needed, add separate tools for high-impact actions, for example:

```text
exec_local      # sandboxed/closed-world development execution
exec_external   # network/external side effects
publish         # git push/deploy/release boundary
```

Those tools should be introduced only when their enforcement matches their annotations.

## Relationship to Web-GPT subagents

DevSpace is the coding/runtime plane, not the agent orchestrator.

```text
Parent ChatGPT
  -> child ChatGPT conversation(s)
       -> @DevSpace
            -> isolated cloud worktree
```

A separate minimal conversation broker can later provide `spawn`, `send`, `wait`, `cancel`, and child completion correlation. DevSpace does not need to own a second task state machine for that purpose.

## Immediate validation sequence

1. Re-port aliases onto this branch with tests.
2. Add the opt-in cloud autonomy profile and instruction tests.
3. Run upstream typecheck and test suite.
4. Deploy this branch to the always-on VM under a dedicated unprivileged account.
5. Connect ChatGPT and compare routine work under `minimal` versus cloud/Codex mode, recording every host-side confirmation or model self-block.
6. Only after observing the remaining friction, decide whether a sandboxed `exec_local` tool is justified.
