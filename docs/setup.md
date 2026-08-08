# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through DevSpace.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server

DevSpace does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

### Open projects by alias

If the DevSpace host contains fixed projects such as Aura and Aura Board, add
short names once:

```bash
devspace config set workspaceAlias aura /actual/devspace/projects/aura
devspace config set workspaceAlias aura-board /actual/devspace/projects/aura-board
```

Replace `/actual/devspace/projects` with the actual project root on the
DevSpace VM. The path is intentionally not hard-coded here because it belongs
to the DevSpace installation, not to this package's documentation.

The coding host can then call `open_workspace` with `{ "alias": "aura" }` or
`{ "alias": "aura-board" }` instead of needing to know the VM filesystem path.

### View an Aura development server from another computer

The MCP URL and the browser preview URL can be different. Configure the public
origin that points to this DevSpace VM (for example a Tailscale hostname):

```bash
devspace config set previewBaseUrl https://devspace.example.com
```

After opening Aura or Aura Board by alias, call `open_preview` with a command
and port, for example:

```json
{
  "workspaceId": "<workspaceId>",
  "command": "npm run dev",
  "port": 3000
}
```

Use the returned URL from a laptop or desktop that can reach the configured
preview origin. The application must listen on the port supplied to
`open_preview`; DevSpace supplies `HOST=0.0.0.0`, `VITE_HOST=0.0.0.0`, and
`PORT=<port>` to the process. The preview route is random and is not an
authentication boundary, so use a private VPN/tunnel and do not expose it on a
public internet endpoint without an access control layer.

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
