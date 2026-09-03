# DevSpace

DevSpace is the workspace-scoped MCP plugin for development repositories hosted on the `testauram` OCI VM. The MCP server runs on the VM and exposes file, search, shell, and Git tools over Tailscale HTTPS. An authorized ChatGPT or Codex session can open `/home/devspace/projects/<repo>` without depending on a local checkout or local SSH key.

## Architecture

- Plugin source and manifest: this repository
- MCP transport: Streamable HTTP at `https://testauram-covspace.tail4cbe57.ts.net/mcp`
- Authentication: OAuth 2.1 authorization code with PKCE, DCR, rotating refresh tokens, and hashed token persistence
- VM service account: `devspace`
- Workspace root: `/home/devspace/projects`
- Representative repositories: `opencodex`, `aura`, and `aura-board`; any repository under the configured allowed root can be opened when permitted by the server.

The plugin contains only the DevSpace manifest, MCP registration, and workspace skill. Runtime execution is provided by the repository's main DevSpace server and its `devspace-mcp.service` deployment.

## Token lifecycle

Access tokens last one hour. Every authorization-code exchange also issues a one-year refresh token. Refresh requests rotate the refresh token, invalidate the old token, and atomically persist token digests under `DEVSPACE_OAUTH_STATE_DIR` so a service restart does not disconnect existing plugin installations. Reuse of a rotated token revokes its refresh-token family. Tool calls enforce the scopes carried by the access token. Raw bearer tokens are never persisted.

## Validation

Run validation from the repository root with `npm test`, `npm run typecheck`, and
`npm run build`. The main DevSpace server owns the OAuth, MCP transport, and
workspace regression tests.

## Deployment

Deploy the main `dist/` runtime through `devspace-mcp.service`, preserve the
existing environment file and `/var/lib/devspace-mcp` state directory, restart
the service, then verify:

```bash
curl -fsS https://testauram-covspace.tail4cbe57.ts.net/healthz
curl -fsS https://testauram-covspace.tail4cbe57.ts.net/.well-known/oauth-authorization-server
```

The metadata response must advertise both `authorization_code` and `refresh_token`. Do not delete `oauth-clients.json` or `oauth-tokens.json` during deployment; deleting them forces users to reconnect.
