# Questionaire

Total restructure: the Router becomes the hub, gateways become symmetric leaves. Supersedes the
route-gateway model. `plans/vault.md` is parked until this lands; the board holds plugin ideas.

## Status

Questionaire complete. Plan through one refinement lap: 24 findings, 16 verified against the code,
one refuted. Not started. Phase 1 gates every later phase.

Evidence the plan rests on, verified against the code:
- Timeouts. The gateway waits 120s for a Router answer (`TOOL_CALL_TIMEOUT_MS`). The Router holds a
  relay 70s (`GATEWAY_RELAY_TIMEOUT_MS`). Wake waits 600s (`WAKE_TIMEOUT_MS` default). The phone
  reads for 35s (`PINNED_READ_TIMEOUT_MS`), holds a long poll 40s (`LONG_POLL_HOLD_MS`) against the
  Router's 55s (`ROUTER_HOLD_MS`), and refreshes discovery every 30s (`DISCOVERY_REFRESH_MS`).
- Commits. The earlier "37 of 120" counted two clusters. The transport cluster is the 17 commits
  listed in Phase 1. The other cluster is Codex thread lifecycle, outside this plan.
- `discoverFull` has no single-flight; the only `inFlight` in `routes` guards blob fetches.
- Board entry `bd_36caa212` holds the route-gateway analysis behind the plan.

Working assumptions in force until the owner answers:
- Degraded mode is retracted. No phone-to-gateway path exists: port 20000 is loopback, port 20003
  is enrollment only. Router down means a read-only cache on the phone. A gateway LAN console
  endpoint would be its own plan.
- Drafts and armed goals stay phone-local. Scheduled sends move to the Router as sealed-shared
  rows with a clear fire time, so they fire with the phone off.

> "Currently it's all centralized and revolved around an arbitrary Gateway. True Sync is impossible
> and shimmed here and there. TBH I didn't come up with it, it just sort of happened with Opus."

## Proposal - Router as hub, transport layer rewritten, everything else kept

Q: Ground-up foundational rewrite with the Router as the centralized hub?
A: Router as hub, yes. Ground-up, no. Rewrite one layer: phone <-> Router <-> gateway transport.

WHAT MOVES TO THE ROUTER
- The owner's mailbox. Every gateway appends; the phone polls once and sees every gateway.
- Presence. Gateways push session rows on change; the Router folds one mesh snapshot per
  audience. Discovery stops existing as a concept.
- Console op routing. The phone addresses a gateway by id; the Router forwards; the reply lands in
  the Router mailbox. No route-gateway anchor, no relay-back leg.
- Owner facts the phone reports once: capabilities, read anchors.
- The board, its authority and cascade, and awareness generation.
- Cross-Domain share state and its lifecycle.

WHAT SHRINKS AT THE GATEWAY
- Loses mailbox ownership, `discoverFull` fan-out, `DISCOVERY_REFRESH_MS`, the route/non-route
  split, the per-gateway capability re-report, the reply-anchor relay.
- Keeps session store, local presence derivation, `host_op`, wake, Codex and Copilot services, and
  the local endpoints the MCP plugin calls, now proxied to the Router.

WHAT IS UNTOUCHED
- Trust: owner root, admissions mirrored on Router and gateways, Ed25519/X25519, sealing,
  `ReplayGuard`, TLS pinning, SAS enrollment, trust-on-first-enroll. Rewriting crypto is where a
  rewrite is most dangerous and this part is the part that works.
- The app's non-transport screens: thread, terminal view, playback, attachments, board UI, drafts,
  zoom, settings. Their repositories change where state comes from; the screens do not.
- MCP tool surfaces. They keep calling the local gateway; the gateway answers from the Router.
- Host daemon.

ROUTER DOWN
No phone-to-gateway path exists and none is added. The phone shows its cache read-only and every
send answers "Router unavailable". Gateways keep their tmux sessions; MCP tools that need owner
state fail the same way. Today's behaviour is the same minus the cached rows, so this is not a
regression.

THE RISK, stated plainly
This is a rewrite of the layer that took 17 delivery fixes in the last 120 commits. Each encodes a
real failure mode. The plan must map every one to "impossible by construction under the hub" or
"carried over", or the rewrite rediscovers them. Phase 1 is that map.

### Assumption A1 - Clean break, coordinated cutover

The four components update on separate triggers, and an old phone cannot talk to a hub Router. A
single-owner self-hosted system can cut over all four at once. No wire compatibility with the
route-gateway model is kept. The cutover has a migration step and a rollback window; neither is
wire compatibility.

### A2 resolved - Cross-Domain is same-Router; the Router stays a courier for friends

Verified: the Router never talks to another Router. `gatewayBridge` keeps `gatewayConnections` as a
map of domainId to a map of gatewayId to connection, so one Router hosts many Domains, and the
`EnrollmentCoordinator` holds the signed link edges between them. A friend's gateways are already
connected to the hub.

Corrected inventory: `crossDomainPeers` is gateway-local. It holds the friend gateway's box and
sign keys, and `createSealer` seals cross-Domain traffic gateway to gateway. Nothing at the Router
can open it. So:
- Cross-Domain rows are tier 3. Sealed to the destination gateway's box key, routed by
  `(domainId, gatewayId)` and link edge, never re-sealed.
- The sealed-shared tier is owner-only. A friend's phone sees clear projected presence and nothing
  else, exactly as today.
- Share state moves to the Router as tier-1 state: which session is shared to which friend Domain,
  with TTL. Share, unshare, unlink, and touch are owner-authenticated Router ops. The gateway keeps
  attesting session kind and reporting live cross-Domain jobs, which is what keeps a share alive
  past its TTL today (`hasLiveCrossDomainThread`).

### Inventory - what rides `gateway_relay` today

Eight `FederatedOp` kinds: `blob_fetch`, `console_push`, `gateway_relay`, `list_teams`,
`presence_push`, `response_push`, `send`, `wake`. Seven relay call sites: `blobFetch` (blob_fetch),
`presenceExchange` twice (presence_push to friends, list_teams discovery), `consolePushOps`
(console_push fan-out to other gateways' consoles), `sendCrossGateway` (send), and two inside
`relayWithRetry` (response_push back to origin, and the retry loop itself).

Under the hub: `list_teams`, `presence_push`, and `console_push` die outright, since the Router
folds presence and owns the mailbox. That is four of seven call sites gone before Question 3 is
even asked. What remains is `send` and `response_push` (Question 3), and `wake` and `blob_fetch`
(request-response, Phase 3).

## Question 1 - Is the Router trusted with content?

Q: The Router is the public-facing component and today "cannot read or forge E2E payloads". As the
hub it holds the mailbox. Does it hold plaintext, or sealed rows?

A: C - trusted with STATE, blind to PAYLOAD. The Router is the authority for anything two phones
must see the same way, and the courier for anything it only carries.

> "that sounds perfect. so you would need to plan the foundation of 2 kinds. Unsealed shared
> states, and Sealed for routing."

Recommendation reason, chosen: the Router cannot merge what it cannot read, and both pain points
(two phones, N computers) are merge problems. Bodies, terminal frames and attachments are never
merged, only carried, and are the dangerous ones to leak, so sealing them costs nothing. Pure A
(all sealed) was withdrawn as too pure; pure B (all clear) leaks every peeked frame for no merge
benefit.

## Question 2 - A sealed-shared tier, and what goes in it?

Q: Between clear shared state and sealed routed content, can the Router hold state it shares
between phones but cannot read?

A: Yes, by construction: a versioned sealed blob with a CLEAR ENVELOPE. The envelope holds exactly
what the Router's logic needs (id, owner, version, and any structure it must reason about); the
rest is sealed. The Router syncs by version and CAS; a losing concurrent writer re-reads and
re-applies client-side, the model every E2EE sync app uses.

Three tiers:
  1. CLEAR SHARED - Router is authority and reader: presence, capabilities, read anchors, mailbox
     envelopes, share state.
  2. SEALED SHARED - Router is authority on the envelope, blind to content: board text, scheduled
     sends, Vault entries and notes.
  3. SEALED ROUTED - Router is courier, holds no state: message bodies, terminal frames, files,
     cross-Domain rows.

Drafts and armed goals stay phone-local (working assumption, see Status).

Consequence, not a choice: the owner content key is SYMMETRIC and held by every phone and every
gateway. Gateways must read the board and write bodies; the Router is the one party without it.
That matches the trust model: gateways are loopback-only owner machines, the Router is the only
public port.

Refined against the code: no synced symmetric keyring exists. The keyring is `DomainSnapshot`
(owner public key, admissions, revocations), `buildConsoleTransport` ships only that, and the
gateway bootstrap bundle has no key slot. The owner root never leaves the originating phone except
as the passphrase-encrypted backup. So the key is generated on the owner phone and travels only as
per-recipient SEALED KEY ENVELOPES. Phase 4 specifies them. Revoking a phone or a gateway is
authorization-only: it cannot erase a copy. Rotation is a key-epoch bump with old epochs retained
for reading.

Board placement is the open sub-question:
  A) Hybrid: structure clear (id, parent, rank, state, session, version, attachment manifest), text
     sealed (title, body). Router keeps cascade, authority and rank. Compromise leaks tree shape.
  B) Whole blob: one sealed board per owner, Router is pure CAS. Phone runs the Kotlin reducers,
     gateway runs boardCascade for agent writes; two cascade owners that must agree. Compromise
     leaks size and version only. Any concurrent edit conflicts on the whole board.
  C) Tier 1: fully clear, Router runs everything. Compromise reads the tasks.

A: A - hybrid. Structure clear, text sealed, Router owns cascade.

> "A"

Recommendation reason, chosen: the move to C was to give the Router the merge; B takes it back and
splits cascade across phone and gateway (the Kotlin-twin pattern the codebase already fights). A
keeps one cascade owner and seals the words; a leaked tree shape says "17 tasks, one has three
children", not what they are.

## Question 3 - One delivery primitive, or two?

Q: Agent-to-agent `send` and its `response_push` ride `gateway_relay` today, a synchronous RPC the
gateway waits 120s on and the Router holds 70s. Under the hub, do they become Router-held inbox
rows like phone traffic, or does the sync relay stay for agents?

  A) One primitive. Router-held inboxes addressed by OWNER (phone) or by SESSION (agent). `send`,
     `response_push`, `console_push` are inbox appends. The Router acks "accepted" at once; the
     destination gateway acks "delivered to session" as a row the sender can read. `wake` and
     `blob_fetch` stay as Router-forwarded request-response with a SHORT per-call timeout;
     `gateway_relay` survives only as their envelope.
  B) Two primitives. Router inboxes for phone traffic; keep `gateway_relay` plus `relayWithRetry`
     and the hold/ack machinery for agent-to-agent. Less to rewrite; crosstalk keeps its own sync
     shape and its own failure modes.

A: A - one primitive. Router-held inboxes addressed by owner or by session. `wake` and
`blob_fetch` remain request-response with a short per-call timeout.

> "A"

Recommendation reason, chosen: the last three commits already moved agent delivery to
hold-until-the-session-says-it-took-it, which is the inbox model; the Router-holds-the-call shape
is what produced the discovery hang; and the failure modes map to one place under A.

Refined against the code:
- The inbox is `DeviceMailbox` and `PendingDeliveryStore` moved to the Router, not a new design.
  Producer-issued idempotency keys, epoch-gated per-consumer cursors, compaction to the slowest
  consumer, idle-consumer eviction, provenance-aware capacity eviction, durable acceptance before
  the ack, retirement on acknowledgement. Dedupe by content hash is dropped: it merges distinct
  messages and duplicates a retried one.
- The clear envelope carries origin, sequence, epoch, size, and the idempotency key. No title.
- Every append answers a sender-visible result: accepted, refused (capacity), expired, target
  revoked, or durability failure, with "accepted, durability uncertain" distinct from "not
  accepted".
- Acks are sender-local delivery state. Across Domains they never distinguish an absent target
  from an unshared one, and delivered state is redacted after unshare or unlink.

## Question 4 - Where do file bytes live?

Q: Blobs are content-addressed today (`blobIdFor` is `sha256-<hex>`, `blob-store` keeps them
immutable on disk at the gateway; board attachments sit under `<ownerId>/<entryId>/<blobId>`).
`blob_fetch` relays a cross-gateway read. The Router has NO bulk storage today. Under the hub,
does the Router hold bytes?

  A) Origin only. The gateway that produced a file keeps it; the Router forwards `blob_fetch` on
     demand and stores nothing. An asleep origin means the attachment is unavailable until it
     wakes. Today's model minus the route hop.
  B) Router only. The gateway uploads once, sealed under the content key; every phone fetches from
     the Router. Works with the origin asleep. Router disk grows without bound unless quota-swept,
     and a swept blob is gone.
  C) Router cache, origin authoritative. Upload on append (or lazy on first fetch), sealed; a size
     quota with LRU sweep; the origin gateway keeps its copy and answers `blob_fetch` when the
     Router has evicted. Content addressing makes the cache correct by construction: immutable,
     deduplicated, no invalidation.

A: C - Router cache, origin authoritative.

> "C it is"

Recommendation reason, chosen: B with a floor under eviction. sha256 ids mean the Router never
reasons about staleness; the cache is a quota number and a sweep. Closes the asleep-laptop case
that A leaves open.

Refined against the code: the Router has no blob store at all, and board attachments are kept
OUT of the gateway's evicting cache on purpose (`BoardAttachmentStore`, no sweeping). The Router
gets two stores: a quota-swept cache for message files, and a reference-held store for board
attachments that is released only when the entry is. Each cached entry records its origin
`(domainId, gatewayId)` so a miss can be routed and an offline origin told apart from an evicted
one. The phone fetches the Router first and the origin only on a typed miss.

### Consequences settled by Questions 1-4, not separately asked

- The Router is authoritative for every owner-scoped thing it holds; the phone is a CACHE with
  offline reads, plus a journal of its own unsent mutations. `ChatPersistence` and `AppStateStore`
  persist what the Router last said, keyed by Router version, and the journal separately. A newer
  Router version never discards a journaled local edit; it is re-applied or reported.
- The gateway keeps only what it physically owns. Precisely: the session store (tmux records, bind
  metadata, labels, workdirs), Codex and Copilot catalogs and threads, pending jobs, `ReplayGuard`,
  origin blob copies, its identity and admissions, and `crossDomainPeers`. The owner state that
  leaves: `boardStore`, `capabilityStore`, the device mailbox, the plane registry, awareness
  banking, share state, read anchors.
- Tenant isolation at the Router becomes load-bearing. The Router legitimately reads across
  Domains for roster, transport, enrollment, and link resolution, so the rule is not "no read
  crosses a domainId". The rule: every owner-state store API takes a `domainId`, the caller is
  authenticated against that Domain's slice before lookup or mutation, and admin cross-Domain
  reads live on separate, named APIs. Residue-tested at the store layer.

## Question 5 - How does the phone hear the Router: poll, or a socket?

Q: The Router's console surface is HTTP POST only today. The phone's foreground path is already a
long-poll chain (`LONG_POLL_HOLD_MS` pinned against `ROUTER_HOLD_MS`) held by `SwitchboardService`;
background uses the `IdlePushbackManager` tiers with `AlarmManager`. Under the hub every owner
fact is at the Router, so one poll is cheap. Does the foreground path stay a long-poll chain, or
become a WebSocket the Router pushes on?

  A) Keep polling. Foreground long-poll chain, background tiers unchanged. The Router's console
     surface stays HTTP. Least new Router code; latency stays the poll cadence; every planes-and-
     inbox read is one round trip per hold.
  B) Foreground socket, background tiers. `SwitchboardService` holds a pinned WS to the Router
     while the app is foreground or a thread is open; the Router pushes inbox rows, state versions
     and presence as they land. Background keeps the existing tiers. The Router gains a console WS
     beside the gateway WS it already runs.
  C) Socket always. A persistent WS in background too, dropping the tiers. Instant delivery at
     the cost of the battery model the tiers were built to protect, and Android's own background
     socket limits.

A: B - foreground socket, background tiers unchanged.

> "B"

Recommendation reason, chosen: the long-poll chain is already a socket in spirit, so B changes
the mechanism not the behaviour; the Router already runs a WS server for gateways; the background
tiers are the carefully engineered part and stay untouched. C throws them away for a latency win
felt only with the app closed.

Refined against the code: the app has no WebSocket client. Every console op is an OkHttp POST
through `ConsoleRelayTransport.relay`, `ConsoleClient.poll` is an HTTP long poll, and
`buildLeafPinnedClient` pins HTTPS only. Phase 6 therefore specifies the console WS protocol and
builds the client, with pin-before-upgrade, a socket-aware reach state machine, and one transport
coordinator that owns the foreground-socket to background-poll handoff under a single consumer
identity. HTTP polling stays until the socket's tests pass.

# Plan

Scale, estimated: about 5,900 lines of gateway modules move to the Router or die. The Router is
about 3,400 lines and roughly doubles. On the phone, 47 Kotlin files match a route-gateway grep,
tests included; the executable subset is a Phase 1 output, not a number to plan on. MCP tools and
the host daemon are near zero in code and non-zero in verification.

Ordering: Phase 1 gates 2. Phase 4 gates 5 and 6, which write sealed content. Phase 8 gates 9.

## Phase 0 - Backup and freeze

- Export the owner key backup from Management.
- Snapshot every durable store: each gateway's `DurableStore` files and blob roots, the Router's
  `federation.json`, and a phone export of drafts, scheduled sends, goals, and read anchors.
- Write a release manifest: commit, plugin bundle, gateway and Router images, daemon, APK, schema
  versions, and the snapshot paths. Rollback selects by manifest, not by tag.
- Pin plugin auto-update for the cutover window.
- `plans/vault.md` stays parked. No code.

## Phase 1 - Failure-mode ledger and invariants

No code. Output is appended to this plan. Gates Phase 2: the invariants are the Router's spec.

Ledger input, the transport cluster, oldest first: `b0a51863`, `d46807e8`, `a0d18ad0`, `4bee4c04`,
`04046284`, `18dc9910`, `e10af02c`, `f0c2e370`, `efe70a45`, `b647b51c`, `a321772e`, `6ffa04c4`,
`bbb29426`, `83301504`, `744f1a59`, `cd1f3df3`, `4e1e0b43`. Plus the failure modes the code
carries without a commit of their own: `PendingDeliveryStore.enqueue` refusing at capacity,
`PendingDeliveryStore.sweep` expiring rows, `DeviceMailbox.sweepIdleConsumers`. Excluded, and why:
the Codex thread lifecycle cluster (`75442682` through `86cfab91`), which the hub does not touch.

Each row maps to IMPOSSIBLE BY CONSTRUCTION (naming the invariant and its residue test) or CARRIED
OVER (naming where). Seeds:
- "Hold a send for an absent session": the Router holds the row until a session claims it. The
  refuse path does not vanish; it becomes the typed result envelope of Question 3.
- "A stale socket clearing a live one": the Router owns a monotonic connection incarnation per
  gateway, carried on registration, presence, delivery, ack, and disconnect. Every mutation
  compares `(gatewayId, sessionId, incarnation, deliveryEpoch)`; stale frames and stale cleanup
  callbacks are rejected. Claims are re-established on gateway restart.
- "Count what the mailbox actually holds": one mailbox writer at the Router, residue-tested.
- The 120s gateway wait against the 35s phone read: per-call timeouts on `wake` and `blob_fetch`,
  pinned in a constants test the way `ChatRepositoryConstantsTest` pins the poll chain.

Also produced here:
- Restart matrix. Every in-memory Router map (`gatewayConnections`, `pendingRelays`,
  `pendingHandshakes`, `seenRegisterNonces`, `ConsoleSurface.pending`, the four coordinators'
  windows) marked "deliberately restarts" or "becomes durable", and how inbox delivery resumes
  without duplicating or losing accepted rows.
- Symbol-level inventory of the phone's route-gateway dependencies: executable code, tests, and
  comments listed apart. Includes the non-transport consumers: `BoardManager` (`knownVersion` from
  `routeGatewayId`, per-gateway lanes), `reportRead`, terminal and session ops that pick a target
  gateway, `TrustOps` and `SessionOps` refresh triggers.
- Gateway connectivity and session liveness state machine as the phone will show it: connected,
  gateway asleep, gateway offline, row accepted, row delivered.

## Phase 2 - Router: owner-scoped state (tiers 1 and 2)

Additive; old surfaces untouched.
- A Router state layer, separate from `fileSecretStore`, which stays the enrollment and admin
  whole-file CAS. Per-Domain, per-owner records keyed `(domainId, ownerId, kind, id)`; keyed
  versions with CAS; one writer per Domain; append segments with periodic snapshots; fsync and
  boot restore; per-file corruption quarantine as `durable-store` does; per-Domain quota; ENOSPC
  and read-only-filesystem behaviour reported as Router health; write cost stated per store.
- Presence protocol: versioned deltas from each gateway carrying its incarnation, tombstones on
  removal, Router-side expiry when the socket drops, reconciliation on reconnect. Signing is not
  needed; the authenticated gateway connection is the trust boundary. The fold is per audience:
  the owner sees everything, a friend Domain sees the projection `presenceForDomain` computes
  today (shared sessions only, the same field filter).
- Share state as tier-1: share, unshare, unlink, touch as owner-authenticated ops; TTL; gateway
  attestation of session kind and live cross-Domain jobs. Domain-isolation checked per op.
- Board: `boardStore`, `boardAuthority`, `boardCascade` move to the Router and run on the clear
  envelope (id, parent, rank, state, session, version, attachment manifest). Titles and bodies
  sealed. Awareness generation moves with it, keeping the bank's semantics: first pre and last post
  folded, recipient selection, `act_now` for a gone entry, holding for a waking session, dropped at
  `MAX_HOLD_MS`. Delivery is a session inbox row (Phase 3). The phone's Kotlin reducers shrink to
  "apply what the Router says".
- Capability fold and read anchors as tier-1 state.
- Scheduled sends as tier-2: sealed body, clear fire time. The Router appends the row to the target
  session inbox at fire time; the phone that scheduled it need not be on.
- Access-matrix residue test: no owner-state API without `domainId`; admin cross-Domain reads on
  separate APIs.
- New wire shapes in the shared Zod schemas, Kotlin regenerated.

## Phase 3 - Router: inboxes, request-response, blob stores

- Inboxes: `DeviceMailbox` and `PendingDeliveryStore` semantics hosted at the Router, addressed by
  owner or by session. Producer-issued idempotency keys persisted before "accepted"; per-consumer
  epoch-gated cursors; compaction to the slowest consumer; idle-consumer eviction; provenance-aware
  capacity eviction; bounded retention; typed result envelope on every append; stale-ack rejection
  by incarnation; recovery of accepted-but-undelivered rows on restart. One writer,
  residue-tested.
- `wake` and `blob_fetch` as Router-forwarded request-response with an operation id, a per-call
  timeout from the real constants, typed outcomes (timeout, disconnected, definitive failure, late
  result discarded by id), idempotent retry, and cancellation. `gateway_relay` survives only as
  their envelope. Wake's 600s wait stays at the gateway; the Router call returns "waking" and the
  session inbox row delivers when the session registers.
- Blob cache: content-addressed, sealed, streaming upload and get, atomic partial-to-final
  promotion, durable size and mtime index or scan-and-rebuild on boot, per-Domain quota, LRU
  sweep, origin `(domainId, gatewayId)` per entry, typed miss.
- Board attachment store: reference-held, released with the entry, never swept by quota.

## Phase 4 - Owner content key

- Generated on the owner phone: HKDF from the owner root with a fixed salt and info string, epoch
  1. The root never leaves the phone.
- Delivery as sealed key envelopes, one per recipient box key, versioned by epoch:
  - to a new console inside the `ConsoleTransport` sealed at Add Device;
  - to a new gateway as a new field in the bootstrap bundle;
  - to an already-enrolled gateway or console by a re-delivery op through the Router.
- Every sealed envelope names its epoch. Readers keep every epoch they were given; a device that
  missed an epoch asks for re-delivery. Old content is not re-encrypted.
- Rotation: bump the epoch, re-deliver to current members. Documented, not automated.
- Revocation is authorization-only and the plan says so. Phone and gateway revocation stay as
  they are.
- Matching Node and Kotlin implementations against a shared fixture before Phases 5 and 6.
- Residue test: the key never appears in a log line or a debug ingest.

## Phase 5 - Gateway client

Replacement before removal. Each module below has a named removal point: the commit in which no
gateway code imports it.
- Push presence deltas on change with the connection incarnation; append outbound rows for its
  sessions; drain its sessions' inboxes as the Router pushes them over the existing WS, acking by
  incarnation; upload blobs to the cache and keep the origin copy; attest session kind and live
  cross-Domain jobs for share state.
- Router-backed proxies for the local endpoints the MCP plugin keeps calling: `/capabilities`
  (Router console answer composed with the local daemon source), `/task-board` and attachments
  (Router board with the same authentication and scoping), `/discover` (Router presence in the
  `bridgeDiscover` shape).
- Delete, each at its removal point: `discoverFull` and every `DISCOVERY_REFRESH_MS` consumer,
  `consolePushOps`, the `list_teams` and `presence_push` legs of `presenceExchange`, the device
  mailbox and `consoleDevices`, the plane registry and `pollPlanes`, `boardStore` and the three
  board modules, `capabilityStore`, `awarenessBank`, `sendCrossGateway`, `relayWithRetry` for
  messages, `crossDomainShareState`.
- Residue test on the retained-state inventory of the Consequences section, not on "no owner
  state".

## Phase 6 - Phone transport

- Console WS protocol: framing, authentication with the existing console credentials, cursor and
  ack semantics matching Phase 3, pin-before-upgrade against the Router fingerprint, HTTPS to WSS
  conversion validated, reconnect with a generation fence.
- One transport coordinator owning the foreground-socket, background-poll, foreground-socket
  transitions under a single consumer identity: cursor ownership, cancellation, replay after
  reconnect, and when a pushed row is acked relative to subscriber processing. Tested across
  Activity stop and start, Service destruction, process revival, and simultaneous reconnects.
- `RouterReach` gains socket-aware candidates and a failover state machine with LAN-to-public
  transition tests.
- `ConsoleClient` targets the Router only; `routeGateway` is deleted, and with it the non-route
  capability re-report and the per-gateway board pull.
- `IdlePushbackManager` and the background tiers are untouched.
- `PollDrain` becomes the one drain for one source. `PresenceOps.refreshDiscovery` and every
  refresh trigger in `TrustOps` and `SessionOps` are deleted once presence is pushed.
- `BoardManager` and `BoardOps` rewritten together around Router versions: CAS, re-apply on a
  lost race, attachment dependencies, authoritative refusals. No per-gateway lanes.
- `ChatPersistence` and `AppStateStore`: per-kind versioned envelopes of what the Router last said,
  plus a mutation journal for edits made offline. Read anchors, scheduled sends, and optimistic
  sends reconcile through the journal.
- `AttachmentOps` fetches the Router cache first and the origin on a typed miss.
- HTTP polling stays until the socket tests pass.

## Phase 7 - MCP plugin and host daemon

A compatibility checklist, not "near zero". The MCP plugin keeps its local gateway base URL. Verify
against the new gateway: `fetchCapabilities`, `postBoard` and `fetchAttachments`,
`registerBridgeDiscover`, Codex and Copilot dispatch, `host_op`, `presence_watch`, and
`presence_derive`. The agent routes, session authority, and the daemon protocol are unchanged.

## Phase 8 - Migration

Between the Router going live and any deletion. Quiesce each gateway, then:
- Export board envelopes, attachment bytes, mailbox snapshots, pending deliveries, in-flight op
  records, and read anchors. Import with an explicit old-to-new epoch, sequence, and opId mapping.
  Verify counts, hashes, parent and rank invariants, and attachment manifests.
- Phone import of scheduled sends and read anchors; the mailbox cursor migrates only after its
  rows are imported. Drafts and goals stay where they are.
- Each gateway reports migration complete to the Router. Router authority for owner state turns
  on only when every gateway has.
- No deletion until every record has a verified disposition.

## Phase 9 - Cutover and removal

Order: Router (both surfaces live), then every gateway, then every phone, then the plugin.
- Rollback gate: Router state snapshot before its first owner write; mutations journaled during the
  window; an idempotent Router-to-old-model export; rollback declared closed after the retention
  window and verified backups.
- Then delete the old Router console surface and every old gateway path in one commit. Any shim
  that lets the two coexist during the window carries a remove-by comment.
- `setup.sh --verify` learns the new registration. Plugin auto-update unpinned after a
  compatibility probe. Vault questionaire resumes on the new substrate.
