---
name: devspace-remote-workspace
description: Use the DevSpace plugin to work in the OCI VM workspace at /home/devspace/projects without changing the existing DevSpace setup. Use when the user asks to inspect, edit, run, synchronize, commit, pull, or push the opencodex, aura, or aura-board repositories in DevSpace.
---

# DevSpace remote workspace

DevSpace is the remote workspace. Use it for repositories hosted on the VM; do not assume that a local path points to the same checkout. The plugin connects to the VM-resident MCP server over Tailscale and does not require this laptop's SSH key for normal operation.

## Workspace

- Host: private Tailscale address assigned to the DevSpace OCI VM
- User: `devspace` (system user; no sudo, OCI, or production-key access)
- Root: `/home/devspace/projects`
- Transport: VM-resident Streamable HTTP MCP over the private Tailscale network
- Repositories: `opencodex`, `aura`, `aura-board`
- GitHub authentication: repository-specific SSH deploy keys owned by `devspace`

Call `open_workspace` once for the requested repository and reuse its `workspaceId`. Use the workspace-scoped `read`, `write`, `edit`, `grep`, `glob`, `ls`, `bash`, and `git` tools thereafter. `devspace_projects` lists the root and repository paths. Paths passed to workspace tools are relative to the opened repository and cannot escape it.

## Git workflow

1. Call `open_workspace` for one of `opencodex`, `aura`, or `aura-board`.
2. Inspect the relevant files and current branch/worktree state.
3. Make focused edits through `edit` or `write`.
4. Run targeted tests or checks through `bash`.
5. Review `git` status and diff before committing.
6. Commit and push only when the user explicitly requests it.

The plugin is the DevSpace remote-workspace entry point and does not alter local DevSpace configuration. The active service root is `/opt/devspace` and its project roots are under `/home/devspace/projects`.
