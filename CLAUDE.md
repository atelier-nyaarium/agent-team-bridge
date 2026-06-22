# Agents

## Key Paths

- `src/` - Main source code
  - `main-mcp.ts` - MCP plugin entry point (loaded by Claude Code / IDE plugins)
  - `main-gateway.ts` - Gateway server entry point (runs in Docker)
  - `gateway/` - **Gateway server** - A Gateway: the central HTTP + WebSocket router for one machine's teams, running in Docker
    - `index.ts` - Server setup: Bun.serve, routes, WebSocket handlers, evie client init, port-forward
    - `routes.ts` - HTTP route handlers (send, respond, poll, teams, health, evie tool-call, ingest, human notify broadcast)
    - `websocket.ts` - WebSocket connection handlers, team registry, heartbeat, wake coordination
    - `wake.ts` - WakeCoordinator class for container on-demand startup
    - `connectorProxy.ts` - WebSocket proxy for game client connector pass-through
    - `evie/` - **Evie bridge** - kubectl port-forward tunnel to evie-bot K8s pod
      - `evieClient.ts` - WebSocket client to evie's BridgeServer. Live role is the console relay transport: `console_relay` frame intake (`onConsoleRelay`) plus the shared tool-call wire (`callTool` + `tool_result` / `tool_error`) that `console_relay_reply` rides. The `evie_*` tool proxy that once consumed `tool_registry` is detached (kept for history). Inbound frames are boundary-parsed through `EvieInboundFrameSchema` (shared/evie-protocol.ts); unknown/malformed frames are counted and warned, never blind-cast
      - `portForward.ts` - kubectl port-forward child process manager with auto-restart
    - `console/` - **Console bridge** - gateway side of the Android channel (see Console Bridge below)
      - `consoleHandler.ts` - `createConsoleHandler`: validates device identity, dispatches the console ops (register/list_teams/send/respond/poll/get_gateway_transport) by reusing the HTTP routes, owns per-conversation mailbox/binding/idempotency state
      - `consolePeer.ts` - `ConsolePeer`, a duck-typed virtual bridge socket whose `send()` appends to the device mailbox instead of a wire
      - `relayPump.ts` - `createConsoleRelayPump`: zod-validates each relay frame, runs the handler, sends the reply back to evie as a `console_relay_reply` tool call
    - `federation/` - **Federation** - cross-Gateway routing + trust (see Federation routing + Federation trust below)
      - `hostRelay.ts` - `createGatewayRelayHandler` (runs an inbound federated op - send/list_teams/wake/response_push - against the local routes) + `createGatewayRelayPump` (zod-validates each `gateway_relay` frame, dispatches, replies as a `gateway_relay_reply` tool call). The cross-Gateway mirror of the console relay pump. Opens/seals the payload through the `sealer`
      - `identity.ts` - `loadOrCreateIdentity(dataDir)`: mints + persists this Gateway's keypair (0600) on first boot
      - `allowlist.ts` - `Allowlist`: the mirrored Domain (owner root + owner-signed admissions/revocations) on the Gateway's volume; `applySnapshot` (idempotent mirror of evie's push), `resolveGateway`/`resolveBySignPub`, `selfAdmission`
      - `sealer.ts` - `createSealer(identity, allowlist, replayGuard?)`: `seal(dstGateway, obj)` / `open(srcGateway, env)` - E2E peer-to-peer over the allowlist's keys, replay-checked after the signature verifies
      - `replayGuard.ts` - `ReplayGuard`: TTL + capped seen-set rejecting a replayed authentic sealed frame
      - `enrollQr.ts` - `logAdmitGatewayQr`: prints this Gateway's admit-gateway QR + SAS (ANSI-forced contrast) on startup while un-admitted
    - `discord/` - Discord utilities (validateMessageParts, used by tests)
  - `mcp/` - **MCP plugin** - Tools registered for Claude Code and other IDE agents
    - `index.ts` - MCP server initialization, mode detection (host vs container), tool registration
    - `bridge/` - **Crosstalk tools** - Cross-team communication via the gateway
      - `helpers.ts` - Bridge state, WebSocket connection to router, routerPost/routerGet
      - `bridgeDiscover.ts` - `crosstalk_discover` tool: list teams on the bridge
      - `bridgeSend.ts` - `crosstalk_send` tool: send request to another team, poll for response
      - `bridgeWait.ts` - `crosstalk_wait` tool: wait N seconds before retrying
      - `replyTool.ts` - Shared reply tool factory (used by channelReply and cliReply)
      - `registerBridgeTools.ts` - Container-side tool registration (crosstalk + reply tools)
    - `channel/` - **Channel mode** - For Claude agents receiving push notifications
      - `channelNotify.ts` - Emit `notifications/claude/channel` to push messages into Claude sessions; materializes inbound Discord file attachments and prepends a `[FILES]` block to the body
      - `channelReply.ts` - `channel_reply` tool: reply to an incoming channel message
      - `humanTools.ts` - the `notify_human` tool: broadcasts a `{title, summary, full, attachments?}` notice (all three tiers required; `tiny` is a deprecated alias for `title`) to every registered console via the gateway's `POST /human/notify`. `attachments` are absolute file paths the agent attaches from its filesystem
      - `evieFiles.ts` - Sanitize, materialize, and render Discord-bridge file attachments under `/tmp/evie-files/<msgId>/`; lazy mtime sweep with 1h TTL
    - `cli/` - **CLI mode** - For non-Claude agents (cursor, copilot, codex)
      - `agentHandlers.ts` - CLI agent process spawners (cursor-agent, copilot, codex)
      - `handleInject.ts` - Handle inject messages from gateway, spawn CLI agent
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
      - `hostWakeListener.ts` - Host-side `host` WebSocket: catalog scan, on-demand container waking, and the `host_op` handler that runs console terminal ops via `hostOpRunner.ts` + `tmuxCore.ts` (see Console terminal view)
    - `evie/` - **Evie tool proxy** - Dynamic MCP tool registration from evie-bot's action registry
      - `evieTools.ts` - Converts evie's JSON Schema tool definitions to Zod via `z.fromJSONSchema()`
    - `resolve-model.ts` - Model resolution by agent type and effort level
  - `shared/` - Shared utilities used by both gateway and MCP
    - `types.ts` - Shared TypeScript types; wire shapes derive from schemas.ts via `z.infer` (`ChannelFile`, `TeamInfo`, the enums), local payload/config types stay hand-written
    - `schemas.ts` - THE single zod truth for every wire shape: reply schemas, `ChannelFileSchema`, `TeamInfoSchema` (with each session's owning `gatewayId`), the full console protocol (`ConsoleOpSchema`, `ConsoleRelayFrameSchema`, `ConsoleRelayReplySchema`, op results, `MailboxEntrySchema`), and `ProvisioningSchema`. Every shared schema carries `.meta({ id })` - the id is the generated Kotlin class name (see codegen below)
    - `tmp-files.ts` - `cleanupTmpDir({dir, maxAgeMs, mode: "files" | "dirs"})` - generic lazy mtime sweep used by the connector and the Discord-bridge file materializer
    - `env.ts` - Container detection (isInsideContainer)
    - `mutex.ts` - Mutex class for serializing CLI-mode requests per team
    - `pending-job-store.ts` - PendingJobStore for tracking in-flight requests with timeout/polling
    - `device-mailbox.ts` - `DeviceMailbox` (per-console inbound queue: monotonic seq, cursor ack, entry cap, epoch) and `DeviceMailboxStore` (per-conversation, idle TTL sweep + LRU device cap, `setOnEvict`)
    - `console-protocol.ts` - `CONSOLE_PROTOCOL_VERSION` + the legacy session-id grammar HELPERS being migrated onto `SessionId` (`composeConvSessionId`/`parseConvSessionTeam`/`noticeSessionId`, `qualifyTeam`/`parseQualifiedTeam`); the grammar CONSTANTS now live in `session-id.ts` and are re-exported here so codegen + un-migrated callers resolve unchanged; the wire TYPES re-export from schemas.ts via `z.infer`
    - `session-id.ts` - The Session Identity value objects (the one canonical address/session form): `TeamAddress` (a `gateway/name` address; a bare name resolves to the local Gateway at the boundary, an explicit/remote gateway is preserved so cross-Gateway keys stay byte-stable across gateways), `SessionId` (a channel conversation's `conv:<conv>:<gateway/name>` key - the single canonical producer, with an injective parse that rejects crafted multi-colon ids), and `NoticeId`. A store key and a lookup key are the SAME value by construction, replacing the ad-hoc bare-vs-qualified string builders. Owns the grammar constants (`CONV_SESSION_PREFIX`/`NOTICE_SESSION_PREFIX`/`GATEWAY_QUALIFIER_SEP`). Hand-authored Kotlin twin at `android/.../proto/SessionId.kt`, held equivalent by `tests/fixtures/session-id/vectors.json` read by both runtimes
    - `host-id.ts` - The gateway's own Gateway id: `resolveLocalGatewayId` (the `GATEWAY_ID` env override, else the sanitized machine hostname) and `sanitizeGatewayId` (slug to `[a-z0-9-]`, never the qualifier separator). Threaded through `GatewayConfig.localGatewayId`
    - `evie-protocol.ts` - SELF-CONTAINED (zod-only) leaf owning the gateway<->evie frame vocabulary, SYNCED verbatim into evie-bot (`cp` + SYNC-HASH): `EvieInboundFrameSchema` (tool_registry / tool_result / tool_error / loose console_relay + loose gateway_relay), `ToolCallFrameSchema`, `ChannelFileSchema` (re-exported by schemas.ts), and the federation routing envelope evie routes on - `GatewayRegisterParamsSchema`, `GatewayRelayRouteSchema` (opaque `payload`), `GatewayRelayReplyParamsSchema`, `FEDERATION_PROTOCOL_VERSION`. The register params also carry the optional admitted-identity proof (signPub/boxPub/admission-JSON/proof). Nothing imports into it
    - `crypto.ts` - SYNCED leaf (node:crypto only): the federation seal/sign core - `generateIdentity`, `sign`/`verify` (Ed25519), `seal`/`unseal` (ephemeral X25519 -> HKDF -> AES-256-GCM), `fingerprint`. Raw 32-byte keys base64; interops with Android BouncyCastle
    - `admission.ts` - SYNCED leaf (imports `./crypto.js`): the trust model - `AdmissionSchema`/`SignedAdmission`/`Revocation`/`DomainSnapshot` (all `.meta({id})`, codegen'd), the canonical `ADMISSION_V1` signing bytes, `verifyAdmission`/`resolveAdmitted`, and the registration proof-of-possession (`registerSigningBytes`/`signRegister`/`verifyRegistration`)
    - `enrollment.ts` - SYNCED leaf (imports `./admission.js` + `./crypto.js`): the typed QR payloads (`EnrollmentPayloadSchema`: enroll-owner/admit-gateway/authorize-console), the owner enroll ops (`EnrollOpSchema`: enroll_redeem/submit_admission/submit_revocation, codegen'd sealed), `EnrollResult`, `payloadSas`, `admissionFromScan`
    - `federation-protocol.ts` - switchboard-only INNER federation vocabulary evie never sees (content-blind): `FederatedOpSchema` (send/list_teams/wake/response_push), the `ReturnRouteSchema` reply-pin, the `GatewayRelayPayloadSchema` (always E2E-sealed: a single `sealed` envelope, no cleartext op - evie cannot read or forge it), and the full `GatewayRelayFrameSchema` the gateway-relay pump validates. NOT codegen'd to Kotlin (cross-Gateway is gateway-to-gateway; the console reaches the mesh through its home Gateway)
    - `stts-providers.ts` - `SttsProviderSchema` for the TTS provider catalog (bundled at `android/.../assets/stts-providers.json`): per-provider id/label/path/container/voices plus a request-body TEMPLATE ($text/$voice). Validated by vitest on every push; the generated Kotlin `SttsProvider` decodes it at runtime and `SttsClient.fillTemplate` fills the template per call. The `voices` arrays are NOT hand-maintained: they are generated from the raw provider voice dumps in `data/stts-voices/` by `scripts/import-stts-voices.ts` (drift-checked by ci.yml). The settings voice picker filters this full list as you type
    - `notice.ts` - `NoticeSchema` `{ title, summary, full }`, the single truth for the `notify_human` tool param and the `/human/notify` wire (tier rules on the field describes). SYNCED leaf: a byte-verbatim copy lives at `nyaaskills/src/shared/notice.ts` (re-copy with `cp src/shared/notice.ts ../nyaaskills/src/shared/notice.ts`). `title` replaces the old `tiny`; the tool/route accept `tiny` as a deprecated alias for one transition release
    - `reconnect.ts` - Exponential backoff reconnector for WebSocket connections
  - `__tests__/` - Test files (vitest)
- `skills/` - Claude Code skills
  - `crosstalk/SKILL.md` - Cross-team communication skill (tool reference, response format)
  - `orchestrate/SKILL.md` - Multi-project orchestrator skill (team spawning, relay agents)
- `agents/` - Claude Code agent definitions
  - `team-relay.md` - Smart relay agent for bridging team-lead to devcontainer agents
- `.claude-plugin/plugin.json` - Plugin metadata (name, version, description)
- `.mcp.json` - MCP server config (entry point: main-mcp.ts)
- `docker-compose.yml` - Docker Compose for the gateway (port 20000, bridge network)
- `Dockerfile` - Gateway container image (Bun + kubectl + dev tools)
- `install.sh` - Add switchboard Docker network to a devcontainer project
- `uninstall.sh` - Remove switchboard Docker network from a devcontainer project
- `start-gateway.sh` - Thin launcher: the no-arg start (git pull, rebuild, health wait) stays bash; `--setup` / `--enroll` exec `scripts/gateway-setup.ts`
- `provision-console.sh` - Thin launcher: execs `scripts/provision.ts` (the Console bootstrap)
- `start-host-daemon.sh` - Start Claude Code host daemon in a tmux session
- `scripts/provision.ts` - Console bootstrap flow (the `provision-console.sh` logic, in bun): Provision/Purge menu, cluster cutover, Domain rooting at the owner key, transport-blob emit + enrollment QR, and an authenticated bridge verify
- `scripts/gateway-setup.ts` - Gateway `--setup` (Configure / Purge menu) and `--enroll` (creds-less LAN enrollment) flow, in bun (the `start-gateway.sh` setup logic)
- `scripts/lib/host.ts` - Shared host-orchestration primitives for the bun setup scripts: Bun.$ wrappers over docker + kubectl (`k`/`kStdin`/`dc`/`dx`, container lifecycle, base64 Secret reads + Opaque-Secret apply), the interactive menu/prompt loop, and `.env` read/write
- `scripts/bootstrap-domain.ts` / `scripts/write-provisioning-blob.ts` / `scripts/render-provisioning-qr.ts` - Pure modules `provision.ts` composes: root evie's Domain at the owner key, assemble + schema-validate the provisioning blob, and render it as a terminal or GIF QR
- `scripts/check-module-residue.ts` - Verify node_modules matches bun.lock (no unsanctioned nested dirs shadowing pinned versions)
- `scripts/codegen-kotlin.ts` - Generate `android/.../proto/Protocol.kt` (kotlinx data classes + sealed `ConsoleOp` + wire constants) from the zod truth in `src/shared/schemas.ts`; committed output, drift-checked by ci.yml. Emission rules live in the script header (encode-side sealed only, open Strings for decode-side enums, integer -> Long)
- `scripts/import-stts-voices.ts` - Normalize each TTS provider's native voice-list dump (`data/stts-voices/<provider>.json`) into the `voices` arrays of `android/.../assets/stts-providers.json`, in place. Per-provider adapters map the heterogeneous shapes (Azure `ShortName`, Google `Name`+int gender, OpenAI deduped, Amazon neural-only, IBM description-name) to `{ id, label }`, English-first. Committed output, drift-checked by ci.yml. To refresh a provider: replace its `data/stts-voices/<provider>.json` with a fresh export, run the script, commit both files. Providers with no dump (ElevenLabs, Uberduck, xAI) keep their hand-curated voices
- `tests/fixtures/protocol/` - Golden wire fixtures decoded by BOTH vitest and the Android unit tests; `_manifest.json` is the single inventory both suites iterate (vitest also asserts directory/manifest agreement)

## Architecture

Two separate entry points, two different runtime contexts:

**MCP Plugin** (`main-mcp.ts`) - Loaded by Claude Code or IDE plugins via `.mcp.json`. Runs in the user's process. Provides tools for cross-team communication, devcontainer dispatch, and game client connectors.

**Gateway** (`main-gateway.ts`) - Runs in a Docker container. A Gateway (one of many in the Mesh): the central HTTP + WebSocket router that all local teams connect to. Handles message routing, request/response lifecycle, and the evie-bot bridge (evie is the content-blind Router that forwards between Gateways).

### Connection Modes

- **Channel mode** (Claude) - Messages arrive as `<channel>` push notifications via `notifications/claude/channel`. Bidirectional, no polling needed. Conversations use persistent channel conversations (see below).
- **CLI mode** (cursor, copilot, codex) - Messages are injected as prompts into spawned agent processes. Uses mutex to serialize requests per team. Each send is a one-shot request/response.

### Channel Conversation Model

Channel-mode agents (Claude windows and devcontainer Claudes) have persistent conversations. Each MCP process generates a stable `conversation_id` on startup and reuses it across WebSocket reconnects for the life of that process.

- The gateway derives a deterministic channel job key `"conv:" + senderConversationId + ":" + targetTeam`. Every `crosstalk_send` between the same (sender window, target team) pair lands in the same store entry; the caller does not manage session_ids.
- Pending-job entries for channel conversations are marked `persistent: true` and are never swept by the store's TTL cleanup. Transient CLI-mode entries still time out after `RESPONSE_TIMEOUT_MS`.
- `channel_reply` may be called multiple times on the same session_id. Use `status: "running"` for interim updates (phase reports, ACKs, partial results) and `status: "completed"` for the final answer. The conversation only closes when a process exits.
- Responses push back to the specific sender sub-session via `conversationRegistry`, so parallel host windows targeting the same devcontainer do not receive each other's replies.
- Reconnects rebind the conversation: the same `conversation_id` shows up with a new WebSocket, the gateway swaps the registry pointer, and the conversation resumes without losing state.

### Evie bridge (console relay)

The gateway maintains a kubectl port-forward tunnel to evie-bot's K8s pod (port 20001). A WebSocket client (`evieClient.ts`) connects with bearer auth. Its live role is the console relay transport: evie relays the console's `console_relay` frames over this WS, and the gateway answers each with a `console_relay_reply` tool call (see Console Bridge below). The same tool-call wire (`callTool` + `tool_result` / `tool_error` correlation) carries those replies.

Evie still emits a `tool_registry` frame, and the host-side `evie_*` tool proxy (`mcp/evie/evieTools.ts`, `z.fromJSONSchema()`) could register those as MCP tools. That proxy is DETACHED (marked `@unused`, unwired from registration): the owner reaches agents through the console now, not evie's Discord tools, but the code is kept in the tree to re-enable later. Detaching the proxy never touches the tool-call wire the console relay rides.

### Channel file attachments

File attachments flow over the console channel; the Discord file path was retired with the human bridge.

**Inbound (console -> agent):** The console's `send` / `respond` ops carry a `files` array (`ChannelFile[]`); byte-bearing entries include `base64`. The gateway validates via `ChannelFilesSchema`, applies a 500 MB consumer-side hard backstop, and forwards the payload as part of the `channel_push`. The host MCP plugin's `materializeFiles()` (in `mcp/channel/evieFiles.ts`) writes byte-bearing entries to `/tmp/evie-files/<messageId>/<safeFilename>` via `<path>.tmp.<pid>` + atomic `rename`, then `renderFilesBlock()` builds a unified `[FILES]` block prepended to the channel notification body so the agent `Read`s them by path. Metadata-only entries (no bytes) have no re-fetch path and are surfaced as not-transferred. Lazy mtime sweep keeps the directory bounded with a 1-hour TTL.

**Outbound (agent -> console):** `notify_human` accepts `attachments` as absolute file paths; the MCP plugin reads each with `fs.readFile`, base64-encodes it into a `ChannelFile`, and ships it on the `/human/notify` notice. The gateway appends the notice (with files) to every registered console's mailbox.

### Gateway identity and qualified names

Every gateway is a **Gateway** with an id (`GATEWAY_ID`, else the sanitized machine hostname; see `resolveLocalGatewayId`). Session names are **gateway-qualified** as `gateway/name` on the wire and on the console; a BARE name (no separator) resolves to the local Gateway. The gateway stays keyed by bare local names internally and qualifies only at the wire edge: `teams()` stamps each `TeamInfo.gatewayId`, register returns the connected `gatewayId`, and `send` canonicalizes an inbound target (stripping the local Gateway, 404ing a different one) so the channel session id carries `gateway/name`. The console keys every per-session surface (threads, tabs, unread, labels) by the canonical `gateway/name` value through its `SessionId.kt` twin, learns its Gateway id at register, and load-normalizes its persisted threads/labels to canonical on read; its presence list compares canonical values, so a session that is live can never be synthesized as a phantom "ended". The gateway derives every session/team key through the `SessionId`/`TeamAddress` value objects (`shared/session-id.ts`, the one canonical producer, so a store key and a lookup key are the same value by construction); the separator/prefixes are codegen'd into Kotlin and the console mirrors the grammar in its `SessionId.kt` twin. Cross-Gateway routing builds on this (see Federation routing below).

### Federation routing (multi-Gateway mesh)

evie is the content-blind **Router** over many Gateways (gateway side in `gateway/federation/`; evie side is evie-bot's `BridgeServer`). Each gateway REGISTERS its gateway id on connect (`gateway_register`), keying a gateway id -> socket table at evie. A Gateway reaches another by calling evie's `gateway_relay` tool; evie routes the frame to the destination Gateway's socket by `dstGateway` alone and correlates the reply by `relayId` (held open, bound to the destination's connection), never parsing the payload. A cross-Gateway send (`routes.sendCrossGateway`) forwards a `gateway_relay` carrying a **return-route** `{srcGateway, srcConversationId, srcSession}`; the destination lands a local channel_push keyed by that same session id with the return-route on its job, and when its agent replies, `respond` forwards a `response_push` home through evie to the origin's anchor (which pushes into the originating conversation). Discovery (`routes.discover`, behind `crosstalk_discover` + the console's `list_teams`) fans out a `list_teams` over evie's presence roster (`list_gateways`) and merges - evie aggregates no team lists. The console reaches the mesh through its **home Gateway** (the id it learned at register, sent as `homeGateway` on every relay; evie routes there, else falls back to the latest gateway). Cross-Gateway frames are now SEALED end to end (see Federation trust below): `gateway_relay.payload` carries a `SealedEnvelope` only the destination Gateway can open. On a Gateway drop, evie's `onDisconnect` fails that Gateway's in-flight relays with an explicit error (not a stall); the gateway's evie-client auto-reconnects and re-syncs the allowlist on re-register.

### Federation trust, enrollment, and E2E crypto

The mesh runs on a single root of trust: the **owner** device. Membership is an allowlist of owner-signed **admissions** mirrored on evie AND every Gateway, so a revocation bites even while evie is unreachable (audit R3).

- **Crypto** (`shared/crypto.ts`, a SYNCED leaf - byte-identical in evie): identity = an Ed25519 signing pair + an X25519 box pair, raw 32-byte keys base64 on the wire (Android's BouncyCastle interops). Seal = per-message ephemeral X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM, signed by the sender's static Ed25519 (forward secrecy from the ephemeral, authenticity from the signature). `node:crypto` only on Bun; **AES-256-GCM not ChaCha20** (Bun lacks the latter). Cross-platform vectors pin Kotlin against node.
- **Trust model** (`shared/admission.ts`, SYNCED): `AdmissionSchema` (owner attests a subject's keys, `kind: gateway|console`), `SignedAdmission`, `Revocation`. Canonical signing bytes are a versioned newline-joined encoding (`ADMISSION_V1\n...`) reproduced byte-exact on node/Bun/Android - never sign raw JSON. `resolveAdmitted` returns the newest owner-verified, non-revoked admission. `DomainSnapshot` = the mirrored `{ownerSignPub, admissions, revocations}`.
- **Registration gate**: `gateway_register` carries the Gateway's `signPub`/`boxPub`, its owner-signed `admission` (JSON), and a fresh `proof` (Ed25519 over `REGISTER_V1\ngatewayId\nproofAt`, proving key possession so an observed admission cannot be replayed). evie's `verifyRegistration` rejects an unadmitted / revoked / replayed / stale registration. During the token+admission coexistence window a token-only register still passes (so a not-yet-enrolled gateway can connect and pull its first sync); `FEDERATION_REQUIRE_ADMISSION=true` makes the proof mandatory at token retirement.
- **Domain mirror**: evie returns the `DomainSnapshot` in the register reply; the gateway's `Allowlist.applySnapshot` idempotently replaces its state with the owner-verified entries (dropping any forged one), so each Gateway enforces the allowlist + revocations locally.
- **Enrollment**: the OPERATOR path is the host-side `./provision-console.sh --setup` (see "Deploying the federation" below) plus the app's "Link this phone" wizard. The owner root key lives ON THE PHONE (the app's Owner setup screen) and never leaves it; the operator reads the owner PUBLIC keys from the app and pastes them, and the script roots evie's Domain at that owner key, then emits a 0600 TRANSPORT-ONLY blob (cluster creds only - no identity, no private keys) the app imports - no SAS, no evie-DM. The Console generates its OWN member identity, owner-signs a `kind:console` admission for it with the phone-held owner key (`FederationManager`), submits it to evie, and likewise owner-admits each Gateway it enrolls. The in-app scanner under `android/.../enroll/` and the `federation-enroll-owner` DM action are RETIRED. The trust machinery still lives in evie's `EnrollmentCoordinator` (persisted in the `evie-federation` k8s Secret via the in-cluster SA + REST - `KubeSecretStore`): owner-signed admissions, the `EnrollOp` ops, and the typed-QR payloads remain. The crypto in `scripts/bootstrap-domain.ts` reuses the same `crypto.ts`/`admission.ts` so a phone-signed admission verifies byte-for-byte on the gateway and the app.
- **Replay-reject**: `ReplayGuard` (a TTL + capped seen-set, checked AFTER the signature verifies) rejects a captured authentic cross-Gateway frame re-delivered to re-run the op.
- **Recovery** (clean-break, owner has 1 console + 1 gateway): delete the `evie-federation` Secret, each gateway's `federation-allowlist.json` (keep `identity.json`), and `~/android-dev/secrets/console-owner-identity.json`, then re-run `./provision-console.sh --setup`. There is no silent re-root: a snapshot / redeem for a different owner is refused.

The console<->gateway op path is now E2E sealed too (the symmetric twin of the cross-Gateway seal): the console seals each op into a `ConsoleRelayFrame` (`{ opId, signerSignPub, sealed }`) to the gateway's box key and signs with its enrolled key; the gateway verifies the signer against an owner-signed `kind:console` admission, decrypts, replay- and freshness-checks, and seals the reply back. evie stays content-blind (its `console_relay` member is a loose passthrough). Only a pre-seal failure (malformed / unadmitted) returns a cleartext error so the console can prompt enrollment. Still pending on the crypto track: the evie self-provisioning of the console-bridge k8s objects (manual YAML for now), and the operational token retirement (`FEDERATION_REQUIRE_ADMISSION=true` + dropping `BRIDGE_TOKEN`/`CONSOLE_BRIDGE_TOKEN`).

### Console Bridge (Android channel)

Gateway side of a native Android chat client that reaches the bridge through evie (the only host the console and the home-NAT gateway both reach). The console is a poll-based client, not a live socket: evie relays opaque `console_relay` frames over the existing gateway<->evie WS, and the gateway answers each with a `console_relay_reply` tool call. See `gateway/console/`; the full design doc lives in git history (`plans/done/android-channel-app.md` at commit f08e83d, removed from the tree after shipping).

- **Identity:** keyed by the console's per-install `conversationId` (the human Device Name is a display label). `consoleHandler.ts:assertValidIdentity` rejects reserved names, a name already held by a real team, and a conversation already owned by a live socket.
- **Virtual peer:** `ConsolePeer` is inserted into the team + conversation registries like a real bridge peer, so existing crosstalk routing (wake, persistent conversations, `channel_push`/`response_push` delivery) is reused unchanged. Its `send()` appends to the device's `DeviceMailbox` instead of a wire; the console drains it with the `poll` op. Virtual peers are excluded from the heartbeat and from DM-holder selection (`getAllActiveRealWs`), and a real registration evicts a squatting virtual peer.
- **Ops:** `register`, `list_teams`, `send` (to a devcontainer or the host-agent), `respond` (only to a thread delivered to this device), `poll`, `get_gateway_transport` (the home Gateway's bootstrap transport creds, served sealed from its `bootstrap-transport.json` so the Console can seal them into a bundle when enrolling a creds-less Gateway), `peek` + `tmux_send` (the terminal view: see Console terminal view below). `send`/`respond`/`tmux_send` are idempotent per `(conversationId, opId)`; reads (`poll`/`peek`) run fresh.
- **Host-agent:** the host orchestrator's `gateway` channel identity is surfaced to the console as `kind: "gateway"` (shown first), reachable by `send` from the console only (`channelOnly`). A send injects a `channel_push` into the orchestrator, which can dispatch to its devcontainers. The cli `host` wake-daemon stays hidden; container crosstalk to the host-agent is deferred to the federation phases.
- **Mailbox:** `DeviceMailbox` is bounded (entry cap with cumulative `dropped` gap signal, 1h idle TTL, store-wide LRU device cap). Each instance carries an `epoch`; `poll` is epoch-gated so a cursor from an evicted instance cannot ack away a new instance's entries.
- **Trust:** frames are zod-validated at the boundary (`ConsoleRelayFrameSchema`) AND E2E sealed: the gateway opens each frame through the `consoleSealer` (verifies the console's signature against an owner-signed `kind:console` admission, decrypts with its box key, replay- and freshness-checks) before dispatch, so it trusts a frame because it is signed by an admitted console, not because it arrived on the evie WS. Each conversationId is bound to its first signing key (a console cannot operate another install's mailbox by borrowing its conversationId). The bearer token is the coexistence-window relay gate at evie, retired by W5. Adds no new HTTP surface.

### Console terminal view (peek + tmux_send)

A power-user view in the Console that drives an agent's RAW tmux pane (distinct from the chat): the `peek` op captures the visible ANSI screen and `tmux_send` injects literal text or a whitelisted control key (Enter/Escape/C-c/arrows/Tab). Both are sealed `ConsoleOp` variants on the same trust path as the chat ops, and reach the host machine through a gateway<->host-daemon RPC layered on the existing host WebSocket:

- **Host RPC:** the gateway sends a `host_op` frame (a `reqId` + a `HostOp`) and correlates the reply by `reqId` through `HostOpCoordinator` (`gateway/hostOpCoordinator.ts`, mirroring `evieClient`'s pending-calls; `failAll` on a host disconnect), via `relayToHost` in `gateway/index.ts`. The host daemon (`hostWakeListener.ts`) runs it through `createHostOpRunner` (`mcp/devcontainer/hostOpRunner.ts`: peek single-flight + a cadence floor + a concurrency cap; send dedup by `(conversationId, opId)` so a relay timeout or gateway restart replays the ack instead of re-typing). The tmux primitives live in `mcp/devcontainer/tmuxCore.ts` (spawn argv - no shell; `--`-guarded literal text submitted atomically with a trailing CR; a slug-validated target name; an ANSI visible-pane capture with a byte cap + content hash). The wire vocabulary is the type-only `shared/host-op.ts` (deliberately no zod/codegen - it rides the trusted, token-authenticated host link, not the untrusted evie relay).
- **Targets:** `kind: "gateway"` (the host-agent's own tmux) and locally-backed `kind: "devcontainer"` (`docker exec` into `<name>_devcontainer-dev-1`). `loose` and cross-Gateway sessions are gated off (`resolveTmuxTarget` in `consoleHandler.ts`).
- **Auth:** the reserved `host` WS slot is authenticated with `HOST_WS_TOKEN` (auto-provisioned into `.env` by `start-gateway.sh`, read by `start-host-daemon.sh`) so a LAN peer cannot squat it to read/forge panes or capture keystrokes.

### Port Map

| Port  | Service                              |
|-------|--------------------------------------|
| 20000 | Gateway (HTTP + WS bridge)           |
| 20001 | Evie bridge server (tool call WS)    |
| 20002 | MCP Connector (game client WS)       |

## Development

### Commands

- `bun run lint` - Biome CI + TypeScript type check
- `bun run lint:fix` - Biome auto-fix
- `bun run test` - Run all tests (vitest)
- `bun run start:gateway` - Start gateway locally
- `bun run start:mcp` - Start MCP server locally
- `bun scripts/check-module-residue.ts` - Verify the node_modules tree against bun.lock
- `bun scripts/codegen-kotlin.ts` - Regenerate the Kotlin protocol types after editing a shared schema (CI fails on a stale `proto/Protocol.kt`)

### Verify locally before pushing (especially Android)

Develop and verify locally before every push. For TypeScript that is `bun run lint && bun run test`. For Android it means an ACTUAL local build, because `ci.yml` does NOT compile or test the Kotlin: it only runs the TS lint/test plus the codegen + stts drift checks. The Kotlin builds solely in `main-push.yml`, which runs on push to `main` AFTER the merge. So a Kotlin compile error or a failing Android unit test lands on `main` before any gate catches it, surfacing only as a red release build.

Text and grep sweeps cannot see this. During the Gateway rename an over-matched Compose `Switch` widget (renamed to a non-existent `Gateway`), a mangled verb (`switches` became `gatewayes`), and a stale cross-platform admission vector all passed every grep and the full TS suite, then broke `compileDebugKotlin` and an Android unit test on `main`. Twice.

The host has a JDK and SDK, so run the Android build before pushing anything under `android/`:

```bash
cd android
JAVA_HOME=/home/nyaarium/android-dev/jdk ANDROID_HOME=/home/nyaarium/android-dev/sdk \
  ./gradlew :app:testDebugUnitTest --console=plain
```

`testDebugUnitTest` compiles the Kotlin and runs the unit tests (the golden-fixture decoders, the SessionId and admission cross-platform vectors). Treat a green run as the Kotlin gate, the same way `bun run lint && bun run test` is the TypeScript gate. For a wire-shape change, regenerate `proto/Protocol.kt` with `bun scripts/codegen-kotlin.ts` first, then run the Android build so the new types are exercised.

The sibling **evie-bot** repo (the synced leaves + the evie-side bridge code) has its own gate that is easy to under-run. Run all three locally before pushing an evie change: `cd ../evie-bot && bun run lint && bun run test:bun && bunx tsc --noEmit`. `bun run lint` is Biome (formatting + lints) and is SEPARATE from `bunx tsc --noEmit` - tsc passing does NOT mean lint passes. evie's `Push (main)` workflow gates its Build & Deploy jobs behind the Lint job, so an unlinted change still merges but SKIPS the rollout (the pod never redeploys). After editing a synced leaf, run all three on the evie copy too, not just tsc + test:bun.

Both variants R8-minify (`isMinifyEnabled` + `isShrinkResources` on release AND debug, to tree-shake `material-icons-extended` down to the icons actually used). `testDebugUnitTest` runs UN-minified, so it does NOT catch an R8 strip: a minify break (a renamed `@Serializable` wire class, a dropped JS-bridge method) only shows at `assembleDebug`/`assembleRelease` or on-device. The minify gate is `./gradlew :app:assembleRelease` plus an on-device wire round-trip (register/poll/seal). Keep-rules live in `app/proguard-rules.pro`: the `@JavascriptInterface` keep is load-bearing (the thread WebView bridge, which the AGP default misses because the bridge is an anonymous object, not a WebView subclass); the kotlinx-serialization block is documented as belt-and-suspenders over the artifact's shipped consumer rules.

### Dependencies

Manifests use EXACT version pins, no ranges. The plugin launches via `bun --install=force run` (.mcp.json), which resolves package.json ranges directly and bypasses the lockfile - a caret range means any plugin start can pull a brand-new release. Dependabot (daily, 7-day cooldown) is the updater; the cooldown gives security audits time to flag a vulnerable release before we take it. The `overrides` block pins transitives with known advisories. After any manifest change, finish with `rm -rf node_modules && bun install --frozen-lockfile`, then run `scripts/check-module-residue.ts` - bun never prunes nested node_modules dirs the lock stopped sanctioning, and a stale nested copy silently shadows the pinned version for both tsc and runtime.

### Synced schema modules

Several leaf modules in `src/shared/` are the source of truth for a wire shape shared with a sibling repo, and are copied VERBATIM (manual `cp`). Each file's header carries the source path, the copy command, and a `// SYNC-HASH:` of its body. After editing a source, RESTAMP then re-copy:

```
bun scripts/check-sync-hash.ts --write src/shared/notice.ts
cp src/shared/notice.ts ../nyaaskills/src/shared/notice.ts
```

- `src/shared/notice.ts` -> `nyaaskills/src/shared/notice.ts`
- `src/shared/evie-protocol.ts` -> `evie-bot/app/features/bridge/evie-protocol.ts`
- `src/shared/crypto.ts` -> `evie-bot/app/features/bridge/crypto.ts` (the federation seal/sign core)
- `src/shared/admission.ts` -> `evie-bot/app/features/bridge/admission.ts` (the trust model + registration proof; imports `./crypto.js`)
- `src/shared/enrollment.ts` -> `evie-bot/app/features/bridge/enrollment.ts` (the QR payloads + enroll ops; imports `./admission.js` + `./crypto.js`)

The crypto/admission/enrollment trio is byte-identical on both sides and each repo's CI runs `check-sync-hash.ts` over its copy; evie's Bundler module resolution handles the `.js` import specifiers in the verbatim copies. `restamp` after editing the source (the hash covers the body), then re-copy all dependents.

The copies are byte-identical. Each repo's CI runs `check-sync-hash.ts` on its copy: a hand-edit that diverges a copy from the hash it was cut at fails the build (even one that still type-checks). The cross-repo stale-copy check (recorded hash vs live source) is deferred.

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

**Gateway (Docker):**
- `PORT` - HTTP/WS port (default: 20000)
- `GATEWAY_ID` - This Gateway's id, qualifying every local session name on the wire (default: the sanitized machine hostname)
- `RESPONSE_TIMEOUT_MS` - How long to wait for a team response (default: 600000)
- `HOST_WS_TOKEN` - Shared secret the host daemon presents to claim the reserved `host` WS slot (which drives the console terminal view). Auto-provisioned into `.env` by `start-gateway.sh`; enforced only when set (a LAN peer otherwise could squat the slot). See Console terminal view above.
- `BRIDGE_TOKEN` - Bearer token for evie bridge auth (activates evie bridge when set)
- `EVIE_KUBECONFIG` - Path to kubeconfig (default: /app/kubeconfig.yaml)
- `EVIE_NAMESPACE` - K8s namespace (default: evie-bot)
- `EVIE_DEPLOYMENT_LABEL` - Pod label selector (default: app=evie-bot-app)
- `EVIE_BRIDGE_PORT` - Remote port on evie pod (default: 20001)
- `EVIE_LOCAL_PORT` - Local port for port-forward (default: 20001)
- `FEDERATION_OWNER_SIGN_PUB` - The Domain owner's raw Ed25519 signing public key (base64), PINNED out-of-band. When set, the Gateway refuses any allowlist snapshot rooted at a different key, so a malicious/token-holding evie cannot root a fresh Gateway at an attacker key. Unset = trust-on-first-use (convenient; pin it for the untrusted-evie threat model). The owner reads this key from the app after enrolling.
- `FEDERATION_DIR` - Where this Gateway persists its keypair + mirrored allowlist (default: alongside the log path)

**MCP Plugin (Container):**
- `PROJECT_NAME` - Team name on the bridge (required for crosstalk)
- `BRIDGE_ROUTER_URL` - Gateway URL (default: http://switchboard:20000)
- `AGENT_TYPE` - Agent type override (auto-detected if not set)
- `PROJECT_HOST_PATH` - Host-side project path for wake registration
- `MCP_CONNECTOR_PORT` - Game client connector port (default: 20002)
- `MODEL_SIMPLE` / `MODEL_STANDARD` / `MODEL_COMPLEX` - Model overrides per effort level

## Testing

Tests live in `src/__tests__/`. Run with `bun run test` or target a specific file:

```bash
bun run test src/__tests__/mutex.test.ts
```

## Debugging the console (on-device, agent-fetchable)

When a console-side symptom is otherwise invisible (a reply that polls in but never renders, etc.), use the debug build's log stream instead of guessing.

- The GitHub release ships **`switchboard-debug.apk`** beside `switchboard-release.apk`, signed with the SAME key, so it installs straight over the release build and back (one-tap side-step). The debug build's `DebugLog` flushes its log to evie each poll cycle; the release build never does (gated on `BuildConfig.DEBUG`). The in-app updater is variant-aware (`AppUpdater.kt`), so a debug build self-updates to the debug asset and stays on debug; to GET onto debug from a release build you must sideload `switchboard-debug.apk` once (the update button can't cross variants).
- Transport: the debug build POSTs its log lines to evie's `POST /ingest` on the console-bridge port (same `CONSOLE_BRIDGE_TOKEN` auth + K8s API service-proxy as `/relay`, no new network surface). evie writes each line to stdout under a `[console-ingest]` marker.
- **Fetch the console's live log** (the only path into the firewalled K8s is evie's stdout, which the gateway's kubectl already reads):

```bash
docker exec switchboard kubectl --kubeconfig=/app/kubeconfig.yaml -n evie-bot \
  logs deploy/evie-bot-deployment --tail=200 | grep '\[console-ingest\]'
```

- `DebugLog.kt` already traces the enroll scan flow and the poll/drain flow: `[Poll]` (per cycle: entry count, epoch, cursor) and `[Drain]` (per mailbox entry: kind, session id, resolved thread, OR the drop reason - `DROPPED (unresolvable team)` / `SKIPPED (no body)` / threaded). To instrument a new area, add `DebugLog.log("<Tag>", "<msg>")`. The build also writes `Downloads/switchboard-debug.log` (pullable by hand if the stream is unavailable).
- Smoke-test the ingest loop end to end (proves stdout fetch works) by POSTing through the service-proxy with the real bridge creds (`~/android-dev/secrets/console-provisioning.json`: `apiUrl`/`saToken`/`caPem`/`appToken`): `POST ${apiUrl}/api/v1/namespaces/evie-bot/services/evie-console-bridge:20004/proxy/ingest`, headers `Authorization: Bearer <saToken>` + `X-Console-Bridge-Token: Bearer <appToken>`, body `{"conversationId":"smoketest","lines":["..."]}`; then grep evie stdout for `[console-ingest]`.

## Deploying the console bridge

The console bridge spans two repos and three runtimes (evie pod, k8s objects, host gateway), so a deploy is a fixed sequence. evie deploys via GitHub CI (push to main builds the image and rolls out k8s); the gateway is a local Docker container rebuilt on the host.

1. **Push evie** (the `app/features/bridge` + `deploy/` changes). On main: `gitPushNewBranch(merge)` moves the commits to a branch + auto-merging PR. The merge to main runs `Push (main)` which builds the image and rolls out the deployment. Await the run, then `gitPull` evie locally (the push reset local main to origin, so the working tree is missing the new files until you pull).
2. **Push switchboard** the same way. Its `main-push.yml` builds the Android APK and refreshes the single latest release. The merge also makes origin/main current so the gateway's `git pull` picks up the P3 relay code. `gitPull` switchboard locally.
3. **Apply the cluster objects** (from the evie-bot repo, after the pull restores `deploy/`):
   - `kubectl create secret generic console-bridge-app-token -n evie-bot --from-literal=CONSOLE_BRIDGE_TOKEN=$(openssl rand -hex 32)` (save the token for the console).
   - `kubectl apply -f deploy/console-bridge.yaml` (Service + scoped SA/Role/RoleBinding + SA-token Secret).
   - `kubectl set env deploy/evie-bot-deployment -n evie-bot --from=secret/console-bridge-app-token` (rolls out; the console bridge only starts on port 20004 when `CONSOLE_BRIDGE_TOKEN` is set).
4. **Restart the gateway + host daemon** on the host: `./down.sh && ./start-gateway.sh && ./start-host-daemon.sh`. `start-gateway.sh` pulls main and rebuilds the container, so the new gateway has the `console_relay` handler and reconnects to evie's bridge.
5. **Validate** with `evie-bot/deploy/console-bridge-smoketest.sh` (health, register, list_teams, idempotency through the API service-proxy). For a full round trip, send a console op to an online team and poll the mailbox for the reply.

Order matters: the console bridge can serve `health` as soon as the env is set, but `register`/`send`/`list_teams` relay through the gateway, so they only succeed once the gateway is rebuilt (step 4). Setting the env before applying `console-bridge.yaml` enables the bridge inside the pod but leaves it unreachable until the Service exists.

## Deploying the federation (trust + enrollment)

Layers on top of the console-bridge deploy. The token and the admission gate COEXIST until the final cutover, so this never breaks a running bridge.

1. **Grant evie its Secret** (one-time RBAC): `kubectl apply -f evie-bot/deploy/federation-rbac.yaml`. It binds get/create/update on the `evie-federation` Secret to evie's pod ServiceAccount (edit the subject if evie does not run as `default`). On next boot evie mints + persists its keypair there and logs its SAS fingerprint.
2. **Optional config** (env on the evie deployment): `FEDERATION_DOMAIN_ID` (default `home`). Leave `FEDERATION_REQUIRE_ADMISSION` unset (defaults false) until the cutover.
3. **Onboard the Console with `./provision-console.sh --setup` plus the app's "Link this phone" wizard** (mirrors `start-gateway.sh --setup`). The owner root key lives ON THE PHONE: in wizard step 1 the app shows its owner PUBLIC keys, and the operator runs the script and pastes them. The script: applies the console-bridge + gateway-bridge cutover (above), roots evie's Domain at the pasted owner key (`bootstrapDomain` sets `ownerSignPub` in the `evie-federation` Secret, MERGED into evie's existing enrollment so it never clobbers other Gateways/admissions/revocations - it preserves prior admissions and signs none, since the owner private key never leaves the phone), writes the Gateway's `bootstrap-transport.json`, restarts evie, then emits a TRANSPORT-ONLY provisioning blob to `~/android-dev/secrets/console-provisioning.json` (0600; cluster SA creds only) and verifies the bridge with an authenticated probe. Wizard step 2 imports that blob; the Console then generates its OWN member identity, owner-signs a `kind:console` admission for it with the phone-held owner key, and submits it to evie (it likewise owner-admits each Gateway it enrolls). The Gateway id is read authoritatively from the container's `GATEWAY_ID` env (run through `sanitizeGatewayId`), never from `docker logs`. Credential posture: the blob is a durable, host-local 0600 file carrying the cluster SA token only (NO identity, no private keys). Re-running `--setup` re-roots the Domain at the (same) owner and refreshes the transport creds. For the untrusted-evie model, set `FEDERATION_OWNER_SIGN_PUB` to the owner key on each gateway; the script ABORTS with the exact remediation if the gateway pins a different owner than the one just rooted.
4. **Token retirement** (final, AFTER a full round trip validates): pin `FEDERATION_OWNER_SIGN_PUB` (and set `FEDERATION_REQUIRE_OWNER_PIN=true`) on every gateway FIRST, so once the bearer is gone a malicious / token-holding evie cannot trust-on-first-use a fresh Gateway onto an attacker-rooted Domain. Then set `FEDERATION_REQUIRE_ADMISSION=true` so evie rejects a token-only register, and drop `BRIDGE_TOKEN` once every Gateway presents an admission. Setting `FEDERATION_REQUIRE_ADMISSION` rolls the evie deployment, so every Gateway reconnects and re-registers under the gate; a Gateway that only ever registered token-only is dropped at that reconnect.

Recovery (clean-break): delete the `evie-federation` Secret + each gateway's `<dataDir>/federation/federation-allowlist.json` (keep `identity.json`) + `~/android-dev/secrets/console-owner-identity.json`, then re-run `./provision-console.sh --setup`. A redeem / snapshot for a different owner is refused by design, so there is no silent takeover.
