# Covspace VM deployment

This directory contains the VM-resident Covspace MCP entry point used by the
`plugins/covspace` ChatGPT/Codex plugin.

Install `server.mjs` as `/opt/covspace-mcp/server.mjs` and run it with the
existing `covspace-mcp.service`. Preserve `/var/lib/covspace-mcp` across
deployments because it contains registered OAuth clients and hashed token
state. The service must run as the unprivileged `covspace` account with
`COVSPACE_ROOT=/home/covspace/projects`.

The deployed endpoint is private to the testauram Tailscale network:

```text
https://testauram-covspace.tail4cbe57.ts.net/mcp
```

After deployment, verify `/healthz` and the OAuth authorization-server
metadata before testing a workspace tool call.
