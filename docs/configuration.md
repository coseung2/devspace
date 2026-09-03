# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_WORKSPACE_ALIASES` | JSON object mapping short aliases such as `aura` to project paths. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_REMOTE_EXTENSION_ORIGINS` | Comma-separated exact `chrome-extension://<id>` origins allowed to use the authenticated Roche remote worker projection. Empty by default (disabled). |

Workspace aliases may also be persisted in `~/.devspace/config.json`:

```json
{
  "allowedRoots": ["/actual/devspace/projects"],
  "workspaceAliases": {
    "aura": "/actual/devspace/projects/aura",
    "aura-board": "/actual/devspace/projects/aura-board"
  }
}
```

Replace `/actual/devspace/projects` with the actual project root on the
DevSpace VM before saving the file.

Or configure them with the CLI:

```bash
devspace config set workspaceAlias aura /actual/devspace/projects/aura
devspace config set workspaceAlias aura-board /actual/devspace/projects/aura-board
```

Replace `/actual/devspace/projects` with the actual DevSpace VM path before
running these commands.

`open_workspace` accepts either `path` or `alias`. Alias targets still have to
be inside `DEVSPACE_ALLOWED_ROOTS`; the alias is only a convenience name, not a
permission bypass.

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

`DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` is matched as an exact hostname list.
Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are always accepted. Every
other host must be listed literally: wildcards, suffix patterns, and parent
domains are not accepted, so `chromiumapp.org` does not authorize
`<extension-id>.chromiumapp.org`, and a listed host does not authorize a
subdomain of it. Dynamic client registration is rejected when any single
`redirect_uris` entry fails this check.

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the legacy tools plus dedicated `grep`, `glob`, `ls`, `exec_command`, and `write_stdin` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_OUTPUT_PROFILE` controls the amount of process output returned to the
host. `default` preserves the larger CLI-oriented limits. `web` uses a 3,000
token default and caps each `exec_command` or `write_stdin` response at 12,000
tokens, while retaining the full in-memory process buffer for later polls.

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

## Roche Remote Worker Projection

The Roche browser extension reads the DevSpace-owned task and process graph
through these authenticated endpoints:

```text
GET  /v1/worker/snapshot
POST /v1/worker/action
```

Both endpoints require an OAuth bearer token with the configured DevSpace scope
and an exact origin listed in `DEVSPACE_REMOTE_EXTENSION_ORIGINS`. The snapshot
contains `protocolVersion: 1`, an Owner/workspace-scoped task list, and a
revision. Actions accept `send_input`, `resume`, `approve`, or `cancel`, plus an
`idempotencyKey` and optional `expectedRevision`. A revision conflict is
returned instead of applying an action against stale UI state.

Tasks are owned by one Owner task scope rather than by OAuth `clientId`, so a
task created from the ChatGPT app is visible and actionable from the extension
and vice versa. `clientId` only namespaces `idempotencyKey` values. Existing
databases are re-keyed by the `mcp-task-owner-caller-key` migration, which
preserves every task field; new databases start in the same state. This shared
scope is safe only because DevSpace is single-user and every client requires the
same Owner approval, and it means any leaked bearer token can read and act on
every Owner-scoped task. See `docs/security.md`.

Configure the production extension ID explicitly; do not use a wildcard:

```bash
DEVSPACE_REMOTE_EXTENSION_ORIGINS="chrome-extension://abcdefghijklmnop" \
npx @waishnav/devspace serve
```

### Two independent extension allowlists

The extension needs two separate server allowlists. They hold different kinds of
values and neither one implies the other:

| Variable | Value kind | Purpose |
| --- | --- | --- |
| `DEVSPACE_REMOTE_EXTENSION_ORIGINS` | exact `chrome-extension://<id>` origin | authorizes projection requests from the extension |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | exact hostname | authorizes the OAuth callback host used during registration and authorization |

For the fixed development extension ID `gefkajhiepdopchmhaliiecdmfohgbce`, the
origin is `chrome-extension://gefkajhiepdopchmhaliiecdmfohgbce` and the redirect
host is `gefkajhiepdopchmhaliiecdmfohgbce.chromiumapp.org`. Add the redirect host
alongside the hosts already authorized for other clients rather than replacing
them:

```bash
DEVSPACE_REMOTE_EXTENSION_ORIGINS="chrome-extension://gefkajhiepdopchmhaliiecdmfohgbce" \
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,localhost,127.0.0.1,gefkajhiepdopchmhaliiecdmfohgbce.chromiumapp.org" \
npx @waishnav/devspace serve
```

Neither list accepts wildcards or pattern entries. `chrome-extension://*`,
`*.chromiumapp.org`, and a bare `chromiumapp.org` are all rejected or simply do
not match, so a different extension's `<other-id>.chromiumapp.org` callback
cannot register against this server. Setting only the origin leaves the OAuth
authorization flow failing at registration; setting only the redirect host
leaves `/v1/worker/snapshot` and `/v1/worker/action` rejecting the extension.

Issued bearer and refresh tokens stay inside the extension in
`chrome.storage.session`. DevSpace stores only their hashes, and tokens are
never logged, displayed, exported, or written to any other extension storage
area.

The legacy `/worker.snapshot` and `/worker.action` endpoints remain loopback-
only development routes. Remote projection state is not a second task store;
the SQLite task store and DevSpace process manager remain authoritative.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_TRUST_PROXY=1` when DevSpace is reached through a reverse proxy
running on the same machine, such as Tailscale Funnel forwarding to the default
loopback listener. DevSpace trusts forwarded client addresses only from
loopback proxy hops; direct non-loopback clients cannot supply trusted proxy
headers.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
