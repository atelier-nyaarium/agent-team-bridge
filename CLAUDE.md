# Agents

Cross-team communication and devcontainer coordination for Claude agent teams. Teams register with a
Gateway over WebSocket; Gateways federate through a self-hosted, content-blind Federation Router to
reach other machines and the native Android console.

This file is a MAP, not a history. Keep entries to a sentence. Anything derivable by reading the
code does not belong here; rationale lives in `git log`.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` / `main-federation.ts` - the four
  entry points
- `src/gateway/` - the Docker-side HTTP + WS router (`index.ts`, `routes.ts`, `websocket.ts`;
  `routeSchemas.ts` holds the request schemas, byte caps and pure helpers the route table validates
  with; `wsTypes.ts` holds the WS registries, `WsData`, the repush bounds and the pure socket
  helpers)
  - `wake.ts` - on-demand container/session startup; `decideWakeCreate` is the pure, unit-testable
    create-vs-reattach-vs-refuse decision
  - `sessionAuthority.ts` - the SOLE owner of "what must a caller prove to act as X". A residue test
    fails the build if any other module reads the credential fields
  - `presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - presence plane, cross-device read
    anchors, host RPC correlation
  - `boardStore.ts` - the owner's task board: its own checked-write durable file and the per-owner
    plane (see Task board below)
  - `boardAuthority.ts` - board write authority (`BoardActor`, `mayWrite`) plus the enumerated
    refusals every board op resolves to and the `refused: ` marker's sole producer
  - `boardNotices.ts` - the pre/post notice classifier the awareness pushes are built from
  - `boardCascade.ts` - the pure both-directions state rule the store runs after a write, so a
    finished parent and its finished children cannot disagree (see Task board below)
  - `noAckPush.ts` - the reply-less awareness push: the bank, its window, and the three-valued
    liveness read at the send edge (see Awareness pushes below)
  - `daemonCapabilities.ts` - the daemon's half of the capability answer, stored beside the console's
    and served as its own section
  - `codexAgentService.ts` / `codexRelay.ts` / `codexRoute.ts` - the session-owned Codex catalog, the
    per-agent critical section that folds daemon receipts and events into it, and the one
    authenticated route behind all five tools; the pure reducers and the shared types live in
    `codexAgentReducers.ts` and `codexAgentTypes.ts` (see Codex delegation below)
  - `router/` - WS client to the self-hosted Router; `pinnedSocket.ts` owns the certificate pin and
    is the only place that reaches past bun's `ws` substitute (see Pinning the Router below)
  - `console/` - gateway side of the Android channel: op dispatch, the `ConsolePeer` virtual peer,
    the capability store, the relay pump, the durable op store. `consoleTypes.ts` holds the deps and
    route interfaces, bounds and pure predicates `consoleHandler.ts`'s dispatcher is built on
- `android/.../ChatRepository.kt` - the console's process singleton. The types and pure helpers it
  operates ON are siblings in the same package, not members: `Message.kt`, `MessageFile.kt`,
  `MessageText.kt` (`oneLine`, and how a row becomes speech), `Draft.kt`, `ThreadOps.kt`,
  `ReadAnchor.kt`, `ChatState.kt`, `ConnError.kt`, `FederationTypes.kt`, `ScheduledSend.kt`.
  `ChatPersistence.kt` is the delegate it HOLDS: the JSON codec between the in-memory maps and
  AppStateStore (threads, read anchors, labels, scheduled sends, absence streaks, drafts)
  - `PollDrain.kt` (`repo.drain`) owns the poll loop and mailbox drain: the loop lifecycle, the four
    plane version cursors this device presents back, and both drain-gate subscriber lists. Inbound
    subscribers fire inside the drain before `mailboxSync.commit`, so the exactly-once they inherit
    is a property of living here rather than of where the code happens to sit
  - `PlaybackOps.kt` (`repo.playback`) owns the playback serialization boundary: the autoplay queue,
    its advance mutex, the marker sequence and the transport controls. It subscribes to the player
    from its own init, so it must stay declared after `stts` and `repoScope`. `PlaybackReadModels.kt`
    holds what a UI surface asks about, which takes no lock and mutates nothing
  - `BoardOps.kt` (`repo.boardOps`) is the repository side of the board: capture, the setters, the
    attachment transfers and assignment. The `BoardManager` it wraps stays as `repo.board`
  - `AttachmentOps.kt` (`repo.attachments`) owns the fetch-and-sweep state: the in-flight flag, the
    per-blob failure counts and the failed-fetch flow the designer dock collects
  - `ScheduledSendOps.kt` (`repo.scheduled`) owns the banked sends, the alarm seam the service wires,
    and the one mutex every fire path funnels through so a warm kick cannot double-convert
  - `GoalOps.kt` (`repo.goals`) owns armed goals: the send they ride, the wait for that session's
    composer, and the one place a `/goal` line is typed (see Armed goals below). `Goal.kt` is the
    record, the sanitizer and the pure `goalStep` rule
  - `PresenceOps.kt` (`repo.presence`) owns the team list rebuild and its mutex, cross-Domain
    presence, and the read anchors this device reports back
  - `SessionOps.kt` (`repo.sessions`) owns the terminal view and session control: peek, tmux send,
    spawn (with its own opId reuse window), wake, relaunch and forget
  - Four more families are EXTENSIONS on `ChatRepository` rather than delegates, since they hold no
    state and an extension has no backing field: `ChatRepositorySend.kt` (send, retry, the single
    `deliver` path, admission and reconcile), `ChatRepositoryThreads.kt` (tabs, labels, rename, and
    the read-anchor reads), `ChatRepositoryDomainLink.kt` (the provisioning blob, the connection it
    buys, who that connection says this owner is, and the wipe that undoes it),
    `ChatRepositoryStts.kt` and `ChatRepositoryDrafts.kt` (speech settings, composer drafts). Call
    sites stay `repo.send(...)`, so the spelling a residue test matches on is the same either way
  - `RouterReach.kt` - the addresses this device knows for its Router and the pure order it tries
    them in; `ConsoleRelayTransport.kt` owns the failover that walks that order (see Self-hosted
    Router, Reach)
  - The federation surface is six more held delegates, reached as `repo.ownerFacts` /
    `.gatewayEnroll` / `.ceremony` / `.devices` / `.domainAdmin` / `.trust`: `OwnerFacts.kt`
    (first-root, the owner key, and every fact submitted through `submitOwnerFact`, plus membership),
    `GatewayEnrollment.kt` (the admit-gateway QR and the pinned LAN bundle delivery),
    `EnrollCeremonyOps.kt` (the FLOW-1 ceremony's repository side), `DeviceApprovalOps.kt` (the
    add-a-device rendezvous, both sides), `DomainAdminOps.kt` (own-Domain identity plus hosted
    tenants), `TrustOps.kt` (the trust graph, the link wizard, FLOW-2, cross-Domain shares). They
    reach back into the repository for `store` / `_state` / `client()` / `federation`, and
    `federation-manager-residue.test.ts` fails the build if anything outside these seven files
    touches the owner keys
    - Both FLOW-1 and FLOW-2 run their commit-reveal compare through `SasExchange.kt`'s
      `runSasExchange`, so a check added there cannot reach one flow and miss the other. Each flow
      supplies its own broker frames and its own out-of-band peer authentication; `EnrollCeremony.kt`
      stays the pure SAS and commitment core beneath both
- `android/.../MainActivity.kt` - the `Repo` singleton, the activity, and the `App` composable that
  routes between screens. Each screen is its own sibling file: `SessionsScreen.kt`,
  `SettingsScreen.kt`, `ThreadScreen.kt`, `Onboarding.kt` (lock, provision, add-device, host setup),
  `SessionDialogs.kt`, `ReorderableTabRow.kt` (geometry in `TabDragMath.kt`), `TimeText.kt`.
  `App` keeps the navigation and overlay flags it routes on; what it does NOT decide routes with lives
  outside it: `RendererPoolBindings.kt` (the WebView pool and its callbacks), `AppOverlays.kt` (queue
  and viewer), `LinkMenu.kt` (a tapped link's menu and how a link opens)
  - Settings is four files: `SettingsScreen.kt` is the hub and its route dispatch, `SettingsSections.kt`
    its small leaf screens (plugins, profile, networks, security), `SettingsSystem.kt` the system screen
    with the update and battery rows it owns, `SettingsVoice.kt` the STTS provider and playback screen
  - The sessions tab is five files: `MainTabsScreen.kt` is the app shell hosting both tabs (it owns
    the top bar and pager, and takes each tab as an opaque slot), `SessionsScreen.kt` the list,
    `SessionsHeaders.kt` its section chrome and status vocabulary, `SessionCard.kt` the card with its
    board rungs (rules in `SessionCardPreview.kt`), `SessionsEmptyState.kt` the connection-state
    machine shown instead of the list
- `android/.../board/` - the console's board half. `BoardState.kt` and `BoardRows.kt` are the pure
  reducers (queue, snapshot merge, row flattening); `BoardManager.kt` owns the durable blob and is
  the only thing that mutates it
  - `federation/` - cross-Gateway routing (`gatewayRelay.ts`), identity, allowlist, sealer, replay
    guard, cross-Domain presence
- `src/mcp/` - the tools registered into Claude Code
  - `bridge/` - `crosstalk_send` / `_discover` / `_wait`, plus shared reply helpers and the
    escaped-newline lint
  - `channel/` - `channel_reply`, `channel_reply_structured`, `notify_human`, channel push
  - `references/` - `ref://` resolution: lexer, grammar, tree-sitter resolver, artifact builder
  - `board/` - the `taskBoard*` tools, registered only when the console announced `taskboard`.
    `taskBoardFetchAttachments` is the two-hop read: names to blobIds on the route, then bytes
  - `designer/` / `connector/` - designer cards; game-client connector
  - `devcontainer/` - host daemon plumbing (`hostDaemon.ts`, `hostOpRunner.ts`, `tmuxCore.ts`) plus
    the per-session tools every peer registers
    - `hostResolve.ts` - the pure, independently-tested resolution logic hostDaemon.ts's WS
      orchestration delegates to: catalog scanning, host/devcontainer workdir and watch-target
      resolution, and the tmux launch command builder
    - `codexTargets.ts` - one supervised `codex app-server` per execution target. A working directory
      is NOT a target property: a thread carries its own, so every host session shares one child
    - `codexAppServer.ts` - the JSONL transport and fail-closed client. Every server-initiated request
      is refused, and a model is checked against `model/list` at each point of use, not just at open
    - `codexTurnTracker.ts` - what a turn produced. `answerOf` is the SOLE reader of "does this turn
      have an answer yet", so the hold decision and the reported outcome cannot disagree
    - `codexDaemonService.ts` - the daemon's half of the relay: commands in, receipts and events out,
      per-agent serialization, and the outbox the gateway acknowledges against. `session()` shares one
      open per target, since commands serialize per AGENT and two agents share a child
  - `local/` - the daemonless backend a session runs itself (see Local agent mode).
    `localAgentRuntime.ts` owns the catalog, wait budget and answer shaping; `codexLocalSession.ts` /
    `copilotLocalSession.ts` are the per-protocol adapters; `localAgentHost.ts` wires a backend to the
    target manager and validates both ends against the schemas the gateway route uses
  - `agentDispatch.ts` - the one seam saying where an agent tool call is served
  - `codex/codexTools.ts` - the five Codex tools, registered only when the daemon announced
    `codex-agent`. Each mints a private operation id per invocation, which is what makes an HTTP
    retry a replay rather than a second delegated task
  - `capabilities.ts` - the bounded read of the gateway's capability union, done before the McpServer
    exists so it can gate tool registration. `capabilitiesTool.ts` serves the guidance itself
- `src/federation-server/` - the self-hosted federation Router: one TLS listener serving the gateway
  WS, the console op surface and the token-exempt device-approval ingress. Ported from evie's bridge;
  see Self-hosted Router below. This IS the live path
  - `routerServer.ts` - the listener and the ONE guarded seam every request enters through:
    `route()` returns a Response and never touches `ServerResponse`, `serve()` is the only adapter.
    Pinned by `federation-launch-seam-residue.test.ts`
  - `fileSecretStore.ts` - the durable federation state, replacing evie's `KubeSecretStore` facade
    whole; whole-file atomic writes, persist-before-publish, bounded CAS re-run
  - `gatewayBridge.ts` / `gatewayTransport.ts` - registration authority and relay routing, and the
    ws adapter beneath them. The four trust callbacks are REQUIRED: an absent `getDomain` would skip
    the entire registration verification block
  - `consoleSurface.ts` / `publicApproval.ts` - the app-token-gated op family, and the two
    nonce-gated public routes that must stay token-exempt
  - `routerTls.ts` - the persistent self-signed cert. Minted only when absent, never auto-rotated;
    rotating it re-provisions every client
  - The five coordinators (`enrollmentCoordinator`, `tenantAdmin`, `enrollHandshakeCoordinator`,
    `deviceApprovalCoordinator`, `trustRendezvousCoordinator`) keep their windows in memory by
    design; a restart loses them and the flows re-arm
- `src/shared/agent-binary.ts` - whether a backend's CLI is on `PATH`. Uncached and `which`-free: the
  answer gates both the daemon's declaration and the plugin's tool registration
- `src/shared/` - wire truth and utilities used by both sides
  - `capabilities.ts` - the capability ids and the guidance text each one carries, what the host
    daemon's own configuration declares at register, and the fold from a per-source bundle to one list
  - `schemas.ts` - THE single zod truth for every wire shape: a barrel re-exporting the
    `schemas*.ts` domain files, so every importer keeps importing named symbols from
    `./schemas.js`. Every schema carries `.meta({id})`, which is its generated Kotlin class name.
    The barrel's export order is biome-sorted and NOT the codegen's emission order, which comes
    from `scripts/codegen-kotlin.ts`'s own ROOTS list
  - `codex-agent.ts` - the Codex delegation wire truth: a barrel over the sibling `codexAgent*.ts`
    domain files (identity, activities, targets, agent state, relay frames, App Server protocol,
    agent record, catalog), re-exporting the original public surface by name so the split files'
    internal helpers stay out of it. Never fed to the Kotlin codegen
  - `channel-file.ts` - the ChannelFile wire shape, zod-only and NOT a leaf (the Router never reads it);
    its own module because schemas.ts and federation-protocol.ts both consume it and would cycle.
    A file DECLARES what it is here (`role`, plus the ref and design-card facts a receiver would
    otherwise have to open the bytes to learn); no receiver may re-derive that from content,
    filename, array position, or message direction
  - `session-id.ts` - the SOLE owner of the address grammar (see Addressing below)
  - `crypto.ts` / `admission.ts` / `router-protocol.ts` / `federation-lifecycle.ts` (a barrel over the
    seven per-flow `federation-*` files) - the federation trust model and its wire vocabulary
  - `notice.ts` - the four notice tiers both reply tools and the console wire share; the one remaining
    synced leaf (see Synced leaves below)
  - `durable-store.ts` - atomic JSON snapshots, plus the per-file restore boundaries that quarantine
    a poisoned file instead of letting it take down every other consumer's state
  - `session-store.ts` - the gateway's authoritative session records, keyed by `spawn.id`
  - `session-sanitize.ts` / `session-tokens.ts` - label/workdir/description normalization; session id
    and bind-token minting
  - `board-attachment-store.ts` - attachment bytes owned by a board entry, keyed
    `(ownerId, entryId, blobId)` with every path segment asserted. Nothing sweeps it; that IS the
    durability. See Board attachments below
  - `board-rank.ts` - fractional ranks for task-board ordering: plain string order IS sibling order,
    and `rebalanceRanks` asserts every rank it mints because an invalid one poisons the durable file
  - `agent-screen.ts` / `pane-trim.ts` - the pure reads of a captured tmux pane: what state the REPL
    is in, and which trailing spaces are `-J` padding rather than content. Each has a hand-written
    Kotlin twin (`AgentScreen.kt`, `TerminalAnsi.kt`) held to a shared fixture corpus
  - `device-mailbox.ts` / `pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` /
    `process-guards.ts`
- `android/` - the console app (Gradle/Kotlin). `proto/Protocol.kt` is generated, not hand-written
- `scripts/` - `build.ts`, `codegen-kotlin.ts`, `sync-leaf.ts`, `setup.ts` (the admin menu entry;
  its options live in `setup-gateway.ts` / `setup-provision.ts` / `setup-purge.ts` /
  `setup-enrollment-ui.ts`, and `setup-status.ts` is the state header it draws first),
  `start-federation.ts` (what `start-federation.sh` execs), `check-module-residue.ts`,
  `import-stts-voices.ts`, `build-grammars.ts`
  - `lib/routerStart.ts` - the ONE place that decides what `.env` holds for the Router: mints the
    tokens, detects and writes the LAN bind on every start, reads and writes the public reach, and
    brings the Router up. Both `start-federation.ts` and Admin Provision go through it
- `tests/fixtures/` - golden wire fixtures and signing vectors read by BOTH vitest and the Kotlin
  tests. `_manifest.json` and `_signing-vectors-manifest.json` are the inventories both runtimes
  iterate, so a new corpus cannot be read by only one side
- `skills/crosstalk/SKILL.md` - the agent-facing tool reference

## Architecture

**MCP plugin** (`main-mcp.ts`) runs in the user's process, loaded via `.mcp.json`.
**Gateway** (`main-gateway.ts`) runs in Docker as one machine's central router.
**Host daemon** (`main-host-daemon.ts`) runs headless on the host and owns the reserved `host` WS
slot: devcontainer wake, session spawn, and the console terminal view. It carries no Claude session.
**Federation Router** (`main-federation.ts`) is the self-hosted replacement for evie's relay, and is
what every Gateway and console reaches today.

| Port  | Service                             |
|-------|-------------------------------------|
| 20000 | Gateway (HTTP + WS)                 |
| 20001 | Federation Router (TLS), was evie's |
| 20002 | MCP connector (game client WS)      |
| 20003 | Enrollment TLS (arming only)        |

20000 publishes to LOOPBACK only: local HTTP authorizes by session binding, which says nothing about
which machine the caller is on. Containers reach it by service name, off that mapping. 20003 is the
one port that needs the LAN, pinned-TLS behind a one-time nonce.

### Channel conversations

Every connection is channel mode; the old CLI dispatch path is gone. Each MCP process mints one
stable `conversation_id` at startup and keeps it across reconnects.

- The job key is `storeKey({kind:"conv", conversationId, address})`, so every send between the same
  (sender, target) pair lands in one entry and callers never manage session_ids.
- Channel entries are `persistent: true` and never TTL-swept. Transient ones expire at 600s.
- `channel_reply` may be called any number of times on a session_id. There is no finality.
- Replies push to the specific sender sub-session, so parallel windows do not cross streams.

### Addressing

`shared/session-id.ts` is the one producer of every session/team key: one separator (`.`), one slug
validator, the `Address` value object (`domain.gateway.spawn.session`), `SpawnPoint` (3 segments,
non-addressable), and `parseTarget` arity dispatch. A store key and a lookup key are the same value
by construction. The Kotlin twin is `android/.../proto/SessionId.kt`, held equivalent by
`tests/fixtures/session-id/vectors.json`.

The gateway keys teams by bare local fields internally and qualifies to a full `Address` only at the
wire edge. Domain id is the `local` sentinel until enrollment. A bare `project` is a spawn-point
(catalog membership decides this, NOT the dot test, so `my.app` is still a project); a send to one
fails fast.

### Sessions and wake

Devcontainer sessions are `project.session` loose peers. The daemon launches one by overriding
`PROJECT_NAME=<project.session>` so the in-container MCP registers under the composite name, which
completes the wake. `SessionStore` is the durable known-session list: a re-wake reattaches live tmux,
else `claude --resume`s the transcript, else launches fresh.

- A send to an asleep composite with a record reattaches it.
- A send to a composite with NO record requires `displayLabel`; it mints an opaque id, so the woken
  session lands at the minted address, never the typed one. Without the label the send fails fast.
- The host machine is a symmetric spawn-point: same `create_session` / `forget` / resume path, but
  starts in `~/projects/<label>` via `resolveHostWorkdir`.
- The daemon's own `host-daemon` session is reserved and refused at every sink.

### Session identity binding

A `SessionRecord` may carry a `bindToken`, minted at dispatch and delivered only through the
daemon's launch command. The MCP presents it at register and as `x-session-token` on every HTTP
call. This closes cross-PROJECT impersonation. Same-project panes share a uid and stay mutually
impersonable by OS construction: an accepted permanent residual, not a gap.

`gateway/sessionAuthority.ts` answers three distinct questions, and collapsing them re-introduces
paid-for bugs:

- `toClaim(teamKey)` - name-keyed, the only place inert-awareness lives. A reattach discards the
  launch command, so a binding stays inert until a register actually presents it.
- `toAnswerFor(ws)` - socket-keyed, deliberately not record-derived: a `claude --resume` alias serves
  a bound record under its own unbound name with no token.
- `toActFor(teamKey)` - the composition, live-first with a record fallback.

UNBOUND is a VALUE a resolver returns, never an absence a caller falls into. That is what stops a
gate from manufacturing an accidental permit.

### Self-hosted Router

`src/federation-server/` replaced evie's relay: the same wire protocol, run in Docker at home, so
`src/gateway/router/routerClient.ts` connects to it unchanged and only the transport under it differs.
Everything below about trust, sealing and admissions holds identically - the Router is content-blind
for the same reasons evie was, and moving it home changed reachability, not trust.

Three surfaces share one TLS port, and the boundary between them is the whole security story: the
gateway WS is bearer-gated at upgrade, the console op family is app-token-gated, and device-approval
join/fetch is deliberately token-EXEMPT because a fresh device holds no credential yet.

Its cert is minted once and never rotated. Rotating it invalidates the pin every enrolled Gateway
and phone holds, which is a re-provision of each, not a restart. That cert is also distinct from the
ephemeral one the 20003 enrollment listener mints per arming.

**Reach: one Router, several addresses, and the phone learns them from the Router.** A home router
hairpins a LAN-to-public connection unreliably or not at all, so the public address is not dependable
from INSIDE and the LAN address is unreachable from OUTSIDE, and neither can be the one stored truth.
The owner types either one; the Router advertises the rest through the app-token-gated `reach` op
(`{publicHost, publicPort?, lanAddresses}`, from `FEDERATION_PUBLIC_HOST` / `_PORT` /
`FEDERATION_BIND`); the console persists what it learned beside the blob (`RouterReach`, wiped with
it) and tries candidates in a FIXED order - every LAN address, then the public host, then the typed
address (`reachCandidates`, pure and tested).

- **The public port is its own field, and LAN never dials it.** A port forward remaps the public
  side only, so `reachCandidates` dials LAN on the Router's own port and public on `publicPort`;
  absent means the Router's own. One port for every candidate was the shape before this and would
  have dialed the LAN on the forwarded port the moment one was configured.

**The GATEWAY is the second client of this rule, and only the rule is shared.** `src/shared/router-reach.ts`
owns the ordering and `RouterReach.kt` is its twin, held equal by `tests/fixtures/router-reach/vectors.json`
(registered in `_signing-vectors-manifest.json`, so both runtimes are forced to read it). Everything
around it diverges on purpose, and collapsing any of it re-introduces a paid-for bug:

- **The phone fails over PER OP, the Gateway PER RECONNECT.** One holds independent HTTPS requests,
  the other one long-lived socket. `withReachFailover` stays in Kotlin; the Gateway's ring lives in
  `routerClient`'s reconnect loop, advancing only when a socket never OPENED - a drop on a working
  address must not walk off it.
- **The Gateway cannot call the `reach` op at all.** It holds a WS bearer, not the console app token,
  so it learns the addresses from its `gateway_register` reply instead. One optional field, so an
  older Router simply says nothing and the ring keeps what it had.
- **A candidate gets a bounded time to open** (`CONNECT_TIMEOUT_MS`, or `LAN_CONNECT_TIMEOUT_MS` when
  private). Without it the socket inherits the OS connect timeout and one stale LAN address wedges
  the Gateway offline for minutes past the point the public host would have worked.
- **No bootstrap self-correction on the Gateway**, unlike the phone. The typed address stays LAST in
  the ring, so it is never stale, only last. A fixed server does not need its door moved.
- **`FEDERATION_ROUTER_HOST` beats the sealed bundle's address.** The phone knows the Router by its
  PUBLIC host, and a machine on the Router's own LAN may not reach that on a first connection, with
  nothing learned yet to fall back to. Gateway Setup asks for a door that works from where that
  machine stands; trust still arrives only in the bundle, so a wrong answer fails to connect and
  cannot redirect anything.
- **`reach.json` is its own file beside `transport.json`**, never merged into it: the transport is
  DELIVERED and must stay byte-stable, this is LEARNED and rewritten on any register.

- **The stored address is only "which Router do I start at".** After the first answer the Router is
  the truth, so `reached()` rewrites the blob's `routerUrl` to the advertised public host: a
  bootstrap left on a raw LAN IP would go stale on a DHCP change, and the LAN address it names
  arrives fresh in `lanAddresses` on every connect anyway.
- **No "last address that worked" field.** One existed and was removed: connecting once from away
  recorded the public host, which then jumped the queue at home and paid a full hairpin timeout on
  every cold start. It optimised the rare case and pessimised the common one.
- **A private candidate gets `LAN_CONNECT_TIMEOUT_MS`, not the full connect timeout.** That is the
  whole reason "LAN first, always" is affordable: away from home the address is unroutable, and this
  bounds the wrong guess at seconds, once per process, instead of a 15s stall on every launch.

- **NOT on `/health`.** That answer is public by necessity, and a LAN address on it tells any scanner
  this port-forward ends on a home network at a specific private address. Behind the token there is
  no chicken-and-egg: `/health` works from whichever address the phone can reach, and the token it
  already holds is what lets it ask for the other one.
- **Failover is on a thrown `IOException` only, never an HTTP status.** A status proves the Router was
  reached and said something; the answer belongs to the caller. `withReachFailover` walks the ring at
  most once per op, and `apiReachable` is where a network change is discovered, since it is the
  first thing a connect does and every later op inherits its choice.
- **The debug ingest follows the transport's CURRENT base** (a provider, not a value): a flush that
  kept dialing the address it was attached with died on exactly the network change worth reading.
- The Router logs an unauthenticated 401 and a TLS handshake failure at the outer gate. Both were
  silent once, and a mismatched console looked identical to one that never dialed.

The outage that produced all of this: the phone held the public domain, the home router hairpinned
new connections only sometimes, and OkHttp's pool kept ONE socket alive that had got through - so
every op rode that socket until it dropped, while each fresh connection (the debug ingest, every
probe) timed out. "Works, then does not, then a reinstall fixes it" is what an intermittent path plus
a pooled connection looks like, and it is worse to diagnose than a path that never works at all:
measuring it once and seeing it succeed proves nothing.

### Pinning the Router

The Router's leaf is self-signed, so its fingerprint IS its identity. `gateway/router/pinnedSocket.ts`
owns the check and `routerClient` holds no certificate logic of its own.

- **The pin runs on the TLS handshake, not after it.** The upgrade request carries the WS bearer, so
  a check on ws's `upgrade` event fires once that bearer is already on the wire and can only close a
  socket that has finished leaking. `pinnedDial` builds the TLS socket itself, hands it to ws through
  `createConnection`, and compares the leaf on `secureConnect`; a wrong Router is destroyed before a
  byte is written, which `router-cert-pinning.test.ts` asserts by watching what the listener SAW.
- **`ws` is reached by resolved path, never by its bare name.** Bun substitutes its own WebSocket for
  the `ws` specifier, and that substitute exposes no peer certificate and ignores `createConnection`,
  so a pin written against the npm package silently does nothing. `require.resolve` and every subpath
  import hit the same substitution, hence the walk up to `node_modules/ws/lib/websocket.js`.
- **The verdict is four-valued and none of them collapse.** `match`, `mismatch`, `unreadable`, and
  `pending` (the socket was never handed over, so nothing was checked). Reporting an unreadable
  certificate as a wrong one is what turned a base-image bump into a fleet-wide "cert fingerprint
  mismatch" naming the one thing that was correct.
- **Chain verification is off and stays off.** A self-signed leaf has no chain, and its subject names
  one CN that no dialled address matches, so hostname identity cannot be satisfied by any address the
  ring holds. The fingerprint replaces both checks rather than supplementing them.
- **bun 1.4+ is required**, and it is the runtime that decides, not the code. `oven/bun:1` is a
  floating tag, so both start paths build with `--pull`; without it two machines on the same commit
  land on different bun majors.

### Federation and trust

The Router is content-blind. Gateways register a gateway id on connect; a Gateway reaches another
via the Router's `gateway_relay`, routed by `dstGateway` alone and correlated by `relayId`. Payloads
are E2E sealed, so the Router can neither read nor forge them. Discovery fans out `list_teams` over
the Router's presence roster and merges locally; the Router aggregates nothing.

Trust roots in a single owner device. Membership is an allowlist of owner-signed admissions mirrored
on the Router AND every Gateway, so a revocation bites while the Router is unreachable.

- **Crypto** (`shared/crypto.ts`): Ed25519 signing pair + X25519 box pair, raw 32-byte keys base64.
  Seal is ephemeral X25519 ECDH into HKDF-SHA256 into AES-256-GCM, signed by the sender's static key.
  **AES-256-GCM not ChaCha20**, because Bun lacks the latter.
- **Never sign raw JSON.** Signing bytes are versioned newline-joined encodings (`ADMISSION_V1\n...`)
  reproduced byte-exact on node, Bun, and Android. Cross-platform vectors pin Kotlin against node.
- **Registration gate:** `gateway_register` carries signPub/boxPub, the owner-signed admission, and a
  fresh possession proof. There is no bearer fallback.
- **Arming mode:** a gateway with no Domain id boots standalone, serving `/health` and `/enroll` with
  no Router client. The bridge activates only when both a `transport.json` and a Domain id resolve,
  so a missing Domain arms for enrollment rather than failing closed.
- **Enrollment:** the owner root key is generated silently on the phone and never leaves it. A fresh
  setup stages a PENDING tenant Domain and emits a transport-only 0600 blob carrying
  `pendingTenant{domainId, nonce}`; the phone self-signs a `FIRST_ROOT_V1` and roots it router-direct
  in one atomic CAS write, so a redeem race has exactly one winner.
- **Replay:** `ReplayGuard` checks AFTER the signature verifies.
- **Trust-on-first-enroll:** the first owner-signed snapshot roots a gateway; a later snapshot rooted
  at a different owner key is ignored. There is no silent re-root.

The console-to-gateway path is sealed the same way: the console seals each op into a
`ConsoleRelayFrame` signed by its enrolled key, and the gateway verifies the signer against an
owner-signed `kind:console` admission before dispatch. Only a pre-seal failure returns cleartext, so
the console can prompt enrollment. Still open on this track: retiring `CONSOLE_BRIDGE_TOKEN`, which
is the one shared app-token the whole console op surface still sits behind.

### Versioned state planes

The console's poll response piggybacks versioned server-state snapshots instead of the console
re-pulling on its own timer. `shared/plane-registry.ts` is the one framework: a mutator only calls
`markDirty()`, and the registry owns version identity, hash-gated bump detection, the race-free
`waitForBump` held-poll primitive, per-plane exception isolation, and a 60s tripwire that self-heals
a mutation that forgot to mark.

Planes today: **presence** (single writer over every presence-affecting field), **linked-peers**,
**read-anchors** (one plane PER OWNER, so a wire-assembly bug cannot leak across owners), and
**cross-domain-presence** (N planes, one per linked Domain, shipping only the changed subset).

**Wire rule:** per-plane fields are flat, hand-named, optional. NEVER a generic map and never a
decode-side discriminated union, because Kotlin codegen has no typed map and silently drops a union
root. An absent known-version means "ship nothing"; an empty array means "ship current truth".

### Console bridge (Android)

The console is a poll-based client, not a live socket: the Router relays opaque `console_relay`
frames and the gateway answers each with a `console_relay_reply`. It is keyed by its per-install
`conversationId`; the Device Name is only a display label. `ConsolePeer` inserts into the team and
conversation registries like a real peer, so wake, persistent conversations, and push delivery are
reused unchanged; its `send()` appends to a `DeviceMailbox` that the `poll` op drains.

- **Ops:** register, list_teams, send, respond, poll, plus peek / tmux_send / create_session /
  rename_session / reload_plugins / forget / close_session.
- **Idempotency:** mutating ops dedup per `(conversationId, opId)` in an in-memory `opCache`; reads
  run fresh. `send`/`respond` additionally sit on `DurableOpStore`, so a restart mid-send cannot
  re-deliver a message the client already believes sent.
- **Mailbox:** bounded (entry cap with a cumulative `dropped` signal, 1h idle TTL, LRU device cap).
  Each instance carries an epoch, and `poll` is epoch-gated so a stale cursor cannot ack away a new
  instance's entries. Eviction prefers `"peer"` entries over real unread mail.
- **Agent-to-agent mirroring:** `mirrorPeer` appends a display-only `kind: "peer"` copy for each
  local participant. Never fires for a console sender/target, and never load-bearing.
- **Plugin actions:** a generic `kind: "plugin_action"` entry lets a tool drive a device-side plugin
  with no new wire type per action. `threadAddr` derives solely from the request's own `from`.
- **Multi-gateway delivery:** the console polls one route Gateway, so every console-bound entry
  lands through `consolePushOps.deliverToOwner` - the SOLE mailbox writer (a residue test fails the
  build on any other `.append(` under `src/gateway`), appending locally and relaying via
  `fanOutConsolePush`. `origin: "relay"` is the only non-fanning append, so the landing side cannot
  gossip-loop; same-Domain-only with no exceptions, deduped per `dedupeKey`. Device-scoped
  producers pass `resolveMailbox` so a late delivery cannot resurrect a torn-down install's inbox.

### Console terminal view

`peek` captures the ANSI pane, `tmux_send` injects literal text or a whitelisted control key,
`create_session` starts or reattaches a named tmux session, `reload_plugins` drives the update
sequence. These reach the host through a `host_op` RPC over the host WebSocket, correlated by
`reqId`, and run through `hostOpRunner.ts` (peek single-flight, cadence floor, concurrency cap,
dedup on the mutating ops).

- `tmuxCore.ts` is spawn argv, no shell. Every session LOOKUP uses tmux's `-t =<name>` exact-match
  form, so `story` can never match `story-2`.
- While a pane does not exist yet, `peekWithFallback` tails `docker logs` instead of erroring. The
  console-facing result mirrors the tag as FLAT optional `kind` + `text` fields, never a zod
  discriminated union.
- The wake path reports a FAILED wake when a fresh pane never captures, so `/send` fails fast on a
  dead launch instead of stalling.
- Auth: the reserved `host` slot is gated by `HOST_WS_TOKEN`, so a LAN peer cannot squat it and
  capture keystrokes.

### Armed goals

The send button's long-press menu offers **Goal**: send the composed message, then type a
`/goal <description>` line into that session's pane. Console-only - no wire shape, no gateway change,
reusing `send` and the existing `tmux_send` op.

- **The turn is NOT waited on.** The message goes over the wire, never through the composer, so the
  box is free while the agent works and a line typed there is queued and runs when the turn ends.
  Waiting for the reply cost a whole turn and bought nothing.
- **THREE tmux sends, never one line.** The CLI folds a burst of typed characters into a paste, and a
  whole `/goal ...` line pasted at once is read as no command. Enter is its own keypress, same reason
  `resumeAfterLimit` is three sends.
- **The composer must be EMPTY.** Typing appends, so a half-typed line the owner left gets submitted
  joined to the goal. `isReady` also rejects a pane held by a dialog, where the line would answer it.
- **The live composer is the LAST prompt row.** A message queued mid-turn draws its own prompt row
  above it, so a first-match read would see the queue and never type.
- **The record is cleared BEFORE the first keystroke.** A process death mid-sequence would otherwise
  type into a composer already holding half a goal. Losing one is re-armable, a session typed at
  twice is not.
- `sentAt` gates the typing: nothing is typed for a message that never went out. `goalStep` is the
  whole rule, and pure.

### Artifact references (`ref://`)

An agent writes a markdown link to `ref://path:Scope:Name#matcher`; the MCP resolves it with
tree-sitter and attaches one file snapshot per referenced file. Lives in `mcp/references/`.

- **A snapshot declares itself.** Each carries `role: "ref-snapshot"` plus a `ref` block naming its
  source path, the canonical keys it backs, and (in snippet mode) its slicing as `(startLine,
  lineCount)` pairs. There is no manifest file and no reserved filename: a receiver classifies from
  the file entry it is already holding, so nothing has to be read, timed, or kept unclaimable.
- **The snapshot's bytes ARE its segments joined by newline**, which is why line counts alone
  partition it. `artifactBuilder`'s join and `RefPayload.payloadFor`'s slicing are inverses; break
  one and the viewer renders the wrong lines under the right header.
- **Grammars are COMMITTED wasm** under `grammars/`, built by `scripts/build-grammars.ts` from pinned
  npm sources. Never harvest a package's own prebuilt wasm: the 0.26 runtime will not load one built
  by an older CLI. Rerun the script and commit after changing a pin.
- **The canonical key is the contract.** It splits on structural separators BEFORE percent-decoding,
  and must be idempotent, since the MCP writes it and the console recomputes it from a tapped link.
- **Detection borrows the console's own vendored markdown parser**, so both sides agree by identity
  on what is a link. `linkify: false` is load-bearing.
- **Paths are shell-style:** bare is project-relative, `/` is filesystem root, `~/` is home.
- **The file tier fails loudly; RESOLUTION always degrades.** A moved line ships with a banner,
  because refusing to send over a stale pointer is worse than opening roughly in the right place.
- **Teaching lives in the plugin's own manifest** (`agent_instructions`), reached through
  `switchboard_capabilities` rather than the always-on block, which names capabilities and carries no
  guidance. `skills/crosstalk/SKILL.md` has the short version and points at the same tool.

### Capability union

A session's tools are gated on what the owner's consoles can render and what the host daemon has
configured. Consoles report loaded plugins at register into a durable `CapabilityStore` (14-day TTL,
500-device cap); the daemon declares its own at register into a separate `DaemonCapabilityStore` with
no TTL. A starting MCP reads both before the McpServer exists.

- **`/capabilities` serves the two sources APART, never pre-merged.** The sources own disjoint id
  spaces, so only a caller holding its own last answer can decide what to keep, and that decision
  needs to know whether the source owning an id spoke this round. Flattening first cost two silent
  capability outages: an OR'd `known` let the daemon's affirmative empty answer for console plugins,
  and the id-blind repair for that resurrected withdrawn capabilities out of the cache.
- The MCP carries forward PER SECTION: a source that spoke is taken as-is including an affirmative
  empty, a silent one keeps what it last said, and the result is written back whole. That is safe
  because every section in it is either a fresh answer or a byte-identical carry-forward of one.
- An ABSENT `enabledPlugins` / `daemonCapabilities` means that source said nothing and its prior
  report stands; an EMPTY array is an affirmative "nothing enabled".
- `unionCapabilities` folds a bundle for consumers that only need the list. Its `known` is an AND,
  meaning COMPLETE rather than "somebody spoke", and only the drift check reads it.
- **Both sides tolerate the pre-split shape**, because the plugin and the gateway update on separate
  triggers and the plugin usually leads. The MCP lifts a flat answer from either the wire or its own
  cache file into the `console` section; the route serves the flat fields beside the sections. Retire
  both once no pre-split gateway or plugin is still starting sessions.
- A daemon declaration is honoured only past the `HOST_WS_TOKEN` gate, so reaching the register path
  is not enough to announce a capability.
- Nothing is assumed when the gateway cannot answer. The fallback is the last answer that actually
  arrived and nothing else. `GATED_CAPABILITY_IDS` is the single list the gates derive from, held
  against the shipped manifests by a fixture test. The daemon's own id has no manifest to hold it
  against, so it is pinned separately.
- **The always-on block carries NAMES, never guidance.** Every surface `capabilityInstructions`
  appends to is length-capped by the harness, and the guidance outgrew it: the assembled block ran
  past the limit and the tail was cut with no error on either side, so a plugin's own examples
  silently never arrived. `switchboard_capabilities` serves the guidance instead, charging its length
  to a call rather than to every request.
- That tool answers from the STARTUP snapshot, since that is what the tool set was gated on. Its one
  fresh read only ever adds a drift warning; reporting it as the answer would describe tools the
  session does not have.
- A running session never changes its tools; a toggle is picked up at the next session start.

### Task board

The owner's task list, homed on the Gateway (`gateway/boardStore.ts`), edited by console ops and the
`/task-board` route, shipped to the phone on the `task-board:${ownerId}` plane. Entries are FLAT
(parent pointer + fractional `rank`); receivers rebuild the tree. Design record: `plans/task-board.md`.

- **The store is the sole validator.** Every write path resolves to one of the enumerated refusals
  (`BoardRefusal`, declared in `boardAuthority.ts`), and a refusal is an ok=false INSIDE the sealed
  reply (`refused: ` prefix) - the ONLY shape a client may retire a queued action on; every other
  failure retries. That prefix is the one signal that DISCARDS an owner's edit, so `refusalError` is
  its single producer and `board-refusal-residue.test.ts` fails the build if any other module under
  `src/` writes it.
- **A session's end is one mutation.** `sessionEnded` trashes done/cancelled and applies the caller's
  `boardDisposition` to the rest, and that disposition rides the `forget` op itself, so a session's
  end and its work's end cannot be ordered wrongly against each other. Required as a VALUE at every
  call site (the TTL sweep passes `release` explicitly), and set-valued server-side: everything the
  store holds for that session, never a list a client enumerated. The reply echoes what was applied
  and the console READS that echo, so a stale Gateway downgrading a `cancel` is reported rather than
  assumed away. The hook rides the deliberate forget and the sweep, never `SessionStore.forget`
  itself, whose rollback callers fire it for launches that never happened.
- **The pending queue is the OTHER writer to those entries**, and folding the disposition in does not
  order it. The console drops that session's queued writes when it forgets (`dropQueuedForSession`),
  because the disposition is the owner's last word on them; a dropped write takes its linked delete.
  Four console-side designs raced this before it was handled by supersession - read the plan's Bug
  Classes before reintroducing one.
- **`forget` needs its OWN local-Address check.** Its `resolveTmuxTarget` call sits inside a `try`
  the kill deliberately swallows, so without the explicit guard a foreign-Domain address whose
  gateway id collides with a local one forgets the same-named LOCAL session and disposes of its
  board work.
- **An invalid rank must never reach the durable file**: the wire schema would reject the whole file
  on the next restore. Four layers hold the line - store refusal, `rebalanceRanks` self-assertion,
  `endRank`'s re-check, and per-entry tolerant restore. Keep all four.
- **Board mutations are absolute but NOT monotonic**, so they ride the DurableOpStore layer like
  send/respond: a lost-reply retry surviving a restart replays the recorded reply instead of
  re-running over newer state. `isBoardMutationKind` is the one predicate both gates derive from.
- **A same-value write commits nothing.** Every setter reports unchanged, since a real commit fsyncs
  the whole board file synchronously.
- **State cascades, and the cascade is OPT-IN per write** (`boardCascade.ts`). A seed's own state is
  never rederived, or reopening a parent whose children are all done would close it again in the same
  breath. The one thing a walk cannot reach is a parent that LOST a child to a trash, move or delete,
  so `orphanedParents` derives those from pre/post rather than letting three call sites name them.
  Nothing is re-checked against `mayWrite`: a cascade is authored by the board, and gating it on the
  writer's authority would make the rule fire or not depending on who holds an entry they cannot see.
  The console does NOT reimplement it; a phone edit shows the cascade when the next snapshot lands.
- **claim/release are session-scoped and per-member**: claim refuses if ANY subtree member is held
  elsewhere; release lets go of only the caller's own members. The owner-authority cascade is
  `board_set_session` alone.
- **A board session is `(gatewayId, sessionId)`.** The stored `sessionId` is the bare local field,
  unique only within its Gateway, while a chat's `Team.name` is the qualified address. The conversion
  is one-directional and has exactly one owner per side: `consoleTargets.boardSessionKey` inbound
  (which refuses a foreign Gateway rather than folding it onto a same-named local session; a residue
  test pins `parseTarget` to consoleTargets.ts within console/) and `BoardManager.sessionKeyOf` on
  the console. Both resolvers answer NULL for an unknown session; a plausible wrong answer is what
  merged two machines' boards under one header.
- **A queued console edit retires on a gateway refusal and on nothing else.** No attempt ceiling
  discards it. A lane may step PAST an action that keeps failing, but never onto another write to the
  same entry, because these ops are absolute and reordering would apply the older value last.
- **A session's authority is a VALUE, never an absence.** Every mutating store method takes a
  `BoardActor`, and `mayWrite` is the ONE predicate behind subject scope, parent scope and the trash
  rule alike. Required rather than defaulted, so a new call site is a compile error instead of a
  silent permit. The console acts as `OWNER_ACTOR`; the `/task-board` route always as the session.
- **The six `taskBoard*` tools** (`mcp/board/boardTools.ts`, modelled on `codex/codexTools.ts`) are
  gated on the console plugin, since without it nothing the agent writes is visible to anyone. Each
  mutating call mints a private operation id: `create` derives its entry id from `(from,
  operationId)` so its replay is structural, and the route records settled replies for the rest.
  That record is in memory - see the route's own comment for what it does not cover.
- **A truncated projection is an id-sorted PREFIX**, so the console's cache carries forward only what
  lies past the cut. Merging the whole prior cache resurrects every deletion, forever.
- `BOARD_TRASH_TTL_MS` and `SESSION_RESUME_TTL_MS` are the same 30 days for unrelated reasons and
  must never share a constant.

### Board attachments

The owner attaches files to a task board entry from the console; agents read them and never write.
Bytes live in `shared/board-attachment-store.ts`, a durable per-entry store beside the blob cache and
deliberately NOT part of it: the cache evicts coldest-first and a board picture is by construction its
coldest object, so eviction there is silent permanent loss.

- **`board_set_attachments` is the SOLE committer of the field**, absolute like every other setter, and
  `upsert` IGNORES `attachments` on every incoming entry. A move ships a subtree verbatim, so honouring
  it there would store members no Gateway ingested.
- **The op declares `supplied`, and the Gateway stores what it can RESOLVE.** A member that is durable
  or cached is kept; one the sender says it is still uploading is a retryable error; one that is
  neither exists on no machine and is DROPPED and reported. That is what makes the op always
  satisfiable - see the plan's `Bug Classes` for the three rounds spent before this, all of them a
  queued op whose precondition the queue could not guarantee wedging its whole Gateway lane.
- **Presence is checked DURABLE-FIRST**, and every member resolves before any is adopted. The absolute
  op re-states survivors, so a cache-only check fails months later once the cache has swept, and a
  partial adopt leaves bytes no stored list names.
- **Three doors read bytes, not two.** `answerBlobOp` covers the HTTP route and the console's sealed
  plane; the federation export `serveBlobRange` is neither. All three go through `readBlobRange`, or a
  peer cannot reach an attachment whose cached copy was swept.
- **The `/task-board` list projects display facts only** (`filename`, `mime`, `size`), never `blobId` or
  `blobGateway`, and the ids live on a separate `attachments` action the fetch tool calls. A blobId is
  a bearer token and the list is the only place an agent could otherwise get one. Stripping is
  ROUTE-side: plugin-side would leak whole records during the gateway-first deploy window.
- **Console:** the local `src` rides `PendingBoardAction`, never the codegen'd `ConsoleOp` (a device
  path would cross the wire). A new queued op kind needs a case in THREE silent fallthroughs -
  `applyBoardOp`, `boardEntryIdsOf`, `entryIdOf`. Uploads run on `repoScope` outside the drain mutex;
  the drain only CHECKS readiness and charges an attempt when bytes are not up, because a head below
  the struggling threshold holds its lane closed.
- **An empty board is never permission to delete bytes.** `boardIsKnown` requires every Gateway to have
  entries: an empty snapshot is what a Gateway that lost its own board file answers, and in that case
  the phone holds the last copies.
- Files land under their BLOB name, not the display name, since a downloading device knows only the
  blobId and the owner can pick two `screenshot.png`. Above `BOARD_AUTO_DOWNLOAD_MAX_BYTES` a console
  waits to be asked; that is NOT a cap on what may be attached, which is the ordinary wire limit.
- **A cross-Gateway move carries its bytes**, as a CHAIN: upsert, then one `board_set_attachments` per
  entry that has any, then the origin's delete, each `dependsOn` the last so the delete drains after
  the destination holds them. Records are re-stamped to the destination, and a member this device
  never downloaded rides `fetchFrom` so the pull is restarted by the per-poll resume pass. `supplied`
  names ONLY what the device holds: claiming the rest would disable the Gateway's drop path and leave
  a picture that exists nowhere retrying forever behind a linked delete, which closes that lane.
- **`remove()` still reclaims nothing**, deliberately. It carries ids and no evidence the destination
  stored anything, and the console is the LAST component to update, so a reclaiming Gateway would
  destroy the only copy for every console still sending the old pair. A leaked directory per move is
  the accepted trade. See `plans/board-attachments.md` for the full reasoning and what closing it needs.

### Awareness pushes

A gateway-authored `channel_push` carrying `no_ack: true` tells a session something and asks for
nothing back. The envelope is general; its one producer is the board (`gateway/noAckPush.ts`).

- **`no_ack` is a plain field on `ChannelPushPayload`**, not zod, so it costs no codegen and opens no
  deploy window. `channelNotify` branches `instructions` on exactly `true` and passes the key through
  to `meta`, where the harness renders it as a tag attribute. Snake_case is load-bearing: a meta key
  failing `/^[a-zA-Z_][a-zA-Z0-9_]*$/` is dropped silently.
- **Nothing can ENFORCE no-reply.** The id carries its own `na-` prefix and names no job, so
  `respond()` absorbs a reply to it rather than letting one reach the agent as a 404 for doing nothing
  wrong. Gated on the store holding NO job for that id: a federated peer picks its own return-route
  key, so the prefix alone would let it park a real job and have the intercept eat the answer.
- **The instruction says do not reply, never "this is not a task".** One of the four kinds hands the
  session work, and the envelope flag cannot see which kinds a body carries.
- **BOTH holders of a touched entry are addressees.** Reading only the pre-state leaves a session
  silent about work it just gained, and strands a take-away when the owner immediately undoes one -
  the arrival supersedes it on the same bank key, which is why the bank keys on entry id.
- **Classified per entry from pre/post against `mayWrite` and `visibleTo`**, never from which method
  ran, so a method gaining a caller cannot change what is announced. An edit carries the id alone
  since a re-read resolves it; everything else carries the title, which the id no longer will.
- **`mutate` stages ids for ONE invocation and releases after `commit` returns.** Four exits never
  commit, and a store-level buffer would ship what they left behind on the owner's next write.
  `sessionEnded` and `sweepTrash` announce nothing; a rank-only reorder announces nothing.
- **The body is bounded and the liveness read is three-valued.** One console tap walks a whole subtree,
  and an uncapped body lands megabytes in a session that asked for nothing. Waking and gone are
  separate answers, or a session that never left is reported as dead, and the hold matches
  `WAKE_TIMEOUT_MS` rather than guessing lower.
- **The window is the only trigger.** An early flush on the session's own board call was tried and
  removed: it fired on the agent's own re-read of a notice, so every owner tap became its own push.

### Codex delegation

A session can hand a self-contained sub-task to a `codex app-server` thread it owns. The daemon
supervises one child per execution target; the gateway owns the durable record and is the only side
that decides anything.

**A fence is which child spoke, and how far in:** `(daemonInstanceId, targetId, generation,
lastEventId)`. Every fenced message carries all four and its own `eventId` IS the fence's high-water
mark, so a receipt and the events around it order by construction. `classifyFence` sorts an arriving
message into advances / duplicate / foreign, and **reconciliation is the ONLY path that may install a
fence which does not advance the current one** - re-establishing which child speaks for an agent is
what it is for.

**An acknowledgement retires the daemon's only copy.** So `ignored` and `applied` both permit it
(one changed state, the other never will) and only a withheld decision does not. A frame the gateway
cannot place is held, and a completed reconciliation is the single thing that supersedes an agent's
held frames - which is why the undecided set is keyed by agent even though the stream is per target.

**Reliable is not the same as fenced.** An activity event carries a generation because a fence orders
it, not because losing it matters. Commentary and refusals are sent once; acceptances, terminals and
interrupt results are retained until acknowledged and replayed across a gateway reconnect.

**A reader of App Server state returns what it KNOWS, and "could not find out" is one of the things
it can know.** Three separate two-valued readers each turned a silence into a definite answer, and
each one reported live work as dead. `ReadOutcome` and `runningTurn` are three-way for that reason;
so is anything added beside them.

**`thread/read` needs `includeTurns: true`** or it answers successfully with an empty `turns` array.
Nothing catches that but a live server.

**Notifications are dispatched in a microtask**, not inline. Resolving a request only SCHEDULES its
continuation, so an inline listener runs first and inverts wire order whenever a reply and a
notification arrive in one chunk - which is exactly what a steer and its own turn's completion do.

**A waiting call holds for less than the CLIENT can survive.** Node's fetch abandons a silent
connection at 300s, and `routerPost` reads that as a network failure and re-posts; since a replayed
operation is never re-dispatched, a longer hold could never deliver its answer at all. Hence
`CODEX_WAIT_BUDGET_MS`. A turn outliving it keeps running and `codexAwaitAgent` collects it.

**A refused REQUEST is not an unwell AGENT.** The result envelope only permits an error when the
agent is genuinely unavailable or recovering, so request-level failures answer HTTP 400 with
`CodexRequestErrorSchema` instead. Routing them through the result envelope shipped three 500s.

**The model is a parameter on start, never configuration.** It is fixed for a thread's life and one
child serves threads that may each want a different one, so it belongs on the call. It is verified
against the App Server's own `model/list` at the point of use, and an unoffered one is refused rather
than swapped.

**`ignored` and `failed` are not the same answer.** `ignored` means the frame will never apply and
the daemon may retire it; `failed` means this gateway could not build a record from it, which is a
fact about this code, so it is never acknowledged. Collapsing them let a reducer bug make the daemon
delete the only copy of a terminal.

**Enabling it:** the capability is announced when the `codex` CLI is found on `PATH`; no environment
variable is required. A session picks the tools up at its next start, never mid-session.

### Local agent mode

A session with no daemon serving a backend runs the child ITSELF (`src/mcp/local/`), so delegation
survives a Gatewayless setup. Installing the CLI is the whole opt-in on both paths.

- **The gate is reachability, not configuration.** `registerAgentBackend` takes the daemon's
  declaration when there is one, since it carries coordination this process cannot offer and its
  agents outlive the session; otherwise a `PATH` probe (`shared/agent-binary.ts`) decides. There is no
  flag on either side, and `daemonCapabilityDeclaration` announces from the same probe.
- **The tools do not know which one served them.** `AgentDispatch` is the seam: gateway dispatch posts,
  local dispatch calls `LocalAgentBackend.handle` with the very body it would have posted. The local
  host validates with the SAME `*GatewayRequestSchema` and parses its answer with the SAME
  `*AgentResultSchema` the route answers with, so a shaping mistake throws here rather than reaching
  Claude as a plausible wrong answer.
- **A refused REQUEST is not an unwell AGENT here either.** Both result schemas reject a busy code
  under an `unavailable` observation, so the runtime returns `{refused}` and the host shapes it as the
  request-error the route uses. Collapsing the two makes the answer unparseable.
- **ONE runtime, TWO published shapes, so the list is projected per backend.** `LocalListAgent` is
  Codex-shaped, and Codex's published row IS that record, so handing it over raw worked there and hid
  that Copilot's never matched (`operations`, bare turns, no timestamps, all strict). `copilotListAgents`
  therefore threw on every non-EMPTY list, which is worse than a broken read: start times out client-side
  while the agent really spawns, so list is the only route back to its id. `projectCopilotListAgent` in
  `copilot-agent.ts` is the sole owner of that field set (mirroring `projectCodexListAgent`) and both the
  gateway route and the local host go through it; `CopilotListAgentSource` is what makes handing over the
  wrong record a COMPILE error rather than a parse throw. A test cannot be the guard here on its own -
  the seam is a `.parse(unknown)`, and the empty list passes vacuously.
- **Child text is normalized where it is STORED, not where it is read.** Both backends bound
  `error.message` and refuse text that is not already `sanitizeAgentErrorText`'d, so trimming alone made
  an ordinary multi-line spawn failure unreportable: the answer threw on its own way out and the caller
  learned nothing about what actually broke. `errorText` covers every `fail()` site and `applyTerminal`
  at once.
- **What local deliberately lacks is what a wire needs.** No relay so nothing is fenced, no restart so
  nothing is durable, no HTTP so an operation cannot be retried behind the caller's back and needs no
  replay identity. Agents die with the MCP process, and the host target is the only one: a
  devcontainer target is something a daemon reaches across a boundary this process does not have.
- **A dead child must not stay cached.** The runtime memoizes its open session, so `LocalBackendSession`
  declares `onClosed` and the runtime evicts on it, identity-guarded so a late close cannot evict its
  successor. Without it every later call goes into a closed pipe and no replacement is ever requested.
- **An idle child is reaped** (`LOCAL_IDLE_REAP_MS`), because stdin-close was otherwise its ONLY
  release: measured at ~155MB flat per child, held for a whole session by agents that used it once.
  Gated on `threadsResumable`, which is a FACT about the backend rather than a policy - a codex
  thread is durable and its replacement resumes it, while an ACP session dies with the Copilot child,
  so only codex is reaped. The guard is a lease held across the WHOLE request in `handle()`, not per
  child call: a per-call lease releases between `startTurn` resolving and its turn record being
  written, and the reaper fires in exactly that gap. At every instant either that lease is held or an
  `activeTurnId` guards the child. `applyTerminal` stamps the idle clock itself, since a terminal
  arrives on the event stream and reaches no lease - without it a long turn is reapable the instant
  it ends.
- **Codex resumes a thread before any follow-up turn**, the way the daemon does. App Server may unload
  an idle thread, and starting a turn on an unloaded one fails.
- The child is reaped when stdin closes. Nothing else ever will, since no daemon supervises it.

**Residual risk, stated plainly:** a Codex thread holds workspace-write and network access for its
whole life, whatever its prompt says, and Switchboard enforces none of it. It can modify the
workspace and start subprocesses that outlive its turn; stopping a turn does not reach them. The
prompt is the only boundary, which is why the start tool's description is the safety story.

**Reconciliation never touches the turn a caller is waiting on.** Asking about a live turn makes the
daemon answer `recovering` whenever it cannot confirm that exact turn, which settles the wait and
reports running work as unconfirmed.

### Copilot delegation

A session can hand a self-contained coding task to a logged-in Copilot CLI through its ACP stdio
server. The gateway and host daemon mirror the Codex seams: one supervised child per execution
target, an authenticated session-owned catalog, durable operation ids, fenced relay frames, and
start / message / await / stop / list tools. Copilot follow-ups are accepted only after the previous
turn is idle because ACP does not expose Codex's steer operation.

**Enabling it:** the capability is announced when the `copilot` CLI is found on `PATH`; no environment
variable is required. Log in with the normal Copilot CLI (`copilot`, then `/login`); no external API
key is used or forwarded. The ACP client selects `gpt-5.6-luna` by default and enables Copilot's agent
permissions for the supervised target.

### Android app

- **Plugin framework** (`android/.../plugins/`): `Plugins` is the process singleton over a
  compile-time `PluginCatalog`; each extension point is a `PluginRegistry<T>` that auto-tags claims
  by plugin, so disabling one sweeps its claims. Dispatch goes through `forEachCaught` / `anyCaught`
  / `firstNotNullCaught`, so a throwing claim is logged and skipped. `threadDockSlots` is the
  exception (Compose values cannot cross a non-inline lambda).
- **Inbound pipeline:** subscribers fire synchronously inside the mailbox drain, before
  `mailboxSync.commit`, so they inherit the cursor's exactly-once. Deliberately not a `SharedFlow`.
  **A handler gets NO bytes**: a delivered message names its files and the blob plane fetches them
  afterwards, so anything a handler decides must come from wire fields alone. That is also what
  keeps a handler's single write ahead of any user action, so nothing it writes can be resurrected.
- **Row re-render:** `ThreadRenderer`'s `fingerprint` decides it, so anything that rides the row
  PAYLOAD and can change while the row is on screen has to be folded in, or the row keeps stale
  content forever. State pushed over the JS bridge instead (`window.thread.*` mutating in place) is
  outside it by design and needs no fold.
- **Presence authority** (`Presence.kt`): a session's facts reach the phone by TWO channels with very
  different latency, and NOTHING on the wire says which. The plane PUSHES the route Gateway's own rows
  on every poll (`presence.ts`'s snapshot walks only its own store; `applyPlanePresence` is the sole
  place a row is stamped LIVE); every OTHER machine is PULLED once per `DISCOVERY_REFRESH_MS`, which
  `PollDrain` calls "the one thing left with no push mechanism". A consumer reading a bare value
  silently assumes push latency and is wrong for every machine but one - which is why waking a session
  on another machine showed a blank terminal until its handshake landed, and why the composer's wake
  notice fired on the wrong sessions.
  - **The status string is PRIVATE and `Presence`'s constructor is private.** The fix is not an
    accessor, it is that `status == "available"` cannot be written at all: every question is a member
    (`isLive`, `isOnline`, `word`, `mayHavePane`, `authoritative`), and a presence field added later
    inherits the authority for free. That is the difference between fixing this defect and its class.
    `presence-authority-residue.test.ts` is the backstop, in the TS suite so it blocks a PR (the Kotlin
    tests run after merge), with positive controls so an empty sweep fails instead of looking clean.
  - **A local action is a RECEIPT, never a status override** (`ActionReceipt`). This device's own
    request is the freshest fact it holds, and `wakeSession` used to throw it away and then wait to be
    told what it already knew. Scoped by opId, so an overlapping wake and relaunch cannot retire each
    other's. Carries an outcome rather than only a time, because "asked", "accepted" and "failed" are
    three different things a timer expresses none of. **Evidence always outranks it**: a row reporting
    the session up retires the receipt rather than being overridden by it, since an optimistic value
    that can outrank a real report is a UI that lies, which is worse than one that is late.
  - **The TTL is a bound, not the expiry that matters**, and must stay longer than one discovery
    interval (asserted in `PresenceTest`). Shorter, and a slow cold boot expires it before the roster
    has spoken once, putting the blank terminal straight back.
  - **UNREACHABLE peeks nothing.** A held row from a gateway the last discovery could not reach says
    only what that machine WAS, so acting on it is a guaranteed round trip to nothing. Without it a
    wake tap on a powered-off machine becomes a peek every couple of seconds for the receipt's whole
    life. Residual: a machine the Router still believes is connected is not stamped UNREACHABLE, so
    that case costs ~a dozen failing peeks before the receipt ages out (`failCount` backs the loop off).
  - **A non-authoritative row is probed ONCE per terminal mount**, rather than trusted or polled
    forever. A POLLED "available" is not evidence, but peeking it every cycle is the cost the idle gate
    exists to avoid; one op settles it.
- **Working / needs-login** (`ChatState.working`): the presence plane FIRST, a local peek only as the
  fallback. A peek lands solely while that session's terminal is on screen, so reading it first froze
  the thread's chip at whatever it saw last time. Every screen also declares its own focus intent, and
  `onForeground` re-declares the last one, or the cadence those chips arrive at sits at the background
  floor while a thread is open.
- **Session card rungs** (`SessionCardPreview.kt`): a PURE function decides which of the headline,
  board line and snippet show and what each is stamped with; the composable paints what it is handed
  and derives nothing. It lives outside `SessionCard` because the inline version was patched twice
  with no test able to reach the rules. The card reports what the SESSION is doing: the headline is
  its own last reply, and the owner's own row never takes a rung. Each rung carries its OWN row's
  time, and the bottom one is `lastActivity`, which is what `sessionOrder` ranks on, so the column
  reads in order.
- **The card's board branch** (`cardBranchOf`): the root is always kept, contiguous finished runs
  collapse to one rung, and what is left is a window around the session's current entry. A prefix
  filled every slot with finished titles and hid the entry being worked on behind the count.
- **One-line rows** (`oneLine`): ASCII whitespace collapse for a row that cannot show a second line,
  which is the card's rungs, the notification shade and `BoardStrip`'s. Wrapping rows do not call it.
  Sanitizing invisible or bidi characters was tried, drew four audit findings, and was ruled out; see
  `plans/pain-points.md` before reintroducing one.
- **Unfinished gateway enrollment** (`PendingEnroll.kt`): the owner-signed admission goes out BEFORE
  any delivery is attempted and has to, since `sealBundle` carries that same admission inside the
  bundle and rolling it back would break the paste fallback that is the whole recovery path. So an
  interrupted enrollment leaves a real keyring member that never received a byte, and the Gateways
  card could not tell that apart from a machine that is switched off. The record is durable (the
  interruption it exists for is the app being KILLED) and written before the POST, not after a
  failure. `gatewayCardState` is the pure precedence: a session outranks the record, because a
  session proves the bundle landed and a stale record must not argue with that. `resumeEnroll`
  re-posts the SAVED bundle, since it is still sealed to that Gateway and still carries its
  admission - but only while that Gateway is on the arming it was sealed against, which is why a 404
  says to re-arm and re-scan instead of offering a paste that hits the same refusal.
- **Terminal copy** (`TerminalCopy.kt`, `TerminalAnsi.kt`): a pane is a fixed grid, so a link longer
  than a row arrives split across rows and every row arrives padded to the pane edge. `trimLineEnds`
  drops that padding before the frame renders, keeping only cells carrying a background or reverse
  (a tmux status line and a selected row both colour out to the edge), so a selection copies text
  rather than blank cells. `selectedUrl` joins the rows back when what survives is ONE whitespace-free
  URL with a scheme, and that same answer both rewrites the clipboard and arms the open button under
  the Paused banner. Two things this cannot do differently: tmux's own `-J` already rejoins rows tmux
  wrapped at the margin, but a TUI computing its own line breaks is never marked wrapped, so the join
  has to happen on this side; and the COPY is where a link becomes legible at all, since Compose keeps
  `Selection` internal and nothing can read what sits under the handles until it is copied. The button
  opens any scheme an installed app claims, unlike a message link, whose set is fixed in `LinkMenu.kt`
  - that one carries a scheme an agent wrote, this one carries what the owner selected by hand.
  - **The padding is dropped TWICE, on purpose.** `-J` is what preserves it (tmux(1): "-J preserves
    trailing spaces and joins any wrapped lines"), so `shared/pane-trim.ts` drops it at capture to cut
    the polled frame by a quarter, and `trimLineEnds` drops it again at render because the daemon and
    the console update on separate triggers and an older daemon still ships padded frames. Trimming is
    idempotent, so the second pass is a no-op rather than a second opinion, and `tests/fixtures/pane-trim`
    holds both to the same rows so they cannot drift. The daemon hashes the TRIMMED bytes: the peek
    reply's 304 is answered against what the console actually received.
  - **Colour-blind trimming is the wrong rule and looks right.** Only trailing spaces carrying no
    background and no reverse are padding; a painted cell colours out to the pane edge and is content.
    Measured on a live pane, 24 padded rows of which two had to be kept - few enough that eyeballing
    the result proves nothing. It is also why dropping `-J` is not the free version of this: tmux
    trims colour-blind, and the join is what the whole link copy depends on.
- **Designer plugin:** docks a `design-card` file from its declared title/group/dimensions the
  moment the message lands, and resolves the bytes at RENDER from the live row (content-keyed, so an
  older revision cannot lend its bytes). A card therefore exists before its bytes and says whether
  it is downloading or gave up. Backed by its own per-team `DesignStore`.
- **Unread tracking:** a per-team `ReadAnchor(epoch, seq, at)`. Mailbox epochs are random and never
  ordered, so an anchor resolves to its row by EQUALITY only and unread is a pure positional count.
  Reads drain by scroll position, not by opening; `thread.js` walks a monotonic pointer against live
  layout because IntersectionObserver cannot fire on a bottom edge.
- **Idle pushback** (`IdlePushbackManager.kt`): background poll cadence backs off the longer it stays
  silent, releasing the wakelock for wall-clock-aligned `AlarmManager` wakeups at the deeper tiers.
  A fresh mailbox entry resets the ladder.
- **TTS playback** (`PlaybackRequests.kt` / `SttsPlayer.kt`): the request lifecycle is a pure unit -
  claim, sound, exactly one terminal, nothing after - and `SttsPlayer` owns only the effects. Every
  event is minted AND queued inside the same locked section as the state change it reports, so
  delivery order is transition order and no consumer reconstructs it. `PlaybackResidueTest` fails the
  build if anything else mints a `PlaybackId` or an event, or if the registry grows a platform import
  (which would end its unit-testability). A cache warm-up deliberately holds NO claim: it is not
  something a consumer can see or stop, and a purge reaches it through the epoch, which also covers
  the gaps between its writes where a claim cannot exist. A tap toggles on what is AUDIBLE, never on
  the claim, because a row cannot show a request that is only synthesizing.
- **Autoplay yields, people do not** (`PlaybackQueue.kt`): `PlaybackOps` owns the queue and advances
  it from playback terminals under one mutex; `SttsPlayer` stays a one-shot engine. A request declares
  whether it YIELDS, and `sound()` decides: a yielding one that finds the sound taken stands down and
  reports its own terminal instead of displacing. That belongs there rather than at the call sites,
  because a request handed to the engine arrives long after any caller is left to ask - a cache miss
  is bounded only by the transport's timeout. Consequence worth knowing before adding a caller-side
  guard: `advance` installs the next entry as the head BEFORE returning it, so a caller that declines
  to speak it strands an entry no terminal will ever retire. Hand it over and let it yield.
- **Spoken boundary markers** (`ChatRepository`'s marker sequencer): a run plays chime, then a sentinel
  naming the session, then the body, as SEPARATE gapped playbacks - never concatenated, because
  providers differ in container. A marker is an ordinary request under the reserved `_marker` team, so
  it inherits one-terminal and ordered delivery; the chime alone does not yield, since standing an
  instantaneous sound down drops the boundary rather than delaying it. `playMarker`/`playChime` return
  WHICH request will report, and the sequencer matches terminals against it - matching on "which entry
  is playing" instead let a torn-down run's marker drive the current one and swallow its message, four
  times. Cached speech is keyed on the WORDS, not just the entry, because one message is spoken two
  ways: attributed when played by hand, unattributed inside a run where the sentinel already said it.
  A RESUME never re-announces (`parkedAnnounced`): a pause parks the entry its markers already
  introduced, and the transport's play button is not a new run.
- **Per-row play state** (`playStatesFor`, `setPlayStates`): the repository ANSWERS what each row is
  doing; consumers do not accumulate it from events. A row is painted as it is built as well as on
  push, since state changes when playback does, not when a row re-renders.
- **Four surfaces, one answer** (`SttsTransport.kt`, `QueueBubble.kt`, `QueueSheet.kt`, plus the
  in-thread row): the lockscreen/shade transport, the floating bubble, the queue sheet and the row all
  READ from the repository and hold no playback state. They redraw off `onTransportChanged` and
  `queueRevision`, which fire after the queue has SETTLED - a raw playback event fires before the
  terminal it reports has advanced anything, so a surface painted from it shows the state from just
  before the advance with no later event to correct it. The bubble is plain Views because a Service
  carries none of the three ViewTree owners a `ComposeView` needs. The sheet is reachable from the
  bubble, the transport notification AND the board header: the first two are permission-gated, so
  without the third a user who refuses both has no pause and no skip at all.
- **Giving up on a sound states whether its position survives** (`SttsPlayer.abandon`): a pause, a
  skip, a trash and a genuine displacement all end as PREEMPTED and disagree about the resume offset,
  so the caller declares intent (`remember`, no default - the compiler demands it) and the engine
  answers whose position it is and which recording it points into. Markers and the settings sample are
  never resumable: a marker's cache key is the words it speaks, shared by every run of that session.
- **The queue warms its own backlog** (`SttsPlayer.warm`, driven from `ChatRepository.warmQueued`):
  every queued entry synthesizes ahead of its turn on a 3-wide pool, keyed on the words the RUN will
  speak rather than the attributed form a hand-play uses, or the cache fills and playback still
  synthesizes live. Holds NO claim - a warm-up is not something a consumer can see or stop, and a
  purge reaches it through the epoch. Keeps going while PAUSED, since a pause means the person is
  busy, not that the work should stop. The measured duration is the by-product that lets a queued
  tile show its length instead of a spinner.
- **Audio focus** (`SpeechFocus.kt`): held for a RUN, `AUDIOFOCUS_GAIN_TRANSIENT` so the user's music
  resumes, released at the end and on a HAND pause. A pause the focus system itself caused KEEPS the
  request (`focusHold`), or releasing drops the listener and the GAIN that would lift that pause
  never arrives, which left a call ending with the run still parked. A DUCKABLE loss keeps
  speaking (`focusAction`):
  it is what a notification ping raises, and pausing on it killed every run, since the transport
  releases focus while paused so no GAIN could ever arrive to lift it. A refused request does not
  pause either, for the same reason: it registers no listener. `ACTION_AUDIO_BECOMING_NOISY` is its
  own receiver because unplugging a headset is a route change, not a focus change.
- **`transportPaused` normalizes in its GETTER**, so a pause cannot be observed over an idle queue. The
  rule lived at the writers through three rounds and each new way of emptying the queue reintroduced
  it; at the value, a future one cannot.
- **Attachment viewer** (`AttachmentViewer.kt`): one fullscreen sheet for every tapped file. Which
  stage it shows is decided by `viewerDecodableImage` in `AttachmentDisplay.kt`, never by a mime
  prefix, because the two renderers disagree in BOTH directions (the WebView draws SVG that
  BitmapFactory cannot; BitmapFactory decodes HEIF that the WebView cannot), so the viewer's set is
  not the thumbnail set.
  - `ZoomMath.kt` owns the arithmetic, free of Compose so it is unit-testable. The layer scale is NOT
    the zoom percentage: `ContentScale.Fit` has already scaled the bitmap and a downsampled one
    covers `sampleSize` source pixels per bitmap pixel, so a preset cannot be a constant. Both ends of
    the pinch range are derived per image, since which of fit or 200% is outermost flips with image
    size. The real gate is an emulator check that 100% is 1:1; the unit test cannot see the
    Dp-versus-pixel seam at the call site.
  - `TextPeek.kt` decides text-vs-binary for the preview stage. `CharsetDecoder` does the classifying,
    because it already separates a character truncated by the peek window from bytes that cannot
    appear in the encoding. `String(bytes)` cannot be used: it substitutes U+FFFD and never fails, so
    every file would classify as text.
  - `SaveTarget.kt` is the SAF half of Save. Downloads via MediaStore is the other half and is the
    only one reachable before a folder is picked. A stored grant is re-validated on every read, and
    `SaveOutcome` keeps "the folder is gone" apart from "the write failed", because only the first
    should send the user back to the picker.
- **Composer drafts:** one `Draft(text, files)` per team in the store, not composer-local state, so
  picked files cannot follow a tab switch. `takeBackIntoDraft` is the single write path back to the
  composer: files UNION, text lands only on a blank draft.
  - `DraftStrip.kt` draws them: collapsed to a fixed-height scrolling strip, expandable to the
    transcript's own layout. Tiles are keyed by FILE, never by position, because a removal shifts
    every later file down a slot and a positional key would leave the old bitmap on a tile whose
    remove badge now deletes a different file. The expand state is composer-local and must stay that
    way; it describes the view, not the draft.
  - `ThumbCache` is the one bitmap cache both thumbnail producers share, bounded in bytes and keyed
    per producer so a design card and an image cannot collide. It holds no lock: serializing renders
    is the WebView producer's problem, and a decode must not queue behind a card capture.
  - `ImageThumbs.sampleFor` bounds a decode by TWO rules, and both are load-bearing. The short edge
    decides sharpness (the tile centre-crops), and a ceiling on the long edge is the only thing that
    binds an extreme aspect ratio. Without the second, a stitched screenshot decodes at full size to
    fill a 64.dp tile and the OOM is swallowed into a blank tile.
  - Where a picked file CAME FROM rides `Draft.locations`, keyed by src, and is shown only in a
    draft-opened viewer. It is on the Draft rather than on any file type so the conversion outward
    has nowhere to put it: a device path names a user and a folder layout, and these cross a gateway
    to another machine. `PickedLocation` takes ONE segment from the SAF document id, never a chain.
    Pinned by `draft-location-residue.test.ts`, which is in the TS suite ON PURPOSE, since the Kotlin
    tests run after merge and could not block a PR. Every Draft writer must COPY rather than rebuild,
    or the map is silently dropped.
- **Scheduled send:** client-local, no wire shape. At most one banked `ScheduledSend` per team, one
  shared alarm on the earliest record, all firing funneled through a mutex-guarded path so a warm
  kick cannot double-convert.

## Development

### Commands

- `bun run lint` - Biome CI + tsc
- `bun run test` - vitest
- `bun run build patch|minor|major` - the release ritual; see Deploying > Plugin
- `bun run build --build-only` - bundle `dist/` without bumping or committing
- `bun scripts/codegen-kotlin.ts` - regenerate `proto/Protocol.kt` after editing a shared schema; CI
  fails on drift
- `bun scripts/check-module-residue.ts` - verify node_modules against bun.lock
- `bun scripts/sync-leaf.ts <path>` (or `--all`) - re-sync a synced leaf
- `bun scripts/import-stts-voices.ts` - regenerate the TTS voice lists. To refresh a provider, drop a
  fresh export at `data/stts-voices/<provider>.json`, run this, commit both files. CI drift-checks it

### Pull before every follow-up edit after a push

`gitPushNewBranch` moves commits to a branch and resets local `main` to `origin/main` while the PR is
still merging, so for a minute or two the tree does NOT contain the work just pushed. Editing in that
window silently applies to a tree missing the feature, and a scripted replace finds nothing and
reports success. This has bitten three times in one session.

Run `gitFetch` then `gitPull` after any push before touching a file. Treat a non-empty
`git log main..origin/main` as a hard stop. When scripting an edit, assert the match before writing.

### Verify locally before pushing, especially Android

`ci.yml` does NOT compile or test Kotlin. It runs the TS lint/test plus the codegen and stts drift
checks; Kotlin builds only in `main-push.yml`, AFTER the merge. So a Kotlin compile error lands on
`main` before any gate catches it. Greps cannot see this class of break (an over-matched Compose
`Switch` rename and a mangled verb both passed every grep and the full TS suite, twice).

```bash
source ~/android-dev/env.sh     # puts java/adb/emulator/gradlew on PATH
cd android && ./gradlew :app:testDebugUnitTest --console=plain
```

Treat that as the Kotlin gate the way `bun run lint && bun run test` is the TS gate. For a wire-shape
change, run the codegen first so the new types are exercised.

`testDebugUnitTest` runs UN-minified. Both variants R8-minify, so a renamed `@Serializable` class or
a dropped JS-bridge method only shows at `assembleRelease` or on-device. Keep-rules live in
`app/proguard-rules.pro`; the `@JavascriptInterface` keep is load-bearing (AGP's default misses it,
since the bridge is an anonymous object rather than a WebView subclass).

The sibling **evie-bot** repo has its own gate: `bun run lint && bun run test`, run INSIDE its
devcontainer (the host node is too old for vitest 4). Its `Push (main)` gates deploy behind lint, so
an unlinted change merges but SKIPS the rollout. Run it after editing any synced leaf.

### Look at the console yourself: the `emulator` build

A third build type beside debug and release. It exists because the console cannot get past onboarding
without a real Gateway, so every visual question otherwise costs the owner a screenshot. Reach for
this before asking a human to describe a screen.

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:assembleEmulator
adb install -r app/build/outputs/apk/emulator/switchboard-emulator.apk
adb shell pm grant com.atelier_nyaarium.switchboard.sandbox android.permission.POST_NOTIFICATIONS
adb shell am start -n com.atelier_nyaarium.switchboard.sandbox/com.atelier_nyaarium.switchboard.MainActivity
adb exec-out screencap -p > /tmp/shot.png    # then Read the png
```

**Shut the AVD down when the feature or plan is done** - it does not exit with your session, and an
idle one still costs ~4.5% of a core and 4.4 GB. One left running burned 8 CPU-hours over 8 days,
which was more than every other process on the machine combined.

```bash
adb emu kill
```

- Installs BESIDE a real install (`applicationIdSuffix = ".sandbox"`), so it cannot overwrite the
  owner's app or data.
- All sandbox code lives in `src/emulator/`, so the onboarding bypass is not compiled into debug or
  release at all. `seedSandbox` is the only seam in shared code and is build-type guarded.
- `SandboxFixtures` is scaffolding, not a spec. Bend it to whatever is being looked at.
- Seeding bypasses the mailbox drain, so no inbound plugin handler runs. Anything a receiver decides
  from wire FIELDS (hiding a ref snapshot, a card's title) is unaffected and renders correctly;
  anything a handler has to record on arrival must be seeded directly, the way `SandboxApp` upserts
  design cards into `DesignStore` after `seedSandbox`.

### Dependencies

EXACT pins, no ranges: the plugin launches via `bun run` and a caret range would let any start pull a
brand-new release. Dependabot (daily, 7-day cooldown) is the updater; `overrides` pins transitives
with known advisories. After any manifest change run
`rm -rf node_modules && bun install --frozen-lockfile`, then `scripts/check-module-residue.ts` - bun
never prunes nested node_modules dirs the lock stopped sanctioning, and a stale nested copy silently
shadows the pinned version for both tsc and runtime.

### Synced leaves

Some `src/shared/` modules are the source of truth for a wire shape shared with a sibling repo and
are copied VERBATIM. Each carries a `// SYNC-HASH:` of its body, and each repo's CI fails on a
mismatch.

| Source | Copy |
|--------|------|
| `notice.ts` | `nyaaskills/src/shared/notice.ts` |

`crypto.ts`, `admission.ts`, `router-protocol.ts` and the eight `federation-*` modules were leaves too,
mirrored into evie's bridge. They are ORDINARY modules now: the Router serves federation itself, evie
holds no copy, and their stamps came off with the copies. `federation-lifecycle.ts` stays a pure
barrel over the seven per-flow `federation-*` files, for readability rather than for a second repo.

The CI list lives in `.github/workflows/ci.yml`; a new leaf needs a row there and in its own repo.

Always use `bun scripts/sync-leaf.ts <path>`. FOOTGUN: the order is format, restamp, copy. Copying
first and running `lint:fix` after reformats the SOURCE, staling both the stamp and the copy, and the
sibling repo's CI fails on the hash. The script runs biome first so a later `lint:fix` is a no-op.

### Code style

Biome: tabs, double quotes, semicolons, 120 char width. Files follow categorized sections:

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

### Environment variables

**Gateway (Docker):**

| Var | Meaning |
|-----|---------|
| `PORT` | HTTP/WS port (default 20000) |
| `GATEWAY_ID` | This Gateway's id (default: sanitized hostname) |
| `HOST_WS_TOKEN` | Secret the host daemon presents for the reserved `host` slot. Fail-closed. Auto-provisioned into `.env` by `start-gateway.sh` |
| `FEDERATION_DOMAIN_ID` | Domain id. NOT fail-closed; the enrollment-delivered `domain-id` file takes precedence |
| `DATA_DIR` | All durable state (default `/app/data`), deliberately separate from the log volume so clearing logs cannot wipe federation identity |
| `FEDERATION_DIR` | Keypair, allowlist, transport.json, domain-id (default: inside `DATA_DIR`) |

**Federation Router (Docker, its own compose project):**

| Var | Meaning |
|-----|---------|
| `FEDERATION_BIND` | The LAN address the Router binds and advertises. DETECTED and written by `scripts/lib/routerStart.ts` on every start (`detectLanHost`, the internet-facing interface), never typed: a DHCP move lands in `.env` before compose reads it. `setup-verify.ts` and `setup-provision.ts` probe the same value, so the probe, the check and the emitted blob agree |
| `FEDERATION_PUBLIC_HOST` / `FEDERATION_PUBLIC_PORT` | Where the Router is reached from OUTSIDE, the one thing setup asks (`2) Admin Provision`, prefilled on a re-run). Empty host means LAN only and the port is not asked; the port is only advertised when it differs from the Router's own |
| `FEDERATION_WS_TOKEN` | Bearer the gateway presents at the Router's WS upgrade. Fail-closed. Minted into `.env` by `start-federation.sh` |
| `CONSOLE_BRIDGE_TOKEN` | App token every console presents on the op surface. Fail-closed. Minted into `.env` by `start-federation.sh`; `export:federation` carries the cluster's across so already-provisioned consoles are not turned away |

Nothing in this table is hand-edited. Every key is minted, detected, or prompted for by
`start-federation.sh` / `setup.sh`, which is why there is no `.env.example`.

**Host daemon:** `HOST_WS_TOKEN` and `BRIDGE_ROUTER_URL` as above. The daemon announces each
capability when its corresponding CLI is found on `PATH`; no environment variable is required.

**MCP plugin (container):** `PROJECT_NAME` (required for crosstalk), `BRIDGE_ROUTER_URL` (default
`http://switchboard:20000`), `AGENT_TYPE`, `PROJECT_HOST_PATH`, `MCP_CONNECTOR_PORT`,
`MODEL_SIMPLE` / `MODEL_STANDARD` / `MODEL_COMPLEX`.

### Testing

Tests live in `src/__tests__/`. `bun run test` for all, or `bun run test <path>` for one.

**vitest runs its workers under NODE, while the gateway, Router and daemon all run under bun.** So a
difference between the two runtimes is invisible to the whole suite, and node is the forgiving one:
`ws` is the real package there, where bun substitutes its own. Certificate pinning passed 2600 tests
while refusing every connection in production for exactly this reason. `bun run check:pinning`
(`scripts/check-pinning-runtime.ts`, a CI step) is the gate that runs on the shipping runtime; reach
for the same shape for anything else whose behaviour is the runtime's rather than ours.

### Debugging the console on-device

The release ships `switchboard-debug.apk` beside `switchboard-release.apk`, signed with the SAME key
so it installs over the release build and back. The debug build flushes `DebugLog` to the Router's
`POST /ingest` each poll cycle; release never does. The in-app updater is variant-aware, so getting
onto debug requires sideloading once.

```bash
docker logs switchboard-federation --since 15m 2>&1 | grep '\[console-ingest\]'
```

`DebugLog` already traces the enroll scan and the poll/drain flow (`[Poll]`, `[Drain]`). **A log line
is never private:** it ships off-device and stays on logcat, so never embed a bearer credential,
invite nonce, or minted secret. Only opaque ids, HTTP codes, and non-secret fields.

### Restart ritual, and starting a host session by hand

`./down.sh` kills the host-daemon tmux along with the gateway, and `./start-gateway.sh` does NOT
bring it back. Always run `./start-host-daemon.sh` after. A forgotten daemon is silent until wake,
peek, and session spawn all fail with `host daemon offline`; this cost a full outage once.

The three start scripts do NOT behave alike, and the difference decides whether new code is running:

- `start-gateway.sh` always cycles (`compose down` then `up --build`), and `git pull`s FIRST, so it
  can move the tree before it builds.
- `start-federation.sh` never brings the Router down. Plain `compose up`, so an unchanged Router
  keeps running and only a config change recreates it - deliberate, since recreating drops every
  gateway. It therefore does NOT pick up new Router code; use `--build` against its own compose
  project for that.
- `start-host-daemon.sh` kills a running daemon and relaunches it. It used to decline with "already
  running", which left the old build serving while reporting success - invisible until wake, peek
  and spawn failed. The daemon is the one component whose staleness has no immediate symptom.

`./down.sh` is the ALL-components stop: gateway, federation Router, host daemon, and both networks.
Bringing it back is three scripts, and the Router is its own compose project so it starts and stops
on its own trigger: `./start-federation.sh && ./start-gateway.sh && ./start-host-daemon.sh`. Order
between the first two does not matter - both create the shared `switchboard-federation` network if
it is absent, because compose declares it external and `down.sh` removes it. Verify the whole path
with `./setup.sh --verify`, which checks the Router answers and that the Gateway is REGISTERED with
it rather than merely running.

Router ops worth knowing: back it up with `./backup-federation.sh` (it refuses while the container
runs, since the store is single-writer, and it archives the two tokens from `.env` alongside the
data volume because a data-only restore authenticates nobody). Host clock drift breaks signed
proofs and invite expiry, so keep NTP running. The Router's cert is minted once and never rotated -
rotating it re-provisions every enrolled Gateway and phone.

A session's identity and its channel hearing BOTH ride the daemon's launch command, so a bare
`claude --resume` on the host comes up broken in two silent ways: it registers under a fresh derived
name (the phone thread and board claims stay keyed on the old one), and the harness drops every
channel push because the plugin is not in the session's channels list. The working manual form is:

```bash
PROJECT_NAME=host.<id> claude --resume <transcript-uuid> \
  --dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium
```

Prefer waking the session from the console once the daemon is up; the daemon composes all of this.
The MCP's own stderr (its `[bridge]`/`[channel]` lines, and the harness's "Channel notifications
skipped" line that is the deafness signature) lands in
`~/.cache/claude-cli-nodejs/<project-dir>/mcp-logs-plugin-switchboard-switchboard/`.

## Deploying

### The four components update on SEPARATE triggers

Each path below is documented on its own, which hides the consequence: nothing here updates
together, so any shared shape meets an older peer on both sides.

| Component | Updates when |
|-----------|--------------|
| MCP plugin | a marketplace pull, i.e. any session restart under autoUpdate |
| Gateway | a manual `./down.sh && ./start-gateway.sh` |
| Host daemon | `./start-host-daemon.sh`, separately again |
| Console | whenever the owner opens the app and takes the update |

The plugin usually leads, because it is the only one that updates without anyone deciding to. So a
new wire field must be OPTIONAL at the gateway and tolerated on both sides, and the deploy order is
gateway first, then the version-bump push. Shipping the bump first opens a fleet-wide 400 window on
every strict schema that gained a required field. This has caused a high-severity outage.

### Plugin

1. Commit your source work. The build script refuses to start on a dirty tree.
2. `bun run build patch|minor|major`.
   - It bumps `package.json`, sets that value into `plugin.json` and every console plugin manifest, bundles `dist/`, and commits as `Build X.Y.Z`.
3. Push.
4. Reload on target containers with the `reload_plugins` tool, not the `/reload-plugins` slash command.

Never hand-edit a version field. `src/mcp/index.ts` and the APK `versionName` derive from `package.json`, and the build script verifies those derivations rather than writing them.

The marketplace reads `plugin.json` to decide whether an update is available. A stale version there silently skips the update.

`.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/dist/main-mcp.js`. Dependencies are bundled into that file and `web-tree-sitter.wasm` is copied beside it, so the plugin needs no install step and no bun on the machine running it. `dist/` is committed for that reason.

Only the MCP entrypoint is bundled. The gateway runs in Docker from `oven/bun:1` and the host daemon runs on the host under tmux, so both keep running from source under bun.

### Installing

Listed under [`atelier-nyaarium/claude-marketplace`](https://github.com/atelier-nyaarium/claude-marketplace)

```bash
# Install my marketplace once
claude plugin marketplace add atelier-nyaarium/claude-marketplace

# Install switchboard
claude plugin install switchboard@atelier-nyaarium
```

### Federation

One repo, one machine, no cluster. The gateway-to-Router WS is admission-only, no bearer fallback.

1. `./setup.sh`, and nothing before it. The menu reads state before it draws (`setup-status.ts`:
   LAN, public reach, Router, fingerprint, Domain, this gateway, and a `Gateways` roster of what the
   Router holds for the admin Domain, via the app-token-gated `gateways` op), and its option labels
   are chosen from that same state, so what an option WILL do is what it says.
2. `2) Admin Provision` asks the one thing it cannot detect, the public host and (only then) port,
   writes `.env`, and brings the Router up itself through `scripts/lib/routerStart.ts`, the same
   module `start-federation.sh` execs. `docker compose up` leaves an unchanged Router running and
   restarts one whose reach moved, so re-running is enter, enter. It then reads the Router's state
   (stop, write, start when it stages a pending admin Domain, since the store is single-writer) and
   emits the transport-only blob: `transport: direct`, the public `routerUrl` (LAN when no public
   host), the leaf fingerprint read from the running Router's `/health`, and the app token from
   `.env`. It refuses to run if it cannot read the state file, because an empty read looks like "no
   Domain" and the fresh branch would stage a pending Domain OVER a rooted one - that exact misread
   happened once, stopped only by the display-name prompt.
3. Domain id is not fail-closed; a gateway without one arms for enrollment. A creds-less secondary
   gets it from the sealed bootstrap bundle. `1) Setup Gateway` arms this gateway, shows its admit
   payload, waits for the phone's sealed bundle, and connects in-process with no restart. Its
   `transportInstalled` accepts ONLY the direct shape, the same rule as `loadRouterTransport`, or the
   menu says "already enrolled" over a file the gateway itself reads as "arm for enrollment".
   - **The payload and the wait are ONE screen** (`EnrollSettle`), and there is no action between
     them. A keypress used to sit there labelled "Done. Continue Enrollment", which promised a next
     step that did not exist and let an admin walk past the comparison without making it and then
     have no way back to it. `readKeyWhile` is what makes settling possible at all: `ask` is Bun's
     global `prompt()`, which blocks the whole event loop, so nothing could poll for the phone behind
     it. Raw mode buys the concurrency, restores cooked mode on every exit, and re-raises ^C by hand
     because raw mode swallows it.
   - **That screen prints the SAS**, `fingerprint(signPub)` from the same admit payload. Its twin is
     Kotlin's `Crypto.fingerprint`, and the phone's own confirm screen says "Confirm this matches the
     Gateway terminal" - which was asking for a comparison against a value the terminal never showed.
   - **The countdown is stamped where `armGateway` returns it**, before the health wait, so it runs
     EARLY rather than late. The gateway owns the real timer; health-wait plus payload-fetch can eat
     75s of the window before the QR is even on screen. Re-arm is offered at ALL times, not only past
     the deadline: the options print once and only the status line is rewritten, so a listing gated on
     expiry would contradict the status line above it.
   - **No `lan` block means no listener was ever opened** (`generateEnrollCert` returns null for a
     non-IPv4 host, `0.0.0.0`, or an openssl failure), so the screen says paste is the only route in
     rather than leaving the admin to wait out the window for a delivery that cannot arrive.
4. Per-user purges: `9) Purge Gateway` drops only this gateway's admission then wipes local state;
   `0) Purge Federation` drops only this owner's Domain slice (other tenants survive) then wipes
   local state and the host blob. Both mutate the Router's own state file through
   `scripts/lib/routerState.ts`.

`scripts/lib/routerState.ts` keeps every Bun `$` template on ONE line: Bun does not treat a
backslash-newline as a continuation, it splits the argv there and the stray backslash lands in it,
so a wrapped template runs a different command and `readRouterFed` returned "" while the file was
fine. That is how the empty-read misread above was produced.

### Cutting over to the self-hosted Router

DONE, and kept as the record of how it was done, since a second machine or a rebuilt one repeats
steps 3 to 6. The gateway and console both reach the Router; `RouterTransport` admits only the
`direct` shape, so there is no k8s branch left to choose between.

The one-way door has been passed: **rollback stayed clean only until the Router accepted its first
federation mutation** (an admission, a revocation, a tenant op). The cluster's copy is stale now, and
repointing back to it would resurrect revoked members.

1. `./backup-federation.sh` with the Router stopped. It refuses while it runs, asserts the cert,
   key and state all landed, and includes both tokens - a data-only archive authenticates nobody.
   A backup taken before the export holds the MINTED identity, not the imported one, so it restores
   a Router no enrolled device recognises. Take a fresh one after step 5.
2. `bun run export:federation` with the Router stopped. Read-only against the cluster; it imports
   the evie identity keypair rather than minting one, which is what makes enrolled devices still
   resolve this Router. It aborts if the Secret moves mid-read. A re-export writes through the
   container, since by then the Router root-owns the data dir and the host cannot. It ALSO carries
   `CONSOLE_BRIDGE_TOKEN` from the separate `console-bridge-app-token` Secret into `.env`: that one
   is not part of the federation state, and a freshly minted one 401s every already-provisioned
   console, which the app reports as "sign-in rejected".
3. `./start-federation.sh`. It detects and writes `FEDERATION_BIND` itself; run `./setup.sh` option
   2 afterwards to add the public host so a phone off the LAN can reach it.
4. Repoint the gateway: rewrite `volumes/gateway-data/federation/transport.json` to the direct
   branch (`transport: "direct"`, `routerUrl` the docker-network alias `https://federation-router:20001`,
   `routerCertFp` from `/health`, `bearer` the `FEDERATION_WS_TOKEN` from `.env`), keeping the old
   file as `transport.k8s.json` for the rollback. Then `./start-gateway.sh`. Confirm
   `router_connected: true` on the gateway's `/health`, `[router] direct transport ->` in its log,
   and `Gateway registered: <domain>/<id>` in the Router's.
5. Point the phone at the LAN address in Settings, Federation, Federation Router. The port defaults
   to 20001 and the fingerprint comes from the Router's `/health`, as PLAIN hex. Editing there
   repoints the transport ONLY; it never re-runs provisioning, so admission and enrollment survive.
6. Verify before trusting it: send, poll, board, peek, wake, and add-a-device.

### Retiring the k8s path

The server side is DONE. Nothing under `src/gateway`, `scripts/` or the Dockerfile reaches a cluster:
`gateway/router/transport.ts` loads only the direct branch, the `EVIE_*` env vars are gone, kubectl is
out of the image, and provision / purge / verify all speak to the Router through
`scripts/lib/routerState.ts` and `/health`. A `transport.json` still holding the k8s shape resolves
to null, so such a Gateway arms for enrollment rather than half-reading a relay it cannot reach.
`setup.sh --gateway-transport` is GONE rather than ported: it wrote a k8s `transport.json` over the
gateway's own, which after the cutover knocks it off the Router.

The one k8s-speaking file left is `scripts/federation-export.ts`, on purpose: it is the one-time
migration that reads the cluster's Secret into the Router, and it stays until the owner deletes the
cluster objects. evie-bot's side (the bridges, the eleven synced copies, the deploy objects) is
deleted and committed locally there, NOT pushed - the owner pushes evie.

Gateway enrollment is off it: the Router answers `onTransport` with the direct branch (owner-signed,
fresh, non-replayed, and only for an owner who ROOTS a Domain here, since that reply carries the WS
bearer), and `GatewayEnrollment.kt` builds a direct bundle from it. The k8s branch stays READABLE on
both so an older Router still enrolls a Gateway; it goes with the rest below.

What remains is CLIENT-side and needs a console release:

- console: the k8s proxy transport branch, `PROXY_CEILING_MS`, and the k8s fields in `Provisioning`
  parsing. Every device must be on a direct blob first, or the update strands it.
- Then the k8s halves of the shared schemas (`schemasProvisioning.ts`, `schemasGatewayTransport.ts`,
  `federation-proofs.ts`), whose refinements still REQUIRE the k8s fields when `transport` is not
  `direct`. Deleting them makes every older blob unparseable, and the plugin updates before the
  console does, so this is last.
- The cluster keeps plain evie-bot hosting with no switchboard role.
