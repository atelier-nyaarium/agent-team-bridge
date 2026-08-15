# Switchboard

Cross-team communication and devcontainer coordination for Claude agent teams. Teams running in separate Dev Containers (and host sessions) reach each other through a central gateway, which also federates with the gateways on other machines and bridges a native Android console.

## Who it's for

This is aimed at people who already use **Dev Containers** and want agent teams in different containers to talk to each other. If you don't use Dev Containers, this project won't help you.

## How it works

Teams register with the gateway over WebSocket. Any agent can call `crosstalk_send` to reach another team. The gateway handles message delivery, the response lifecycle, and request serialization.

- Agents use **channel mode**: messages arrive as push notifications and replies push back automatically, so there is no polling.
- The gateway connects to **evie-bot** (a content-blind router running in Kubernetes) to reach the gateways on other machines and to relay the Android console. evie forwards end-to-end-sealed frames between gateways without reading them.

See `skills/crosstalk/SKILL.md` for the full tool reference and response format.

## Architecture

```
Host Machine
  start-host-daemon.sh
    Host daemon (headless) - devcontainer wake, console terminal view, session spawn
      Claude Code session (spawned on demand via create_session) - joins the gateway as a loose peer
        MCP Plugin (main-mcp.ts): crosstalk_* / channel_reply* / notify_human

Docker: switchboard (port 20000)
  Gateway (main-gateway.ts)
    HTTP routes + WebSocket hub
    Evie WS client over the k8s API service-proxy (SA token + owner-signed admission)
      cross-gateway federation routing + Android console relay

DevContainers (one per project)
  Claude Code
    MCP Plugin (main-mcp.ts): crosstalk_* / channel_reply* / notify_human
      Game client connector (port 20002)
```

### Port Map

| Port  | Service                              |
|-------|--------------------------------------|
| 20000 | Gateway (HTTP + WS bridge)           |
| 20001 | Federation Router (TLS)              |
| 20002 | MCP Connector (game client WS)       |
| 20003 | Enrollment TLS (arming only)         |

## Starting the gateway

```bash
docker compose up -d
```

The gateway listens on port 20000 and uses the external network `switchboard`.

## Setup

**1. Install the plugin.** In Claude Code:

```
claude plugin marketplace add atelier-nyaarium/claude-marketplace

claude plugin install switchboard@atelier-nyaarium
```

Autoupdate is a settings flag. One-line jq version:

```
tmp=$(mktemp) && jq '. * {extraKnownMarketplaces: {"atelier-nyaarium": {autoUpdate: true}}}' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
```

**2. Set environment variables** in your devcontainer - this is what lets your team's MCP plugin find its gateway, and is required for every devcontainer regardless of whether that gateway is enrolled into federation:

- `PROJECT_NAME` - Your team's name on the bridge (e.g. `my-project`)
- `BRIDGE_ROUTER_URL` - Router URL (default: `http://switchboard:20000`)

**3. Add the Docker network** to your devcontainer:

```bash
/path/to/switchboard/install.sh
```

This adds `switchboard-network` to your `.devcontainer/compose.yml`.

**4. Rebuild the Devcontainer.**

- **F1** then `Dev Containers: Rebuild Container`

**To remove the network config:**

```bash
/path/to/switchboard/uninstall.sh
```

### Optional: Android console app and cross-machine federation

The steps above are everything you need for local crosstalk between devcontainers on one machine - a gateway that is never enrolled still boots in "arming mode" and routes that traffic fine. If you also want the native Android console app, or to link multiple machines' gateways together, the gateway's owner (a one-time action per gateway, not something each devcontainer does) runs `./setup.sh` - see the "Deploying the federation" section of `CLAUDE.md` for the full enrollment flow.

## MCP Tools

Every session registers the same core tools; the game-client connector is the only container-only addition.

### Every session

| Tool | Description |
|------|-------------|
| `crosstalk_send` | Send a request to another team |
| `crosstalk_discover` | List all teams on the bridge |
| `crosstalk_wait` | Wait N seconds before retrying a deferred request |
| `channel_reply` | Reply to an incoming channel message |
| `channel_reply_structured` | Reply with a native-object payload, only when the inbound tag carries a `reply_schema` |
| `notify_human` | Push a notice to the owner's consoles |
| `reload_plugins` | Run the plugin update + MCP reconnect sequence |
| `set_effort_level` | Set the session's effort level |
| `compact_session` | Compact the session's context |

### Container-only

| Tool | Description |
|------|-------------|
| `mcpConnectorStatus` / `mcpConnectorServe` / `mcpConnectorUnserve` | Game client connector control |
| Project tools | Dynamic tools from the project's `mcp-schema.js` |

## Evie Bridge

When a service-proxy transport (`transport.json`, delivered by enrollment) is present in the gateway's federation dir, the gateway connects to evie-bot over the Kubernetes API server's service-proxy. The transport's SA token authenticates to the API server (scoped by RBAC), the cluster CA is pinned for TLS, and registration is gated by the owner-signed admission.

evie is a **content-blind router**: it relays sealed frames without reading them. It carries:

- **Cross-gateway federation**: a gateway reaches teams on another machine's gateway through evie, which routes each end-to-end-sealed frame by destination gateway id and never parses the payload.
- **Console relay**: the native Android console reaches the gateway through evie, which relays the console's opaque frames over the same WebSocket.

## Circular dependency warning

If Team A is waiting on Team B, Team B must not call back to Team A. Both will deadlock until timeout.
