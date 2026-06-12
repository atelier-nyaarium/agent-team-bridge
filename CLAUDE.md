# Agents

## Key Paths

- `src/` - Main source code
  - `main-mcp.ts` - MCP plugin entry point (loaded by Claude Code / IDE plugins)
  - `main-arbiter.ts` - Arbiter server entry point (runs in Docker)
  - `arbiter/` - **Arbiter server** - Central HTTP + WebSocket router running in Docker
    - `index.ts` - Server setup: Bun.serve, routes, WebSocket handlers, evie client init, port-forward
    - `routes.ts` - HTTP route handlers (send, respond, poll, teams, health, evie tool-call, ingest, human notify broadcast)
    - `websocket.ts` - WebSocket connection handlers, team registry, heartbeat, wake coordination
    - `wake.ts` - WakeCoordinator class for container on-demand startup
    - `connectorProxy.ts` - WebSocket proxy for game client connector pass-through
    - `evie/` - **Evie bridge** - kubectl port-forward tunnel to evie-bot K8s pod
      - `evieClient.ts` - WebSocket client to evie's BridgeServer, tool call forwarding, DM forwarding, `phone_relay` frame intake (`onPhoneRelay`). Inbound frames are boundary-parsed through `EvieInboundFrameSchema` (shared/evie-protocol.ts); unknown/malformed frames are counted and warned, never blind-cast
      - `portForward.ts` - kubectl port-forward child process manager with auto-restart
    - `phone/` - **Phone bridge** - arbiter side of the Android channel (see Phone Bridge below)
      - `phoneHandler.ts` - `createPhoneHandler`: validates device identity, dispatches the phone ops (register/list_teams/send/respond/poll) by reusing the HTTP routes, owns per-conversation mailbox/binding/idempotency state
      - `phonePeer.ts` - `PhonePeer`, a duck-typed virtual bridge socket whose `send()` appends to the device mailbox instead of a wire
      - `relayPump.ts` - `createPhoneRelayPump`: zod-validates each relay frame, runs the handler, sends the reply back to evie as a `phone_relay_reply` tool call
    - `discord/` - Discord utilities (validateMessageParts, used by tests)
  - `mcp/` - **MCP plugin** - Tools registered for Claude Code and other IDE agents
    - `index.ts` - MCP server initialization, mode detection (host vs container), tool registration
    - `bridge/` - **Crosstalk tools** - Cross-team communication via the arbiter
      - `helpers.ts` - Bridge state, WebSocket connection to router, routerPost/routerGet
      - `bridgeDiscover.ts` - `crosstalk_discover` tool: list teams on the bridge
      - `bridgeSend.ts` - `crosstalk_send` tool: send request to another team, poll for response
      - `bridgeWait.ts` - `crosstalk_wait` tool: wait N seconds before retrying
      - `replyTool.ts` - Shared reply tool factory (used by channelReply and cliReply)
      - `registerBridgeTools.ts` - Container-side tool registration (crosstalk + reply tools)
    - `channel/` - **Channel mode** - For Claude agents receiving push notifications
      - `channelNotify.ts` - Emit `notifications/claude/channel` to push messages into Claude sessions; materializes inbound Discord file attachments and prepends a `[FILES]` block to the body
      - `channelReply.ts` - `channel_reply` tool: reply to an incoming channel message
      - `humanTools.ts` - `respond_to_human`, `transfer_human_to`, and `notify_human` tools; `respond_to_human` accepts per-part `{text?, attachments?: [absolutePath, ...]}` so the agent can attach any file from its filesystem; `notify_human` broadcasts a `{tiny, summary, full, attachments?}` notice (all three tiers required) to every registered phone via the arbiter's `POST /human/notify`
      - `evieFiles.ts` - Sanitize, materialize, and render Discord-bridge file attachments under `/tmp/evie-files/<msgId>/`; lazy mtime sweep with 1h TTL
    - `cli/` - **CLI mode** - For non-Claude agents (cursor, copilot, codex)
      - `agentHandlers.ts` - CLI agent process spawners (cursor-agent, copilot, codex)
      - `handleInject.ts` - Handle inject messages from arbiter, spawn CLI agent
      - `promptBuilders.ts` - Build initial and follow-up prompts for injected requests
      - `cliReply.ts` - `crosstalk_reply` tool: reply to an incoming bridge request
    - `connector/` - **Game client connector** - WebSocket bridge for external game clients
      - `connectorTools.ts` - MCP tools for connector management (status, serve, certs, tokens)
      - `projectTools.ts` - Dynamic tool registration from project's mcp-schema.js
      - `listener.ts` - HTTP/HTTPS WebSocket listener for game client connections
      - `sessions.ts` - Connected game client session management
      - `tls.ts` - Self-signed CA and server certificate generation
      - `utils.ts` - Shared utilities (textResult, registerStubTool)
    - `devcontainer/` - **Host-only dispatch tools** - Manage agent sessions in devcontainers
      - `devcontainerCli.ts` - `dispatch_cli` tool: run a CLI agent inside a devcontainer
      - `devcontainerExec.ts` - `dispatch_exec` tool: execute shell commands in a devcontainer
      - `sessionPeek.ts` - `session_peek` tool: capture tmux pane 0 screen of a team's session
      - `sessionSend.ts` - `session_send` tool: send a line of input to a team's tmux session
      - `hostSessionPeek.ts` - `host_session_peek` tool: capture the host's own tmux pane 0 screen
      - `hostSessionSend.ts` - `host_session_send` tool: send input to the host's own tmux session
      - `reloadPlugins.ts` - `reload_plugins` tool: automated plugin update and MCP reconnect sequence
      - `helpers.ts` - Project resolution, container lifecycle, devcontainer CLI discovery
      - `hostWakeListener.ts` - Host-side `host` WebSocket: catalog scan, on-demand container waking
    - `evie/` - **Evie tool proxy** - Dynamic MCP tool registration from evie-bot's action registry
      - `evieTools.ts` - Converts evie's JSON Schema tool definitions to Zod via `z.fromJSONSchema()`
    - `resolve-model.ts` - Model resolution by agent type and effort level
  - `shared/` - Shared utilities used by both arbiter and MCP
    - `types.ts` - Shared TypeScript types; wire shapes derive from schemas.ts via `z.infer` (`ChannelFile`, `TeamInfo`, the enums), local payload/config types stay hand-written
    - `schemas.ts` - THE single zod truth for every wire shape: reply schemas, `PostResponsePart*` (outbound `respond_to_human` parts), `ChannelFileSchema`, `TeamInfoSchema`, the full phone protocol (`PhoneOpSchema`, `PhoneRelayFrameSchema`, `PhoneRelayReplySchema`, op results, `MailboxEntrySchema`), and `ProvisioningSchema`. Every shared schema carries `.meta({ id })` - the id is the generated Kotlin class name (see codegen below)
    - `tmp-files.ts` - `cleanupTmpDir({dir, maxAgeMs, mode: "files" | "dirs"})` - generic lazy mtime sweep used by the connector and the Discord-bridge file materializer
    - `env.ts` - Container detection (isInsideContainer)
    - `mutex.ts` - Mutex class for serializing CLI-mode requests per team
    - `pending-job-store.ts` - PendingJobStore for tracking in-flight requests with timeout/polling
    - `device-mailbox.ts` - `DeviceMailbox` (per-phone inbound queue: monotonic seq, cursor ack, entry cap, epoch) and `DeviceMailboxStore` (per-conversation, idle TTL sweep + LRU device cap, `setOnEvict`)
    - `phone-protocol.ts` - Phone protocol constants + session-id grammars (`NOTICE_SESSION_PREFIX`, `CONV_SESSION_PREFIX` with compose/parse helpers, `PHONE_PROTOCOL_VERSION`); the wire TYPES re-export from schemas.ts via `z.infer`
    - `evie-protocol.ts` - SELF-CONTAINED (zod-only) leaf owning the arbiter<->evie frame vocabulary: `EvieInboundFrameSchema` (tool_registry / tool_result / tool_error / dm_forward / loose phone_relay), `ToolCallFrameSchema`, and `ChannelFileSchema` (re-exported by schemas.ts). Built to be copied verbatim into evie-bot in a later phase; nothing imports into it
    - `stts-providers.ts` - `SttsProviderSchema` for the TTS provider catalog (bundled at `android/.../assets/stts-providers.json`): per-provider id/label/path/container/voices plus a request-body TEMPLATE ($text/$voice). Validated by vitest on every push; the generated Kotlin `SttsProvider` decodes it at runtime and `SttsClient.fillTemplate` fills the template per call
    - `reconnect.ts` - Exponential backoff reconnector for WebSocket connections
  - `__tests__/` - Test files (vitest)
- `skills/` - Claude Code skills
  - `crosstalk/SKILL.md` - Cross-team communication skill (tool reference, response format)
  - `orchestrate/SKILL.md` - Multi-project orchestrator skill (team spawning, relay agents)
- `agents/` - Claude Code agent definitions
  - `team-relay.md` - Smart relay agent for bridging team-lead to devcontainer agents
- `.claude-plugin/plugin.json` - Plugin metadata (name, version, description)
- `.mcp.json` - MCP server config (entry point: main-mcp.ts)
- `docker-compose.yml` - Docker Compose for the arbiter (port 20000, bridge network)
- `Dockerfile` - Arbiter container image (Bun + kubectl + dev tools)
- `install.sh` - Add switchboard Docker network to a devcontainer project
- `uninstall.sh` - Remove switchboard Docker network from a devcontainer project
- `start-arbiter.sh` - Quick script to rebuild and start the arbiter container
- `start-host-daemon.sh` - Start Claude Code host daemon in a tmux session
- `scripts/check-module-residue.ts` - Verify node_modules matches bun.lock (no unsanctioned nested dirs shadowing pinned versions)
- `scripts/codegen-kotlin.ts` - Generate `android/.../proto/Protocol.kt` (kotlinx data classes + sealed `PhoneOp` + wire constants) from the zod truth in `src/shared/schemas.ts`; committed output, drift-checked by ci.yml. Emission rules live in the script header (encode-side sealed only, open Strings for decode-side enums, integer -> Long)
- `tests/fixtures/protocol/` - Golden wire fixtures decoded by BOTH vitest and the Android unit tests; `_manifest.json` is the single inventory both suites iterate (vitest also asserts directory/manifest agreement)

## Architecture

Two separate entry points, two different runtime contexts:

**MCP Plugin** (`main-mcp.ts`) - Loaded by Claude Code or IDE plugins via `.mcp.json`. Runs in the user's process. Provides tools for cross-team communication, devcontainer dispatch, and game client connectors.

**Arbiter** (`main-arbiter.ts`) - Runs in a Docker container. Central HTTP + WebSocket router that all teams connect to. Handles message routing, request/response lifecycle, and the evie-bot bridge.

### Connection Modes

- **Channel mode** (Claude) - Messages arrive as `<channel>` push notifications via `notifications/claude/channel`. Bidirectional, no polling needed. Conversations use persistent channel conversations (see below).
- **CLI mode** (cursor, copilot, codex) - Messages are injected as prompts into spawned agent processes. Uses mutex to serialize requests per team. Each send is a one-shot request/response.

### Channel Conversation Model

Channel-mode agents (Claude windows and devcontainer Claudes) have persistent conversations. Each MCP process generates a stable `conversation_id` on startup and reuses it across WebSocket reconnects for the life of that process.

- The arbiter derives a deterministic channel job key `"conv:" + senderConversationId + ":" + targetTeam`. Every `crosstalk_send` between the same (sender window, target team) pair lands in the same store entry; the caller does not manage session_ids.
- Pending-job entries for channel conversations are marked `persistent: true` and are never swept by the store's TTL cleanup. Transient CLI-mode entries still time out after `RESPONSE_TIMEOUT_MS`.
- `channel_reply` may be called multiple times on the same session_id. Use `status: "running"` for interim updates (phase reports, ACKs, partial results) and `status: "completed"` for the final answer. The conversation only closes when a process exits.
- Responses push back to the specific sender sub-session via `conversationRegistry`, so parallel host windows targeting the same devcontainer do not receive each other's replies.
- Reconnects rebind the conversation: the same `conversation_id` shows up with a new WebSocket, the arbiter swaps the registry pointer, and the conversation resumes without losing state.

### Evie Bridge

The arbiter maintains a kubectl port-forward tunnel to evie-bot's K8s pod (port 20001). A WebSocket client connects with bearer auth and receives:
- Tool registry (action schemas exported as JSON Schema)
- DM forwards (Discord DMs from the owner, relayed to the host orchestrator)
- Tool call results (responses to forwarded tool invocations)

Evie's tools are dynamically registered as MCP tools on the host using `z.fromJSONSchema()` (Zod v4.3.0+), prefixed with `evie_`.

### Discord File Attachments (bridge)

Bidirectional, integrated with the Evie bridge.

**Inbound (user-Discord -> agent):** The bot fetches image and GIF attachment bytes on DM arrival and ships them base64-encoded inside the `dm_forward` frame as a `files` array (`ChannelFile[]`). Other attachment types pass through metadata-only. The arbiter validates the array via `ChannelFilesSchema`, applies a 500 MB consumer-side hard backstop (mirroring the bot's send-side cap), and forwards the payload as part of the `channel_push`. The host MCP plugin's `materializeFiles()` (in `mcp/channel/evieFiles.ts`) writes byte-bearing entries to `/tmp/evie-files/<discord_message_id>/<safeFilename>` via `<path>.tmp.<pid>` + atomic `rename`, then `renderFilesBlock()` builds a unified `[FILES messageId="..."]` block prepended to the channel notification body. Materialized entries get `-> /path` (agent uses `Read`); non-materialized entries do not (agent uses `evie_fetch_message_files`). Lazy mtime sweep keeps the directory bounded with a 1-hour TTL.

**Outbound (agent -> user-Discord):** The `respond_to_human` tool accepts `parts: Array<string | {text?, attachments?: [absolutePath, ...]}>`. Strings auto-wrap to `{text}` via the schema-level `.transform()`. The MCP plugin reads each absolute path with `fs.readFile`, base64-encodes, and ships per-part `{text?, attachments?: [{filename, base64}]}` records via the arbiter's `/human/respond` route. Evie-bot's `BridgeServer.handlePostResponse` rebuilds each part as `channel.send({content, files: AttachmentBuilder[]})`. Discord auto-renders images inline; other files appear as download links. Per-part error handling reports `Sent X/Y parts before failure` so partial sends are visible to the agent.

### Phone Bridge (Android channel)

Arbiter side of a native Android chat client that reaches the bridge through evie (the only host the phone and the home-NAT arbiter both reach). The phone is a poll-based client, not a live socket: evie relays opaque `phone_relay` frames over the existing arbiter<->evie WS, and the arbiter answers each with a `phone_relay_reply` tool call. See `arbiter/phone/`; the full design doc lives in git history (`plans/done/android-channel-app.md` at commit f08e83d, removed from the tree after shipping).

- **Identity:** keyed by the phone's per-install `conversationId` (the human Device Name is a display label). `phoneHandler.ts:assertValidIdentity` rejects reserved names, a name already held by a real team, and a conversation already owned by a live socket.
- **Virtual peer:** `PhonePeer` is inserted into the team + conversation registries like a real bridge peer, so existing crosstalk routing (wake, persistent conversations, `channel_push`/`response_push` delivery) is reused unchanged. Its `send()` appends to the device's `DeviceMailbox` instead of a wire; the phone drains it with the `poll` op. Virtual peers are excluded from the heartbeat and from DM-holder selection (`getAllActiveRealWs`), and a real registration evicts a squatting virtual peer.
- **Ops:** `register`, `list_teams`, `send` (to a devcontainer), `respond` (only to a thread delivered to this device), `poll`. `send`/`respond` are idempotent per `(conversationId, opId)`; reads run fresh.
- **Mailbox:** `DeviceMailbox` is bounded (entry cap with cumulative `dropped` gap signal, 1h idle TTL, store-wide LRU device cap). Each instance carries an `epoch`; `poll` is epoch-gated so a cursor from an evicted instance cannot ack away a new instance's entries.
- **Trust:** frames are zod-validated at the boundary (`PhoneRelayFrameSchema`); the arbiter trusts only frames relayed off the evie WS and adds no new HTTP surface. Evie verifies the phone's bearer token. Not yet wired end to end (evie phone-bridge port + k8s service-proxy are later phases).

### Port Map

| Port  | Service                              |
|-------|--------------------------------------|
| 20000 | Arbiter (HTTP + WS bridge)           |
| 20001 | Evie bridge server (tool call WS)    |
| 20002 | MCP Connector (game client WS)       |

## Development

### Commands

- `bun run lint` - Biome CI + TypeScript type check
- `bun run lint:fix` - Biome auto-fix
- `bun run test` - Run all tests (vitest)
- `bun run start:arbiter` - Start arbiter locally
- `bun run start:mcp` - Start MCP server locally
- `bun scripts/check-module-residue.ts` - Verify the node_modules tree against bun.lock
- `bun scripts/codegen-kotlin.ts` - Regenerate the Kotlin protocol types after editing a shared schema (CI fails on a stale `proto/Protocol.kt`)

### Dependencies

Manifests use EXACT version pins, no ranges. The plugin launches via `bun --install=force run` (.mcp.json), which resolves package.json ranges directly and bypasses the lockfile - a caret range means any plugin start can pull a brand-new release. Dependabot (daily, 7-day cooldown) is the updater; the cooldown gives security audits time to flag a vulnerable release before we take it. The `overrides` block pins transitives with known advisories. After any manifest change, finish with `rm -rf node_modules && bun install --frozen-lockfile`, then run `scripts/check-module-residue.ts` - bun never prunes nested node_modules dirs the lock stopped sanctioning, and a stale nested copy silently shadows the pinned version for both tsc and runtime.

### Code Style

Uses Biome for formatting and linting. Tabs, double quotes, semicolons, 120 char line width.

File structure follows categorized sections:

```ts
////////////////////////////////
//  Interfaces & Types

////////////////////////////////
//  Schemas

////////////////////////////////
//  Class

////////////////////////////////
//  Functions & Helpers
```

### Environment Variables

**Arbiter (Docker):**
- `PORT` - HTTP/WS port (default: 20000)
- `RESPONSE_TIMEOUT_MS` - How long to wait for a team response (default: 600000)
- `BRIDGE_TOKEN` - Bearer token for evie bridge auth (activates evie bridge when set)
- `EVIE_KUBECONFIG` - Path to kubeconfig (default: /app/kubeconfig.yaml)
- `EVIE_NAMESPACE` - K8s namespace (default: evie-bot)
- `EVIE_DEPLOYMENT_LABEL` - Pod label selector (default: app=evie-bot-app)
- `EVIE_BRIDGE_PORT` - Remote port on evie pod (default: 20001)
- `EVIE_LOCAL_PORT` - Local port for port-forward (default: 20001)

**MCP Plugin (Container):**
- `PROJECT_NAME` - Team name on the bridge (required for crosstalk)
- `BRIDGE_ROUTER_URL` - Arbiter URL (default: http://switchboard:20000)
- `AGENT_TYPE` - Agent type override (auto-detected if not set)
- `PROJECT_HOST_PATH` - Host-side project path for wake registration
- `MCP_CONNECTOR_PORT` - Game client connector port (default: 20002)
- `MODEL_SIMPLE` / `MODEL_STANDARD` / `MODEL_COMPLEX` - Model overrides per effort level

## Testing

Tests live in `src/__tests__/`. Run with `bun run test` or target a specific file:

```bash
bun run test src/__tests__/mutex.test.ts
```

## Deploying the phone bridge

The phone bridge spans two repos and three runtimes (evie pod, k8s objects, host arbiter), so a deploy is a fixed sequence. evie deploys via GitHub CI (push to main builds the image and rolls out k8s); the arbiter is a local Docker container rebuilt on the host.

1. **Push evie** (the `app/features/bridge` + `deploy/` changes). On main: `gitPushNewBranch(merge)` moves the commits to a branch + auto-merging PR. The merge to main runs `Push (main)` which builds the image and rolls out the deployment. Await the run, then `gitPull` evie locally (the push reset local main to origin, so the working tree is missing the new files until you pull).
2. **Push switchboard** the same way. Its `main-push.yml` builds the Android APK and refreshes the single latest release. The merge also makes origin/main current so the arbiter's `git pull` picks up the P3 relay code. `gitPull` switchboard locally.
3. **Apply the cluster objects** (from the evie-bot repo, after the pull restores `deploy/`):
   - `kubectl create secret generic phone-bridge-app-token -n evie-bot --from-literal=ANDROID_BRIDGE_TOKEN=$(openssl rand -hex 32)` (save the token for the phone).
   - `kubectl apply -f deploy/phone-bridge.yaml` (Service + scoped SA/Role/RoleBinding + SA-token Secret).
   - `kubectl set env deploy/evie-bot-deployment -n evie-bot --from=secret/phone-bridge-app-token` (rolls out; the phone bridge only starts on port 20004 when `ANDROID_BRIDGE_TOKEN` is set).
4. **Restart the arbiter + host daemon** on the host: `./down.sh && ./start-arbiter.sh && ./start-host-daemon.sh`. `start-arbiter.sh` pulls main and rebuilds the container, so the new arbiter has the `phone_relay` handler and reconnects to evie's bridge.
5. **Validate** with `evie-bot/deploy/phone-bridge-smoketest.sh` (health, register, list_teams, idempotency through the API service-proxy). For a full round trip, send a phone op to an online team and poll the mailbox for the reply.

Order matters: the phone bridge can serve `health` as soon as the env is set, but `register`/`send`/`list_teams` relay through the arbiter, so they only succeed once the arbiter is rebuilt (step 4). Setting the env before applying `phone-bridge.yaml` enables the bridge inside the pod but leaves it unreachable until the Service exists.
