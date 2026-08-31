# Agents

Cross-team communication and devcontainer coordination. This file is a map, not history.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` / `main-federation.ts` - four entry points
- `src/gateway/` - Docker-side HTTP and WS router
- `src/gateway/wake.ts` - container/session wake decisions
- `src/gateway/sessionAuthority.ts` - sole owner of credential-field access; residue-tested
- `src/gateway/presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - presence, read anchors, host RPC correlation
- `src/gateway/boardStore.ts` - durable owner task board
- `src/gateway/boardAuthority.ts` - board write authority, refusals, and sole `refused: ` producer
- `src/gateway/boardAwareness.ts` / `boardCascade.ts` - board awareness and parent-child state rules
- `src/gateway/awarenessBank.ts` - subscriber state, deadlines, and liveness reads
- `src/gateway/daemonCapabilities.ts` - daemon capability answer
- `src/gateway/codexAgentService.ts` / `codexRelay.ts` / `codexRoute.ts` - Codex catalog, relay folding, authenticated route
- `src/gateway/router/` - Router WS client; `pinnedSocket.ts` owns certificate pinning
- `src/gateway/console/` - Android channel, op dispatch, capability store, relay, durable ops
- `android/.../ChatRepository.kt` - console process singleton and repository facade
- `android/.../Message.kt` / `MessageFile.kt` / `MessageText.kt` / `Draft.kt` / `ThreadOps.kt` / `ReadAnchor.kt` / `ChatState.kt` / `ConnError.kt` / `FederationTypes.kt` / `ScheduledSend.kt` - repository value types and pure helpers
- `android/.../ChatPersistence.kt` - JSON codec between repository state and AppStateStore
- `android/.../PollDrain.kt` - poll loop, mailbox drain, four plane cursors, drain-gate subscribers
- `android/.../PlaybackOps.kt` / `PlaybackReadModels.kt` - playback serialization and lock-free read models
- `android/.../BoardOps.kt` - repository board operations
- `android/.../AttachmentOps.kt` - attachment fetch-and-sweep state
- `android/.../ScheduledSendOps.kt` - scheduled sends and single fire mutex
- `android/.../GoalOps.kt` / `Goal.kt` - armed goals and `/goal` line production
- `android/.../PresenceOps.kt` - team presence and read-anchor reporting
- `android/.../SessionOps.kt` - terminal and session controls
- `android/.../ChatRepositorySend.kt` / `ChatRepositoryThreads.kt` / `ChatRepositoryDomainLink.kt` / `ChatRepositoryStts.kt` / `ChatRepositoryDrafts.kt` - stateless repository extensions
- `android/.../RouterReach.kt` / `ConsoleRelayTransport.kt` - Router addresses, ordering, and failover
- `android/.../OwnerFacts.kt` / `GatewayEnrollment.kt` / `EnrollCeremonyOps.kt` / `DeviceApprovalOps.kt` / `DomainAdminOps.kt` / `TrustOps.kt` - federation delegates
- `android/.../SasExchange.kt` / `EnrollCeremony.kt` - shared SAS exchange and commitment core for FLOW-1 and FLOW-2
- `android/.../MainActivity.kt` - `Repo`, activity, and `App` navigation shell
- `android/.../SessionsScreen.kt` / `SettingsScreen.kt` / `ThreadScreen.kt` / `Onboarding.kt` / `SessionDialogs.kt` / `ReorderableTabRow.kt` / `TabDragMath.kt` / `TimeText.kt` - screen siblings and tab geometry
- `android/.../RendererPoolBindings.kt` / `AppOverlays.kt` / `LinkMenu.kt` - WebView pool, overlays, and link actions
- `android/.../SettingsSections.kt` / `SettingsSystem.kt` / `SettingsVoice.kt` - settings leaf screens
- `android/.../MainTabsScreen.kt` / `SessionsHeaders.kt` / `SessionCard.kt` / `SessionCardPreview.kt` / `SessionsEmptyState.kt` - sessions tab shell, cards, rules, and empty-state machine
- `android/.../board/` - board reducers and durable `BoardManager`
- `android/.../federation/` - cross-Gateway routing, identity, allowlist, sealing, replay, and presence
- `src/mcp/` - Claude Code tools
- `src/mcp/bridge/` / `channel/` / `references/` / `board/` / `designer/` / `connector/` - bridge, channel, reference, board, designer, and connector tools
- `src/mcp/devcontainer/` - host daemon plumbing and per-session tools
- `src/mcp/devcontainer/hostResolve.ts` - pure host/workdir/watch-target resolution and tmux command construction
- `src/mcp/devcontainer/windowsSpawn.ts` - Windows PowerShell probing, WSL path translation, and native directory listing
- `src/mcp/devcontainer/codexTargets.ts` - one supervised Codex App Server per execution target
- `src/mcp/devcontainer/codexAppServer.ts` - JSONL transport and fail-closed App Server client
- `src/mcp/devcontainer/codexThreadLifecycle.ts` - per-thread queues, settled-turn archival, bounded retirement
- `src/mcp/devcontainer/codexTurnTracker.ts` - turn output; sole `answerOf` reader
- `src/mcp/devcontainer/codexLiveTurns.ts` - live-turn bindings, clocks, and warnings
- `src/mcp/devcontainer/agentDaemonCore.ts` - shared daemon registry, generation fence, serialization, numbering, and outbox
- `src/mcp/devcontainer/codexDaemonService.ts` / `copilotDaemonService.ts` - daemon relay services
- `src/mcp/local/` - daemonless agent backend
- `src/mcp/agentDispatch.ts` - agent tool serving seam
- `src/mcp/codex/codexTools.ts` - five Codex tools and per-invocation replay ids
- `src/mcp/capabilities.ts` / `capabilitiesTool.ts` - capability gating and guidance
- `src/federation-server/` - live self-hosted federation Router
- `src/federation-server/routerServer.ts` - guarded `route()` seam and sole `serve()` adapter; residue-tested
- `src/federation-server/fileSecretStore.ts` - durable federation state and bounded atomic CAS
- `src/federation-server/gatewayBridge.ts` / `gatewayTransport.ts` - registration and relay routing; four trust callbacks required
- `src/federation-server/consoleSurface.ts` / `publicApproval.ts` - token-gated operations and token-exempt nonce routes
- `src/federation-server/routerTls.ts` - persistent self-signed certificate; rotation re-provisions clients
- `src/federation-server/*Coordinator.ts` - in-memory flow windows; restart loses and re-arms them
- `src/shared/agent-binary.ts` - uncached backend CLI presence check
- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, and bundle folding
- `src/shared/schemas.ts` / `schemas*.ts` - sole Zod wire truth; `.meta({id})` names generated Kotlin classes
- `src/shared/codex-agent.ts` / `codexAgent*.ts` - Codex delegation wire truth; excluded from Kotlin codegen
- `src/shared/channel-file.ts` - declared ChannelFile metadata; receivers do not infer it from bytes or position
- `src/shared/session-id.ts` - sole address grammar owner
- `src/shared/host-spawn.ts` - sole host-shell spawn-segment and command owner
- `src/shared/crypto.ts` / `admission.ts` / `router-protocol.ts` / `federation-lifecycle.ts` - federation trust wire vocabulary
- `src/shared/notice.ts` - shared notice tiers
- `src/shared/atomic-write.ts` - sole write-then-rename and temp-suffix owner; residue-tested
- `src/shared/durable-store.ts` - atomic snapshots and per-file quarantine boundaries
- `src/shared/session-store.ts` - authoritative gateway sessions keyed by `spawn.id`
- `src/shared/session-sanitize.ts` / `session-tokens.ts` - normalization, session ids, and bind tokens
- `src/shared/board-attachment-store.ts` - path-asserted board attachment ownership; no sweeping
- `src/shared/board-rank.ts` - sibling ordering and asserted fractional ranks
- `src/shared/agent-screen.ts` / `pane-trim.ts` - pure tmux-pane reads with Kotlin twins and shared fixtures
  - **A rule is a RUN, not a LINE, and `afterRuleRun` is the sole owner of that.** `-J` welds rows; Windows-hosted panes weld composer rules to adjacent rows. All readers use `footerRegion`; residue-tested.
  - **Two rule notions, not interchangeable.** `TOOLBAR_RUN_RE` is U+2500 only; `ANY_RULE_RUN_RE` spans U+2500-U+259F.
  - **`limitNotice` searches in TWO passes and the order is load-bearing.** Whole-line matches precede welded-rule matches.
  - **The composer glyph is a two-member class.** Linux uses U+276F; Windows uses U+003E. Whitespace is explicit because JS and JVM `\s` differ for U+00A0.
  - **The last-two-lines fallback is uniform.** Every reader scopes this fallback to the final region.
- `src/shared/device-mailbox.ts` / `pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` / `process-guards.ts` - shared mailbox, jobs, planes, reconnect, and process guards
- `android/` - Gradle/Kotlin console app; `proto/Protocol.kt` generated
- `scripts/` - build, Kotlin codegen, leaf sync, setup, federation start, residue checks, and voice import
- `scripts/lib/routerStart.ts` - sole Router `.env` and startup owner
- `tests/fixtures/` - shared golden wire and signing fixtures; manifests drive both runtimes
- `skills/crosstalk/SKILL.md` - agent-facing tool reference

## Architecture

**`main-mcp.ts`** MCP plugin, user process.
**`main-gateway.ts`** Docker gateway and central router.
**`main-host-daemon.ts`** host `host` WS slot, devcontainer wake, session spawn, terminal view.
**`main-federation.ts`** self-hosted federation relay.

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |
| 20003 | Enrollment TLS, one-time nonce |

### Addressing

**`shared/session-id.ts`** owns session/team key production, separators, slug validation, `Address`, `SpawnPoint`, and target parsing. Kotlin mirrors it through the shared fixture vectors.

A bare project is a spawn point by catalog membership, not by dot detection. `my.app` may still be a project. Sending to a spawn point without a session fails.

### Host spawn points

A host spawn point is a named shell, not a session. `host` is bash; `windows` is PowerShell over WSL. Both produce ordinary host tmux sessions.

**`isHostSpawn` and `host-spawn.ts`** own host-spawn classification. `host-spawn-residue.test.ts` rejects new classification sites.

**`kind`** identifies tmux location, not interpreter. Windows sessions still use WSL tmux.

**Discovery**: absent `HostSpawnState` means unknown, never no spawn points. Host spawn points are discovery metadata, not presence rows, and `/discover` strips them. Unreachable gateways contribute no spawn-point offer.

**Windows launch facts**: use `claude.exe`, append to `WSLENV`, encode `-EncodedCommand` as UTF-16LE base64, and always use `Set-Location`. `pwsh.exe` is not assumed available.

Windows workdir paths use forward slashes. UNC paths are rejected. Browsing uses native `Get-ChildItem`, not Linux `/mnt` paths.

`hostWorkdirHint` falls back to the session label. A label is not necessarily a path and must not be passed to `wslpath`.

### Sessions and wake

Devcontainer sessions are loose `project.session` peers. The daemon sets `PROJECT_NAME` to the composite name before launch.

The host is another spawn point and uses the same create, resume, and forget path. Its default workdir is `~/projects/<label>`.

**`host-daemon`** is reserved and must never be dispatched or registered as a session. Residue tests enforce this at the sinks.

### Session identity binding

A bind token is delivered only through the daemon launch command and presented at registration and on HTTP requests. Same-project panes remain mutually impersonable by OS construction.

**`sessionAuthority.ts`** owns binding resolution. `toClaim` is name-keyed and ignores undelivered reattach tokens; `toAnswerFor` is socket-keyed and follows the registered incarnation; `toActFor` composes live-first with record fallback.

`UNBOUND` is an explicit resolver value. A missing or unparseable subject must not become an accidental permit.

### Self-hosted Router

`src/federation-server/` replaces evie's relay with the same wire protocol. Three surfaces share one TLS port: bearer-gated gateway WS, app-token-gated console ops, and token-exempt device approval for fresh devices.

The Router certificate is minted once. Rotation requires re-provisioning every enrolled Gateway and phone. It is distinct from the ephemeral certificate used by the 20003 enrollment listener.

**Reach: one Router, several addresses.** Home routers may not hairpin LAN-to-public connections. The Router advertises `{publicHost, publicPort?, lanAddresses}` through the app-token-gated `reach` op. The phone stores this in `reach.json` and tries LAN addresses, public host, then bootstrap address.

**The GATEWAY shares ordering, not failover behavior.** The phone fails over per operation. The Gateway fails over per reconnect and advances only when a socket never opened.

- Gateway registration cannot call `reach`: it has a WS bearer, not the console app token. It receives optional reach data in `gateway_register`.
- `FEDERATION_ROUTER_HOST` overrides the sealed bundle address for Gateway setup.
- LAN uses the Router port. Public uses `publicPort`; absent means the Router port.
- A private candidate uses `LAN_CONNECT_TIMEOUT_MS`.
- The typed address remains last. There is no last-successful-address field.
- `reach.json` stays beside `transport.json`; delivered transport bytes remain stable while learned reach data changes.
- Reach is not exposed on `/health`.
- Failover follows thrown `IOException`, not HTTP status.
- Debug ingest uses the transport's current base after reach changes.

### Pinning the Router

The Router leaf is self-signed. Its fingerprint is its identity. `gateway/router/pinnedSocket.ts` owns the check.

- **Pin before the WS upgrade.** The bearer must not be sent before the TLS leaf matches.
- **Resolve the real `ws` package.** Bun's bare `ws` substitution lacks peer-certificate access and ignores `createConnection`.
- Preserve `match`, `mismatch`, `unreadable`, and `pending` as separate verdicts.
- Chain verification stays off. The fingerprint replaces certificate-chain and hostname verification for this self-signed leaf.
- Bun 1.4+ is an observed floor enforced by `assertBunFloor`; `check-pinning-runtime.ts` verifies the runtime behavior. Node uses the real `ws` package.
- `moduleDir()` must use `fileURLToPath()`, not URL pathname conversion.

### Federation and trust

The Router routes opaque sealed payloads by `dstGateway` and `relayId`. It cannot read or forge E2E payloads. Presence discovery is local merging of `list_teams` responses.

The owner device is the trust root. Owner-signed admissions are mirrored on the Router and every Gateway, so revocation still applies while the Router is unreachable.

- **Crypto:** Ed25519 signing, X25519 boxes, HKDF-SHA256, and AES-256-GCM. AES-256-GCM is required because Bun lacks ChaCha20.
- **Never sign raw JSON.** Versioned newline-joined encodings are reproduced byte-exactly across Node, Bun, and Android.
- Registration requires keys, an owner-signed admission, and fresh possession proof. No bearer fallback.
- A Gateway without a Domain starts standalone for `/health` and `/enroll`; the bridge activates only when both transport and Domain resolve.
- Enrollment roots the first owner key through a single atomic CAS write. The owner root private key never leaves the phone.
- `ReplayGuard` runs after signature verification.
- Trust-on-first-enroll rejects later snapshots rooted at a different owner key.
- Console relay frames are sealed and signed by the enrolled console key; the Gateway checks the owner-signed `kind:console` admission.
- `CONSOLE_BRIDGE_TOKEN` remains the shared app-token gate for the console surface.

**File map.** `src/federation-server/` owns Router surfaces, registration, enrollment, and trust.
**File map.** `src/gateway/router/routerClient.ts` owns Gateway reach failover and Router registration.
**File map.** `src/shared/router-reach.ts` and `android/.../RouterReach.kt` own equivalent candidate ordering.
**File map.** `src/gateway/router/pinnedSocket.ts` owns TLS pinning.
**File map.** `tests/fixtures/router-reach/vectors.json` and pinning tests enforce cross-runtime reach and pinning behavior.
**File map.** `src/shared/crypto.ts` owns federation sealing and signatures.

**A cross-machine answer states how complete it is.** `discover()` returns asked, answered,
unreachable ids and `rosterKnown` beside the rows, so a partial result is not a plain success and an
unreadable roster is not "no peers". `isRegistered` is not `isConnected`: a refused registration
leaves the socket open, which is how a revoked gateway reads as alone. The console holds rows for a
gateway named unreachable rather than sweeping them.

### Versioned state planes

The console poll response carries versioned server-state snapshots. `shared/plane-registry.ts` owns version identity, hash-gated bumps, held polling, and the 60s recovery tripwire.

Planes: **presence**, **linked-peers**, **read-anchors** per owner, and **cross-domain-presence** per linked Domain.

**Wire rule:** flat, hand-named optional fields. Generic maps and decode-side unions do not work because Kotlin codegen cannot type them reliably. Absent known-version means ship nothing. Empty array means ship current truth.

### Console bridge (Android)

Poll-based, keyed by per-install `conversationId`. Device Name is display-only. `ConsolePeer` participates in normal peer registries; its `send()` appends to the mailbox drained by `poll`.

- Mutating ops deduplicate by `(conversationId, opId)`. `send` and `respond` also use `DurableOpStore`, preserving delivery identity across restart.
- Mailbox instances carry an epoch. A stale poll cannot acknowledge a replacement instance. Eviction prefers display-only `"peer"` entries over unread mail.
- `mirrorPeer` is display-only and never applies to console senders or targets.
- Plugin actions use one generic `kind: "plugin_action"` entry. `threadAddr` comes only from the request's `from`.
- `consolePushOps.deliverToOwner` is the sole mailbox writer, enforced by a residue test. `origin: "relay"` is the only non-fanning append, preventing relay loops. Delivery is same-Domain only and deduplicated by `dedupeKey`.

### Console terminal view

Terminal operations reach the host through correlated `host_op` RPCs. `hostOpRunner.ts` owns peek single-flight, cadence and concurrency limits, and mutating-op deduplication.

- `tmuxCore.ts` builds spawn argv without a shell. Exact tmux lookup uses `-t =<name>`; prefix lookup would let `story` select `story-2`.
- `peekWithFallback` returns Docker logs before a pane exists. The result uses flat optional `kind` and `text`; a discriminated union does not work with the Kotlin wire model.
- A fresh wake with no capturable pane is reported as failed, allowing `/send` to fail instead of waiting forever.
- The reserved `host` slot requires `HOST_WS_TOKEN`.

### Armed goals

Long-press **Goal** sends the composed message, then types `/goal <description>` into the session pane. Console-only, using existing `send` and `tmux_send`.

- Waiting for the turn does not work because the message bypasses the composer and the queued line runs after the turn.
- One pasted `/goal` line does not work because the CLI reads the burst as paste rather than a command. Three tmux sends, with Enter separate.
- Injection does not work unless the composer is empty and the pane is ready. A draft or dialog would consume or join the command.
- The live composer is the last prompt row. Earlier prompt rows may represent queued messages.
- Clear the pending record before the first keystroke. A partial sequence can be re-armed; a second injection can submit a duplicated goal.
- `sentAt` gates injection. Never type a goal for a message that did not send.

### Artifact references (`ref://`)

Only `full` on `channel_reply` and `notify_human` scans markdown links. Other fields, crosstalk, code fences, and inline code do not.

**Path:** bare means the project root, `/x` the filesystem root, `~/x` home.

**Chain:** colon-separated scope and name segments. `[n]` selects the nth same-named declaration. `arguments` selects a parameter list; `arguments:name` selects one parameter.

The project root comes from `REFERENCE_ROOT`, the host's first `roots/list` answer, or the server start directory, each resolved to its git toplevel. A plugin-directory cwd falls back to shell `PWD`. Root discovery is bounded by `HOST_ROOTS_TIMEOUT_MS`.

**Text:** `#` searches the chain's declaration, or the whole file without a chain. `#from..to` selects a range. `#text@before:anchor` and `#text@after:anchor` select the nearest occurrence.

Escape spaces and closing parentheses, or use angle brackets. Percent-encode literal `..` and `@after:`.

**Refused, naming the fix:** outside-root chain, missing or ambiguous name, or no matcher result. `exact` requires one hash-verified declaration.

**Degraded to `fuzzy` or `unresolved` with a notice:** only when the lexicon cannot answer because it is absent, incompatible, warming, dead, or refuses the workspace or file.

### Capability union

A session's tools use separate console and daemon capability sources. The MCP reads both before creating `McpServer`; the console source has a 14-day TTL and 500-device cap, while the daemon source has no TTL.

- **`/capabilities` keeps sources separate.** `enabledPlugins` and `daemonCapabilities` are disjoint sections. Absent means no report, empty means affirmative none.
- **Pre-split flat capability responses remain supported** during rollout: the MCP lifts flat answers into `console`; the route serves flat fields beside sections.
- A daemon declaration counts only after the `HOST_WS_TOKEN` gate.
- Offline fallback is the last answer that actually arrived. `GATED_CAPABILITY_IDS` drives both gates; the daemon id is pinned separately.
- **Always-on instructions carry names, not guidance.** `capabilityInstructions` is harness-capped and silently truncates long guidance; `switchboard_capabilities` serves guidance per call.
- That tool answers from the startup snapshot. A fresh read may warn about drift but must not describe tools absent from the session.
- A running session's tools do not change until its next start.

File map:
- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, and source folding.
- `src/gateway/console/capabilityStore.ts` - durable console capability reports.
- `src/gateway/daemonCapabilities.ts` - daemon capability reports.
- `src/mcp/capabilities.ts` / `capabilitiesTool.ts` - startup gating and guidance serving.

### Task board

The owner's board is stored by `gateway/boardStore.ts`; entries use parent pointers and fractional ranks.

- **The store is the sole validator.** `BoardRefusal` replies use the `refused: ` marker, the only client-visible signal that retires a queued edit. `refusalError` is its sole producer; `board-refusal-residue.test.ts` enforces this.
- **A session end is one mutation.** `sessionEnded` applies its required `boardDisposition` to the complete server-side session set, and the reply is authoritative for console reporting.
- The pending queue remains a separate writer. Forgetting a session drops its queued writes and linked deletes; a lane may pass a persistently failing action, but never reorder another write to the same entry ahead of it.
- **`forget` performs its own local-address check.** Its kill path swallows target-resolution errors, so the guard prevents a foreign address from forgetting a colliding local session.
- Invalid ranks must be refused before durable persistence; restore remains tolerant because one poisoned entry must not poison the board.
- Board mutations are absolute and replay through `DurableOpStore`; retrying a lost reply must not reapply an older value over newer state.
- Cascade is opt-in per write. The seed state is not rederived; `orphanedParents` comes from pre/post state for parents whose child disappeared.
- **A board session is `(gatewayId, sessionId)`.** The stored id is Gateway-local; `Team.name` is qualified. `consoleTargets.boardSessionKey` and `BoardManager.sessionKeyOf` are the sole directional converters, and unknown or foreign targets resolve to null.
- A queued console edit retires on refusal only. Absolute writes must not be reordered.
- `mayWrite` is the sole authority predicate for board scope and trash rules; console writes use `OWNER_ACTOR`, route writes use the session actor.
- A truncated projection is an id-sorted prefix. Merging the entire prior cache resurrects deleted entries.
- `BOARD_TRASH_TTL_MS` and `SESSION_RESUME_TTL_MS` are both 30 days but must remain separate constants.

File map:
- `src/gateway/boardStore.ts` - durable board state and owner plane.
- `src/gateway/boardAuthority.ts` - actors, authority, refusals, and refusal marker.
- `src/gateway/boardCascade.ts` - post-write state cascade.
- `src/shared/board-rank.ts` - rank ordering and rank assertions.
- `src/mcp/board/boardTools.ts` - six gated task-board tools.

### Board attachments

Attachment bytes belong to entries in `shared/board-attachment-store.ts`, separate from the evicting blob cache.

- **`board_set_attachments` is the sole field committer.** `upsert` ignores incoming `attachments`.
- The op declares `supplied`; durable or cached members are retained, uploading members cause retry, and unresolved members are dropped and reported.
- Presence checks are durable-first, and every member resolves before any is adopted.
- **All three byte-serving doors use `readBlobRange`:** `answerBlobOp`, the HTTP route, and federation `serveBlobRange`.
- `/task-board` exposes display facts only. Blob ids and gateways travel through the separate attachment fetch action; route-side stripping prevents bearer-token leakage.
- Cross-Gateway moves chain destination upsert, attachment writes, then origin delete. Records are restamped; unavailable local bytes use `fetchFrom`.
- `remove()` reclaims nothing because the destination has not been proven to hold the bytes; leaked per-move directories are accepted.

File map:
- `src/shared/board-attachment-store.ts` - durable per-entry attachment bytes.
- `src/gateway/routes.ts` / `src/gateway/boardStore.ts` - board attachment projection and mutation.
- `src/mcp/board/boardTools.ts` - attachment name lookup and byte fetch.
- `android/.../BoardOps.kt` / `AttachmentOps.kt` - console queueing and fetch state.

### Awareness

- **Awareness rides the next message.** The send route drains each session's bank into `channel_push`; standalone pushes are only the `act_now` fallback.
- The bank keeps the first pre-state and last post-state per identity, then diffs at flush. Intermediate edits, moves, and undo sequences collapse into one net fact.
- Reply disposition and gateway `no_ack` are separate axes; `no_ack` wins. `act_now` starts its hold at the first observation and is not extended. Board `gone` is `act_now`; other board changes are `no_act`.
- The route drains only after confirming an active delivery path.
- `no_ack`, `act`, and `awareness` are plain `ChannelPushPayload` fields. Notification metadata must be strings with snake_case keys.
- No-reply interception is valid only when the store has no job for the fallback id; the `na-` prefix alone is insufficient across federation.
- Both holders of a changed entry receive awareness, classified from pre/post visibility. A self-echo is skipped.
- `mutate` stages ids per invocation and releases them after commit; `sessionEnded` and `sweepTrash` announce nothing, and rank-only reorders announce nothing.
- Awareness bodies are bounded. Liveness distinguishes waking from gone and uses `WAKE_TIMEOUT_MS`.
- The phone drains board edits before sending the next wire message.

File map:
- `src/gateway/awarenessBank.ts` - subscriber bank, flush deadline, and liveness.
- `src/gateway/boardAwareness.ts` - board recipients and net-change classification.
- `src/gateway/routes.ts` - awareness delivery on channel pushes.

A session can hand a self-contained sub-task to a `codex app-server` thread it owns. The daemon supervises one child per execution target; the gateway owns the durable record.

**A fence is `(daemonInstanceId, targetId, generation, lastEventId)`.** Reconciliation is the only path that may install a non-advancing fence.

**An acknowledgement retires the daemon's only copy.** `ignored` and `applied` permit it; only a withheld decision does not. Held frames are keyed by agent, although the stream is per target.

**`thread/read` needs `includeTurns: true`.** Without it, a successful live-server response has an empty `turns` array.

**ThreadLifecycle owns parked threads.** `codex app-server` starts every configured MCP server in `~/.codex/config.toml` as its own child on `thread/start`, a measured outside fact. A thread nobody unloads holds those servers for the app server's whole life. `thread/archive` unloads the thread and kills them; follow-up use unarchives and resumes it.

**A retired generation publishes nothing new.** `publish` checks liveness, and retirement retracts nothing already retained in the outbox. `release` must name the generation, or a late exit can tear down its successor.

**`startTurn` hands the turn id to `onStarted` before draining.** A terminal can beat its own `turn/start` reply. Scheduling registration does not work. The local session and daemon rely on this ordering.

**A terminal hold names its release event and bound.** The tracker holds a terminal that precedes its final item until that item arrives or the deadline releases it. A read still reporting `inProgress` leaves it held.

**Progress is any frame from the turn's own thread.** Matching only a turn id, or counting only tracker-parsed frames, misattributes or interrupts live work. Reconciliation treats an unconfirmed turn as `recovering`.

**Bookkeeping names the record, never only the id.** `mutate` checks identity before its request and never after it; an awaited reply can resume after that record was replaced. Retire, load, and poison must therefore refuse or drop by record identity. Retirements move the record to the back, and eviction leaves queued or non-parked records for a later pass.

**A turn's clock and warning live with its binding in `CodexLiveTurns`.** Rebinding to another thread creates a different identity and inherits neither.

**A request failure is a `kind`, never a sentence.** The transport emits `refused`, `timeout`, `unreadable`, or `closed`; callers must not branch on wording. Notifications dispatch in a microtask, preserving reply-before-notification wire order.

**A refused request is not an unavailable agent.** Request failures use the request-error envelope and HTTP 400; genuine agent failure uses the unavailable result envelope.

**The model is a start parameter, not configuration.** It is checked against `model/list` at use time and is not silently substituted.

**`ignored` and `failed` differ.** `ignored` may be acknowledged and retired; `failed` is never acknowledged because this gateway could not build its record.

### Local agent mode

A session without a serving daemon runs the child itself (`src/mcp/local/`). Installing the CLI is the opt-in.

- **The gate is reachability, not configuration.** A daemon declaration wins; otherwise `shared/agent-binary.ts` probes `PATH`.
- **`AgentDispatch` hides the serving mode.** Local dispatch calls `LocalAgentBackend.handle` with the same body; local validation and result parsing reuse the gateway schemas.
- **The list is projected per backend.** `projectCopilotListAgent` in `copilot-agent.ts` is the sole owner of Copilot's strict field set; gateway and local paths use it. `CopilotListAgentSource` makes the wrong record a compile error.
- **Child errors are normalized where stored.** `errorText` covers every `fail()` site and `applyTerminal`.
- **A closed local child must be evicted.** `LocalBackendSession.onClosed` is identity-guarded so a late close cannot evict its successor.
- **Idle reaping is Codex-only.** `threadsResumable` gates it. The hold spans the whole `handle()` request, not one child call; at every instant either that hold or `activeTurnId` guards the child. `applyTerminal` stamps the idle clock.
- **Codex loads before every follow-up turn.** `ThreadLifecycle` owns the rule; a fresh child unarchives and resumes a parked thread.
- **Local settlement uses the same owner.** `CodexLocalSession` calls `client.settleTurn`; `onTerminal` resolves the caller. Child exit, close, and retirement settle parked turns directly.
- **`LocalTurnHandle.settled` never rejects.** A rejection becomes a failed terminal.

The Codex thread retains workspace-write and network access for its whole life. Switchboard does not enforce a stronger boundary.

### Copilot delegation

A session can delegate a self-contained task to a logged-in Copilot CLI through ACP stdio. Follow-ups wait for the previous turn to become idle because ACP has no steer operation.

**Enabling it:** `copilot` on `PATH` announces the capability. Login uses the normal CLI and `/login`; no API key is forwarded. Default model: `gpt-5.6-luna`, with agent permissions enabled for the supervised target.

### Android app

- **Plugin framework** (`android/.../plugins/`): plugin claims are registry-owned and swept when a plugin is disabled. `threadDockSlots` must remain outside the caught-dispatch path because Compose values cannot cross a non-inline lambda.
- **Inbound pipeline:** handlers receive wire fields and file names, never file bytes. Subscribers run synchronously before `mailboxSync.commit`; do not replace this with `SharedFlow`.
- **Row re-render** (`ThreadRenderer`): any changing row payload must enter its fingerprint. JS bridge state mutates in place and intentionally does not.
- **Presence authority** (`Presence.kt`): the gateway's own presence is pushed; other machines are discovered by polling. A bare presence value does not reveal which channel produced it.
- **Presence residue** (`Presence.kt`, `presence-authority-residue.test.ts`): `status` is private, `Presence` construction is private, and consumers use authority-bearing members such as `isLive`, `isOnline`, `mayHavePane`, and `authoritative`. Do not restore writable status strings.
- **Action receipts** (`ActionReceipt`): local actions are receipts, not status overrides. Evidence retires a receipt; it never loses to an optimistic local value. Receipts are scoped by `opId`.
- **Presence TTL** (`PresenceTest`): must exceed one discovery interval. Otherwise a slow cold boot expires before discovery speaks.
- **Unreachable presence**: do not peek a row marked `UNREACHABLE`. A router-connected but unreachable machine remains an exception and can cause repeated failed peeks until `failCount` backs off.
- **Non-authoritative presence**: probe once per terminal mount. Polling is not evidence.
- **Working / needs-login** (`ChatState.working`): presence first, local peek only as fallback. Foreground re-declares screen focus so an open thread does not remain at background cadence.
- **Session card rungs** (`SessionCardPreview.kt`): the session's own reply supplies the headline; the owner's row never does. Each rung carries its own row time; ordering uses `lastActivity`.
- **Card board branch** (`cardBranchOf`): retain the root and a window around the current entry; collapse contiguous finished runs. A prefix of finished titles can hide the active entry.
- **Unfinished gateway enrollment** (`PendingEnroll.kt`): admission is persisted before POST and before delivery. Resume only with the saved bundle and the arming it was sealed against; a 404 requires re-arm and re-scan.
- **Terminal copy** (`TerminalCopy.kt`, `TerminalAnsi.kt`): trim only trailing cells with neither background nor reverse. Painted trailing cells are content. Join only a single whitespace-free URL with a scheme.
- **Terminal padding** (`shared/pane-trim.ts`, `TerminalCopy.kt`): trimming occurs at capture and render because daemon and console updates are independent and older daemons still send padded frames. Keep `-J`; it preserves spaces and joins tmux-wrapped rows.
- **Designer plugin** (`plugins/designer/`): owns design cards, live content-keyed rendering, and per-team `DesignStore`.
- **Unread tracking** (`ReadAnchor.kt`, `thread.js`): anchors match mailbox rows by epoch and sequence equality. Reads drain by scroll position.
- **Idle pushback** (`IdlePushbackManager.kt`): owns silent-poll backoff and aligned `AlarmManager` wakeups.
- **Playback requests** (`PlaybackRequests.kt`, `SttsPlayer.kt`): registry state mints and queues each event under the same lock as its transition. `PlaybackResidueTest` owns the single-mint boundary. Warm-up holds no claim and purge reaches it through the epoch.
- **Playback queue** (`PlaybackQueue.kt`, `PlaybackOps.kt`): yielding requests stand down when sound is taken. `advance` installs the next head before returning it; declining that handoff strands the entry.
- **Spoken markers** (`ChatRepository`): chime, sentinel, and body remain separate requests. Match terminals by returned request identity, not by current queue entry. Cache by spoken words, not entry alone. Resume does not re-announce parked markers.
- **Playback surfaces** (`SttsTransport.kt`, `QueueBubble.kt`, `QueueSheet.kt`): read repository state after queue settlement, not raw playback events. The bubble stays on Views because a Service lacks Compose's ViewTree owners. The board header is the third access path when notification and transport permissions are denied.
- **Abandon semantics** (`SttsPlayer.abandon`): callers declare whether position survives; there is no default. Markers and settings samples are never resumable.
- **Audio focus** (`SpeechFocus.kt`): a focus-induced pause retains the request and duckable loss keeps speaking. A refused focus request registers no listener. Becoming noisy is a route change, not focus loss.
- **Transport pause** (`transportPaused`): normalize in the getter so an idle queue cannot expose paused state.
- **Attachment viewer** (`AttachmentDisplay.kt`, `AttachmentViewer.kt`): choose the viewer stage by actual decoder capability, not MIME prefix. WebView and `BitmapFactory` disagree in both directions.
- **Zoom math** (`ZoomMath.kt`): derive limits per image and sample size; the layer scale is not the displayed zoom percentage. Emulator coverage is required for the 100% one-to-one seam.
- **Text preview** (`TextPeek.kt`): classify with `CharsetDecoder`; `String(bytes)` substitutes U+FFFD and makes binary data look textual.
- **Save targets** (`SaveTarget.kt`): SAF and MediaStore are separate paths. Revalidate stored grants; only a missing folder returns to the picker.
- **Composer drafts** (`Draft.kt`, `DraftStrip.kt`): drafts are per-team store state. File tiles key by file, not position. `Draft.locations` preserves source metadata and every writer must copy it.
- **Thumbnail sizing** (`ImageThumbs.kt`): bound both short and long edges; extreme aspect ratios otherwise decode at full size.
- **Scheduled send** (`ScheduledSend.kt`, `ScheduledSendOps.kt`): one banked record per team and one shared earliest alarm; firing is mutex-guarded.

## Development

### Commands

- `bun run lint` - Biome and `tsc`.
- `bun run test [path]` - Vitest.
- `bun run build patch|minor|major` - release build and commit.
- `bun run build --build-only` - bundle without versioning.
- `bun scripts/codegen-kotlin.ts` - regenerate Kotlin protocol types.
- `bun scripts/check-module-residue.ts` - verify `node_modules` against `bun.lock`.
- `bun scripts/import-stts-voices.ts` - regenerate the committed TTS catalog.
- `bun scripts/sync-leaf.ts <path>` or `--all` - synchronize a leaf.

### Pull before every follow-up edit after a push

`gitPushNewBranch` can reset local `main` to `origin/main` while the PR merges. Run `gitFetch` and
`gitPull` after every push. A non-empty `git log main..origin/main` is a hard stop. Scripted edits
must assert their match before writing.

### Verify locally before pushing, especially Android

CI does not compile Kotlin before merge. Run:

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:testDebugUnitTest --console=plain
```

`testDebugUnitTest` is un-minified. Both debug and release are R8-minified, so verify reflective
Android and JavaScript bridge entry points with `assembleRelease` or on-device. The
`@JavascriptInterface` keep rule in `app/proguard-rules.pro` is load-bearing.

The sibling **evie-bot** repo must be checked inside its devcontainer:

```bash
bun run lint && bun run test
```

### Emulator build

Use the `emulator` variant for visual inspection without onboarding or a real Gateway:

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:assembleEmulator
adb install -r app/build/outputs/apk/emulator/switchboard-emulator.apk
adb shell pm grant com.atelier_nyaarium.switchboard.sandbox android.permission.POST_NOTIFICATIONS
adb shell am start -n com.atelier_nyaarium.switchboard.sandbox/com.atelier_nyaarium.switchboard.MainActivity
adb exec-out screencap -p > /tmp/shot.png
```

It installs beside the real app. Emulator seeding bypasses mailbox draining, so handler-created
state must be seeded directly. Run `adb emu kill` when finished.

### Dependencies

Exact pins only. After a manifest change:

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun scripts/check-module-residue.ts
```

Bun leaves unsanctioned nested `node_modules` copies that can shadow the lockfile version.

### Synced leaves

| Source | Copy |
|--------|------|
| `src/shared/notice.ts` | `nyaaskills/src/shared/notice.ts` |

CI enforces the `SYNC-HASH` and the copy. Always use `sync-leaf.ts`: format, restamp, then copy.

### Code style

Biome: tabs, double quotes, semicolons, 120-character width.

### Testing

Vitest runs under Node. The gateway, Router, and daemon run under Bun. `ws` and WebSocket behavior
therefore differ. `bun run check:pinning` is the shipping-runtime gate.

### Debugging the console on-device

Debug APK logs flush to the Router's `/ingest`; release does not. Logs are not private. Never log
bearer credentials, invite nonces, or minted secrets.

```bash
docker logs switchboard-federation --since 15m 2>&1 | grep '\[console-ingest\]'
```

### Restart ritual, and starting a host session by hand

`./down.sh` stops the host daemon as well as the Gateway. `./start-gateway.sh` does not restart it.
Use:

```bash
./start-federation.sh && ./start-gateway.sh && ./start-host-daemon.sh
```

`start-federation.sh` does not rebuild the Router. Use `--build` for new Router code.
`start-host-daemon.sh` restarts the daemon. Declining a restart leaves the old build serving.
`./setup.sh --verify` checks Router reachability and Gateway registration.

The Router certificate is not rotatable without re-provisioning enrolled Gateways and phones.
Clock drift breaks signed proofs and invite expiry.

A bare `claude --resume` loses the host identity and channel subscription. Use:

```bash
PROJECT_NAME=host.<id> claude --resume <transcript-uuid> \
  --dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium
```

The MCP and harness diagnostics are in
`~/.cache/claude-cli-nodejs/<project-dir>/mcp-logs-plugin-switchboard-switchboard/`.

## Deploying

### The four components update on SEPARATE triggers

| Component | Updates when |
|-----------|--------------|
| MCP plugin | marketplace pull or session restart under autoUpdate |
| Gateway | manual restart |
| Host daemon | `./start-host-daemon.sh` |
| Console | app update |

New wire fields OPTIONAL at the gateway and tolerated by both peers. Deploy gateway first, then push the version bump. The plugin can update before the other components.

### Plugin

1. Commit source work.
2. Run `bun run build patch|minor|major`.
3. Push.
4. Reload target containers with `reload_plugins`.

The build derives versions, bundles `dist/`, and commits the release. Do not hand-edit version fields. Bun 1.4.0 or newer required.

### The lexicon submodule

`lexicon/` supplies the client at build and test time. `postinstall` links its packages into `node_modules/@nyaa-lexicon/`; runtime uses the bundled client.

- Fresh clone: `git submodule update --init` before `bun install`.
- Pin moves require a committed submodule change before release.
- Never install inside `lexicon/`. Nested `node_modules` shadow root dependency pins and produce duplicate packages.
- A real `node_modules/@nyaa-lexicon` directory is invalid. It must link into `lexicon/`.

### Installing

```bash
claude plugin marketplace add atelier-nyaarium/claude-marketplace
claude plugin install switchboard@atelier-nyaarium
```

### Federation

The gateway-to-Router WS is admission-only. No bearer fallback.

Run `./setup.sh` first. Admin Provision starts the Router, writes `.env`, and emits a direct transport blob containing the Router URL, `/health` fingerprint, and app token. An unreadable Router state must abort provisioning. An empty read can stage a new Domain over an existing rooted one.

Gateway Setup displays the admit payload and waits on the same screen for the phone's sealed bundle. `prompt()` blocks polling, so `readKeyWhile` uses raw mode and restores cooked mode on every exit. The screen prints the SAS from the admit payload. The countdown starts when `armGateway` returns, before health and payload waits. No LAN block means paste is the only enrollment route.

Purge Gateway removes only gateway state and gateway-owned `.env` keys. Purge Federation removes this owner's Domain slice first, then performs the gateway purge and removes the Domain id and setup code. The Domain id may come from `.env` or the Router's admin-Domain mark.

**Purge Gateway does not revoke the Gateway.** Only the phone holds the signing key. Use Revoke in the app. Do not edit the Router file to remove an admission.

**`.env` is shared by the gateway and Router.** Purges must preserve the file.

**The phone drops a revoked Gateway's board column.** `BoardManager.retainGateways` also makes unreferenced attachment buckets collectible.

**The phone's half of Purge Federation is Forget this Domain.** Revoke and Delete remains the app-only path because it also purges the Domain server-side.

`scripts/lib/routerState.ts` keeps Bun `$` templates on one line. Bun treats a backslash-newline as an argument split, not continuation.

### Cutting over to the self-hosted Router

**Rollback becomes unsafe after the Router accepts a federation mutation.** The cluster copy is then stale and can resurrect revoked members.

1. Stop the Router and run `./backup-federation.sh` after migration.
2. With the Router stopped, run `bun run export:federation`. It must import the existing identity and preserve `CONSOLE_BRIDGE_TOKEN`.
3. Run `./start-federation.sh`, then `./setup.sh` option 2 if a public host is needed.
4. Point the gateway at the direct Router transport and confirm both health endpoints and Router registration.
5. Point the phone at the Router LAN address. This changes transport only.
6. Verify send, poll, board, peek, wake, and add-a-device.

### Retiring the k8s path

The server path is direct-only. `scripts/federation-export.ts` remains the one-time cluster migration until the owner deletes the cluster objects.

Keep the k8s transport readable until every console has a direct blob. Remove the console proxy branch, `PROXY_CEILING_MS`, and k8s provisioning fields in a console release; remove the shared k8s schema halves last. `setup.sh --gateway-transport` is gone.
