# Questionaire

Total restructure: the Router becomes the hub, gateways become symmetric leaves. Supersedes the
route-gateway model. `plans/vault.md` is parked until this lands; the board holds plugin ideas.

## Status

Questionaire complete. Plan through two refinement laps: 44 findings, 30 verified against the code,
6 refuted. Not started. Phase 1 gates every later phase.

Evidence the plan rests on, verified against the code:
- Timeouts. The gateway waits 120s for a Router answer (`TOOL_CALL_TIMEOUT_MS`). The Router holds a
  relay 70s (`GATEWAY_RELAY_TIMEOUT_MS`) and rejects a late reply by id. Wake waits 600s
  (`WAKE_TIMEOUT_MS` default), and a positive wake ack clamps the registration window to the
  original deadline. The phone reads for 35s (`PINNED_READ_TIMEOUT_MS`), holds a long poll 40s
  (`LONG_POLL_HOLD_MS`) against the Router's 55s (`ROUTER_HOLD_MS`), and refreshes discovery every
  30s (`DISCOVERY_REFRESH_MS`).
- Commits. The transport failure-fix set is the 27 commits listed in Phase 1, from a wider window
  than 120. The Codex thread lifecycle cluster is outside this plan.
- `discoverFull` has no single-flight; the only `inFlight` in `routes` guards blob fetches.
- Two delivery legs exist today. Gateway to session already holds a row until the receiver acks
  (`PendingDeliveryStore`, `ChannelDeliveryCoordinator`). Gateway to gateway is still the
  synchronous `gateway_relay` RPC. Question 3 extends the first model to the second.
- Board entry `bd_36caa212` holds the route-gateway analysis behind the plan.

Decided by the owner after lap 1:
- Degraded mode is retracted. No phone-to-gateway path exists: port 20000 is loopback, port 20003
  is enrollment only. Router down means a read-only cache on the phone and "Router unavailable"
  on every action, with one allowance: a scheduled send may be composed offline and journaled
  until the Router returns.

> "Retract it. No degradation. Router down means the phone read-only cache only. Maybe scheduled
> send at most. Just "Router unavailable"."

Working assumptions in force until the owner answers:
- Drafts and armed goals stay phone-local. Scheduled sends move to the Router as sealed-shared
  rows with a clear fire time, so they fire with the phone off. The Router is their only
  scheduler; the phone's alarm path retires.
- Rollback restores the Phase 0 snapshots and loses writes made after cutover. The window is one
  day. A bidirectional journal that would preserve them costs more than the writes it saves for a
  single owner.

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
- The board's structure, authority, cascade, and observations. Awareness TEXT stays at the
  gateway, which holds the key to render it.
- Cross-Domain share state and its lifecycle.
- Scheduled sends, and the firing of them.

WHAT SHRINKS AT THE GATEWAY
- Loses mailbox ownership, `discoverFull` fan-out, `DISCOVERY_REFRESH_MS`, the route/non-route
  split, the per-gateway capability re-report, the reply-anchor relay.
- Keeps session store, local presence derivation, `host_op`, wake, Codex and Copilot services,
  the cross-Domain sealer and peer keys, the awareness delivery adapter, and the local endpoints
  the MCP plugin calls, now answered from the Router.

WHAT IS UNTOUCHED
- Trust: owner root, admissions mirrored on Router and gateways, Ed25519/X25519, sealing,
  `ReplayGuard`, TLS pinning, SAS enrollment, trust-on-first-enroll. Rewriting crypto is where a
  rewrite is most dangerous and this part is the part that works. Phase 2 adds one symmetric
  envelope beside it and changes nothing in it.
- The app's non-transport screens: thread, terminal view, playback, attachments, board UI, drafts,
  zoom, settings. Their repositories change where state comes from; the screens do not.
- MCP tool surfaces. They keep calling the local gateway; the gateway answers from the Router.
- Host daemon.

ROUTER DOWN
No phone-to-gateway path exists and none is added. The phone shows its cache read-only and every
action answers "Router unavailable", except composing a scheduled send, which the phone journals
and uploads when the Router returns. Gateways keep their tmux sessions; MCP tools that need owner
state fail the same way. Today's behaviour is the same minus the cached rows, so this is not a
regression.

THE RISK, stated plainly
This is a rewrite of the layer that took 27 delivery fixes. Each encodes a real failure mode. The
plan must map every one to "impossible by construction under the hub" or "carried over", or the
rewrite rediscovers them. Phase 1 is that map.

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
- Cross-Domain rows are tier 3. The origin gateway seals to the destination gateway's box key, as
  today; the Router appends the row to the destination session's inbox, addressed by
  `(domainId, gatewayId, sessionId)` and authorized by link edge; the destination gateway drains,
  opens, and acks. `response_push` is the same row in reverse. The gateway keeps `crossDomainPeers`
  and the sealer.
- The sealed-shared tier is owner-only. A friend's phone sees clear projected presence and nothing
  else, exactly as today.
- Share state moves to the Router as tier-1 state: which session is shared to which friend Domain,
  with TTL. Share, unshare, unlink, and touch are owner-authenticated, versioned Router ops. The
  gateway keeps attesting session kind and live cross-Domain jobs, which is what keeps a share
  alive past its TTL today (`hasLiveCrossDomainThread`); the attestation carries canonical Domain,
  gateway, session, job id, observation time, and gateway incarnation. Unlink keeps today's
  semantics: explicit shares dropped, everyone-trusted shares stop matching until relink,
  in-flight jobs expired, presence projection torn down.
- Every relay gate that exists today (verified sender, Domain, target share, return route, job
  binding, forged `dstDomainId` and `sessionId` rejection) is a Phase 1 ledger row naming its
  Router symbol and test.

### Inventory - what rides `gateway_relay` today

Eight `FederatedOp` kinds: `blob_fetch`, `console_push`, `gateway_relay`, `list_teams`,
`presence_push`, `response_push`, `send`, `wake`. Seven relay call sites: `blobFetch` (blob_fetch),
`presenceExchange` twice (presence_push to friends, list_teams discovery), `consolePushOps`
(console_push fan-out to other gateways' consoles), `sendCrossGateway` (send), and two inside
`relayWithRetry` (response_push back to origin, and the retry loop itself).

Under the hub: `list_teams`, `presence_push`, and `console_push` die outright, since the Router
folds presence and owns the mailbox. That is four of seven call sites gone before Question 3 is
even asked. What remains is `send` and `response_push` (Question 3), `wake` (absorbed by the inbox,
Phase 3), and `blob_fetch` (request-response, Phase 3).

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
  1. CLEAR SHARED - Router is authority and reader: presence, roster, capabilities, read anchors,
     mailbox envelopes, share state.
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
as the passphrase-encrypted backup. So the key is DERIVED on the owner phone from the root and an
epoch, deterministically, which makes the existing owner backup sufficient to regenerate every
epoch. It travels only as per-recipient SEALED KEY ENVELOPES. Phase 2 specifies them. Revoking a
phone or a gateway is authorization-only: it cannot erase a copy. Rotation is a key-epoch bump with
old epochs retained for reading.

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

Refined against the code: `applyCascade` and the awareness renderer read titles. So the split is:
the Router runs cascade and emits STRUCTURAL observations (entry ids, pre and post state, actor);
the gateway that delivers an awareness row opens the titles and renders the text. One cascade
owner, one renderer, the Router still blind.

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

A: A - one primitive. Router-held inboxes addressed by owner or by session.

> "A"

Recommendation reason, chosen: the gateway-to-session leg already holds a row until the receiver
acks (the last three commits); the gateway-to-gateway leg is the one synchronous RPC left, and it
is what produced the discovery hang. A extends the model that works to the leg that does not, and
the failure modes map to one place.

Refined against the code:
- The inbox is `DeviceMailbox` and `PendingDeliveryStore` semantics hosted at the Router, not a new
  design: producer-issued idempotency keys, epoch-gated per-consumer cursors, compaction to the
  slowest consumer, idle-consumer eviction, durable acceptance before the ack, retirement on the
  receiver's ack. Dedupe by content hash is dropped. Capacity REFUSES; an accepted row is never
  evicted.
- A row is a clear envelope plus ciphertext. The producer signs the envelope (origin, destination,
  idempotency key, epoch, content kind); the Router adds sequence, accepted-at, and measured size.
  Body, file manifest, and awareness payload are inside the ciphertext. No title.
- The operation ledger moves with the mailbox: one Router transaction keyed
  `(domainId, ownerId, conversationId, opId)` dedupes acceptance and appends the row, so a retry
  through a different gateway cannot accept twice.
- Every append answers a sender-visible result: accepted, refused (capacity), expired, target
  revoked, or durability failure, with "accepted, durability uncertain" distinct from "not
  accepted".
- Wake is not a Router op. A row for a session that is not registered makes the destination
  gateway run its existing wake path; the row's state (accepted, waking, delivered, failed) is what
  the sender reads. No synchronous wait crosses the Router.
- Acks are sender-local delivery state, validated against `(gatewayId, sessionId, incarnation,
  deliveryEpoch)`. Across Domains they never distinguish an absent target from an unshared one,
  and delivered state is redacted after unshare or unlink.

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
gets two stores, both Domain-scoped in path and lookup: a quota-swept cache for message files, and
a reference-held store for board attachments and scheduled-send files, released when the entry is
deleted or the send fires. Each cached entry records its origin `(domainId, gatewayId)` so a miss
can be routed and an offline origin told apart from an evicted one. The phone fetches the Router
first and the origin only on a typed miss.

### Consequences settled by Questions 1-4, not separately asked

- The Router is authoritative for every owner-scoped thing it holds; the phone is a CACHE with
  offline reads, plus a JOURNAL of its own unsent mutations. `ChatPersistence` and `AppStateStore`
  persist what the Router last said, keyed by Router version, and the journal separately. A newer
  Router version never discards a journaled local edit; it is re-applied or reported.
- The gateway keeps only what it physically owns. Precisely: the session store (tmux records, bind
  metadata, labels, workdirs), Codex and Copilot catalogs and threads, pending jobs, `ReplayGuard`,
  origin blob copies, its identity and admissions, `crossDomainPeers` and the sealer, and the
  awareness delivery adapter. The owner state that leaves: `boardStore`, `capabilityStore`, the
  device mailbox, the plane registry, awareness generation, share state, read anchors, the
  console op ledger.
- Tenant isolation at the Router becomes load-bearing. The Router legitimately reads across
  Domains for roster, transport, enrollment, and link resolution, so the rule is not "no read
  crosses a domainId". The rule: every owner-state store API takes a `domainId`, the caller is
  authenticated against that Domain's slice before lookup or mutation, and admin cross-Domain
  reads live on separate, named APIs. Residue-tested at the store layer and at the public Router
  methods.
- The gateway is the only principal the Router trusts for a session. An MCP call authenticates to
  the gateway with its session token, as today; the gateway acts toward the Router over its own
  authenticated WS as "gateway G for session S". The Router never sees a session token and never
  trusts a client-supplied `from`.

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
`buildLeafPinnedClient` pins HTTPS only. OkHttp's `newWebSocket` on that pinned client runs the
fingerprint trust manager during TLS, before the upgrade, so pinning carries over; `ws` and `http`
schemes are rejected. `IdlePushbackManager`'s tier POLICY is untouched; its `DeepIdleScheduler`
interface gains one client, the transport coordinator, which is the only thing that starts a poll,
holds a socket, or takes the wake lock. HTTP polling stays until the socket's tests pass.

# Plan

Scale, estimated: about 5,900 lines of gateway modules move to the Router or die. The Router is
about 3,400 lines and roughly doubles. On the phone, 47 Kotlin files match a route-gateway grep,
tests included; the executable subset is a Phase 1 output, not a number to plan on. MCP tools and
the host daemon are near zero in code and non-zero in verification.

Ordering: Phase 1 gates everything. Phase 2 gates every phase that writes sealed content, which is
all of 3 to 6. Phase 3 gates 4. Phase 8 gates 9.

## Phase 0 - Backup and freeze

- Export the owner key backup from Management. It regenerates every content-key epoch.
- Snapshot every durable store: each gateway's `DurableStore` files and blob roots, and the
  Router's `federation.json`. Hash each. No phone snapshot: drafts and goals stay on the phone,
  and everything else the phone holds is re-derived from the Router or journaled to it.
- Write a release manifest: commit, plugin bundle hash, gateway and Router image digests, daemon
  commit, APK hash, schema versions, snapshot paths and hashes. Deploy and rollback consume the
  manifest with no fetch and no build.
- `plans/vault.md` stays parked. No code.

## Phase 1 - Failure-mode ledger, invariants, and specs

No code. Output is appended to this plan. Gates Phase 2.

### Ledger

Input, the transport failure-fix set, oldest first: `2ead9add`, `5495f624`, `258e1f51`,
`0d4ccd6a`, `cb98949d`, `ac10e5db`, `f270dcf4`, `cacc8774`, `054368bb`, `b0a51863`, `d1ebf73b`,
`9ece181c`, `a0d18ad0`, `4bee4c04`, `04046284`, `18dc9910`, `e10af02c`, `f0c2e370`, `efe70a45`,
`a321772e`, `6ffa04c4`, `bbb29426`, `83301504`, `744f1a59`, `cd1f3df3`, `4e1e0b43`, `4963848d`.
Plus the failure modes the code carries without a commit of their own:
`PendingDeliveryStore.enqueue` refusing at capacity, `PendingDeliveryStore.sweep` expiring rows,
`DeviceMailbox.sweepIdleConsumers`, and every cross-Domain relay gate named in A2. Excluded, and
why: `d46807e8` (documentation), `b647b51c` (board replay validation, not transport), and the Codex
thread lifecycle cluster (`75442682` through `86cfab91`), which the hub does not touch.

Each row states trigger, wrong outcome, and the invariant the fix imposed, then maps to
IMPOSSIBLE BY CONSTRUCTION (naming the Router invariant and its residue test) or CARRIED OVER
(naming where). Seeds:
- "Hold a send for an absent session": the Router holds the row until a session claims it. The
  refuse path does not vanish; it becomes the typed result envelope of Question 3.
- "A stale socket clearing a live one": the Router owns a monotonic connection incarnation per
  gateway, carried on registration, presence, delivery, ack, and disconnect. Every mutation
  compares `(gatewayId, sessionId, incarnation, deliveryEpoch)`; stale frames and stale cleanup
  callbacks are rejected. Claims are re-established on gateway restart.
- "Count what the mailbox actually holds": one mailbox writer at the Router, residue-tested.
- "Funnel every append through one door": the op ledger transaction is the only append path.
- "Pin before the bearer": carried over unchanged to the console WS.
- "A mesh answer states its own completeness": the roster (below) replaces fan-out coverage.
- `gateway_relay` and `response_push` get their own rows: acceptance, timeout, retry, late result,
  sender-visible outcome, kept apart from the channel-delivery rows.

### Restart matrix

Every in-memory map in `federation-server`, enumerated by grep, marked "deliberately restarts" or
"becomes durable", with how inbox delivery resumes without duplicating or losing accepted rows.
Includes `gatewayConnections`, `connGateways`, `pendingRelays`, `pendingHandshakes`,
`handshakeAttempts`, `seenRegisterNonces`, `ConsoleSurface.pending`, and every coordinator's
windows, rendezvous, `byTarget`, nonces and cleanups. States the named-offline contract that
replaces today's 503.

### Inventories

- Symbol-level inventory of the phone's route-gateway dependencies: executable code, tests, and
  comments listed apart. Includes the non-transport consumers: `BoardManager` (`knownVersion` from
  `routeGatewayId`, per-gateway lanes, `enqueueMove`, attachment buckets, refusal notices),
  `BoardOps` (`forgetWithBoardDisposition`, `boardAssignTargets`), `reportRead`, terminal and
  session ops that pick a target gateway, `TrustOps` and `SessionOps` refresh triggers.
- Gateway connectivity and session liveness state machine as the phone will show it: connected,
  gateway asleep, gateway offline, row accepted, row waking, row delivered, row failed.

### Specs

One section each, appended here, each with its residue test named. Later phases implement them
and add nothing the spec did not say.
- Content envelope and key delivery (Phase 2).
- Router state layer: record format, segment and snapshot generations, fsync order, boot replay,
  compaction commit, corruption quarantine (its own, `durable-store`'s `load` returns null and does
  not quarantine), single-writer enforcement, quota, ENOSPC (Phase 4).
- Inbox, op ledger, consumer registry, capacity, and result envelope (Phase 3).
- Presence deltas, roster, and the two projections (Phase 4).
- Share state and attestation (Phase 4).
- Board structure, cascade, observations, and the gateway awareness adapter (Phase 4).
- Scheduled sends (Phase 4).
- Console WS, transport coordinator, and persistence journal (Phase 6).
- Migration fence and snapshot cut (Phase 8).

## Phase 2 - Owner content key

- Derivation, on the owner phone only: `HKDF-SHA256(root, salt = fixed, info = "switchboard-content"
  || epoch)`. Deterministic, so the owner backup regenerates every epoch. Epoch 1 at cutover.
- A standalone symmetric envelope beside the X25519 seal: AES-256-GCM, random nonce, AAD binding
  `(domainId, ownerId, epoch, content kind)`. Node and Kotlin both already hold HKDF-SHA256 and
  AES-256-GCM; `deriveKey` is private on both and stays so. Shared fixture in `tests/fixtures/`.
- Keyrings: the phone persists epochs in the Keystore-backed store beside the identity, cleared
  with it on re-provision; the gateway persists them under `DATA_DIR`.
- Delivery as sealed key envelopes, one per recipient box key, versioned by epoch:
  - to a new console inside the `ConsoleTransport` sealed at Add Device;
  - to a new gateway as a new field in the bootstrap bundle, installed atomically with the
    admission and transport, or the install fails whole;
  - to an already-enrolled member by a re-delivery op: signed by the member's admitted signing
    key, box key resolved from the Router's admission record, never from the request; the
    response sealed to that box key; operation nonce persisted for idempotency and expiry.
- Backfill at cutover: enumerate every admitted console and gateway, deliver every epoch, require
  per-recipient confirmation before Phase 8 may start.
- Reader state `missing_epoch`: retain the row, do not ack, do not compact, request re-delivery
  once with bounded retry. Distinct from malformed ciphertext and from a revoked target.
- Rotation: bump the epoch, re-deliver to current members. Old content is not re-encrypted.
  Documented, not automated.
- Revocation is authorization-only and the plan says so.
- Residue test: the key never appears in a log line or a debug ingest.

## Phase 3 - Router: inboxes, op ledger, blob stores

Additive; old surfaces untouched.
- Inboxes per the Question 3 refinement, addressed by owner or by `(domainId, gatewayId,
  sessionId)`. Consumer registry keyed by console installation identity with incarnation, last
  seen, forget on revoke. Capacity refuses; per-Domain and per-owner quotas. Recovery of
  accepted-but-undelivered rows on restart. One writer, residue-tested.
- Op ledger transaction: dedupe on `(domainId, ownerId, conversationId, opId)`, append, persist,
  then answer. In-flight, complete, failed, and crash-recovery states.
- Delivery to a gateway over its WS with `(deliveryId, incarnation, deliveryEpoch)`; the gateway
  offers to the session and acks on the receiver's word, as `ChannelDeliveryCoordinator` does
  today; a row for an unregistered session runs the gateway's wake path and reports `waking`.
  Only the destination gateway may ack its rows. `deliveryProtocol < 1` plugins are refused at
  cutover, not silently downgraded.
- Cross-Domain rows as A2 states. `sendCrossGateway` and `relayWithRetry` are replaced by an
  append, never merely deleted.
- `blob_fetch` stays request-response with an operation id, the 70s Router hold and 120s gateway
  wait named in a constants test, typed outcomes, and late-result rejection by id.
- Blob cache: content-addressed, sealed, Domain-scoped, streaming upload with a lease, generation-
  checked chunk commits, atomic partial-to-final promotion, durable index or scan-and-rebuild on
  boot, per-Domain quota, LRU sweep that skips active transfers, origin `(domainId, gatewayId)`
  per entry, typed miss.
- Reference-held store: Domain-scoped, released with the entry or the fired send, boot-time orphan
  reconciliation.

## Phase 4 - Router: owner-scoped state (tiers 1 and 2)

- The Router state layer per its spec, separate from `fileSecretStore`, which stays the enrollment
  and admin whole-file CAS. Per-Domain, per-owner records keyed `(domainId, ownerId, kind, id)`;
  keyed versions with CAS.
- Presence: each gateway sends a baseline snapshot on registration, then deltas with a sequence,
  its incarnation, and tombstones; the Router expires a gateway's rows when its socket drops and
  reconciles on reconnect. Signing is not needed; the authenticated connection is the boundary.
  Two projections, separately versioned: session presence (the `TeamInfo` fields) and gateway
  spawn points. The fold is per audience: the owner sees everything; a friend Domain sees the
  `presenceForDomain` projection (shared sessions only, the same field filter).
- Roster: expected gateways are the Domain's admitted gateways; each carries registration
  freshness and last accepted incarnation. `rosterKnown`, `asked`, `answered`, and the unreachable
  lists are derived from it, so the `bridgeDiscover` shape survives with no fan-out.
- Share state and attestation per A2.
- Board: `boardStore`, `boardAuthority`, `boardCascade` at the Router on the clear envelope (id,
  parent, rank, state, session, version, attachment manifest). Titles and bodies sealed. Cascade
  emits structural changes. Observations go to the owning gateway as session inbox rows; the
  gateway's awareness bank keeps its fold (first pre, last post), recipient selection, `act_now`
  for a gone entry, holding for a waking session, dropping at `MAX_HOLD_MS`, and renders titles it
  can open. Attachment manifest commits after the bytes are in the reference-held store.
- Scheduled sends as tier-2: destination resolved at schedule time to `(domainId, gatewayId,
  sessionId)` in the clear envelope with the fire time; files uploaded at schedule time to the
  reference-held store; body sealed. One record per target session; replace and cancel are
  versioned writes with tombstones, so a stale cancel cannot remove a newer replacement. At fire
  time the Router appends the row to the session inbox through the op ledger under the send's own
  opId, and writes a sender-visible result row the phones render as pending, sent, or error. The
  phone's alarm path retires.
- Capability fold and read anchors as tier-1 state.
- Access-matrix residue test at the store layer and the public methods.
- New wire shapes in the shared Zod schemas, Kotlin regenerated.

## Phase 5 - Gateway client

Replacement before removal. Each module below has a named removal point: the commit in which no
gateway code imports it.
- Register with the Router carrying its incarnation; send the presence baseline and deltas;
  append outbound rows through the op ledger; drain its sessions' inbox rows and ack by
  `(deliveryId, incarnation, deliveryEpoch)`; run wake for rows to unregistered sessions; upload
  blobs to the cache and keep the origin copy; attest session kind and live cross-Domain jobs;
  render and deliver awareness rows.
- Router-backed answers for the local endpoints the MCP plugin keeps calling: `/capabilities`
  (Router console answer composed with the local daemon source), `/task-board` and attachments
  (the gateway authenticates the session token locally and acts as the gateway for that session),
  `/discover` (Router roster and projections in the `bridgeDiscover` shape).
- Delete, each at its removal point: `discoverFull` and every `DISCOVERY_REFRESH_MS` consumer,
  `consolePushOps`, the `list_teams` and `presence_push` legs of `presenceExchange`, the device
  mailbox and `consoleDevices`, the plane registry and `pollPlanes`, `boardStore` and the three
  board modules except the awareness adapter, `capabilityStore`, `durableOpStore`,
  `sendCrossGateway`, `relayWithRetry`, `crossDomainShareState`.
- Residue test on the retained-state inventory of the Consequences section.

## Phase 6 - Phone transport

- Console WS per its spec: framing, authentication with the existing console credentials, cursor
  and ack semantics matching Phase 3, `newWebSocket` on the pinned client, `wss` only, reconnect
  with a generation fence.
- Transport coordinator per its spec: the one client of `DeepIdleScheduler`; owns foreground-
  socket, background-poll, foreground-socket transitions under a single consumer identity;
  cursor ownership, cancellation, replay after reconnect, ack timing relative to subscriber
  processing; socket activity resets the tiers' silence clock. Tested across Activity stop and
  start, Service destruction, process revival, and simultaneous reconnects.
- `RouterReach` gains socket-aware candidates and a failover state machine with LAN-to-public
  transition tests.
- `ConsoleClient` targets the Router only; `routeGateway` is deleted, and with it the non-route
  capability re-report and the per-gateway board pull.
- `PollDrain` becomes the one drain for one source. `PresenceOps.refreshDiscovery` and every
  refresh trigger in `TrustOps` and `SessionOps` are deleted once presence is pushed.
- `BoardManager` and `BoardOps` rewritten together around Router versions: CAS, re-apply on a
  lost race, attachment availability, refusal persistence, forget disposition, move ordering. No
  per-gateway lanes.
- Persistence journal per its spec: per-kind versioned envelopes of what the Router last said,
  a mutation journal with idempotency keys, ack and retirement, torn-write recovery, and a
  migration for every existing unversioned slot. Read anchors, scheduled sends, and optimistic
  sends reconcile through it. A scheduled send composed with the Router down waits in it.
- `AttachmentOps` fetches the Router cache first and the origin on a typed miss.
- HTTP polling stays until the socket tests pass.

## Phase 7 - MCP plugin and host daemon

A compatibility checklist, not "near zero". The MCP plugin keeps its local gateway base URL. Verify
against the new gateway: `fetchCapabilities`, `postBoard` and `fetchAttachments`,
`registerBridgeDiscover`, Codex and Copilot dispatch, `host_op`, `presence_watch`, and
`presence_derive`. The agent routes, session authority, and the daemon protocol are unchanged.

## Phase 8 - Migration

After the Router is live and the key backfill has confirmed every member, before any deletion.
- Fence: a migration epoch every gateway write boundary checks. Phones and agents get "migrating"
  on every mutation; in-flight console ops settle or are failed typed; no in-flight op is
  imported, because `DurableOpStore` keeps only a marker, not the request.
- Cut: with zero writers, immutable hashed snapshots of every gateway store and blob root at one
  epoch. Restore is offline into an empty Router process, never into a live one.
- Import: board envelopes and attachment bytes; mailbox rows, cursors, and epochs with an explicit
  old-to-new mapping; pending deliveries; read anchors. Verify counts, hashes, parent and rank
  invariants, attachment manifests.
- Phone self-migration on first hub connect: scheduled sends and read anchors enter the journal
  from the local records and upload; the local alarm is cancelled only after the Router accepts.
  Drafts and goals stay where they are.
- Each gateway holds a migration lease: active, offline, retired, or excluded. Router authority
  for owner state turns on when every active gateway reports complete; an offline gateway is
  fenced and reconciles its epoch on reconnect before it may write.
- No deletion until every record has a verified disposition.

## Phase 9 - Cutover and removal

Order: Router (both surfaces live), then every gateway, then every phone, then the plugin bump
pushed last, so marketplace auto-update never installs a plugin ahead of its gateway. No pin.
- Rollback: restore the Phase 0 snapshots from the manifest, no fetch, no build. Writes made after
  cutover are lost (working assumption, see Status). Window one day; then delete the old Router
  console surface and every old gateway path in one commit. Any shim that lets the two coexist
  during the window carries a remove-by comment.
- `setup.sh --verify` learns the new registration. Vault questionaire resumes on the new
  substrate.
