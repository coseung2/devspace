# Covspace

Covspace is a DevSpace-style MCP plugin for development repositories hosted on the `testauram` OCI VM. The MCP server runs on the VM and exposes workspace-scoped file, search, shell, and Git tools over Tailscale HTTPS. A client can therefore open `/home/covspace/projects/<repo>` from any authorized ChatGPT or Codex session without depending on a local checkout or local SSH key.

## Architecture

- Plugin source and manifest: this repository
- MCP transport: Streamable HTTP at `https://testauram-covspace.tail4cbe57.ts.net/mcp`
- Authentication: OAuth 2.1 authorization code with PKCE, DCR, rotating refresh tokens, and hashed token persistence
- VM service account: `covspace`
- Workspace root: `/home/covspace/projects`
- Supported repositories: `opencodex`, `aura`, and `aura-board`

The legacy stdio-to-SSH server in `scripts/covspace-mcp.mjs` is retained only as migration history. Normal plugin operation uses `scripts/covspace-http.mjs` on the VM.

## Token lifecycle

Access tokens last one hour. Every authorization-code exchange also issues a one-year refresh token. Refresh requests rotate the refresh token, invalidate the old token, and atomically persist token digests under `COVSPACE_OAUTH_STATE_DIR` so a service restart does not disconnect existing plugin installations. Reuse of a rotated token revokes its refresh-token family. Tool calls enforce the scopes carried by the access token. Raw bearer tokens are never persisted.

## Validation

```powershell
npm run check
npm test
```

The regression suite exercises the complete OAuth code + PKCE flow, refresh rotation, old-token rejection, MCP authorization, persisted-digest safety, and refresh after a server restart.

## Deployment

Deploy `scripts/covspace-http.mjs` to the VM service path, preserve the existing environment file and `/var/lib/covspace-mcp` state directory, restart the service, then verify:

```bash
curl -fsS https://testauram-covspace.tail4cbe57.ts.net/healthz
curl -fsS https://testauram-covspace.tail4cbe57.ts.net/.well-known/oauth-authorization-server
```

The metadata response must advertise both `authorization_code` and `refresh_token`. Do not delete `oauth-clients.json` or `oauth-tokens.json` during deployment; deleting them forces users to reconnect.
