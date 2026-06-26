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
    Host daemon (headless) - devcontainer wake + the console terminal view
  start-session.sh <name>
    Claude Code session - joins the gateway as a loose peer
      MCP Plugin (main-mcp.ts): crosstalk_* / channel_reply / notify_human

Docker: switchboard (port 20000)
  Gateway (main-gateway.ts)
    HTTP routes + WebSocket hub
    Evie WS client over the k8s API service-proxy (SA token + owner-signed admission)
      cross-gateway federation routing + Android console relay

DevContainers (one per project)
  Claude Code
    MCP Plugin (main-mcp.ts): crosstalk_* / channel_reply / notify_human
      Game client connector (port 20002)
```

### Port Map

| Port  | Service                              |
|-------|--------------------------------------|
| 20000 | Gateway (HTTP + WS bridge)           |
| 20001 | Evie bridge server (tool call WS)    |
| 20002 | MCP Connector (game client WS)       |

## Starting the gateway

```bash
docker compose up -d
```

The gateway listens on port 20000 and uses the external network `switchboard`.

## Setup

**1. Install the plugin.** In Claude Code:

```
/plugin install atelier-nyaarium/switchboard
```

The plugin provides the MCP server and skills automatically.

**2. Set environment variables** in your devcontainer:

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

## MCP Tools

Every session registers the same core tools; the game-client connector is the only container-only addition.

### Every session

| Tool | Description |
|------|-------------|
| `crosstalk_send` | Send a request to another team |
| `crosstalk_discover` | List all teams on the bridge |
| `crosstalk_wait` | Wait N seconds before retrying a deferred request |
| `channel_reply` | Reply to an incoming channel message |
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
