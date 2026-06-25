# Switchboard

Cross-team communication, devcontainer orchestration, and tool proxying for agent teams. Connects Claude Code, Cursor, Copilot, and Codex agents running in separate DevContainers through a central gateway (a Gateway).

## Who it's for

This is aimed at people who already use **Dev Containers** and want agent teams in different containers to talk to each other. If you don't use Dev Containers, this project won't help you.

## How it works

Teams register with the gateway (a Gateway) over WebSocket. Any agent can call `crosstalk_send` to reach another team. The gateway handles message delivery, response lifecycle, and request serialization.

- **Claude agents** use channel mode: messages arrive as push notifications, responses are pushed back automatically.
- **CLI agents** (cursor, copilot, codex) use inject mode: the gateway spawns agent processes, sends prompts, and waits for completion.

The gateway also bridges to **evie-bot** (a Discord bot running in Kubernetes), proxying its 46 action tools as MCP tools and forwarding Discord DMs into the host Claude session.

See `skills/crosstalk/SKILL.md` for the full tool reference and response format.

## Architecture

```
Host Machine
  start-host-daemon.sh
    Claude Code (host orchestrator)
      MCP Plugin (main-mcp.ts)
        crosstalk_send / crosstalk_discover
        dispatch_cli / dispatch_exec
        session_peek / session_send
        evie_* tools (46 proxied from evie-bot)

Docker: switchboard (port 20000)
  Gateway (main-gateway.ts)
    HTTP routes + WebSocket hub
    Evie WS client over the k8s API service-proxy (SA token + admission)

DevContainers (one per project)
  Claude / Cursor / Copilot / Codex
    MCP Plugin (main-mcp.ts)
      crosstalk_send / channel_reply / crosstalk_reply
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

### Host-only tools (orchestrator)

| Tool | Description |
|------|-------------|
| `dispatch_cli` | Run a CLI agent (cursor/copilot/codex) inside a devcontainer |
| `dispatch_exec` | Execute a shell command inside a devcontainer |
| `session_peek` | Capture the visible tmux screen of a team's Claude session |
| `session_send` | Send a line of input to a team's tmux session |
| `crosstalk_send` | Send a request to another team |
| `crosstalk_discover` | List all teams on the bridge |
| `evie_*` | 46 proxied tools from evie-bot (Discord, Cloudflare, Linode, Cursor, etc) |

### Container tools (all agents)

| Tool | Description |
|------|-------------|
| `crosstalk_send` | Send a request to another team |
| `crosstalk_discover` | List all teams on the bridge |
| `crosstalk_wait` | Wait N seconds before retrying a deferred request |
| `channel_reply` | Reply to an incoming channel message (Claude only) |
| `crosstalk_reply` | Reply to an incoming bridge request (CLI agents only) |
| `mcpConnectorStatus` | Game client connector status |
| `mcpConnectorServe` | Start serving project tools on the connector port |
| `mcpConnectorUnserve` | Stop serving project tools |
| Project tools | Dynamic tools from the project's `mcp-schema.js` |

## Evie Bridge

When a service-proxy transport (`transport.json`, delivered by enrollment) is present in the gateway's federation dir, the gateway connects to evie-bot over the Kubernetes API server's service-proxy. The transport's SA token authenticates to the API server (scoped by RBAC), the cluster CA is pinned for TLS, and registration is gated by the owner-signed admission. This enables:

- **Tool proxying**: Evie's action registry (46 tools) is exported as JSON Schema and dynamically registered as MCP tools on the host, prefixed with `evie_`.
- **DM forwarding**: Discord DMs from the bot owner are forwarded to the host orchestrator as channel push notifications.
- **Tool calls**: The host can invoke any evie action through the proxied MCP tools.

## Using Cursor agents instead of Claude

Set `AGENT_TYPE=cursor` in your devcontainer environment. The bridge auto-detects which CLI agent is available if not set.

## Circular dependency warning

If Team A is waiting on Team B, Team B must not call back to Team A. Both will deadlock until timeout.
