# Agents

## Key Paths

- `src/` - Main source code
  - `main-mcp.ts` - MCP plugin entry point (loaded by Claude Code / IDE plugins)
  - `main-gateway.ts` - Gateway server entry point (runs in Docker)
  - `main-host-daemon.ts` - Headless host daemon entry point: runs the host plumbing (wake + the console terminal-view `host_op`) on the host, no Claude session. Launched by `start-host-daemon.sh`
  - `gateway/` - **Gateway server** - A Gateway: the central HTTP + WebSocket router for one machine's teams, running in Docker
    - `index.ts` - Server setup: Bun.serve, routes, WebSocket handlers, evie client init
    - `routes.ts` - HTTP route handlers (send, respond, poll, teams, health, evie tool-call, ingest, human notify broadcast)
    - `websocket.ts` - WebSocket connection handlers, team registry, heartbeat, the lead/worker handshake (mint at register, re-push a lost one on demand, resolve the answer), wake coordination
    - `wake.ts` - `WakeCoordinator` class for container on-demand startup, plus `decideWakeCreate` - the pure create-vs-reattach-vs-refuse decision `doWakeTeam` acts on for a send-triggered composite target, split out so it is unit-testable independent of SessionStore/the host-wake side effects
    - `connectorProxy.ts` - WebSocket proxy for game client connector pass-through
    - `evie/` - **Evie bridge** - WebSocket client to evie-bot over the K8s API service-proxy
      - `evieClient.ts` - WebSocket client to evie's BridgeServer. Live role is the console relay transport: `console_relay` frame intake (`onConsoleRelay`) plus the shared tool-call wire (`callTool` + `tool_result` / `tool_error`) that `console_relay_reply` rides. Inbound frames are boundary-parsed through `EvieInboundFrameSchema` (shared/evie-protocol.ts); unknown/malformed frames are counted and warned, never blind-cast
    - `console/` - **Console bridge** - gateway side of the Android channel (see Console Bridge below)
      - `consoleHandler.ts` - `createConsoleDispatcher`: validates device identity, dispatches the console ops (register/list_teams/send/respond/poll plus the terminal-view ops) by reusing the HTTP routes, owns per-conversation mailbox/binding/idempotency state
      - `consolePeer.ts` - `ConsolePeer`, a duck-typed virtual bridge socket whose `send()` appends to the device mailbox instead of a wire
      - `capabilityStore.ts` - `CapabilityStore`: what plugins the owner's consoles have enabled, per device, durably. Two timestamps per record: `lastSeen` (any authenticated op, drives the 14-day abandonment GC only) and `reportedAt` (only a register that carried a list, the write-recency arbiter for conflicting instruction text). See Console capability union below
      - `relayPump.ts` - `createConsoleRelayPump`: zod-validates each relay frame, runs the handler, sends the reply back to evie as a `console_relay_reply` tool call
    - `federation/` - **Federation** - cross-Gateway routing + trust (see Federation routing + Federation trust below)
      - `gatewayRelay.ts` - `createGatewayRelayHandler` (runs an inbound federated op - send/list_teams/wake/response_push - against the local routes) + `createGatewayRelayPump` (zod-validates each `gateway_relay` frame, dispatches, replies as a `gateway_relay_reply` tool call). The cross-Gateway mirror of the console relay pump. Opens/seals the payload through the `sealer`
      - `identity.ts` - `loadOrCreateIdentity(dataDir)`: mints + persists this Gateway's keypair (0600) on first boot
      - `allowlist.ts` - `Allowlist`: the mirrored Domain (owner root + owner-signed admissions/revocations) on the Gateway's volume; `applySnapshot` (idempotent mirror of evie's push), `resolveGateway`/`resolveBySignPub`, `selfAdmission`
      - `sealer.ts` - `createSealer(identity, allowlist, replayGuard?)`: `seal(dstGateway, obj)` / `open(srcGateway, env)` - E2E peer-to-peer over the allowlist's keys, replay-checked after the signature verifies
      - `replayGuard.ts` - `ReplayGuard`: TTL + capped seen-set rejecting a replayed authentic sealed frame
      - `enrollQr.ts` - `logAdmitGatewayQr`: prints this Gateway's admit-gateway QR + SAS (ANSI-forced contrast) on startup while un-admitted
    - `discord/` - Discord utilities (validateMessageParts, used by tests)
  - `mcp/` - **MCP plugin** - Tools registered for Claude Code and other IDE agents
    - `index.ts` - MCP server initialization, mode detection (host vs container), tool registration
    - `capabilities.ts` - `fetchCapabilities`: the bounded, single-attempt read of the gateway's capability union a session makes before its MCP server exists, plus `hasCapability`/`capabilityInstructions` and `GATED_CAPABILITY_IDS` (the one list both the tool gates and the fail-open set derive from)
    - `bridge/` - **Crosstalk tools** - Cross-team communication via the gateway
      - `helpers.ts` - Bridge state, WebSocket connection to router, routerPost/routerGet, `postPluginAction` (self-scoped POST /plugin-action wrapper - takes no target/team param, so a plugin-action tool cannot smuggle a different destination through it), and the handshake role cache (`confirmHandshakeRole`) that lets a reconnect confirm its remembered lead/worker answer silently instead of re-answering the bridge handshake every time
      - `bridgeDiscover.ts` - `crosstalk_discover` tool: list addressable teams on the bridge, grouped into one header per team (`groupDiscoverEntries`) - a session-less team still gets a bare header, only the console and reserved `"host"` name are hidden; each active session nests under its header as a `project.session` composite or a loose/cross-gateway peer; asleep sessions show a `last seen Xm ago` recency from `TeamInfo.lastActive`
      - `bridgeSend.ts` - `crosstalk_send` tool: send a request to a session and poll for the response. A `project.session` target that is online receives it directly, joining that collaboration with no separate invite step even if a different team started it; an asleep one is woken; a not-yet-existing one is created on send through the `doWakeTeam` path, but only when `displayLabel` is set (it mints an opaque id there too - the send fails fast otherwise)
      - `bridgeWait.ts` - `crosstalk_wait` tool: wait N seconds before retrying
      - `replyTool.ts` - Shared reply helpers: `readReplyAttachment` (also used by `notify_human`), `postReply` (the POST /respond + success/failure tool-response skeleton shared by both channel reply tools), `toolError`, and the escaped-newline lint (`literalEscapeHazard`/`literalEscapeReject` - rejects a literal backslash-n used as markdown structure in console-rendered prose before sending; code fences and inline spans are exempt, judged by CommonMark's own rules). A tool routing its prose through `postReply` inherits the lint automatically; a tool with its own POST path (`notify_human`, `crosstalk_send`'s displayLabel) must call it first-thing itself. The always-visible half is `REAL_NEWLINES_GUIDANCE` in `shared/schemas.ts` (appended to the prose-field describes)
      - `registerBridgeTools.ts` - Container-side tool registration (crosstalk + reply tools)
    - `channel/` - **Channel mode** - For Claude agents receiving push notifications
      - `channelNotify.ts` - Emit `notifications/claude/channel` to push messages into Claude sessions; materializes inbound Discord file attachments and prepends a `[FILES]` block to the body
      - `channelReply.ts` - two tools: `channel_reply` (the ~99% prose path - required `{title, summary, full, fullSpoken}` tiers, optional `attachments`) and `channel_reply_structured` (a native-object `responseData`, used only when the inbound tag carries a `reply_schema`, e.g. the bridge handshake)
      - `humanTools.ts` - the `notify_human` tool: broadcasts a `{title, summary, full, fullSpoken, attachments?}` notice (all four tiers required; the schema is strict, so an unknown field like the retired `tiny` is rejected, not silently stripped) to every registered console via the gateway's `POST /human/notify`. Its tier fields are the SAME `GuidedNoticeTiers` object `channel_reply` spreads (schemas.ts), so the two tools' describes are identical by construction. `attachments` are absolute file paths the agent attaches from its filesystem
      - `evieFiles.ts` - Sanitize, materialize, and render Discord-bridge file attachments under `/tmp/evie-files/<msgId>/`; lazy mtime sweep with 1h TTL
    - `designer/` - **Designer plugin tools** - agent-facing counterpart to the console's Designer plugin
      - `designerTools.ts` - `registerDesignerTools`: `designer_push_card` (inline HTML wrapped into a `ChannelFile`, sent through the existing `postReply`/`respond` path - same effect as attaching a marked `.html` file) and `designer_delete_card` (fileName only, self-scoped through `postPluginAction("designer", "delete-card", ...)`). Degrades to a disabled stub pair when `PROJECT_NAME` is unset, matching `registerBridgeTools`'s own pattern
    - `connector/` - **Game client connector** - WebSocket bridge for external game clients
      - `connectorTools.ts` - MCP tools for connector management (status, serve, certs, tokens)
      - `projectTools.ts` - Dynamic tool registration from project's mcp-schema.js
      - `listener.ts` - HTTP/HTTPS WebSocket listener for game client connections
      - `sessions.ts` - Connected game client session management
      - `tls.ts` - Self-signed CA and server certificate generation
      - `utils.ts` - Shared utilities (textResult, registerStubTool)
    - `devcontainer/` - **Host daemon plumbing + per-session tools** - the headless host daemon's wake + terminal-view layer, plus a few tools every peer registers
      - `hostDaemon.ts` - The host daemon's `host` WebSocket: catalog scan, on-demand waking of both devcontainer and host sessions (a host session `claude --resume`s from its `SessionStore` record and starts in `resolveHostWorkdir`, else `$HOME`), and the `host_op` handler (peek / tmux_send / create_session / reload_plugins / killSession) run via `hostOpRunner.ts` + `tmuxCore.ts` (see Console terminal view). Started by `src/main-host-daemon.ts`
      - `hostOpRunner.ts` - Executes a `HostOp` against tmux with the audit controls: peek single-flight + cadence-floor, and dedup-by-`dedupKey` for the mutating ops (send / createSession / reloadPlugins)
      - `tmuxCore.ts` - The low-level tmux argv layer (no shell): peek / sendText / sendKey / createSession against a `<sessionName>.0` pane, on the host (bare `tmux`) or a devcontainer (`docker exec`)
      - `reloadPlugins.ts` - The plugin update + MCP reconnect sequence: `spawnReloadPlugins(target)` backs the daemon's `reload_plugins` host op, and the same module still registers the in-session `reload_plugins` MCP tool every peer carries
      - `setEffortLevel.ts` - `set_effort_level` tool: send `/effort <level>` to the session's own tmux pane
      - `compactSession.ts` - `compact_session` tool: send `/compact` to the session's own pane
      - `helpers.ts` - Project resolution + container lifecycle (`ensureContainerUpAsync`, `execInContainer`, `resolveProject`), used by the wake path
  - `shared/` - Shared utilities used by both gateway and MCP
    - `types.ts` - Shared TypeScript types; wire shapes derive from schemas.ts via `z.infer` (`ChannelFile`, `TeamInfo`, the enums), local payload/config types stay hand-written
    - `schemas.ts` - THE single zod truth for every wire shape: reply schemas, `ChannelFileSchema`, `TeamInfoSchema` (with each session's owning `gatewayId`), the full console protocol (`ConsoleOpSchema`, `ConsoleRelayFrameSchema`, `ConsoleRelayReplySchema`, op results, `MailboxEntrySchema`), and `ProvisioningSchema`. Every shared schema carries `.meta({ id })` - the id is the generated Kotlin class name (see codegen below)
    - `durable-store.ts` - `DurableStore` (atomic JSON snapshot to disk) plus the two restore boundaries every durable consumer goes through: `openDurable(dir, name, build)` for state restored at construction, and `restoreDurable(name, restore)` for state restored in place. Both contain a poisoned file to that file alone. `load()` already covers a file that will not parse; these cover one that parses and then throws inside its CONSUMER, which is not hypothetical (a `mailboxes.json` missing `entries`, a `replay-guard.json` holding bare numbers). Restoring several files under one try loses every restore after the throwing one, and the persist tick then writes those empty consumers back over good files - which is how a corrupt mailbox snapshot could take the owner's whole session list with it. `quarantine()` is what makes the retry safe: the file stops being read for the rest of the process but is still written through, so the next save heals it
    - `tmp-files.ts` - `cleanupTmpDir({dir, maxAgeMs, mode: "files" | "dirs"})` - generic lazy mtime sweep used by the connector and the Discord-bridge file materializer
    - `env.ts` - Container detection (isInsideContainer)
    - `pending-job-store.ts` - PendingJobStore for tracking in-flight requests with timeout/polling
    - `device-mailbox.ts` - `DeviceMailbox` (per-console inbound queue: monotonic seq, cursor ack, entry cap, epoch) and `DeviceMailboxStore` (per-conversation, idle TTL sweep + LRU device cap, `setOnEvict`)
    - `session-store.ts` - `SessionStore`, the gateway's authoritative session records keyed by the composite `spawn.id` team (the durable known-session list, backing the `session-resume` DurableStore). Owns every session invariant: per-spawn id + label uniqueness (`-#` dedup via an O(1) per-spawn label index), `sanitizeLabel` write-boundary validation (a label is a single visibly-printable path segment, so an unauthenticated register cannot steer `resolveHostWorkdir`'s path join), the legacy resume-map migration, mint/adopt/`mintOrReattach`/`recordRegister`/bind/confirm/rename/forget/sweep, and the volatile `liveTeam` pointer (never persisted). A gateway-minted record's `mintedFrom` (an opaque provenance string - `(conversationId, opId)` for `create_session`, `(conversationId, resolved target)` for a send-triggered mint) plus `findByMintedFrom` let a retry reattach to its own prior record by provenance instead of recomputing or re-probing anything; `mintOrReattach` is the one shared entry point both callers use rather than each hand-rolling the same reattach-or-mint check. Liveness POLICY stays with callers (a "live" check is a registry probe only the gateway can make); the caller-driven `sweep(ttlMs)` runs before `snapshot()` on the persist tick so the file never holds an expired record
    - `console-protocol.ts` - `CONSOLE_PROTOCOL_VERSION` + the console wire TYPES (re-exported from schemas.ts via `z.infer`). The session-id grammar lives entirely in `session-id.ts` now; the old shadow grammar helpers/constants here (`composeConvSessionId`/`parseConvSessionTeam`/`noticeSessionId`/`qualifyTeam`/`parseQualifiedTeam` + the prefix/qualifier constants) were deleted in the address-grammar migration
    - `session-id.ts` - The SOLE owner of the unified address grammar (one dot-delimited path, no back-compat): one separator `ADDRESS_SEP` (`.`) and one slug validator (`SLUG_RE`/`isSlug`/`assertSlug`, dotless `[a-z0-9][a-z0-9-]*`); the `Address` value object (the 4-segment `domain.gateway.spawn.session` canonical) and `SpawnPoint` (3-segment, non-addressable); `parseTarget(wire, localDomain, localGateway)` arity dispatch (1 = local spawn-point, 2 = local chat, 3 = remote spawn-point, 4 = remote chat); the `SessionKey` union (`{kind:"conv", conversationId, address}` | `{kind:"notice", sender}`) with `storeKey`/`parseStoreKey` the single store-key producer/parser (`conv.<conv>.<domain>.<gateway>.<spawn>.<session>`, `notice.<domain>.<gateway>.<spawn>.<session>`); `LOCAL_DOMAIN_SENTINEL` (`local`) for arming mode (null Domain id); and the internal local team-field codec (`parseSessionName`/`composeSessionName`/`isComposite`, the `spawn.session` register/tmux field, split on the one separator). A store key and a lookup key are the SAME value by construction. Hand-authored Kotlin twin at `android/.../proto/SessionId.kt` (Address/SpawnPoint/SessionKey + the same codec), held equivalent by `tests/fixtures/session-id/vectors.json` read by both runtimes. The legacy `TeamAddress`/`SessionId`/`NoticeId` classes + the `conv:`/`notice:`/`gateway/name` grammar were deleted in the migration
    - `gateway-id.ts` - The gateway's own Gateway id: `resolveLocalGatewayId` (the `GATEWAY_ID` env override, else the sanitized machine hostname) and `sanitizeGatewayId` (slug to `[a-z0-9-]`, never the qualifier separator). Threaded through `GatewayConfig.localGatewayId`
    - `domain-id.ts` - The gateway's own Domain id: `resolveLocalDomainId(federationDir)` returns `string | null` (it does NOT throw) - the enrollment-delivered `domain-id` file in the federation dir first, then the `FEDERATION_DOMAIN_ID` env, else null. Null means the gateway boots standalone (arming mode); a Domain is required only to connect to evie. `sanitizeDomainId` slugs the id and rejects an empty / all-separator value
    - `owner-id.ts` - The owner's stable id: `ownerKeyId(signPubB64)` = the full SHA-256 hex of the DECODED owner signing key. Keys the owner's shared console inbox AND is the spawn segment of the console's OWN address (`domain.gateway.<ownerId>.<DEFAULT_SESSION>`), so a free-form Device Name is never an address segment. The gateway builds it via `consoleSelfAddress`; the console mints the same address in its `thisDeviceAddress`. Switchboard-only (out of the evie-synced crypto core); the hand-authored Kotlin twin is `android/.../crypto/OwnerId.kt`, held equivalent by `tests/fixtures/owner-id/vectors.json`
    - `evie-protocol.ts` - SELF-CONTAINED (zod-only) leaf owning the gateway<->evie frame vocabulary, SYNCED verbatim into evie-bot (`cp` + SYNC-HASH): `EvieInboundFrameSchema` (tool_result / tool_error / loose console_relay + loose gateway_relay; the tool-proxy `tool_registry` member was retired with the host split), `ToolCallFrameSchema`, `ChannelFileSchema` (re-exported by schemas.ts), and the federation routing envelope evie routes on - `GatewayRegisterParamsSchema`, `GatewayRelayRouteSchema` (opaque `payload`), `GatewayRelayReplyParamsSchema`, `FEDERATION_PROTOCOL_VERSION`. The register params also carry the optional admitted-identity proof (signPub/boxPub/admission-JSON/proof). Nothing imports into it
    - `crypto.ts` - SYNCED leaf (node:crypto only): the federation seal/sign core - `generateIdentity`, `sign`/`verify` (Ed25519), `seal`/`unseal` (ephemeral X25519 -> HKDF -> AES-256-GCM), `fingerprint`, plus the signing-safe zod field factories (`b64Field`/`slugField`/`displayField`) that enforce the no-newline-in-preimage invariant once for every signed op instead of per-field inline regexes. Raw 32-byte keys base64; interops with Android BouncyCastle
    - `admission.ts` - SYNCED leaf (imports `./crypto.js`): the trust model - `AdmissionSchema`/`SignedAdmission`/`Revocation`/`DomainSnapshot` (all `.meta({id})`, codegen'd), the canonical `ADMISSION_V1` signing bytes, `verifyAdmission`/`resolveAdmitted`, and the registration proof-of-possession (`registerSigningBytes`/`signRegister`/`verifyRegistration`)
    - `federation-lifecycle.ts` - SYNCED leaf (imports `./admission.js` + `./crypto.js`): the typed QR payloads (`EnrollmentPayloadSchema`: enroll-owner/admit-gateway/authorize-console), the owner enroll ops (`EnrollOpSchema`: enroll_redeem/submit_admission/submit_revocation plus the friend-onboarding `provision_tenant`/`remove_tenant`/`set_display_name` and the user self-purge `delete_domain`, codegen'd sealed), the device self-enroll rendezvous (`ConsoleApprovalOpSchema`: arm/join/poll/approve/fetch/cancel - a held device authorizes a fresh device through evie's broker over a NEW public nonce-gated ingress, evie's ONLY internet-facing surface), the `PendingTenant` record + the self-signed `first_root` primitive (its console-op wrapper lives in `schemas.ts`) and their versioned signing bytes (`PROVISION_TENANT_V1`/`REMOVE_TENANT_V1`/`SET_DISPLAY_NAME_V1`/`FIRST_ROOT_V1`/`DELETE_DOMAIN_V1`), the `TRANSPORT_REQUEST_V1` owner possession-proof (`TransportRequestSchema`/`TransportResultSchema` + `transportRequestSigningBytes`/`signTransportRequest`/`verifyTransportRequest`: an owner phone proves it owns a rooted network to pull the gateway-bridge transport from evie; hand-written Kotlin twin + cross-platform vectors under `tests/fixtures/transport-request/`), `EnrollResult`, `payloadSas`, `admissionFromScan`
    - `federation-protocol.ts` - switchboard-only INNER federation vocabulary evie never sees (content-blind): `FederatedOpSchema` (send/list_teams/wake/response_push), the `ReturnRouteSchema` reply-pin, the `GatewayRelayPayloadSchema` (always E2E-sealed: a single `sealed` envelope, no cleartext op - evie cannot read or forge it), and the full `GatewayRelayFrameSchema` the gateway-relay pump validates. NOT codegen'd to Kotlin (cross-Gateway is gateway-to-gateway; the console reaches the mesh through its route Gateway)
    - `stts-providers.ts` - `SttsProviderSchema` for the TTS provider catalog (bundled at `android/.../assets/stts-providers.json`): per-provider id/label/path/container/voices plus a request-body TEMPLATE ($text/$voice). Validated by vitest on every push; the generated Kotlin `SttsProvider` decodes it at runtime and `SttsClient.fillTemplate` fills the template per call. The `voices` arrays are NOT hand-maintained: they are generated from the raw provider voice dumps in `data/stts-voices/` by `scripts/import-stts-voices.ts` (drift-checked by ci.yml). The settings voice picker filters this full list as you type
    - `notice.ts` - the notice-tier truth for BOTH reply tools and the console wire: the four required tier fields (`NoticeTitle`/`NoticeSummary`/`NoticeFull`/`NoticeFullSpoken` - `fullSpoken` is the spoken copy of the body the console's FULL play tier speaks; tier rules live on the field describes), `NoticeSchema` composing them, plus the lenient wire projection every hop BELOW the tool boundary shares: `NoticeTierWireFields` (the optional `{title, summary, fullSpoken}` trio, spread into `RespondBodySchema`, `response_push`, and `console_push`'s entry so a hop cannot silently strip one tier), `pickTiers` (the single compose projection - also normalizes a blank tier to absent), and `SPOKEN_TIER_FIELDS` (feeds the escaped-newline lint loops). `MailboxEntrySchema` keeps flat literal tier fields (its field order feeds the Kotlin codegen); protocol-fixtures.test.ts pins that it declares every tier and that a mailbox fixture exercises each one on both runtimes. SYNCED leaf: a byte-verbatim copy lives at `nyaaskills/src/shared/notice.ts` (re-sync with `bun scripts/sync-leaf.ts src/shared/notice.ts`). `title` is the only headline field (the old `tiny` is retired; the `notify_human` tool and the `/human/notify` route are strict, so a stray `tiny` is rejected)
    - `reconnect.ts` - Exponential backoff reconnector for WebSocket connections
    - `process-guards.ts` - `installRejectionGuard(name)`: the shared process-wide `unhandledRejection` guard (log + keep running) every entrypoint installs so a stray fire-and-forget rejection cannot kill a long-lived process. `uncaughtException` stays per-entrypoint (its recovery policy differs: daemon exits to its respawn loop, gateway flush-free-exits beside its durable state, mcp exits for Claude Code to re-establish)
  - `__tests__/` - Test files (vitest)
- `skills/` - Claude Code skills
  - `crosstalk/SKILL.md` - Cross-team communication skill (tool reference, response format)
- `.claude-plugin/plugin.json` - Plugin metadata (name, version, description)
- `.mcp.json` - MCP server config (entry point: main-mcp.ts)
- `docker-compose.yml` - Docker Compose for the gateway (port 20000, bridge network)
- `Dockerfile` - Gateway container image (Bun + kubectl + dev tools)
- `install.sh` - Add switchboard Docker network to a devcontainer project
- `uninstall.sh` - Remove switchboard Docker network from a devcontainer project
- `start-gateway.sh` - Plain start for this machine's gateway (git pull, rebuild, health wait); setup lives in `./setup.sh`
- `setup.sh` - Thin launcher: execs `scripts/setup.ts` (the admin setup menu; sets up this machine's gateway and roots the owner's own Domain, not a path to add consoles or guests)
- `start-host-daemon.sh` - Start the headless host daemon (`src/main-host-daemon.ts`) in a tmux session: it owns the gateway's reserved `host` WS slot (devcontainer wake + the console terminal view), carrying no Claude session. Launches it under `run-host-daemon.sh`
- `run-host-daemon.sh` - Supervisor for the host daemon: restarts it with exponential backoff and, after repeated fast crashes, drops the tmux pane to an interactive shell (reachable via `tmux attach -t host-daemon`) instead of hot-looping. The daemon exits only on an `uncaughtException`; a stray rejection is logged and survived (see `shared/process-guards.ts`)
- `scripts/setup.ts` - The admin setup flow (the `setup.sh` logic, in bun): a grouped menu titled with the hostname. `1) Setup Gateway` arms this machine's gateway for enrollment, renders its admit payload as a QR or as copy-paste JSON (each with a save-to-file fallback), then waits for the phone's sealed bundle (LAN POST to `/enroll` or a pasted blob) and connects to evie in-process (no restart); re-enrolling clears the old transport behind a confirm, and temp artifacts are wiped on success / back-out / ^C. `2) Evie Admin Provision` runs the cluster cutover, stages the pending admin Domain, emits the Console blob, and opens the enrollment QR menu. `9) Purge Gateway` removes only this gateway's admission from evie then erases the local state; `0) Purge Federation` removes only this owner's Domain slice from evie (other tenants survive) then wipes the local allowlist + host blob. There is no host-side Domain rooting or owner-key handling; the phone roots the Domain
- `scripts/lib/host.ts` - Shared host-orchestration primitives for the bun setup scripts: Bun.$ wrappers over docker + kubectl (`k`/`kStdin`/`dc`/`dx`, container lifecycle, base64 Secret reads + Opaque-Secret apply), the interactive menu/prompt loop, and `.env` read/write
- `scripts/bootstrap-domain.ts` / `scripts/write-provisioning-blob.ts` / `scripts/render-provisioning-qr.ts` - Pure modules `scripts/setup.ts` composes: the admin-Domain Secret mutations (`pendingAdminDomain` stages the admin Domain as a pending tenant, `readAdminDomain` reads its rooted/displayName state, `removeDomain` / `removeGatewayAdmission` are the per-user purges), assemble + schema-validate the provisioning blob, and render it as a terminal or GIF QR
- `scripts/check-module-residue.ts` - Verify node_modules matches bun.lock (no unsanctioned nested dirs shadowing pinned versions)
- `scripts/codegen-kotlin.ts` - Generate `android/.../proto/Protocol.kt` (kotlinx data classes + sealed `ConsoleOp` + wire constants) from the zod truth in `src/shared/schemas.ts`; committed output, drift-checked by ci.yml. Emission rules live in the script header (encode-side sealed only, open Strings for decode-side enums, integer -> Long)
- `scripts/import-stts-voices.ts` - Normalize each TTS provider's native voice-list dump (`data/stts-voices/<provider>.json`) into the `voices` arrays of `android/.../assets/stts-providers.json`, in place. Per-provider adapters map the heterogeneous shapes (Azure `ShortName`, Google `Name`+int gender, OpenAI deduped, Amazon neural-only, IBM description-name) to `{ id, label }`, English-first. Committed output, drift-checked by ci.yml. To refresh a provider: replace its `data/stts-voices/<provider>.json` with a fresh export, run the script, commit both files. Providers with no dump (ElevenLabs, Uberduck, xAI) keep their hand-curated voices
- `tests/fixtures/protocol/` - Golden wire fixtures decoded by BOTH vitest and the Android unit tests; `_manifest.json` is the single inventory both suites iterate (vitest also asserts directory/manifest agreement)
- `tests/fixtures/_signing-vectors-manifest.json` - the cross-runtime inventory of the signing-bytes vector corpora (provision-ops, xdomain-link, cross-domain-sas, enroll-sas, session-id, sync-cursor, transport-request, owner-id); a vitest test + a Kotlin twin iterate it and assert directory agreement, so a new op's vectors can never be read by only one runtime (the stale-vector-breaks-on-main class). Per-op suites still own the byte assertions

## Architecture

Two separate entry points, two different runtime contexts:

**MCP Plugin** (`main-mcp.ts`) - Loaded by Claude Code or IDE plugins via `.mcp.json`. Runs in the user's process. Provides tools for cross-team communication, devcontainer dispatch, and game client connectors.

**Gateway** (`main-gateway.ts`) - Runs in a Docker container. A Gateway (one of many in the Mesh): the central HTTP + WebSocket router that all local teams connect to. Handles message routing, request/response lifecycle, and the evie-bot bridge (evie is the content-blind Router that forwards between Gateways).

### Connection Mode

Every bridge connection is **channel mode** now (the CLI dispatch path - cursor/copilot/codex agents injected as prompts - was retired with the host split). Messages arrive as `<channel>` push notifications via `notifications/claude/channel`. Bidirectional, no polling needed. Conversations use persistent channel conversations (see below). `ConnectionMode` is a single-value enum (`"channel"`) kept for the `TeamInfo.mode` wire field.

### Channel Conversation Model

Channel-mode agents (Claude windows and devcontainer Claudes) have persistent conversations. Each MCP process generates a stable `conversation_id` on startup and reuses it across WebSocket reconnects for the life of that process.

- The gateway derives a deterministic channel job key via `storeKey({kind:"conv", conversationId: senderConversationId, address})` = `conv.<conversationId>.<domain>.<gateway>.<spawn>.<session>`. Every `crosstalk_send` between the same (sender window, target session) pair lands in the same store entry; the caller does not manage session_ids.
- Pending-job entries for channel conversations are marked `persistent: true` and are never swept by the store's TTL cleanup. Transient (non-persistent) entries still time out after the `PendingJobStore` default TTL (600s).
- `channel_reply` may be called multiple times on the same session_id - there is no status field and no finality; the conversation only closes when a process exits.
- Responses push back to the specific sender sub-session via `conversationRegistry`, so parallel host windows targeting the same devcontainer do not receive each other's replies.
- Reconnects rebind the conversation: the same `conversation_id` shows up with a new WebSocket, the gateway swaps the registry pointer, and the conversation resumes without losing state.

### Evie bridge (console relay)

The gateway connects to evie-bot over the Kubernetes API server's service-proxy, using a `transport.json` (SA token + cluster CA + endpoint) delivered into its federation dir by enrollment. A WebSocket client (`evieClient.ts`) presents the SA token as Authorization (the API server authenticates it, RBAC scopes it) and pins the cluster CA for TLS; registration is gated by the owner-signed admission, not a bearer. Its live role is the console relay transport: evie relays the console's `console_relay` frames over this WS, and the gateway answers each with a `console_relay_reply` tool call (see Console Bridge below). The same tool-call wire (`callTool` + `tool_result` / `tool_error` correlation) carries those replies.

### Channel file attachments

File attachments flow over the console channel; the Discord file path was retired with the human bridge.

**Inbound (console -> agent):** The console's `send` / `respond` ops carry a `files` array (`ChannelFile[]`); byte-bearing entries include `base64`. The gateway validates via `ChannelFilesSchema`, applies a 500 MB consumer-side hard backstop, and forwards the payload as part of the `channel_push`. The host MCP plugin's `materializeFiles()` (in `mcp/channel/evieFiles.ts`) writes byte-bearing entries to `/tmp/evie-files/<messageId>/<safeFilename>` via `<path>.tmp.<pid>` + atomic `rename`, then `renderFilesBlock()` builds a unified `[FILES]` block prepended to the channel notification body so the agent `Read`s them by path. Metadata-only entries (no bytes) have no re-fetch path and are surfaced as not-transferred. Lazy mtime sweep keeps the directory bounded with a 1-hour TTL.

**Outbound (agent -> console):** `notify_human` accepts `attachments` as absolute file paths; the MCP plugin reads each with `fs.readFile`, base64-encodes it into a `ChannelFile`, and ships it on the `/human/notify` notice. The gateway appends the notice (with files) to every registered console's mailbox.

**On-device storage (Android, `Attachments.kt`):** decoded/stored bytes live under `filesDir/attachments/<bucket>/<name>`, one bucket per logical origin - inbound entries bucket by mailbox coordinates (`<epoch>-<seq>`, one bucket per drained entry, never shared across rows or teams); an outbound send buckets by its own `opId` (a fresh UUID, so two sends can never collide on one bucket). `ChatRepository` owns which srcs are still referenced (a pure walk of `_state.value.threads`); `Attachments` owns the storage primitives (`fileFor`/`bucketOf` resolve a src, `deleteFiles` removes named files and any bucket left empty, `sweepOrphanBuckets` is the cold-start backstop for anything unreferenced and old enough not to still be mid-write). Forgetting a team purges its dropped rows' files immediately (`ChatRepository.forget`); a superseded optimistic send purges its old bucket via `Attachments.mergeSentEchoFiles`'s per-file merge, which is also what protects a row that keeps some of its old files (a byteless mirror arm) from an over-eager delete.

### Gateway identity and qualified names

Every gateway is a **Gateway** with an id (`GATEWAY_ID`, else the sanitized machine hostname; see `resolveLocalGatewayId`) and a Domain id. Sessions are addressed by the unified dot path `domain.gateway.spawn.session` (an `Address`); a LOCAL team field is `spawn.session` (a chat) or a bare `spawn` (a spawn-point), and the Domain id is the `local` sentinel until enrollment. The gateway stays keyed by bare local team fields internally and qualifies to the full `Address` only at the wire edge: `teams()` stamps each `TeamInfo.gatewayId` (+ `domainId`), register returns the connected `gatewayId`, and `send` resolves a target by ARITY via `parseTarget` (a spawn-point fails fast; the local-collapse rule keeps an our-(domain,gateway) arity-4 target local while a different gateway/Domain routes cross-Gateway), so the channel session id carries the full `domain.gateway.spawn.session`. The console keys every per-session surface (threads, tabs, unread, labels) by the canonical `Address` through its `SessionId.kt` twin, learns its Gateway id at register, and runs a one-shot schema-version wipe of the old-grammar keys on upgrade; its presence list compares canonical values, so a live session can never be synthesized as a phantom "ended". The gateway derives every session/team key through the `Address`/`SpawnPoint`/`SessionKey` value objects (`shared/session-id.ts`, the one canonical producer, so a store key and a lookup key are the same value by construction); the separator/tags/slug pattern are codegen'd into Kotlin and the console mirrors the grammar in its `SessionId.kt` twin. Cross-Gateway routing builds on this (see Federation routing below).

### Federation routing (multi-Gateway mesh)

evie is the content-blind **Router** over many Gateways (gateway side in `gateway/federation/`; evie side is evie-bot's `BridgeServer`). Each gateway REGISTERS its gateway id on connect (`gateway_register`), keying a gateway id -> socket table at evie. A Gateway reaches another by calling evie's `gateway_relay` tool; evie routes the frame to the destination Gateway's socket by `dstGateway` alone and correlates the reply by `relayId` (held open, bound to the destination's connection), never parsing the payload. A cross-Gateway send (`routes.sendCrossGateway`) forwards a `gateway_relay` carrying a **return-route** `{srcGateway, srcConversationId, srcSession}`; the destination lands a local channel_push keyed by that same session id with the return-route on its job, and when its agent replies, `respond` forwards a `response_push` back to the origin through evie to the origin's anchor (which pushes into the originating conversation). Discovery (`routes.discover`, behind `crosstalk_discover` + the console's `list_teams`) fans out a `list_teams` over evie's presence roster (`list_gateways`) and merges - evie aggregates no team lists. The console routes through its **route Gateway** (the id it learned at register), sent as `targetGateway` on each relay; evie routes there, else falls back to the latest gateway. Cross-Gateway frames are now SEALED end to end (see Federation trust below): `gateway_relay.payload` carries a `SealedEnvelope` only the destination Gateway can open. On a Gateway drop, evie's `onDisconnect` fails that Gateway's in-flight relays with an explicit error (not a stall); the gateway's evie-client auto-reconnects and re-syncs the allowlist on re-register.

### Federation trust, enrollment, and E2E crypto

The mesh runs on a single root of trust: the **owner** device. Membership is an allowlist of owner-signed **admissions** mirrored on evie AND every Gateway, so a revocation bites even while evie is unreachable (audit R3).

- **Crypto** (`shared/crypto.ts`, a SYNCED leaf - byte-identical in evie): identity = an Ed25519 signing pair + an X25519 box pair, raw 32-byte keys base64 on the wire (Android's BouncyCastle interops). Seal = per-message ephemeral X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM, signed by the sender's static Ed25519 (forward secrecy from the ephemeral, authenticity from the signature). `node:crypto` only on Bun; **AES-256-GCM not ChaCha20** (Bun lacks the latter). Cross-platform vectors pin Kotlin against node.
- **Trust model** (`shared/admission.ts`, SYNCED): `AdmissionSchema` (owner attests a subject's keys, `kind: gateway|console`), `SignedAdmission`, `Revocation`. Canonical signing bytes are a versioned newline-joined encoding (`ADMISSION_V1\n...`) reproduced byte-exact on node/Bun/Android - never sign raw JSON. `resolveAdmitted` returns the newest owner-verified, non-revoked admission. `DomainSnapshot` = the mirrored `{ownerSignPub, admissions, revocations}`.
- **Registration gate**: `gateway_register` carries the Gateway's `signPub`/`boxPub`, its owner-signed `admission` (JSON), and a fresh `proof` (Ed25519 over `REGISTER_V1\ngatewayId\nproofAt`, proving key possession so an observed admission cannot be replayed). evie's `verifyRegistration` rejects an unadmitted / revoked / replayed / stale registration. The admission proof is mandatory: there is no bearer fallback, so a Gateway with no owner-signed admission cannot register.
- **Domain mirror**: evie returns the `DomainSnapshot` in the register reply; the gateway's `Allowlist.applySnapshot` idempotently replaces its state with the owner-verified entries (dropping any forged one), so each Gateway enforces the allowlist + revocations locally.
- **Arming-mode boot**: a gateway whose `resolveLocalDomainId` returns null boots STANDALONE - it serves `/health` + the `/enroll` listener but starts NO evie client. The evie bridge activates only when BOTH a `transport.json` AND a Domain id resolve; missing either, the gateway stays off the mesh. So the gateway never fails closed on a missing Domain id - it arms for enrollment. While arming for the creds-less enroll path it holds its raw admit payload in memory and serves it at a nonce-gated `GET /admit-payload` (the setup script presents the enrollment nonce it armed with), so the host reads it (QR or pretty JSON) without opening the gateway's root-owned federation dir; the route 404s without the nonce, once a bundle installs, or once the window expires.
- **Enrollment**: the ADMIN path is the host-side `./setup.sh` (see "Deploying the federation" below) plus the app's onboarding scan. The owner root key lives ON THE PHONE and never leaves it; it is generated SILENTLY on first app start (`FederationManager.ownerIdentity()`, encrypted-only - there is no owner-key paste anymore). A FRESH setup stages a PENDING tenant Domain (no host-side rooting) and emits a 0600 TRANSPORT-ONLY blob (console-bridge creds only - no identity, no private keys) carrying a `pendingTenant{domainId, nonce}`; on scan the phone first-roots that Domain at its silent owner key (see Friend onboarding below). The Console generates its OWN member identity, owner-signs a `kind:console` admission for it with the phone-held owner key (`FederationManager`), submits it to evie, and likewise owner-admits each Gateway it enrolls. The in-app scanner under `android/.../enroll/` and the `federation-enroll-owner` DM action are RETIRED. The trust machinery still lives in evie's `EnrollmentCoordinator` (persisted in the `evie-federation` k8s Secret via the in-cluster SA + REST - `KubeSecretStore`): owner-signed admissions, the `EnrollOp` ops, and the typed-QR payloads remain. The crypto in `scripts/bootstrap-domain.ts` reuses the same `crypto.ts`/`admission.ts` so a phone-signed admission verifies byte-for-byte on the gateway and the app. The friend-onboarding MULTI-TENANT lifecycle (the admin stages a PENDING tenant Domain; the friend's phone first-roots it at its OWN auto-generated owner key via an atomic one-time-nonce spend; the owner renames a Domain live; remove evicts a guest) lives in evie's `TenantAdmin` over the same Secret - a single `runCas` resourceVersion engine backing `saveDomain`/`mutateDomain`/`mutateSecret`, and a `runGuardedAdminOp` gate (admin-signed, skew-windowed, with a PERSISTED nonce-dedup ledger) that type-enforces dedup-after-verify + no-burn-on-no-effect. A pending Domain is reachable for first-root ONLY (a `gateway_register` into one is refused).
- **Friend onboarding** (cooperative/trusted-friends only - the invite nonce is a one-time bearer secret, no stranger threat): the ADMIN stages a PENDING tenant for a FRIEND from the app's "Networks you host" UI (admin-signed `provision_tenant`), and for their OWN fresh admin Domain via `setup.sh` (the admin Domain is staged pending, no host-side rooting). The friend or fresh admin scans a ONE-TIME invite QR - a transport-only provisioning blob carrying the console-bridge creds plus a `pendingTenant{domainId, nonce}`. The app reads the `pendingTenant` off the BLOB (a pending Domain has no gateway, so a register reply can never report "pending"), self-signs a `FIRST_ROOT_V1` with its silent owner key, and POSTs it EVIE-DIRECT to evie's console-bridge first-root intake (no gateway pre-root). evie atomically roots the Domain at that key AND spends the nonce in one CAS write, so a redeem race resolves to exactly one winner; first-root rejects are opaque (no Domain-state enumeration). The gateway then self-heals: a `gateway_register` refused because the Domain is still pending carries a pending signal, and the gateway retries until the phone roots its Domain. `displayName` is the network display LABEL: evie stores + serves it on the register snapshot + discovery roster, a rename (owner-signed `SET_DISPLAY_NAME_V1`) is owner-immediate on its OWN gateway (via `domain_update`) and reaches linked Peers LAZILY on their next discovery refresh; Peers display that displayName.
- **In-person enroll trust handshake (FLOW-1, User-First)**: the same invite ALSO seeds a mutual key-confirmation ceremony so the admin and the freshly-rooted user trust each other with NO gateway anywhere. The QR carries the admin's owner keys + Domain + a phone-minted `{handshakeId, pin}` (the `EnrollHandshakeRef` on the provisioning blob); the pin is out-of-band and NEVER reaches evie. Both phones commit then reveal their owner keys through evie's `EnrollHandshakeCoordinator` - a DUMB BROKER that only relays the two frames keyed by `handshakeId` (window cap + TTL + role-slot bound to its first committer + idempotent re-poll) and computes NO SAS, verifies NO commitment. Each phone verifies the peer's reveal opens its round-1 commitment, then computes the owner-anchored, fixed-slot role-tagged `ENROLL_SAS_V1` 6-digit code LOCALLY (`SasCrypto.enrollSas` / `cross-domain-sas.ts`'s enroll* helpers - switchboard-only, NOT a synced leaf, since evie computes no SAS); the humans glance-compare, and the enrollee additionally pins the admin keys to the QR (authenticating the admin->user leg out of band). On a mutual match each owner signs a `SignedXDomainLinkEdge` to the other's Domain over the EXACT confirmed domain (no re-fetch) - the trust output is the EXISTING cross-Domain link edges, NOT a new admission and NOT a gateway peer (the enrollee has no gateway). evie routes each `submit_xdomain_link` to the edge's OWN `srcDomainId` coordinator (`addLinkEdge` owner-verifies it there), so a user with no gateway records its own half - the User-First invariant. The Android ceremony is `EnrollCeremony` (pure role/SAS/verify core) + `EnrollCeremonyScreen`, mirroring the cross-Domain `LinkWizard`; the broker frame schemas (`EnrollHandshakeOp`/`EnrollHandshakeResult`/`EnrollReveal`) live in the synced `federation-lifecycle.ts`.
- **Gateway-bridge transport pull**: the gateway-bridge transport (the proxy SA token + CA a creds-less Gateway needs to reach evie) is SERVED BY EVIE, not staged on a Gateway or carried in the provisioning blob. When the Console enrolls a creds-less Gateway it pulls the transport on demand: it signs a `TRANSPORT_REQUEST_V1` possession-proof with its network OWNER key and POSTs it to evie's console-bridge `transport` intake; evie verifies the proof, freshness, and non-replay, resolves the signer to a rooted Domain owner, and returns the SA token + CA. The Console fills `apiUrl` from its own provisioning blob, assembles the `GatewayTransport`, and seals it into the bootstrap bundle (which also carries the network `domainId` so the Gateway resolves the same Domain on its next boot). This keeps the blob QR-sized and leaves evie holding the one copy of the gateway-bridge creds.
- **Replay-reject**: `ReplayGuard` (a TTL + capped seen-set, checked AFTER the signature verifies) rejects a captured authentic cross-Gateway frame re-delivered to re-run the op.
- **Recovery** (clean-break, owner has 1 console + 1 gateway): run `setup.sh` `0) Purge Federation`. It drops only this owner's Domain slice from evie's Secret (a hosted friend tenant survives), then does the same full local wipe as Purge gateway (`.env` + `volumes/gateway`) and removes the host blob under `~/.config/switchboard`, then re-run setup. There is no silent re-root: a snapshot / redeem for a different owner is refused.

The console<->gateway op path is now E2E sealed too (the symmetric twin of the cross-Gateway seal): the console seals each op into a `ConsoleRelayFrame` (`{ opId, signerSignPub, sealed }`) to the gateway's box key and signs with its enrolled key; the gateway verifies the signer against an owner-signed `kind:console` admission, decrypts, replay- and freshness-checks, and seals the reply back. evie stays content-blind (its `console_relay` member is a loose passthrough). Only a pre-seal failure (malformed / unadmitted) returns a cleartext error so the console can prompt enrollment. The gateway<->evie WS carries no bearer: it rests on the k8s service-proxy SA token + RBAC plus the owner-signed admission at `gateway_register`. Still pending on the crypto track: the evie self-provisioning of the console-bridge k8s objects (manual YAML for now), and retiring the console bearer (`CONSOLE_BRIDGE_TOKEN`).

### Versioned state planes (gateway -> console live sync)

The console's poll response piggybacks live, versioned snapshots of server-side state instead of the console re-pulling on its own timer. `PlaneRegistry` (`shared/plane-registry.ts`) is the one-call framework every such plane registers against - `registerPlane({ name, snapshot, identityOf })` - and the registry owns everything else: version identity (`{epoch, counter}`), hash-gated bump detection (a mutator only calls `markDirty()`; the registry recomputes and bumps the counter IFF the content's hash actually changed), the held-poll wake primitive (`waitForBump`, race-free - a waiter registers within the same synchronous tick as any bump it might otherwise miss), and a 60-second tripwire that self-heals (logs + bumps) any mutation that changed a plane's content without ever calling `markDirty`. Each plane's tripwire check is isolated per plane, so one plane's snapshot/identity computation throwing never aborts the tripwire's check of any other plane, nor crashes the gateway process. `scope` narrows `changedSince`/`waitForBump` to exactly the planes a caller is asking about, so a registry shared by several planes never reports an unrelated plane as "changed" to a caller who never asked about it. `registerPlane` also accepts an optional `onBump(version)` callback, fired synchronously right after a real bump - the hook a plane whose purpose is PUSHING on change (rather than sitting passively for a poll to read) needs; `unregisterPlane(name)` drops a plane whose lifetime is shorter than the process's, also settling any in-flight `waitForBump` waiter that was tracking it by name.

Three planes exist today, all consumed through `consoleHandler.ts`'s poll case:

- **presence** (`gateway/presence.ts`, `PresenceFacade`) - the single writer over every presence-affecting field (`GET /teams` and the poll response's presence rows read the exact same `snapshot()`): SessionStore records, the live WebSocket registry, wake/create in-flight state, and the daemon-derived working/needsLogin map. Local-Gateway-only for what a Gateway serves ITS OWN console over poll - a session's presence there is visible only through the Gateway actually holding its live socket, and no cross-Gateway exchange for THAT poll-facing path exists yet (see `plans/cross-gateway-presence-exchange.md` for the deferred design and why it matters). A separate, already-built mechanism now exists for a DIFFERENT audience - a linked Domain, not this Gateway's own console - see cross-Domain presence below.
- **linked-peers** (registered inline in `gateway/index.ts`'s `activateFederation()`) - the cross-Domain trust roster, a single scalar version (no per-source concept, unlike presence's array-of-per-gateway-source shape).
- **read-anchors** (`gateway/readAnchors.ts`, `ReadAnchors`) - cross-device "how far has any of this owner's own devices read this conversation" sync, monotonic per (owner, team): a device's reported `(epoch, seq)` only overwrites the stored anchor if strictly ahead (a newer epoch wins outright, or the same epoch with a higher seq). ONE plane PER OWNER (`read-anchors:${ownerId}`, registered lazily on that owner's first touch), never a single Gateway-wide plane, so a bug in wire assembly cannot leak one owner's read positions to a different owner sharing the same Gateway process. Bounded per owner against an unauthenticated device inventing unlimited team names. The write path (`report_read` op) and the read piggyback (poll response `readAnchors`/`readAnchorsVersion`) are independent; the Android side (`ChatRepository.kt`'s `applyReadAnchors`/`reportLocalReadAdvances`) merges a synced anchor into its own local one via the SAME `isAnchorAdvance` primitive the scroll-driven local read model already uses (see Console chat unread tracking below) - resolved by ROW POSITION in that device's own locally-rendered thread, never by numeric epoch/seq comparison, since a device's local thread order and the Gateway's cross-device numeric merge are different comparison domains.

Wire shape: a poll response's per-plane fields (`presence`/`presenceVersions`, `linkedPeers`/`linkedPeersVersion`, `readAnchors`/`readAnchorsVersion`, `crossDomainPresence`) are flat, hand-named optional fields - never a generic plane map (Kotlin codegen has no typed map, and a decode-side union silently drops fields). An ABSENT known-version (an old console build) means "ship nothing, behave exactly as before" for presence's array-shaped version and for `crossDomainPresence`'s own `knownCrossDomainPresenceVersions`; an EMPTY array or an absent scalar (linked-peers/read-anchors, which have no legacy-vs-cold-boot distinction to make) means "ship the current truth unconditionally." `crossDomainPresence` is the one plane family that is genuinely N independently-versioned planes (one per linked Domain) rather than a single plane - each entry bundles its own `{domainId, version, sessions, lastRefreshedAt}`, and the array carries only the SUBSET of linked Domains whose plane actually changed, never a full resend of every linked Domain the way the other planes resend their whole snapshot. `settled` on the poll response tags which plane (if any) is why a held poll actually returned, in priority order mailbox > presence > crossDomainPresence > linkedPeers > readAnchors > domain > timeout, so the console's own instant-empty-response degradation heuristic never misreads a plane-only settle as a broken old Gateway.

Full design history and the audit rounds that shaped this are in `plans/versioned-state-planes.md`; known gaps against that design (a WebSocket register path that could leave a session's row unannounced, a deferred cross-Gateway presence exchange, and others) are tracked in `plans/pain-points.md` and `plans/cross-gateway-presence-exchange.md`.

#### Cross-Domain presence (linked-friend sessions, live push + pull backstop)

`gateway/federation/crossDomainPresence.ts` gives a linked Domain a LIVE view of this Gateway's sessions, replacing the old discovery-refresh-only pull for that specific relationship, and gives this Gateway's OWN console a live view of what linked friends have pushed back. Piggybacked on the console poll response alongside presence/linked-peers/read-anchors (see Versioned state planes above).

- **Source side** (`createCrossDomainPresenceSource`) - one internal, never-polled change-detector plane per linked-and-shared-to Domain (`presence:crossdomain-source:<domainId>`), fed by the SAME trigger set as every other presence mutation plus the share/link/unlink hooks that can add or remove a Domain from the linked-and-shared set. Its `onBump` callback pushes a `presence_push` `FederatedOp` through a per-destination `CoalescedPusher` (at most one in-flight/retrying attempt per destination Domain, replace-in-place on a fresher payload, capped retries with backoff).
- **Consumer side** (`CrossDomainPresenceConsumer`) - the landing plane (`presence:crossdomain:<domainId>`), lazily registered per source Domain (mirrors `ReadAnchors`'s own per-key pattern), capped the same way as the source side. A per-Domain floor bounds how often an inbound push is actually processed (a fresh `seal()` mints a new nonce every call, so the replay guard alone cannot bound resend rate) by deferring and coalescing a too-frequent call behind a timer rather than dropping it, so a legitimate fast burst is delayed, never lost. Each landed entry's freshness timestamp is hashed into the plane in a coarse (60s) bucket, not raw - a reconfirmation of unchanged content still eventually ships a fresher timestamp without bumping (and waking every poller) on every single reconfirmation.
- **Backstop pull** (`createCrossDomainPresenceReconciler`) - `presence_push` gets no retry chain of its own; a failed or exhausted push is simply caught by this reconciler's own independent 10s tick (decoupled from the console's poll loop, so a hung linked peer can never stall it), which pulls each currently-linked Domain's `list_teams` and lands the result through the SAME consumer entry point a push uses. A per-Domain in-flight generation token (mirrors `CoalescedPusher`'s own) guards against both piling a second attempt onto an already-running one and a stale attempt (still resolving after a concurrent unlink) resurrecting state `teardown()` just removed. A peer's `list_teams` reply is untrusted content - `routes.ts`'s `relayListTeams` schema-validates it (also used by `discover()`'s own two fan-out legs) before anything downstream trusts it as typed data.
- Both sides share the same `MAX_LINKED_DOMAINS_FOR_PRESENCE` cap and are torn down together with `unlinkDomain`/`untrustOwner`'s existing cleanup.
- **Android UI** (`android/.../ChatRepository.kt`, `MainActivity.kt`) - a "Linked friends" board section, one entry per Domain from the EXISTING `linkedDomains()`/`CrossDomainLink.mergeLinkedDomains` roster (never from the new field's own keys, so a freshly-linked friend with nothing shared back yet still shows up). `ChatState.crossDomainPeerSessions` lands the pushed/pulled entries as a per-domainId upsert (never a wholesale replace - the wire only ships the changed subset each poll); `knownCrossDomainPresenceVersions` (the client's own known-version tracking presented on each poll) is upserted the same way. A friend's freshness renders as a 3-state chip (`CrossDomainFreshness`: fresh/stale/unknown, `CrossDomainPresenceUi.kt`) computed against `lastRefreshedAt` and a periodic re-check tied to `ChatState.foreground` (a Compose-reactive mirror of `ChatRepository.isVisible`, updated alongside it). The friend header and the existing per-Gateway board header share one `CollapsibleSectionHeader` composable.

Full design history and the audit rounds that shaped this (plan-alignment and red-team passes per phase, plus framework-first passes) are in `plans/cross-domain-presence.md` (deleted once all 3 phases shipped, retrievable via git log); its pain points are folded into `plans/pain-points.md`.

### Console Bridge (Android channel)

Gateway side of a native Android chat client that reaches the bridge through evie (the only host the console and the behind-NAT gateway both reach). The console is a poll-based client, not a live socket: evie relays opaque `console_relay` frames over the existing gateway<->evie WS, and the gateway answers each with a `console_relay_reply` tool call. See `gateway/console/`; the full design doc lives in git history (`plans/done/android-channel-app.md` at commit f08e83d, removed from the tree after shipping).

- **Identity:** keyed by the console's per-install `conversationId` (the human Device Name is a display label). `consoleHandler.ts:assertValidIdentity` rejects reserved names, a name already held by a real team, and a conversation already owned by a live socket.
- **Virtual peer:** `ConsolePeer` is inserted into the team + conversation registries like a real bridge peer, so existing crosstalk routing (wake, persistent conversations, `channel_push`/`response_push` delivery) is reused unchanged. Its `send()` appends to the device's `DeviceMailbox` instead of a wire; the console drains it with the `poll` op. Virtual peers are excluded from the heartbeat and from DM-holder selection (`getAllActiveRealWs`), and a real registration evicts a squatting virtual peer.
- **Ops:** `register`, `list_teams`, `send` (to a devcontainer or a loose session), `respond` (only to a thread delivered to this device), `poll`, `peek` + `tmux_send` + `create_session` + `rename_session` + `reload_plugins` + `forget` + `close_session` (the terminal view + session lifecycle: see Console terminal view below). `create_session` takes either a typed `sessionName` (adopted as the id) or a `displayLabel` (the gateway mints the id); `rename_session` sets the gateway-authoritative `sessionLabel` on a record (server sanitizes + per-spawn dedups). `close_session` kills a session's tmux but KEEPS its record (a restart / mop-up), the inverse of `forget` which also drops the record; it refuses while a wake is in flight and reports honestly against a user-launched (alias) session rather than a false success. `send`/`respond`/`tmux_send`/`create_session`/`rename_session`/`reload_plugins`/`forget`/`close_session` are idempotent per `(conversationId, opId)` via an in-memory `opCache` (`consoleHandler.ts`, the per-process single-flight/replay layer); reads (`poll`/`peek`) run fresh. `send`/`respond` additionally sit on a DURABLE, restart-proof layer beneath that cache: `DurableOpStore` (`gateway/console/durableOpStore.ts`) persists a two-state (`in-flight`/`complete`) record synchronously on every transition, consulted only on an opCache miss, so a gateway restart mid-send can no longer re-deliver a message the client already believes sent. A `generation` token minted on every dispatch - including a same-opId re-execution over an already-`in-flight` record - lets a stale, superseded attempt's own eventual failure recognize that a newer overlapping attempt has since taken the key, instead of erasing its still-live state; a `complete` record is write-once and permanent, and the durable key is namespaced by op kind (`send`/`respond` never share a slot even if a client coincidentally reuses an opId across the two). Bounded (500 conversations x 256 ops, 14-day TTL matching the client's `reconcilePending()` retry horizon) with an active `sweep()` alongside `SessionStore`'s own. Full design history and the audit rounds that shaped this are in `plans/scheduled-send.md`. The Console now pulls the gateway-bridge transport from evie (see Gateway-bridge transport pull above).
- **Host machine:** the conversational host-agent was retired in the host split. A host Claude runs as an ordinary `loose` peer, spawned on demand through the console's `host` spawn-point (the daemon's `create_session`); the privileged host plumbing lives in the headless host daemon, which registers the reserved, console-hidden `host` slot. The console reaches the host machine's terminal + session lifecycle through the dedicated `host` target (see Console terminal view), not a chat session.
- **Devcontainer sessions are dynamic `project.session` loose peers.** A bare `project` is the catalog **spawn-point** (kind `devcontainer`), never a chat; each named session is a separate loose chat addressed `project.session`. The daemon launches a session by overriding `PROJECT_NAME=<project.session>` (after sourcing `~/.bashrc` so it wins over the image ENV) so the in-container MCP registers under the composite name, which is what completes the wake. The gateway keeps a durable `SessionStore` of session records (a record is established when a session completes its lead handshake, not at register, and is TTL-evicted) so a re-wake reattaches a live tmux else `claude --resume`s the record's transcript id else launches fresh. The store IS the durable known-session list: `teams()` surfaces each record as `online` (a live incarnation that has confirmed), `verifying` (a live incarnation not yet (re)confirmed), else `available` (asleep, wakeable, with `lastActive`). A send to an asleep composite with an existing record reattaches it (wakes as-is, same address). A send to a composite with NO record yet requires a `displayLabel` (`crosstalk_send`'s own field, or the console's `send`, which never sends to a target it has not already `create_session`'d): it mints an opaque id under the addressed spawn via the same mint-and-provenance path `create_session` uses, so the woken session lands at that minted address, never the one typed - a `displayLabel`-less send to a nonexistent target fails fast instead of silently adopting the typed segment as the id. A failed wake rolls back a record this send itself minted (not one that was already confirmed/live). Whether a name is a spawn-point is decided by **catalog membership** (`isCatalogProject` in `gateway/index.ts`, the dir scan + the bare register), NOT the mechanical `isComposite` dot test, so a dotted dir name (`my.app`) is still a project; the register write-guard keeps composites out of the catalog. A send to a bare `project` fails fast (a spawn-point has no session). The console **board** renders projects as purely informational spawn-point headers (`SpawnPointHeader`) with their `project.session` chats nested under them. A `Create` button on the Gateway row (`GatewayHeader`, your own Gateway only) opens a session-name dialog (`CreateSessionDialog`) with a project selector defaulted to `host`, which runs `create_session` then opens the new chat. The **host machine is a symmetric spawn-point** too: the board shows a synthetic `host` header for your OWN gateway (the host is not in `offlineCatalog`, and the daemon's reserved `host` slot is hidden from `teams()`), selectable in that same dialog - the server resolves a `host` target through the identical `create_session`/`forget`/resume path as a devcontainer. A host session is recorded in the store and re-launched with `claude --resume` on a later wake exactly like a devcontainer session (so it survives a reboot), and it starts in `~/projects/<label>` (`resolveHostWorkdir` keyed on the record's workdir hint, else `$HOME`) rather than the daemon's own cwd. The daemon's own `host-daemon` supervisor session is reserved (`isReservedHostSession` in `shared/host-op.ts`), so a `forget`/`create_session`/wake targeting it is refused at every sink and can never kill or relaunch over the daemon. **Forget** (`forget` console op -> `killSession` host-op + `dropSessionResume`) tears a named session down: it kills the tmux and drops the resume record so it stops listing. **Busy presence** (`verifying`/`working`) renders as a shared ambient pulse bar (`PulseBar`); `working` itself is driven by a tmux peek (`isAgentWorking` / `AgentScreen.kt`, the "esc to interrupt" spinner): the open chat peeks continuously, every other listed session gets one cheap peek per list change.
- **Mailbox:** `DeviceMailbox` is bounded (entry cap with cumulative `dropped` gap signal, 1h idle TTL, store-wide LRU device cap). Each instance carries an `epoch`; `poll` is epoch-gated so a cursor from an evicted instance cannot ack away a new instance's entries. The OOM backstop's eviction is kind-aware: it prefers the oldest `"peer"` entry over other kinds, so a burst of agent-to-agent chatter (below) evicts itself before a slow device's real unread mail.
- **Agent-to-agent mirroring:** `routes.ts`'s `mirrorPeer` taps `send`/`respond`/`sendCrossGateway` and appends a `kind: "peer"` display copy into the owner's mailbox for each LOCAL participant of an agent-to-agent exchange, tagged under that participant's own thread (`from`/`to` are the exchange's real sender/recipient, not the thread's own peer). Never fires for a console sender/target - the console already sees its own conversations through the normal channel push/reply path. Purely additive display (never load-bearing: a failure here is caught and logged, never surfaces to the caller). The console persists a peer row's real `from`/`to` verbatim (`ChatRepository.kt`'s `persistedAttribution`/`loadedAttribution`), so the same exchange durably exists in both participants' threads; `forget()` sweeps every thread for a peer row naming the forgotten address (`threadsAfterForget`), not just the forgotten team's own thread, so the other copy cannot outlive it.
- **Plugin actions:** a generic, agent-initiated `kind: "plugin_action"` mailbox entry (`{pluginId, actionType, payload}`) landed by `routes.ts`'s `pluginAction`, so a tool can drive a device-side plugin (e.g. the Designer's delete-card) without a dedicated wire type per action. `threadAddr` derives SOLELY from the request's own `from` (`localAddress(from)`) - there is no separate target field, so a caller has no MORE room to name another conversation than `send()` already has (this is not a new authentication boundary; see `plans/pain-points.md` for the underlying same-network trust model). `pluginId`/`actionType` are slug-constrained and `payload` is size-capped (`MAX_PLUGIN_ACTION_PAYLOAD_BYTES`), independent of `device-mailbox.ts`'s own byte accounting, which does not count this field. On the console, `ChatRepository.kt`'s drain loop dispatches a `plugin_action` entry (never rendered as a chat message) to `PluginHost.pluginActions`, a registry keyed `pluginId:actionType`; a claimed `PluginActionHandler` runs synchronously on the poll thread before the cursor commits, same fast/bounded/non-blocking contract as `InboundMessageHandler`, plus a MANDATORY idempotency contract (the mailbox's at-least-once delivery has no persisted fold for this kind, unlike a rendered message). The Designer's `designer:delete-card` handler is the first consumer, driven by the `designer_delete_card` MCP tool (`mcp/designer/designerTools.ts`) through the self-scoped `postPluginAction` helper. Full design + red-team history in git (commits `dc28dbb`, `95e82c8`, `f35c008`); residuals in `plans/pain-points.md`.
- **Multi-gateway console-bound delivery:** a Domain can run more than one Gateway, but the console only polls its one route Gateway - so content composed on a *different* same-Domain Gateway (a peer-mirror row, a `notify_human` notice, or a plugin action on a Gateway with no console ever registered against it) has to be relayed there. `routes.ts`'s `fanOutConsolePush` is the origin-side fan-out: after `mirrorPeer`/`humanNotify`/`pluginAction` land their entry on the local mailbox, it enumerates every other same-Domain Gateway via evie's `list_gateways` (the same call `discover()` makes), self-excludes and filters through the locally-mirrored Allowlist, and relays a `console_push` `FederatedOp` to each over the existing sealed `gateway_relay` transport. The landing side (`routes.consolePush`, reached through `gatewayRelay.ts`'s `handleOp`) only ever appends locally and never re-fans-out - origin-only, so an entry cannot gossip-loop around the mesh. `console_push` is gated same-Domain-only at the destination with no exceptions (a cross-Domain sender is hard-denied before any mailbox write), stricter than every other `FederatedOp` kind. Delivery is idempotent per `dedupeKey` (feeding `DeviceMailbox.append`'s `seenKeys` map directly - `ReplayGuard` can't serve this role, since it mints a fresh nonce per relay attempt including retries). `mirrorPeer`/`humanNotify`/`pluginAction`/`routes.consolePush` all land their entry through one shared `landMailboxEntry` helper, so the dedupeKey-embedding convention has one writer instead of four.
- **Trust:** frames are zod-validated at the boundary (`ConsoleRelayFrameSchema`) AND E2E sealed: the gateway opens each frame through the `consoleSealer` (verifies the console's signature against an owner-signed `kind:console` admission, decrypts with its box key, replay- and freshness-checks) before dispatch, so it trusts a frame because it is signed by an admitted console, not because it arrived on the evie WS. Each conversationId is bound to its first signing key (a console cannot operate another install's mailbox by borrowing its conversationId). The bearer token is the coexistence-window relay gate at evie, retired by W5. Adds no new HTTP surface.

### Session identity binding (which session may speak as which name)

A `SessionRecord` may carry a `bindToken`: a secret minted when the gateway dispatches a launch and
delivered ONLY through the daemon's launch command (`buildLaunchCommand` exports
`SWITCHBOARD_SESSION_TOKEN` beside `PROJECT_NAME`, over the already-`HOST_WS_TOKEN`-gated channel).
The MCP presents it at register and as `x-session-token` on every HTTP call. This closes
CROSS-PROJECT impersonation: a compromised devcontainer cannot register as another project's
session, forge `from` on `/send`, `/human/notify` or `/plugin-action`, answer another session's
handshake or vibe check, or forge a reply into a conversation it does not own. Same-project panes
share one container and one uid, so they remain mutually impersonable by OS construction - that is
a permanent, accepted residual, not a gap.

`gateway/sessionAuthority.ts` is the SOLE owner of "what must a caller prove to act as X". Nothing
else reads the credential fields; a residue test (`__tests__/session-authority.test.ts`) fails the
build if any module outside it and `session-store.ts` mentions them. It answers two genuinely
different questions plus one named composition, and collapsing them re-introduces bugs that were
already paid for:

- `toClaim(teamKey)` - NAME-keyed, and the only place inert-awareness lives. A token minted for a
  launch that merely reattached was never delivered (a reattach discards the launch command), so a
  binding stays INERT until a register actually presents it (`bindActiveAt`). Without this, every
  reattach and gateway restart would strand its own session.
- `toAnswerFor(ws)` - SOCKET-keyed, deliberately NOT record-derived: a `claude --resume` alias
  incarnation legitimately serves a bound record under its own unbound name and holds no token.
- `toActFor(teamKey)` - the composition, live-first with a record fallback, because asleep is a
  session's normal state and the easiest moment to forge into.

`satisfies` is the only comparator (timing-safe; a missing presentation is a refusal, never a
fallback) and `sameAs` the only identity check. `SessionBinding` is opaque and UNBOUND is a VALUE a
resolver returns, never an absence a caller falls into - that property is what makes a gate unable
to manufacture an accidental permit, which was the shape of every bug this replaced.

Deferred and tracked in `plans/pain-points.md`: the LAN-stranger origin gate, read-side ownership
on `/poll` and `/pending`, the ungated fan-out, and `bindResume`'s transcript-id path.

### Console terminal view (peek + tmux_send)

A power-user view in the Console that drives an agent's RAW tmux pane (distinct from the chat): the `peek` op captures the visible ANSI screen, `tmux_send` injects literal text or a whitelisted control key (Enter/Escape/C-c/arrows/Tab), `create_session` starts a new named tmux session running a fresh agent, or reattaches if that session already exists (the daemon builds the launch command, the console supplies only the target + name), and `reload_plugins` drives a session through the plugin update + MCP reconnect sequence. All are sealed `ConsoleOp` variants on the same trust path as the chat ops, and reach the host machine through a gateway<->host-daemon RPC layered on the existing host WebSocket:

- **Pre-tmux docker-logs fallback:** while a session's tmux pane does not exist yet (a devcontainer still booting), a `peek` cannot capture a pane, so the daemon's `peekWithFallback` (`mcp/devcontainer/tmuxCore.ts`) falls back to a bounded tail of the devcontainer's `docker logs` (`captureContainerLogs`, its own shorter timeout) instead of erroring. The host-WS result `HostPeekResult` is a discriminated union tagged `kind: "tmux" | "container-logs"`; the console-facing `ConsolePeekResultSchema` mirrors the tag as FLAT optional `kind` + `text` fields (never a zod `discriminatedUnion` - the Kotlin codegen silently drops a decode-side union root, so a decode-side result must stay a flat object). The raw `peekPane` is unchanged and reject-on-absent, still used directly by the wake/ready callers (`awaitReady`, `handleWake`) whose dead-launch detection depends on it; only the console-facing wiring uses the fallback wrapper. State machine: container logs while the pane is absent (fast non-zero capture), the tmux pane once it exists.
- **Exact-match session targeting:** every tmux session LOOKUP (`has-session`, `capture-pane`, `resize-window`, `kill-session`) uses tmux's `-t =<name>` exact-match prefix (`exactSession` in `tmuxCore.ts`), not a bare name, so an op can never prefix-match a sibling session (e.g. `story` matching `story-2`) in a shared container. `new-session` assigns a name and keeps the bare form.
- **App rendering (`android/.../TerminalView.kt`):** the console opens a not-yet-live session (status `available`/`verifying`, or a fresh create) into the terminal view only when it is already known to be stuck (`sessionNeedsLogin`, daemon-derived off the presence plane - true even before "online", since a peeked pane can show a login prompt while the MCP handshake is still pending); a plain still-booting session opens to chat instead, since there is nothing to watch until it either comes up or gets stuck (`MainActivity.kt`'s `ThreadScreen`, the `terminalMode` default). `TerminalView` always peeks (backing off to 8x cadence while the session is not answering) and renders per the peek frame: the tmux pane + input palette, the read-only container-logs snapshot (no input), a centered `Wake`/`Retry` button when the session is off, or `Connecting...` before the first frame. Once a mount has peeked a real pane (`everSawTmuxFrame`), a later status drop back to `available` (Ctrl-C killing the foreground claude, tmux itself alive) keeps showing that pane rather than idling out to the Wake screen; and while the session is not online, the slash-macro row (claude TUI commands, nothing to receive them) swaps to a Wake up button that force-relaunches via `ChatRepository.relaunchSession` - `close_session` + `create_session` composed, because a bare create no-ops whenever the tmux session still exists regardless of what is running inside it. A create (`ChatRepository.spawnSession`) fires and stays on the board - the gateway adopts the record synchronously, so its tile appears via the next `teams()` refresh with no separate placeholder or navigation. Close Tab fires `close_session` (kill tmux, keep the record, stays on the board); Forget is the `forget` op (also drops the record).

- **Host RPC:** the gateway sends a `host_op` frame (a `reqId` + a `HostOp`) and correlates the reply by `reqId` through `HostOpCoordinator` (`gateway/hostOpCoordinator.ts`, mirroring `evieClient`'s pending-calls; `failAll` on a host disconnect), via `relayToHost` in `gateway/index.ts`. The host daemon (`hostDaemon.ts`) runs it through `createHostOpRunner` (`mcp/devcontainer/hostOpRunner.ts`: peek single-flight + a cadence floor + a concurrency cap; the mutating ops - send / create_session / reload_plugins - dedup by `(conversationId, opId)` so a relay timeout or gateway restart replays the ack instead of re-running). The tmux primitives live in `mcp/devcontainer/tmuxCore.ts` (spawn argv - no shell; `--`-guarded literal text submitted atomically with a trailing CR; a slug-validated target name; an ANSI visible-pane capture with a byte cap + content hash; `hasSession`/`ensureSession` reattach-or-create so a create no longer errors on a duplicate). The wake path reports a FAILED wake when a freshly launched pane never captures (a dead launch - bad bashrc, claude off PATH), so `/send` fails fast instead of stalling. The wire vocabulary is the type-only `shared/host-op.ts` (deliberately no zod/codegen - it rides the trusted, token-authenticated host link, not the untrusted evie relay).
- **Targets:** the `host` machine (the `"host"` target, run via bare `tmux`) and a locally-backed `kind: "devcontainer"` (`docker exec` into `<name>_devcontainer-dev-1`). A `TmuxTarget` carries a `sessionName` and the pane is always `.0`. The session rides in the address: `peek`/`tmux_send`/`reload_plugins` derive it from a composite `project.session` target (a bare name keeps the conventional `claude` session for back-compat), while `create_session` passes an explicit new session name. `resolveTmuxTarget` (`consoleHandler.ts`) does catalog-first disambiguation (a whole-name project match wins, else the last separator splits the session off) and validates the resolved name via the shared `assertTmuxName`/`isTmuxName` (`shared/host-op.ts`, slug + 64-char cap, enforced at both the gateway boundary and the host sinks). Loose and cross-Gateway targets are gated off, as is the daemon's own reserved `host-daemon` session (`isReservedHostSession`, also backstopped in `tmuxCore` create/kill).
- **Auth:** the reserved `host` WS slot is authenticated with `HOST_WS_TOKEN` (auto-provisioned into `.env` by `start-gateway.sh`, read by `start-host-daemon.sh`) so a LAN peer cannot squat it to read/forge panes or capture keystrokes.

### Console capability union (which tools a session gets)

A session's tools are gated on what the owner's consoles can actually render. The console reports
its enabled plugins at register; the gateway unions those reports across devices; a starting MCP
session reads the union over HTTP and uses it to decide which tools to register and what guidance
to carry. Full design and the audit rounds behind it are in `plans/artifact-references.md`.

- **Reporting (Android):** `PluginManager.reportable()` returns the LOADED plugins (not merely
  enabled - one whose entry threw renders nothing, and offering an agent a broken surface is worse
  than not offering it), each with the `agent_instructions` line from its own `manifest.json`. The
  text is owned by the plugin, so adding one delivers its agent guidance with no wire or gateway
  change. `ChatRepository.enabledPlugins` is the supplier seam the app wires (the repository holds
  no Context, and the plugin framework is Context-bound); `reportEnabledPlugins` re-reports on a
  toggle and arms `pluginReportPending` until the report lands, which the poll loop retries. That
  retry is not symmetric politeness: a dropped toggle-ON report leaves the gateway holding an
  AFFIRMATIVE union, and an affirmative union is exactly what a starting session does not
  second-guess, so the owner would silently lose a tool they just switched on.
- **The union (gateway):** `CapabilityStore` (`gateway/console/capabilityStore.ts`), keyed by
  conversationId, durable, 14-day TTL, 500-device cap. A capability disappears only when every
  device that had it has either said otherwise or gone quiet for two weeks. An ABSENT
  `enabledPlugins` means the device said nothing and its prior report stands; an EMPTY array is an
  affirmative "nothing enabled". Zero live records serves `known: false`, never an affirmative empty
  union. `lastSeen` advances on any sealed op but is only flushed to disk once it drifts past
  `LAST_SEEN_FLUSH_FLOOR_MS`, keeping the poll path free of disk writes while still surviving a
  restart - without that flush a phone that had polled daily for weeks would be swept on the first
  tick after a restart, since the durable value only moved on a register.
- **Serving:** `GET /capabilities` (`routes.ts`'s `capabilities`), UNGATED by the same ruling that
  settled Phase 0 - it serves non-secret plugin ids beside an already-open `/teams` and `/pending`,
  and the hand-launched host window it exists to serve carries no credential to present.
- **Consuming (MCP):** `mcp/capabilities.ts`'s `fetchCapabilities`, awaited in `startMcp` after
  `BRIDGE_ROUTER_URL` defaulting and before the McpServer is constructed, so the answer can gate
  tool registration and feed the server instructions. Deliberately not `routerGet`: that retries
  past any deadline, cannot see a status code, and reads a URL only set once the bridge initializes.
  One bounded attempt, then `fallback()`. **Fail-open is the whole safety argument:** an agent
  holding a tool the owner cannot render loses nothing, while an agent missing a tool the owner does
  have is a silent outage with no error anywhere. So only an AFFIRMATIVE union lacking a capability
  removes a tool, and `fallback()` lets the disk cache only ADD to the core set, never shrink below
  it. `GATED_CAPABILITY_IDS` is the single list both the gates and that core set derive from, and a
  fixture test holds it against the shipped `manifest.json` files so the planned rename of a plugin
  id to `<author>.<content_id>` fails a test instead of silently un-registering its tools.
- **Timing:** a running session never changes its tools. A plugin toggle is picked up at the next
  session start, which is the owner's explicit decision.

### Android plugin framework

The console app has an in-APK plugin framework (`android/.../plugins/`) so first-party features (the Designer, today the only one) are modular and individually toggleable in Settings, shaped for a later per-repo split. Full design + red-team history is in git (commit ffa32c4); open follow-ups are in `plans/features-and-fixes.md` (Item 15) and `plans/pain-points.md`.

- **Framework core:** `Plugins` is the process singleton (mirrors `Repo`): it builds a `PluginHost`, boots a `PluginManager` over the compile-time `PluginCatalog`, and is started from `SwitchboardService.onCreate` before polling. `PluginManager` collapses install/enable/load into one persisted flag, refuses on manifest/id collision, and disables via a one-sweep retract. Each extension point is a `PluginRegistry<T>` on `PluginHost` (`runtime.createRegistry`): `threadDockSlots`, `attachmentOpeners`, `threadForgetHandlers`, `accountWipeHandlers`, the data-plane `inboundMessages`, the command-plane `pluginActions`, and `attachmentChipDecorators`. A registry auto-tags each claim with its source plugin, so disabling a plugin sweeps its claims and it stops receiving. Exception containment is structural: dispatch sites consult claims through the registry's `forEachCaught`/`anyCaught`/`firstNotNullCaught` (a throwing claim is logged and skipped, never fatal) - except `threadDockSlots`, whose `@Composable` values cannot cross a non-inline lambda, so a throwing slot rides Compose's own error path.

- **Attachment-chip decoration:** a plugin can restyle its own attachment chips in the chat body. `AttachmentChipDecorator` (claimed into `attachmentChipDecorators`) maps `(team, MessageFile)` to a `ChipDecoration(title, kind)` or null; `ThreadRendererPool`/`ThreadRenderer` consult it per file at transcript-serialization time (main thread - decorators must be in-memory lookups, never disk), and the payload gains an additive `decoration` key that `thread.js`'s `buildFiles` renders as a titled accent chip (`textContent` only; malformed decoration falls back to the plain chip; images ignore decoration entirely). Staleness is accepted in both directions for already-rendered rows (full design + audit history in git): the row fingerprint excludes decoration, so plugin toggles or store changes only affect rows serialized afterward.

- **Inbound message pipeline:** the data plane. `ChatRepository` exposes `addInboundSubscriber`; it fires each subscriber SYNCHRONOUSLY inside the mailbox drain, in the `appendInbound`-true branch, BEFORE `mailboxSync.commit` - so a subscriber inherits the mailbox cursor's exactly-once for free (a hot `SharedFlow` would sever that coupling, so it is deliberately not one). `Plugins` bridges that once-per-process into `host.inboundMessages`, mapping each `Message` to a coordinate-free `InboundMessage` (no epoch/seq - those stay in `SyncCursor`) and handing handlers `filesDir`, not a `Context`, to block reentrant repo calls from the drain thread. A throwing subscriber is caught and logged, never breaks the drain. `MainActivity` invokes the forget/wipe registries at the thread-forget and account-clear callsites.

- **Designer plugin** (`plugins/designer/`): renders a conversation's `@dsCard`-marked HTML attachments as a dock gallery (`DesignerDock`), opens a tapped card chip into the same viewer, and ingests each new dsCard via its `inboundMessages` handler into `DesignStore` - the Designer's own per-team device store (own SharedPreferences file, per-team `StateFlow`, additive pointer index, at-monotonic `upsert`). A one-shot per-team dock backfill seeds cards that predate the plugin; it marks its flag before seeding (so an interrupted seed never resurrects a deleted card) and guards each seed against a `removalGen` (so a Delete/Forget racing the seed wins). The backfill + removal-guard is a general inbound-consumer pattern, a candidate to lift into the framework once a second such plugin exists. Its `designer:card-title` chip decorator styles a card's in-chat attachment chip with the card's `displayName` via `DesignStore.cardForRel` - rel-keyed, never fileName-keyed, so an older revision, a deleted card, or a non-card html keeps the plain chip instead of borrowing the current card's title.

### Console chat unread tracking

Opening a thread snaps to its first unread message with a divider, and the unread badge plus the
bar notification drain by SCROLL POSITION rather than by the act of opening - reaching a message's
bottom edge is what marks it read. Full design + three audit rounds are in git (`plans/` history);
a cross-device sync follow-on is scoped but unbuilt.

- **The read anchor** (`ChatRepository.kt`): a per-team `ReadAnchor(epoch, seq, at)` - the mailbox
  journal coordinate a device has read up to, persisted via `AppStateStore.saveReadAnchors`/
  `loadReadAnchors`. Mailbox epochs are random per instance and never ordered (`device-mailbox.ts`),
  so an anchor is resolved to its row by (epoch, seq) EQUALITY only (`anchorIndex`); unread is a
  pure positional count of inbound rows after that index (`unreadCount`, `unreadRows`,
  `firstUnreadId`). Every writer - `append`, `appendInbound`, `markRead`, `readUpTo`, `forget` -
  converges on the same `recomputeUnread` derivation inside its own `_state` update, so the count
  can never drift from the anchor. A missing anchor entry counts everything (a new team badges its
  first message immediately); the one-shot `loadPersistedReadAnchors` migration seeds every
  pre-existing thread's anchor at its tail on first run after this model shipped, so the update
  itself never resurrects old messages as unread.
- **The read pointer** (`thread.js`): IntersectionObserver cannot fire at "a row's bottom edge
  enters the viewport" (it only fires at threshold crossings, and the final on-screen rows never
  exit), so reads are driven by walking a monotonic `region`/`pointerIdx` pointer against live
  `getBoundingClientRect()` layout on every plausible event - scroll-settle, resize, append, and
  PIN RELEASE (the moment a programmatic scroll's 200ms settle window closes, which is also the
  "read check once after the open snap" moment, timed so `content-visibility` relevancy has
  updated). `region` seeds ONLY from rows at-or-after the unread boundary (never historicals - an
  earlier bug mixed them in and inverted walk order); Kotlin's `revealFirstUnread` union-merges a
  fresh region on every open. Suppression: no walk while a pin is settling, and the walk itself
  (not just the bridge report) is suppressed while the app is backgrounded - `arrivedVisible`
  (a transient, never-persisted `Message` field) tags each row at drain time, with a
  `resumeBacklogPending` correction in `ChatRepository.onForeground()` so the away-backlog a resume
  drains is never mistaken for something the user watched arrive. The boundary check itself carries
  a small `BOTTOM_EDGE_SLOP_PX` tolerance - `scrollIntoView`'s bottom-alignment leaves a sub-pixel
  rounding residue (confirmed on-device: a row's bottom edge landing ~0.66px past `innerHeight`), and
  a strict comparison let that residue permanently block the read pointer on the LAST row of a
  transcript - it could only ever clear once later content pushed it up, never by just being viewed.
- **The "New messages" divider** (`thread.js`): a trailing bookmark, not a one-shot reveal. It sits
  directly above the current boundary row - the next still-unread row while one remains, else the
  LAST row `region` ever tracked this visit once caught up - so it persists as a "read up to here
  this visit" marker instead of vanishing the instant you finish reading; only a genuine reopen with
  nothing unread (`revealFirstUnread`/`setMessages`, gated by the Kotlin-side anchor being fully
  advanced) removes it. Anchoring to a real row rather than "the last DOM child" matters: an early
  version parked it AFTER the last row, which stranded it above a same-session own-send (nothing else
  ever re-anchors past a non-counting append) and relocated visibly on every live batch; anchoring
  BEFORE the boundary row instead sidesteps both, since a later append can never land between the
  divider and the row it marks.
- **Kotlin<->JS wiring** (`ThreadRenderer.kt`, `ThreadRendererPool.kt`, `MainActivity.kt`): the
  `Android.readUpTo(id, at)` bridge posts to main and is forwarded team-bound through the pool
  (matching `onAttachmentTap`/`onPlayTap`'s existing pattern). Opening a thread is a separate
  Compose effect from ongoing message sync, keyed on an `openNonce` counter bumped by every genuine
  open gesture (notification tap, board tap, a tab switch onto a different thread) - `openNonce`,
  not the ambient "current" team, is what a reveal computes against, since the flush-then-reveal
  round trip is async and can resolve after the user has navigated elsewhere.
- **Notification reconciler** (`SwitchboardService.kt`): `reconcileTeamNotifications` replaces the
  old clear-on-open behavior. It is LEVEL-based against `NotificationManager.activeNotifications`
  (never a remembered prior emission, so a process restart's first pass converges cleanly): a
  team's bar entry cancels once its count reaches 0, silently refreshes while draining
  (`setOnlyAlertOnce`), and is left alone entirely if not currently showing (a muted or
  visible-arrival team can never gain a phantom entry). `Forget` and Close-Tab muting are both
  honored explicitly, since forget drops a team from the map this reconciler iterates.

### Idle pushback (console background poll cadence)

The console's background poll cadence backs off the longer it stays silent, instead of polling at
a flat interval forever. `IdlePushbackManager` (`android/.../IdlePushbackManager.kt`) decides the
wait after every poll pass: FOREGROUND/MINUTE (visible, or backgrounded under 10 minutes silent)
behave like the fast cadence with the service's wakelock held; HALF_HOUR/HOURLY/TWELVE_HOUR
release the wakelock and schedule a wall-clock-aligned `AlarmManager` wakeup instead (`:00`/`:30`,
the top of the hour, or 8am/8pm local), driven through `SwitchboardService`'s `DeepIdleScheduler`
implementation and `PollAlarmReceiver` (the alarm target, including dead-process revival). Any
genuinely-fresh mailbox entry resets the ladder back to MINUTE. The silence clock persists across
restarts via `AppStateStore`'s `IdleSilenceStore` conformance, so a reboot resumes the tier it
earned rather than re-climbing from scratch. Full design, the questionaire, and three audit rounds
(plan alignment, an adversarial red team, and a framework-first pass) are in
`plans/idle-pushback-manager.md`.

### Composer drafts (Android)

The pending outgoing message for a thread is ONE stored value: `Draft(text, files)` in
`ChatState.drafts`, keyed by team. Files are already-copied `MessageFile` refs, not live picker
grants, so a draft outlives both the grant and the process - attachments now survive a restart the
way text always did, and `sweepOrphanAttachments` counts an open draft's files as referenced.
Commands (`setDraftText`, `addDraftFiles`, `removeDraftFile`, `appendDraftText`, `clearDraft`) live
on `ChatRepository`; the composer renders from the store rather than holding its own state, which is
what keeps picked files from following a tab switch into the wrong session.

`takeBackIntoDraft` is the single write path for handing a not-yet-sent message back to the
composer, used by both the failed-row Cancel and the scheduled-send dock's cancel-for-edit. Files
always UNION and text lands only on a blank draft: a file list has a meaningful merge so no caller
can drop a pick, while text has none so anything already typed wins. Destroying composer contents is
therefore not expressible at a call site, and `Draft.isOccupied` is the one definition of "the
composer holds something" behind the Send button, the failed row's Cancel (mirrored into the
WebView via `ThreadRenderer.setComposerOccupied`), and the dock's X.

### Scheduled Send (Android, client-local)

Long-press the console's send button (`Schedule Send` / `Send`) to bank a message for a future
wall-clock time instead of sending it live - purely client-local, no gateway involvement or wire
shape. `ChatRepository.scheduleSend()`/`rescheduleSend()`/`cancelScheduledSend()` bank at most one
`ScheduledSend` per team in `ChatState.scheduledSends` (mirrors the `Draft` storage pattern: plain
SharedPreferences JSON, no special re-provisioning survival), eagerly copying any picked attachment
into its own bucket at schedule time. Cancelling for edit hands the record back through
`takeBackIntoDraft` (see Composer drafts below) rather than restoring it itself. A single shared `AlarmManager` alarm always targets the
earliest pending record (`ScheduledSendAlarmReceiver`, armed through `SwitchboardService`'s
`ScheduledSendAlarmScheduler` implementation); firing funnels through the mutex-guarded
`ChatRepository.fireDueScheduledSends()`/`fireOne()` from both the cold-boot chain and the
receiver's warm kick, so a warm kick can never double-convert the same due record. A failed fire
gets one bounded retry (`kickScheduledSendRetry`, resolved by `opId` never by the volatile row id)
then a dedicated, per-team-hashed failure notification (`SwitchboardService.
notifyScheduledSendFailed`/`scheduledSendFailedNotificationId`) so an unattended failure is never
silent. `ClockChangeReceiver` defensively re-syncs the alarm on a system clock or timezone change
(`RTC_WAKEUP` is wall-clock based). Full design, the questionaire, and three audit rounds (plan
alignment, an adversarial red team, and a framework-first pass) are in `plans/scheduled-send.md`,
which also carries the durable send/respond idempotency layer this feature's own audit motivated
(see Console Bridge above).

Use the local Android toolchain (see "Verify locally before pushing" below) to actually build and
verify changes rather than reasoning from memory alone - an emulator AVD may already be booted
(`adb devices` to check), and `adb install -r` + a real launch is worth doing for anything
UI-facing. A running gateway + an existing (possibly expired) provisioning blob may also be
reachable locally; check `curl localhost:20000/health` and
`~/.config/switchboard/console-provisioning.json` before assuming a from-scratch backend is needed.

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

### Pull before every follow-up edit after a push

`gitPushNewBranch` moves the commits to a branch and resets local `main` to `origin/main` while the
PR is still merging, so for a minute or two the working tree does NOT contain the work just pushed.
Editing in that window silently applies to a tree missing the feature: a scripted search-and-replace
finds nothing and reports success, and the follow-up commit lands without the change it was meant to
build on. This is not hypothetical - it happened three times in one session, and once it handed a
stale tree to an audit that then reported already-fixed code as broken.

After any push, run `gitFetch` then `gitPull` before touching a file. Treat a non-empty
`git log main..origin/main` as a hard stop rather than a warning. When scripting an edit, assert the
match before writing; a replace that silently no-ops is the failure mode this hazard produces.

### Verify locally before pushing (especially Android)

Develop and verify locally before every push. For TypeScript that is `bun run lint && bun run test`. For Android it means an ACTUAL local build, because `ci.yml` does NOT compile or test the Kotlin: it only runs the TS lint/test plus the codegen + stts drift checks. The Kotlin builds solely in `main-push.yml`, which runs on push to `main` AFTER the merge. So a Kotlin compile error or a failing Android unit test lands on `main` before any gate catches it, surfacing only as a red release build.

Text and grep sweeps cannot see this. During the Gateway rename an over-matched Compose `Switch` widget (renamed to a non-existent `Gateway`), a mangled verb (`switches` became `gatewayes`), and a stale cross-platform admission vector all passed every grep and the full TS suite, then broke `compileDebugKotlin` and an Android unit test on `main`. Twice.

The host has a JDK and SDK, so run the Android build before pushing anything under `android/`:

```bash
cd android
JAVA_HOME=/home/nyaarium/android-dev/jdk ANDROID_HOME=/home/nyaarium/android-dev/sdk \
  ./gradlew :app:testDebugUnitTest --console=plain
```

Equivalently, `source ~/android-dev/env.sh` once to put `java`/`adb`/`emulator`/`gradlew` on `PATH`
for the rest of the shell session, then just `./gradlew :app:testDebugUnitTest`. The same toolchain
also has an AVD available for on-device verification beyond the unit-test gate (`adb devices` to
check if one is already booted) - useful for anything UI-facing: `assembleDebug`, `adb install -r`,
and a real launch/interaction catch classes of bug a compile+unit-test pass alone cannot (a Compose
runtime crash, a manifest/receiver registration mistake, an actual clock-change or config-change
broadcast firing correctly - all things worth simulating for real rather than reasoning about from
the API docs alone).

`testDebugUnitTest` compiles the Kotlin and runs the unit tests (the golden-fixture decoders, the SessionId and admission cross-platform vectors). Treat a green run as the Kotlin gate, the same way `bun run lint && bun run test` is the TypeScript gate. For a wire-shape change, regenerate `proto/Protocol.kt` with `bun scripts/codegen-kotlin.ts` first, then run the Android build so the new types are exercised.

The sibling **evie-bot** repo (the synced leaves + the evie-side bridge code) has its own gate: `bun run lint && bun run test`. Both repos define `lint` identically as `biome ci . && bunx tsc --noEmit`, so it covers formatting, lints, AND types in one command. evie's `bun run test` runs BOTH its suites - vitest (`*.test.ts`) plus the bun-runtime bridge tests (`*.bun.test.ts`) - chained, so run it INSIDE evie's devcontainer: the host node (18) is too old for vitest 4 (it needs node 20.12+ for `util.styleText`), so the vitest half only passes in the container. Use `./devcontainer-up.sh` then `devcontainer exec --workspace-folder . bash -lc 'bun run lint && bun run test'` (lint also runs fine on the host; only the vitest half needs the container). evie's `Push (main)` workflow gates its Build & Deploy jobs behind the Lint job, so an unlinted change still merges but SKIPS the rollout (the pod never redeploys). After editing a synced leaf, run the evie gate too, not just switchboard's.

Both variants R8-minify (`isMinifyEnabled` + `isShrinkResources` on release AND debug, to tree-shake `material-icons-extended` down to the icons actually used). `testDebugUnitTest` runs UN-minified, so it does NOT catch an R8 strip: a minify break (a renamed `@Serializable` wire class, a dropped JS-bridge method) only shows at `assembleDebug`/`assembleRelease` or on-device. The minify gate is `./gradlew :app:assembleRelease` plus an on-device wire round-trip (register/poll/seal). Keep-rules live in `app/proguard-rules.pro`: the `@JavascriptInterface` keep is load-bearing (the thread WebView bridge, which the AGP default misses because the bridge is an anonymous object, not a WebView subclass); the kotlinx-serialization block is documented as belt-and-suspenders over the artifact's shipped consumer rules.

### Dependencies

Manifests use EXACT version pins, no ranges. The plugin launches via `bun run` (.mcp.json); it uses the installed node_modules and auto-installs only missing deps on demand. The old `--install=force` flag, which forced a full dependency reinstall on every launch, was removed because that reinstall breaks on Windows (file locking on in-use node_modules). Exact pins still matter because a caret range would let any plugin start pull a brand-new release. Dependabot (daily, 7-day cooldown) is the updater; the cooldown gives security audits time to flag a vulnerable release before we take it. The `overrides` block pins transitives with known advisories. After any manifest change, finish with `rm -rf node_modules && bun install --frozen-lockfile`, then run `scripts/check-module-residue.ts` - bun never prunes nested node_modules dirs the lock stopped sanctioning, and a stale nested copy silently shadows the pinned version for both tsc and runtime.

### Synced schema modules

Several leaf modules in `src/shared/` are the source of truth for a wire shape shared with a sibling repo, and are copied VERBATIM (manual `cp`). Each file's header carries the source path, the copy command, and a `// SYNC-HASH:` of its body. After editing a source, use `sync-leaf.ts` - it formats, restamps, and copies in ONE atomic step (reading the target from the leaf's own header):

```
bun scripts/sync-leaf.ts src/shared/notice.ts   # format -> restamp -> cp, all at once
bun scripts/sync-leaf.ts --all                   # re-sync every leaf
```

FOOTGUN (why the script exists): the manual order is format -> restamp -> cp. If you `cp` and THEN run `bun run lint:fix`, biome reformats the SOURCE, so the stamp + the copy go stale and the sibling repo's CI fails on a hash mismatch. `sync-leaf.ts` runs the biome pass FIRST so a later `lint:fix` is a no-op. The manual equivalent (run lint:fix BEFORE these two, never after):

```
bun scripts/check-sync-hash.ts --write src/shared/notice.ts
cp src/shared/notice.ts ../nyaaskills/src/shared/notice.ts
```

- `src/shared/notice.ts` -> `nyaaskills/src/shared/notice.ts`
- `src/shared/evie-protocol.ts` -> `evie-bot/app/features/bridge/evie-protocol.ts`
- `src/shared/crypto.ts` -> `evie-bot/app/features/bridge/crypto.ts` (the federation seal/sign core)
- `src/shared/admission.ts` -> `evie-bot/app/features/bridge/admission.ts` (the trust model + registration proof; imports `./crypto.js`)
- `src/shared/federation-lifecycle.ts` -> `evie-bot/app/features/bridge/federation-lifecycle.ts` (the QR payloads + enroll ops; imports `./admission.js` + `./crypto.js`)

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
- `HOST_WS_TOKEN` - Shared secret the host daemon presents to claim the reserved `host` WS slot (which drives the console terminal view). Auto-provisioned into `.env` by `start-gateway.sh`. Fail-closed: a host-slot registration is refused unless the gateway has this set AND the daemon presents the matching token, so a LAN peer cannot squat the slot. See Console terminal view above.
- `EVIE_NAMESPACE` - K8s namespace (default: evie-bot)
- `FEDERATION_DOMAIN_ID` - This Gateway's Domain id, the admin box's OWN-Domain record (written by Provision, read back by re-provision + the purges). It is NOT fail-closed: when unset (and no enrollment-delivered `domain-id` file is present) the gateway boots standalone in arming mode and opens its `/enroll` listener; a Domain id is needed only to connect to evie. The enrollment-delivered `domain-id` file takes precedence over this env. A friend's enrolled gateway has no env value and gets its Domain id from the delivered bundle.
- `DATA_DIR` - Where the Gateway persists ALL durable state (federation keypair, pending-jobs, mailboxes, replay-guard, the session-resume map), deliberately SEPARATE from the debug-log volume so clearing logs can never wipe federation identity (default: `/app/data`, mounted from `./volumes/gateway-data`). A one-time boot migration copies legacy state from the log dir.
- `FEDERATION_DIR` - Where this Gateway persists its keypair + mirrored allowlist + the enrollment-delivered transport.json + domain-id (default: a `federation` dir inside `DATA_DIR`)

The gateway is trust-on-first-enroll: the first owner-signed snapshot roots it, and a later snapshot rooted at a different owner key is ignored (the re-root guard in `Allowlist.applySnapshot`). The gateway has no owner-key pin. evie-bot's `BridgeService.adminSignPub()` reads `FEDERATION_OWNER_SIGN_PUB` for an optional admin-op pin, but it is unset in the pod and dormant.

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
- **Fetch the console's live log** (the only path into the firewalled K8s is evie's stdout). The gateway container no longer holds a kubeconfig (the admin kubeconfig is cleared after provisioning), so read it host-side with the evie-bot repo's kubeconfig:

```bash
KUBECONFIG=~/projects/evie-bot/kubeconfig.yaml kubectl -n evie-bot \
  logs deploy/evie-bot-deployment --tail=200 | grep '\[console-ingest\]'
```

- `DebugLog.kt` already traces the enroll scan flow and the poll/drain flow: `[Poll]` (per cycle: entry count, epoch, cursor) and `[Drain]` (per mailbox entry: kind, session id, resolved thread, OR the drop reason - `DROPPED (unresolvable team)` / `SKIPPED (no body)` / threaded). To instrument a new area, add `DebugLog.log("<Tag>", "<msg>")`. The build writes no on-device file (debug streams to `/ingest`, release is logcat-only); startup also sweeps any `switchboard-debug.log` an older build spilled to Downloads.
- **A `DebugLog.log` line is never private:** it ships off-device to evie stdout and stays on logcat, so a message must never embed a bearer credential, one-time invite nonce, or other minted secret - only opaque ids, HTTP codes, and non-secret op/result fields. `ConsoleClient.kt`'s `postEvieDirect` is the worked example: every evie-direct call site states a `logBody` posture explicitly (no default), and `loggedBodyPreview` is the one place a response body ever reaches a log line.
- Smoke-test the ingest loop end to end (proves stdout fetch works) by POSTing through the service-proxy with the real bridge creds (`~/.config/switchboard/console-provisioning.json`: `apiUrl`/`saToken`/`caPem`/`appToken`): `POST ${apiUrl}/api/v1/namespaces/evie-bot/services/evie-console-bridge:20004/proxy/ingest`, headers `Authorization: Bearer <saToken>` + `X-Console-Bridge-Token: Bearer <appToken>`, body `{"conversationId":"smoketest","lines":["..."]}`; then grep evie stdout for `[console-ingest]`.

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

Layers on top of the console-bridge deploy. The gateway<->evie WS is admission-only: it rests on the k8s service-proxy SA token + RBAC plus the owner-signed admission at `gateway_register`, with no bearer fallback.

1. **Grant evie its Secret** (one-time RBAC): `kubectl apply -f evie-bot/deploy/federation-rbac.yaml`. It binds get/update/patch on the `evie-federation` Secret to evie's pod ServiceAccount (edit the subject if evie does not run as `default`), plus a `get`-only rule on the `gateway-bridge-proxy-token` Secret so evie's `transport` endpoint can read the gateway-bridge creds it serves. Re-apply it after a transport-endpoint change so the new rule lands. On next boot evie mints + persists its keypair there and logs its SAS fingerprint.
2. **Domain id**: not fail-closed. A gateway with no Domain id boots standalone in arming mode and opens its `/enroll` listener; it connects to evie only once both a Domain id and a `transport.json` resolve. The admin's Domain id is minted and written to the gateway `.env` (as `FEDERATION_DOMAIN_ID`) by `setup.sh` Provision; a creds-less secondary gateway gets its Domain id from the sealed bootstrap bundle (the bundle carries `domainId`) and records it to its `domain-id` file, so no hand-set env is needed.
3. **Run `./setup.sh`** and use the menu. `2) Evie Admin Provision` does the cluster cutover then the fresh-vs-reprovision state machine: there is NO owner-key paste (the owner root key is generated silently on the phone). A FRESH setup STAGES A PENDING admin Domain (no host-side rooting), PROMPTS for the display name (you type "Nyaarium"), applies the console-bridge + gateway-bridge cutover, restarts evie, then emits a TRANSPORT-ONLY provisioning blob to `~/.config/switchboard/console-provisioning.json` (0600; the CONSOLE-bridge SA creds only, NOT the gateway-bridge transport) carrying a `pendingTenant{domainId, nonce}`. On scan the phone reads `pendingTenant` off the blob, self-signs a `FIRST_ROOT_V1` with its silent owner key, and first-roots the Domain EVIE-DIRECT (see Friend onboarding above). The Console then generates its OWN member identity, owner-signs a `kind:console` admission, and submits it to evie. `1) Setup Gateway` arms this machine's gateway, shows its admit payload (QR or pasted JSON), waits for the phone's sealed bundle, and connects to evie in-process (no restart); the Console owner-admits the Gateway and seals it the gateway-bridge transport (pulled from evie) plus the network `domainId` in the bundle. The Gateway id is read authoritatively from the container's `GATEWAY_ID` env (run through `sanitizeGatewayId`), never from `docker logs`. Credential posture: the blob is a durable, host-local 0600 file carrying the cluster SA token only (NO identity, no private keys). RE-PROVISIONING an already-rooted admin Domain skips staging and re-emits the blob only (no re-root). The gateway is trust-on-first-enroll (the first owner-signed snapshot roots it; a later snapshot rooted at a different owner is ignored).
4. **Registration gate**: evie gates every `gateway_register` on the owner-signed admission, so a Gateway with no admission is rejected; a fresh Gateway must be enrolled (Setup Gateway delivers the sealed bootstrap bundle) before it can register.

Per-user purges: `9) Purge Gateway` drops only this gateway's admission from evie's Domain (`removeGatewayAdmission`) then erases the local `.env` + `volumes/gateway`. `0) Purge Federation` drops only the running user's whole Domain slice from evie (`removeDomain` - other tenants, including their cross-Domain link edges, survive), then does the full local wipe (`.env` + `volumes/gateway`) and removes the host blob under `~/.config/switchboard`. Re-run `./setup.sh` afterward. A redeem / snapshot for a different owner is refused by design, so there is no silent takeover.
