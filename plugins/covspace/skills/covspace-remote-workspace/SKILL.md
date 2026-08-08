---
name: covspace-remote-workspace
description: Use the Covspace plugin to work in the OCI VM workspace at /home/covspace/projects without changing the existing DevSpace setup. Use when the user asks to inspect, edit, run, synchronize, commit, pull, or push the opencodex, aura, or aura-board repositories in Covspace.
---

# Covspace remote workspace

Covspace is a separate remote workspace. Do not change DevSpace configuration or assume that a DevSpace path points to Covspace. The plugin connects to a VM-resident MCP server over Tailscale; it must not require this laptop's SSH key for normal operation.

## Workspace

- Host: private Tailscale address assigned to the Covspace OCI VM
- User: `covspace` (system user; no sudo, OCI, or production-key access)
- Root: `/home/covspace/projects`
- Transport: VM-resident Streamable HTTP MCP over the private Tailscale network
- Repositories: `opencodex`, `aura`, `aura-board`
- GitHub authentication: repository-specific SSH deploy keys owned by `covspace`

Call `open_workspace` once for the requested repository and reuse its `workspaceId`. Use the workspace-scoped `read`, `write`, `edit`, `grep`, `glob`, `ls`, `bash`, and `git` tools thereafter. `covspace_projects` lists the root and repository paths. Paths passed to workspace tools are relative to the opened repository and cannot escape it.

## Git workflow

1. Call `open_workspace` for one of `opencodex`, `aura`, or `aura-board`.
2. Inspect the relevant files and current branch/worktree state.
3. Make focused edits through `edit` or `write`.
4. Run targeted tests or checks through `bash`.
5. Review `git` status and diff before committing.
6. Commit and push only when the user explicitly requests it.

The plugin does not replace DevSpace and does not alter local DevSpace configuration. The older `/home/ubuntu/covspace` checkout is intentionally preserved separately and is not the active Covspace service root.
