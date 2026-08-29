# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Roche Browser Projection

The Roche extension's remote worker projection is disabled unless
`DEVSPACE_REMOTE_EXTENSION_ORIGINS` contains one or more exact
`chrome-extension://<id>` origins. Requests to `/v1/worker/snapshot` and
`/v1/worker/action` require both that origin and a valid OAuth bearer token for
the configured DevSpace resource and scope. Wildcards, arbitrary web origins,
and missing origins are rejected.

Remote task reads and actions are scoped to the single Owner task scope, the
same scope the MCP task tools use. The projection exposes no owner-level
`listAll` path: it lists only Owner-scoped tasks, optionally narrowed by
`workspaceId`. The action endpoint also checks the caller's revision and accepts
an idempotency key so reconnects do not silently replay an ambiguous browser
action. Idempotency keys are namespaced per OAuth client, and the entries are
process-local, so they are bounded protection rather than a replacement for
durable task state or OAuth authorization.

### One Owner task scope across OAuth clients

DevSpace is a single-user server. Every OAuth client, whether it is the ChatGPT
app or an independently registered browser extension, must be approved with the
same Owner password before it receives a token, and any such token already
grants the full workspace, filesystem, and shell authority of this server.
Splitting task ownership by OAuth `clientId` therefore adds no security
boundary; it only hides the Owner's own tasks from the Owner's other client.

Tasks are consequently owned by one stable Owner caller key. A task started from
the ChatGPT app is visible and actionable from the browser extension and vice
versa. `clientId` remains only an idempotency namespace and an audit value.

This sharing is safe *only* because of the single-user, single-approval model. It
also means the authority of a compromised bearer token is wider than a
client-scoped model would suggest: a stolen or leaked token can read every
Owner-scoped task on this server, including tasks created by another client, and
can send input to, resume, approve, or cancel any of them. Treat a token
compromise as full Owner compromise: rotate the Owner password, revoke tokens,
and restart the server. Do not host a multi-tenant or shared-account DevSpace
deployment on this model.

The browser extension must never copy ChatGPT cookies, session storage,
workspace grants, or account credentials. Its transport is a thin projection
client; DevSpace remains the only execution and orchestration authority.

### Extension origin and redirect host are separate grants

Authorizing the extension requires two independent allowlist entries, and each
one grants a different thing:

- `DEVSPACE_REMOTE_EXTENSION_ORIGINS=chrome-extension://gefkajhiepdopchmhaliiecdmfohgbce`
  authorizes projection requests coming from that extension origin.
- `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` must contain
  `gefkajhiepdopchmhaliiecdmfohgbce.chromiumapp.org` alongside the hosts already
  authorized for other clients, which authorizes the OAuth callback used by the
  Authorization Code + PKCE flow.

These are different values, not two spellings of one grant, and neither implies
the other. Both lists are matched exactly; wildcards and pattern entries such as
`chrome-extension://*`, `*.chromiumapp.org`, or a bare `chromiumapp.org` are not
accepted. Because `chromiumapp.org` callback hostnames are derived from the
extension ID, exact matching is what prevents another extension's
`<other-id>.chromiumapp.org` redirect from registering a client against this
server. Dynamic registration fails if any one submitted `redirect_uris` entry is
outside the allowlist, so a valid Roche callback cannot be used to smuggle in a
second unauthorized redirect.

Bearer and refresh tokens issued to the extension remain extension-local and
session-only in `chrome.storage.session`. DevSpace persists only token hashes.
Tokens are never logged, rendered in UI, exported, or copied into
`chrome.storage.local`, page storage, or a ChatGPT tab.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.
