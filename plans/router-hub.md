# Questionaire

Total restructure: the Router becomes the hub, gateways become symmetric leaves. Supersedes the
route-gateway model. `plans/vault.md` is parked until this lands; the board holds plugin ideas.

## Status

Questionaire complete. Plan through three refinement laps: 60 findings, 48 verified against the
code, 7 refuted. Phase 1 gates every later phase, and each spec it produces gets its own audit
when written.

Phase 0 on this host: snapshot and operator's note at `volumes/router-hub-phase0/20260901-172058`
(gitignored). Other gateway hosts take their own per the note. Owner key backup exported
2026-09-01.

Evidence the plan rests on, verified against the code:
- Timeouts. The gateway waits 120s for a Router answer (`TOOL_CALL_TIMEOUT_MS`). The Router holds a
  relay 70s (`GATEWAY_RELAY_TIMEOUT_MS`) and rejects a late reply by id. Wake waits 600s
  (`WAKE_TIMEOUT_MS` default), and a positive wake ack clamps the registration window to the
  original deadline. The phone reads for 35s (`PINNED_READ_TIMEOUT_MS`), holds a long poll 40s
  (`LONG_POLL_HOLD_MS`) against the Router's 55s (`ROUTER_HOLD_MS`), and refreshes discovery every
  30s (`DISCOVERY_REFRESH_MS`).
- Commits. The transport failure-fix set is the 35 commits listed in Phase 1, from a wider window
  than 120. The Codex thread lifecycle cluster is outside this plan.
- `discoverFull` has no single-flight; the only `inFlight` in `routes` guards blob fetches.
- Two delivery legs exist today. Gateway to session holds a row until the receiver acks
  (`PendingDeliveryStore`, `ChannelDeliveryCoordinator`) for a peer that can ack; a legacy peer
  retires the row on socket write, and a held row can still expire or be failed. Gateway to
  gateway is the synchronous `gateway_relay` RPC. Question 3 extends the first model to the second
  and makes it unconditional.
- Board entry `bd_36caa212` holds the route-gateway analysis behind the plan.

Owner decisions:
- Degraded mode is retracted. No phone-to-gateway path exists: port 20000 is loopback, port 20003
  is enrollment only. Router down means a read-only cache on the phone and "Router unavailable"
  on every action, with one allowance: a scheduled send may be composed offline and journaled
  until the Router returns.

> "Retract it. No degradation. Router down means the phone read-only cache only. Maybe scheduled
> send at most. Just "Router unavailable"."

- Scheduled sends move to the Router as sealed-shared rows with a clear fire time, so they fire
  with the phone off. The Router is their only scheduler; the phone's alarm path retires. Drafts
  and armed goals stay phone-local.

> "and sure, scheduled sends at the Router."

- No rollback. Fix forward; Phase 0's snapshots are the only safety net. The federation is one
  owner plus a test user's Domain, so a window that preserves post-cutover writes buys nothing.

> "no rollback. just 1 user and a test user Kashia"

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
  One wire change: `send` and `respond` carry a producer-issued `opId`, because the Router op
  ledger needs an identity that survives a retry through another gateway, and today's requests
  have none (`deliveryId` is minted per attempt).
- Host daemon.

ROUTER DOWN
No phone-to-gateway path exists and none is added. The phone shows its cache read-only and every
action answers "Router unavailable", except composing a scheduled send, which the phone journals
and uploads when the Router returns. Gateways keep their tmux sessions; MCP tools that need owner
state fail the same way. Today's behaviour is the same minus the cached rows, so this is not a
regression.

THE RISK, stated plainly
This is a rewrite of the layer that took 35 delivery fixes. Each encodes a real failure mode. The
plan must map every one to "impossible by construction under the hub" or "carried over", or the
rewrite rediscovers them. Phase 1 is that map.

### Assumption A1 - Clean break, coordinated cutover

The four components update on separate triggers, and an old phone cannot talk to a hub Router. A
single-owner self-hosted system can cut over all four at once. No wire compatibility with the
route-gateway model is kept. The cutover has a migration step and no rollback.

### A2 resolved - Cross-Domain is same-Router; the Router stays a courier for friends

Verified: the Router never talks to another Router. `gatewayBridge` keeps `gatewayConnections` as a
map of domainId to a map of gatewayId to connection, so one Router hosts many Domains, and the
`EnrollmentCoordinator` holds the signed link edges between them. A friend's gateways are already
connected to the hub.

`crossDomainPeers` is gateway-local. It holds the friend gateway's box and
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

No synced symmetric keyring exists. The keyring is `DomainSnapshot`
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

`applyCascade`, the awareness fold, and the MCP cascade prose all read
titles, and the awareness bank hashes complete pre and post entries. So the split is: the Router
runs cascade on structure and emits observations as complete pre and post projections in which
title and body are the ciphertext it already holds; the gateway that delivers an awareness row
opens them, folds, and renders; the gateway that answers a board write re-hydrates the cascaded
titles before answering MCP. One cascade owner, one renderer, the Router still blind. Board
sessions are `(domainId, gatewayId, sessionId)` in the clear envelope, never a bare session id.

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

Inbox rules:
- The inbox is `DeviceMailbox` and `PendingDeliveryStore` semantics hosted at the Router, not a new
  design: producer-issued idempotency keys, epoch-gated per-consumer cursors, compaction to the
  slowest consumer, idle-consumer eviction, durable acceptance before the ack, retirement on the
  receiver's ack. Not carried: `DeviceMailbox`'s OOM backstop that evicts unacked rows, and
  dedupe by content hash. Capacity REFUSES before the append; an accepted row is never evicted.
- A row is a clear envelope plus ciphertext. The producer signs the envelope (origin, destination,
  idempotency key, epoch, content kind); the Router adds sequence, accepted-at, and measured size.
  Body, file manifest, and awareness payload are inside the ciphertext. No title.
- The operation ledger moves with the mailbox: one Router transaction keyed
  `(domainId, ownerId, conversationId, opId)` dedupes acceptance and appends the row, so a retry
  through a different gateway cannot accept twice. Console ops carry that `opId` today; agent
  `send` and `respond` gain one (the MCP wire change above). `deliveryId` and `channelJobId` are
  never the key.
- Every append answers a sender-visible result: accepted, refused (capacity), expired, target
  revoked, or durability failure, with "accepted, durability uncertain" distinct from "not
  accepted".
- Wake is not a Router op. A row for a session that is not registered makes the destination
  gateway run its existing wake path; `wakeStart` already fires at dispatch and becomes the
  `waking` report. The row's state (accepted, waking, delivered, failed) is what the sender reads.
  Timeout and host-disconnect stay `waking`, since the launch may still complete; `failed` is a
  definitive refusal only. No synchronous wait crosses the Router.
- Acks are sender-local delivery state. The hold-until-ack behaviour carries over from
  `ChannelDeliveryCoordinator`; the ack envelope `(deliveryId, gatewayId, sessionId, incarnation,
  deliveryEpoch)` is new, since today's ack is `deliveryId` alone and any socket in the team can
  retire a row. Across Domains acks never distinguish an absent target from an unshared one, and
  delivered state is redacted after unshare or unlink.

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

Recommendation reason, chosen: C is B with a floor under eviction. sha256 ids mean the Router never
reasons about staleness; the cache is a quota number and a sweep. Closes the asleep-laptop case
that A leaves open.

The Router has no blob store, and board attachments are kept
OUT of the gateway's evicting cache on purpose (`BoardAttachmentStore`, no sweeping). The Router
gets two stores, both Domain-scoped in path and lookup: a quota-swept cache for message files, and
a reference-held store for board attachments and scheduled-send files, released when the entry is
deleted, or when the last row that names the file is done with it: the fired session row
terminal (receiver ack, expiry, typed failure) AND the owner-inbox result row compacted past every
consumer cursor. A phone-uploaded file has no gateway origin, so the Router copy is the only one
until both rows are done. Firing transfers the reference to the rows; it does not drop it. Each cached entry records its origin `(domainId, gatewayId)` so a miss
can be routed and an offline origin told apart from an evicted one. The phone fetches the Router
first and the origin only on a typed miss.

### Consequences settled by Questions 1-4, not separately asked

- The Router is authoritative for every owner-scoped thing it holds; the phone is a CACHE with
  offline reads, plus a JOURNAL of its own unsent mutations. `ChatPersistence` and `AppStateStore`
  persist what the Router last said, keyed by Router version, and the journal separately. A newer
  Router version never discards a journaled local edit; it is re-applied or reported.
- The gateway keeps only what it physically owns. Precisely: the session store (tmux records, bind
  metadata, labels, workdirs), Codex and Copilot catalogs and threads, pending jobs, `ReplayGuard`,
  origin blob copies, its identity and admissions, `crossDomainPeers` and the sealer, the
  awareness delivery adapter, and the daemon capability source. The owner state that leaves:
  `boardStore`, `capabilityStore`, the device mailbox, the plane registry, awareness generation,
  share state, read anchors, the console op ledger. Migrated once in Phase 8, then gone: pending
  deliveries, board attachment bytes. Discarded after the migration fence: board replay markers.
- The Router keeps a session registry: `(domainId, gatewayId, sessionId)` for every session record
  a gateway reports, kept while the record exists and not expired with presence. It is how a row,
  an observation, or a board assignment reaches a sleeping session's gateway.
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

Every console op is an OkHttp POST
through `ConsoleRelayTransport.relay`, `ConsoleClient.poll` is an HTTP long poll, and
`buildLeafPinnedClient` pins HTTPS only. OkHttp's `newWebSocket` on that pinned client runs the
fingerprint trust manager during TLS, before the upgrade, so pinning carries over; `ws` and `http`
schemes are rejected. `IdlePushbackManager`'s tier POLICY is untouched; its `DeepIdleScheduler`
interface gains one client, the transport coordinator, which is the only thing that starts a poll,
holds a socket, or takes the wake lock. HTTP polling stays until the socket's tests pass.

# Plan

Scale: About 5,900 lines of gateway modules move to the Router or die. The Router is about 3,400
lines and roughly doubles. On the phone, 47 Kotlin files match a route-gateway grep, tests included.
The executable subset is a Phase 1 output. MCP tools and the host daemon are near zero in code and
non-zero in verification.

Ordering: Phase 1 gates everything. Phase 2 gates every phase that writes sealed content, phases 3
through 6. Phase 3 gates 4. Phase 8 gates 9.

## Phase 0 - Backup and freeze ✅ Done

- ✅ Export the owner key backup from Management. It regenerates every content-key epoch. Exported
  by the owner 2026-09-01.
- ✅ Snapshot every durable store: each gateway's `DurableStore` files and blob roots, and the
  Router's `federation.json`. Hash each. No phone snapshot: drafts and goals stay on the phone,
  and everything else the phone holds is re-derived from the Router or journaled to it. Done on
  this host; other gateway hosts pending the owner, command in the operator's note.
- ✅ Record the running release by hand: commit, image digests, APK hash, snapshot paths and
  hashes. An operator's note. No rollback.
- ✅ `plans/vault.md` stays parked. No code.

## Phase 1 - Failure-mode ledger, invariants, and specs ✅ Done

No code. Output is the `# Specs` and `# Phase 1 outputs` sections. Gates Phase 2.

### Ledger

Transport failure-fix set, oldest first: `e6f70cb4`, `12869b9c`, `2ce9938f`,
`66b71d4d`, `0a1a5983`, `21fbd1a8`, `2ead9add`, `5495f624`, `258e1f51`, `0d4ccd6a`, `cb98949d`,
`ac10e5db`, `f270dcf4`, `cacc8774`, `054368bb`, `d489614f`, `d7fb5a6a`, `b0a51863`, `d1ebf73b`,
`9ece181c`, `a0d18ad0`, `4bee4c04`, `04046284`, `18dc9910`, `e10af02c`, `f0c2e370`, `efe70a45`,
`a321772e`, `6ffa04c4`, `bbb29426`, `83301504`, `744f1a59`, `cd1f3df3`, `4e1e0b43`, `4963848d`.
Failure modes without a dedicated commit:
`PendingDeliveryStore.enqueue` refusing at capacity, `PendingDeliveryStore.sweep` expiring rows,
`DeviceMailbox.sweepIdleConsumers`, the legacy-peer retire-on-write branch of
`ChannelDeliveryCoordinator.offer`, and every cross-Domain relay gate named in A2. Excluded:
`d46807e8`, `2de44eef`, `d00c0fa5` (documentation), `9258d185` (test only), `b647b51c` (board
replay validation, not transport), the refactor-only wake and poll extractions, and the Codex
thread lifecycle cluster (`75442682` through `86cfab91`).

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
  windows, rendezvous, `byTarget`, nonces and cleanups. States the named-offline contract replacing
  the current 503.

### Inventories

- Symbol-level inventory of the phone's route-gateway dependencies: executable code, tests, and
  comments listed apart. Includes the non-transport consumers: `BoardManager` (`knownVersion` from
  `routeGatewayId`, per-gateway lanes, `enqueueMove`, attachment buckets, refusal notices),
  `BoardOps` (`forgetWithBoardDisposition`, `boardAssignTargets`), `reportRead`, terminal and
  session ops that pick a target gateway, `TrustOps` and `SessionOps` refresh triggers.
- Gateway connectivity and session liveness state machine as the phone will show it: connected,
  gateway asleep, gateway offline, row accepted, row waking, row delivered, row failed.

### Specs

One section per spec. Name its residue test. Later phases implement only these specs.
- Content envelope and key delivery (Phase 2).
- Router state layer: record format, segment and snapshot generations, fsync order, boot replay,
  compaction commit, corruption quarantine (its own, `durable-store`'s `load` returns null and does
  not quarantine), single-writer enforcement, quota, ENOSPC (Phase 4).
- Inbox, op ledger, consumer registry, session registry, delivery ack envelope, capacity, and
  result envelope (Phase 3).
- Presence deltas, roster, and the two projections (Phase 4).
- Share state and attestation (Phase 4).
- Board structure, cascade, sealed pre and post observations, the gateway awareness adapter, and
  the phone's sealed-text projection (Phase 4 and 6).
- Scheduled sends (Phase 4).
- Retained gateway endpoints: the local authentication boundary, Router request and response
  shapes, local-versus-Router composition, attachment authorization (Phase 5).
- Console WS, transport coordinator, and persistence journal (Phase 6).
- Migration fence, snapshot cut, and offline import (Phase 8).
- The cutover verification gate (Phase 9).

## Phase 2 - Owner content key ✅ Done

Commits 41bd6ff6, ce8ddb71, 4ec17784.

- Derivation, on the owner phone only, per S1: `HKDF-SHA256(root, salt = fixed, info =
  "switchboard-content-v1\n" + domainId + "\n" + epoch)`. Deterministic, so the owner backup
  regenerates epoch 1 once the Domain id is known. Epoch 1 at first root and when a restored owner
  learns its Domain id; cutover backfills it to every member. The owner path verifies every held
  epoch against the derivation.
- A standalone symmetric envelope beside the X25519 seal: AES-256-GCM, random nonce, AAD binding
  `(domainId, ownerId, epoch, content kind)`. `deriveKey` is private on both runtimes. Shared
  fixtures in `tests/fixtures/content-envelope` and `tests/fixtures/device-join`, opened by both.
- Keyrings: the phone persists epochs in the Keystore-backed store beside the identity, cleared
  with it on re-provision; the gateway persists them under `DATA_DIR/federation`. A corrupt slot
  or file is set aside, never read as empty and overwritten. One rule owner per runtime
  (`ContentKeyStore.classify` and `ContentKeyring.classify`): always unwrap, equal bytes for a
  held epoch pass, different bytes refuse the whole batch.
- Delivery as sealed key envelopes, one per recipient box key, the epoch inside the sealed body:
  - to a new console inside the `ConsoleTransport` sealed at Add Device. The join is signed by the
    new device's console key so the Router cannot swap the box key; the phone installs the
    transport, latches, snapshot, and keys in one store commit;
  - to a new gateway in the bootstrap bundle beside the signing console's admission. Install is
    staged under `federation/staging/`, then one `INSTALLED` marker, then activation copies each
    artifact into place with transport last; boot recovery re-runs activation, rolls back
    corruption, and fails the boot on any other activation error. Re-enrollment merges over the
    live plus bundle trust view and merges keys; first enrollment keeps trust on first use;
  - to an already-enrolled member by a re-delivery op: signed by the member's admitted signing
    key, box key resolved from the Router's admission record, never from the request; the
    response sealed to that box key; operation nonce persisted for idempotency and expiry (Phase
    3).
- Backfill at cutover: enumerate every admitted console and gateway, deliver every epoch, require
  per-recipient confirmation before Phase 8 may start.
- Reader state `missing_epoch`: retain the row, do not ack, do not compact, request re-delivery
  once with bounded retry. Distinct from malformed ciphertext and from a revoked target.
- Rotation: bump the epoch, re-deliver to current members. Old content is not re-encrypted.
  Documented, not automated.
- Revocation is authorization-only.
- Residue test: the key never appears in a log line or a debug ingest.
- Deploy order: the Router before the app, since the held device refuses a join whose `joinSig`
  an older Router dropped; the gateway before the app as usual, and an older phone's bundle still
  enrolls a new gateway because first enrollment resolves no signer.

### Bug Classes

- **Staged install activation** (`bootstrapInstall.ts`): patched three rounds. Round one moved
  the allowlist write to the atomic writer and made activation require all four artifacts. Round
  two replaced rename-by-artifact with copy-then-remove so recovery re-runs. Round three split
  corruption from activation errors and added the owner check on the recovery road. Defect class:
  a multi-file install with no single commit point. Architecture verdict: fold `domain-id` into
  the allowlist record, write transport last, and delete the staging directory, after the keyring
  writer below and once Phase 3's re-delivery road can heal a lost transport rename (deferred item
  A7 under Phase 3). A per-generation directory with a pointer rename was rejected: it moves the
  invariant into every reader and both incremental writers.
- **Held-epoch rule** (`contentKeyStore.ts`, `ContentKeyring.kt`, `bootstrapInstall.ts`):
  patched twice. Round one made the outcome three-way. Round two made every road unwrap first and
  byte-compare, and made re-enrollment merge instead of replace. Defect class: three roads into
  one keyring, each with its own rule. Architecture verdict, landed: `ContentKeyStore.classify`
  plus `commit` own the rule on the gateway and `stageBootstrap` takes the store; the phone's Add
  Device is one store commit through `ContentKeyring.classify`.

## Phase 3 - Router: inboxes, op ledger, blob stores ✅ Done

Commit 68fb09c8.

Additive. Old surfaces untouched.

Slices, in order: 3.0 the opening commits below; 3.1 the S2 owner state layer
(`src/federation-server/owner/`); 3.2 the S3 wire shapes (`src/shared/schemasInbox.ts`, OwnerOp
signing bytes, frames) and codegen roots; 3.3 the S3 inbox service (addresses, rows, op ledger,
consumer and session registries, capacity, retention, results) on 3.1; 3.4 the OwnerOp intake on
the console surface and the gateway frames on the bridge (`inbox_append`, `inbox_ack`,
`session_upsert`, `session_forget`, incarnation on register, `inbox_deliver` push); 3.5 the
gateway drain (`inboxDeliveryPump`: durable claim, offer through `ChannelDeliveryCoordinator`,
wake path, ack) and the cross-Domain append that replaces `sendCrossGateway` and
`relayWithRetry`; 3.6 `blob_fetch` by op id with the constants test; 3.7 the Router blob cache
and reference-held store.

Opening commits, from the Phase 2 architecture pass, before the re-delivery road:
- A4, decided: `keyringGeneration` leaves `KeyReceiptSchema` and `keyReceiptSigningBytes`. A
  receipt names the Domain, the recipient, the epoch, `at`, and a nonce; the nonce makes it
  idempotent and neither keyring tracks a generation. Protocol.kt regenerated.
- A10: Kotlin twins of `keyRequestSigningBytes` and `keyReceiptSigningBytes` with canonical-bytes
  vectors in the content-envelope fixture, after A4.
- A3: the phone's `FederationManager.installContentKeys(envelopes, trust)` as the one road entry,
  `@Synchronized`, returning a typed merge decision; `commit` is the only slot writer and the
  receipt is signed only after a durable commit.
Phase 3 scope note: the OwnerOp intake lands with `deliver`, `consumer_register`, `inbox_read`,
`inbox_advance`, and `op_result`; the VALUE ops (`blob_fetch`, `list_dirs`, `create_session`) keep
riding `console_relay` until the phone transport switches in Phase 6, where the Router forwards
them with a typed `unreachable`.
Later in the phase or after it: A5 (a present-but-invalid allowlist fails closed and is set aside),
A7 (delete the staging directory; `domain-id` folds into the allowlist record; transport written
last), A8 (residue tests: sole writer of `content-keys.json`, sole derivation site, no key bytes in
any log the roads emit, on both runtimes), A9 (a cross-runtime merge decision table in a shared
fixture), A11 (a residue test that every shared `_V1` preimage tag has a Kotlin twin and a fixture).
Crust from Phase 2, small: the identity mint temp (`federation-identity.json.<hex>`) sits outside
the atomic temp sweep's name grammar, so a crash mid-mint leaves it behind; the phone keeps one
corrupt content-key sibling slot, so a second set-aside overwrites the first; numeric wire
grammar (`1.0`, quoted `"1"`) differs between zod and kotlinx, which matters once a row both
runtimes decode exists, so the Router re-emits rows through its schema before relaying.
- Inboxes per Question 3, addressed by owner or by `(domainId, gatewayId,
  sessionId)`. Consumer registry keyed by console installation identity with incarnation, last
  seen, forget on revoke. Capacity refuses; per-Domain and per-owner quotas. Recovery of
  accepted-but-undelivered rows on restart. One writer, residue-tested.
- Op ledger transaction: dedupe on `(domainId, ownerId, conversationId, opId)`, append, persist,
  then answer. In-flight, complete, failed, and crash-recovery states.
- Session registry per the Consequences section, fed by gateway registration and session record
  changes.
- Delivery to a gateway over its WS with `(deliveryId, incarnation, deliveryEpoch)`; the gateway
  offers to the session and acks on the receiver's word with the full ack envelope; a row for an
  unregistered session runs the gateway's wake path, `wakeStart` reports `waking`, ambiguous
  outcomes stay `waking`. Only the destination gateway may ack its rows. `deliveryProtocol < 1`
  plugins are refused at cutover, not silently downgraded.
- Cross-Domain rows as A2 states. `sendCrossGateway` and `relayWithRetry` are replaced by an
  append, never merely deleted.
- `blob_fetch` stays request-response with an operation id, the 70s Router hold and 120s gateway
  wait named in a constants test, typed outcomes, and late-result rejection by id.
- Blob cache: content-addressed, sealed, Domain-scoped, streaming upload with a lease that
  carries a generation and expires 10 minutes after its last renewal (an expired lease's partial
  is reclaimed by the sweep and a chunk commit under it is refused; boot reclaims partials with
  no live lease), generation-checked chunk commits, atomic partial-to-final promotion, durable
  index or scan-and-rebuild on boot, per-Domain quota, LRU sweep that skips live transfers,
  origin `(domainId, gatewayId)` per entry, typed miss.
- Reference-held store: Domain-scoped, released with the entry or the fired send, boot-time orphan
  reconciliation.

Deferred from the Phase 3 audit:
- The `sent` echo row in the owner inbox lands with the phone transport (Phase 6), which is its
  only reader; the deliver op writes one row until then.
- `ReferenceHeldStore.reconcile` runs at boot once S5 to S7 state (Phase 4) supplies the live
  references; nothing holds a reference before that.
- An operator command to accept a quarantined range and write `durability_failure` result rows
  for it (Phase 4 operations). Until then a quarantined owner stays quarantined across restarts
  and `/health` names it.
- A consumer's incarnation comes from the phone's `consumer_register` (Phase 6); the intake
  stores what the op carries, default 0.
- Op ledger and session registry ids carry no `domainId`: the per-Domain store directory does.
- A result row written by a retire batch skips the capacity check on purpose: the retire must
  land, and a result row is bounded by the rows it answers.

### Bug Classes

- **Journal batch atomicity** (`ownerStateStore.ts`): one journal line per op, replayed
  independently, let a torn batch replay a ledger record without its row and an fsync failure
  reuse a seq. Verdict, landed: one line per batch, applied whole or not at all; an fsync failure
  applies to memory and answers `durability_uncertain`; a short write is cut back to its start.
- **Quarantine without a record** (`ownerStateStore.ts`): the bad segment was renamed and nothing
  else, so the next boot opened clean. Verdict, landed: the manifest records the quarantine and
  a corrupt manifest quarantines in place; `/health` names quarantined owners.
- **Claim before custody** (`inboxDeliveryPump.ts`): the claim was persisted before the offer and
  cleared after an ack that may not have landed, so a lost ack re-offered and a `missing_epoch`
  row was never retried. Verdict, landed: a claim is cleared only on a landed ack, an ack with no
  local custody drops its claim, and the receiver's ack must name the session and hold a claim.
- **Origin binding gaps** (`gatewayBridge.ts`, `ownerOpIntake.ts`, `schemasInbox.ts`): the
  address Domain was never bound to the signer, a linked peer could append to any address kind,
  a producer could write a `clear` row, and a bearer-only registrant drained an inbox. Verdict,
  landed: the intake binds the address to the op's Domain, a peer row reaches only a registered
  session, `clear` rows are Router-only by schema, and an identity-less registration gets no
  incarnation.

## Phase 4 - Router: owner-scoped state (tiers 1 and 2) ✅ Done

Commit 975b8725.

- The Router state layer per its spec, separate from `fileSecretStore`, which stays the enrollment
  and admin whole-file CAS. Per-Domain, per-owner records keyed `(domainId, ownerId, kind, id)`;
  keyed versions with CAS.
- Presence: each gateway sends a baseline snapshot on registration, then deltas with a sequence,
  its incarnation, and tombstones. A socket drop marks the gateway's rows
  `presenceFresh: unreachable` and keeps them; the reconnect baseline under a new incarnation
  replaces them; only `session_forget` removes a row. Signing is not needed; the authenticated
  connection is the boundary.
  Two projections, separately versioned: session presence (the `TeamInfo` fields) and gateway
  spawn points. The fold is per audience: the owner sees everything; a friend Domain sees the
  `presenceForDomain` projection (shared sessions only, the same field filter).
- Roster: expected gateways are the Domain's admitted gateways; each carries registration
  freshness and last accepted incarnation. `rosterKnown`, `asked`, `answered`, and the unreachable
  lists are derived from it, so the `bridgeDiscover` shape survives with no fan-out.
- Share state and attestation per A2.
- Board: `boardStore`, `boardAuthority`, `boardCascade` at the Router on the clear envelope (id,
  parent, rank, state, session as `(domainId, gatewayId, sessionId)`, version, attachment
  manifest). Titles and bodies sealed. Cascade runs on structure. Observations are complete pre
  and post projections carrying the sealed title and body, delivered as inbox rows to the gateway
  hosting the recipient session per the session registry; that gateway's awareness bank keeps its
  fold (first pre, last post), recipient selection, `act_now` for a gone entry, holding for a
  waking session, dropping at `MAX_HOLD_MS`, opens the text, and renders. A board write's
  cascaded changes come back the same way and the answering gateway re-hydrates their titles
  before the MCP response. Attachment manifest commits after the bytes are in the reference-held
  store.
- Scheduled sends as tier-2: destination resolved at schedule time to `(domainId, gatewayId,
  sessionId)` in the clear envelope with the fire time, the sender conversation and its channel
  job key so a reply can route; files uploaded at schedule time to the reference-held store; body
  and the echo the phones need to fold the result into the pending row sealed. A spawn point is
  not a valid target, as `routes.send` already refuses. One record per target session; replace and
  cancel are versioned writes with tombstones, so a stale cancel cannot remove a newer
  replacement. At fire time the Router appends the row to the session inbox through the op ledger
  under the send's own opId, and writes a sender-visible result row the phones render as pending,
  sent, or error. The phone's alarm path retires.
- Capability fold and read anchors as tier-1 state.
- Access-matrix residue test at the store layer and the public methods.
- New wire shapes in the shared Zod schemas, Kotlin regenerated.

Deferred from Phase 4:
- The link edge drop stays the owner-signed `revoke_xdomain_link` enroll op; the `cross_domain_unlink`
  OwnerOp tears down shares, generations, and rows and pushes `unlink` frames, and does not touch the
  edge.
- A scheduled fire is two writes, not one batch: the ledger append through the inbox service, then
  the record and result row. A crash between them re-arms the record as `firing` and the ledger's
  opKey dedupe keeps the second fire from appending twice.
- The gateway opens a scheduled `message` row (Router origin, body sealed under `inbox.body`) in
  Phase 5; the Phase 3 pump only knows `op.payload`.
- The owner projection reads a linked Domain's rows to fold its friend projection and records that
  projection's version in the linked Domain's store; a named cross-Domain read, per the Consequences.
- Gateway consumers of every frame here (`presence_baseline`, `presence_delta`, `share_job_live`,
  `board_op`, `capabilities_read`) land in Phase 5.

### Bug Classes

- **Payload-named identity** (`presenceService.ts`, `boardService.ts` `board_op`, `shareService.ts`
  `attest`): the second phase in a row where a handler trusted a gatewayId, sessionId, or
  sessionTarget from the payload instead of the registration (Phase 3's origin-binding class).
  Verdict, landed in two rounds: every frame handler receives the registration and stamps or
  checks identity from it, and the bridge now deletes `domainId` and `gatewayId` from a frame's
  payload before the handler runs, so a handler cannot read one. Residue-tested.
- **Result rows sharing the op's key** (`scheduledService.ts`): the pending, sent, and failed
  result rows used the send's own opKey, so the op ledger answered `conflict` to the fire itself
  and no scheduled send ever landed. Unit tests with a stubbed inbox could not see it. Verdict,
  landed: result rows key beside the op (`<opId>.pending`), and one test per service runs
  through the real `InboxService`.
- **Reference holds outside the batch** (`boardService.ts`): holds and releases moved before the
  write committed, so a refused write leaked or dropped a hold. Verdict, landed: reference changes
  are collected and applied after the batch answers ok.

## Phase 5 - Gateway client ✅ Done

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
- Delete at the replacement point: `discoverFull` and every `DISCOVERY_REFRESH_MS` consumer,
  `consolePushOps`, the `list_teams` and `presence_push` legs of `presenceExchange`, the plane
  registry and `pollPlanes`, `capabilityStore` (phones re-report on first connect), awareness
  generation, `sendCrossGateway`, `relayWithRetry`.
- Delete after Phase 8 imports and verifies these source stores: the
  device mailbox and `consoleDevices`, `pendingDeliveries`, `boardStore` and the board modules
  except the awareness adapter, board attachment bytes, `durableOpStore` and `boardReplays`,
  `crossDomainShareState`, the read-anchor projection.
- Residue test on the retained-state inventory of the Consequences section.

Slices: 5.0 presence baseline and deltas, `presence_resync`, share attestation, the `unlink` frame;
5.1 Router-backed `/discover`; 5.2 Router-backed `/task-board` and observations; 5.3 Router-backed
`/capabilities`; 5.4 blob upload to the cache; 5.5 the deletions and the residue test.

**The deletion list remains in use.** Five analyses, one per target, reported live importers with
line numbers. Every target still has a consumer in a later phase:
- `discoverFull` is not a fan-out any more; its body IS the Router-backed replacement. The name is
  the console `list_teams` seam and the `/discover` producer for `bridgeDiscover`, so it survives to
  the Phase 9 cutover. Its `DISCOVERY_REFRESH_MS` consumers are all on the phone.
- `relayListTeams` and `pullPresenceFromDomain` are the cross-Domain presence backstop, on a 10s
  timer. The Router computes the same content in the owner projection's `linked` array, but nothing
  folds it into `CrossDomainPresenceConsumer`, and the phone's friend-session map is fed only by the
  `crossDomainPresence` poll plane. Phase 6.
- `presence_push` likewise: dropping it degrades the FRIEND Domain's phone freshness, and dropping
  the schema arm breaks an un-upgraded peer's still-outbound push on a path with no version
  negotiation. Phase 6, and the arm waits for Phase 9.
- `sendCrossGateway` is not a transport; it is the origin's bookkeeping, and the sole minter of the
  `dstDomainId` binding the reply gate reads. `relayWithRetry` still carries every SAME-Domain
  gateway-to-gateway op, the reply pin, and the `console_push` fan-out. The Router append replaced
  the cross-Domain transport only.
- `consolePushOps`, `pollPlanes`, `capabilityStore` and the plane registry are all on the live phone
  path, because the Router relays console frames rather than handling them. The registry also stays
  in the Router binary because `presence-identity.ts` imports `stableHash` from it, and Phase 5 board
  awareness imports it too.

Landed instead: `gateway-retained-state-residue.test.ts`, a ratchet that fails when owner state on
its way out gains a NEW gateway consumer, and asserts the agent board path is off `boardStore`.

Deferred from Phase 5:
- The phone still writes the gateway's local board while agents write the Router's. The two boards
  are separate until Phase 6 moves the phone.
- `capabilities_report` has no producer, so the Router's capability rows are empty. `/capabilities`
  therefore prefers a Router snapshot only when it says `known: true`.
- `presence_read_friend` has no caller; the phone is its audience.
- The reference-held blob upload has no Phase 5 caller. Board attachments and scheduled sends are
  written by the console, which moves in Phase 6.
- `blob_fetch` reads the Router CACHE, never the reference-held store. Board attachment bytes still
  live on the gateway that holds the entry, so the agent fetch works today. Phase 6 must widen the
  fetch when the phone starts uploading an attachment the Router alone holds.
- The entry gains `session` beside the bare `sessionId`; the plugin reads the bare one until Phase 9.
- S8 says `from` is stamped by the gateway, never read from the request. It is still read, but
  `refuseImpersonation` proves the caller holds the binding for the name it claims, so a forged
  `from` is REFUSED rather than reattributed. The property S8's residue test wants holds; the
  mechanism differs. Stamping instead is a plugin wire change, so it waits for Phase 7.
- S8 says the board op carries `{ actor: session }`. It does not: the receiver names the writer from
  the authenticated channel, which is the Phase 4 payload-named-identity fix applied to this frame.
- A board write reads and decrypts the WHOLE board, up to the CAS retry count per write. Bounded by
  `MAX_ENTRIES_PER_OWNER`; a partial read is a design change, not a fix.

### Settled: sealing a blob

Answer C stands. The Router holds ciphertext, and what gets dropped instead is the rule that the
Router verifies a plaintext digest.

**Per-chunk AEAD on the boundary the upload already uses.** `blob_chunk` carries `offset` and
`final` today and the uploader already splits at `BLOB_CHUNK_BYTES`, so sealing rides that boundary
rather than inventing framing. Each chunk is sealed on its own; its AAD binds the domain, the owner
root key, the epoch, kind `blob`, the blob id, the chunk index, and the final flag. Binding the
index stops a splice, the blob id stops a swap between files, and the final flag stops a truncation.

**Verification moves end to end.** The blob id stays `sha256-<plaintext digest>`. The Router verifies
only a ciphertext digest carried on `blob_begin`, which is what it can actually check, and the phone
verifies the plaintext digest after opening. That is stronger than the Router vouching for bytes,
not a concession to get sealing in.

**Ranges stay arithmetic.** Each frame is `nonce (12) + ciphertext (plaintext length) + tag (16)`.
The full-chunk stride is `BLOB_CHUNK_BYTES + 28`, or 1,048,604 bytes. The Router serves whole
covering chunks and the reader trims after opening. The store learns the framing constants, never a
key, so it stays opaque to content.

The Router store callers pass the ciphertext digest to `BlobStore`. Plaintext callers retain id
verification. `blob_fetch` rounds ranges to chunk boundaries. The reader opens, trims, and checks
the plaintext digest.

Rejected: a cleartext cache. It would make attachments the one content category the Router can read,
against every other decision here, and it is the option that cannot be walked back once phones
depend on the Router serving those bytes. If the Router is ever to be trusted with content, answer C
changes first and says so.

### Bug Classes

Found by two audits of the completed phase.

- **Success inferred from the absence of a refusal** (`presenceReporter.ts`): a send that never
  landed advanced the sequence and latched `hasBaseline`, because only the resync flag was read and
  an error answer looks like an accepted one. On an idle gateway no later delta ever corrects it, so
  the machine's own sessions and shells vanish from discovery while it is online. Verdict, landed:
  a send must be positively acknowledged, a failed baseline holds the deltas, and a failed delta
  keeps its sequence and retries.
- **The remote copy trusted over the local original** (`routes.ts` `discoverFull`): the Router's
  projection replaced this gateway's own rows, so a lost presence write hid live sessions on the one
  machine that cannot be wrong about them. Verdict, landed: own rows and shells come from here, the
  Router supplies every other gateway's.
- **A read placeholder written back as truth** (`boardClient.ts`, `routes.ts` update): text that
  could not be opened rendered as a placeholder, and an edit restated the whole sealed block, so a
  body-only edit could store the placeholder as the real title. Verdict, landed: the view says
  whether an entry's text opened, and an edit refuses when it did not.
- **Restating a field the write did not mean to touch** (`routes.ts` update): the upsert restated
  the parent, which runs the PARENT's authority check, so a session could not edit a child it
  legitimately held. Same class as the sealed-names blanking found earlier in the phase. Verdict,
  landed: an upsert names only what it changes.
- **Release before hold on the same reference** (`boardService.ts`): replacing `[A]` with `[A, B]`
  queued a release of A and then a hold of A, and a release that takes the last reference deletes
  the bytes. Verdict, landed: the batch nets to a membership diff before touching the store.
- **A reservation counted as a holding** (`referenceHeldStore.ts`): `has()` answered on references
  alone, and a begin takes the reference before the bytes, so a board entry could name a file whose
  upload never finished. Verdict, landed: referenced AND whole.
- **Evidence that never expires** (`shareService.ts`): a job attestation had no age, so one
  attestation pinned its share for as long as the Router ran. Verdict, landed: attestations age out,
  against the Router's own clock rather than the value the attester sent.
- **A local answer made to wait on a remote one** (`routes.ts` `capabilities`): the Router call can
  hold for its own two-minute timeout while this route's caller gives up in well under two seconds.
  Verdict, landed: the Router gets a one-second deadline and the local answer stands.
- **A refusal minted from a storage failure** (`boardService.ts`): every non-ok batch answered
  `conflict`, so a full disk read as contention and was retried forever. Verdict, landed: only a CAS
  conflict is a conflict.
- **One dead child bricking the branch above it** (`routes.ts` claim and release): a trashed
  descendant refused the whole subtree, permanently. Verdict, landed: trashed members are stepped
  over, being out of every list already.
- **A payload naming what it may pin** (`gatewayBridge.ts` `blob_begin`): the held store took its
  reference from the frame with no check that the record exists, and the cache admitted against a
  size the caller declared while reserving nothing until the bytes arrived. Verdict, landed: both
  upload frames require sealing, reservation, and reference validation.

A second red team, over the fixes rather than the phase, found six more. Fresh code is where fresh
bugs live, and four of these were introduced by the first round's own fixes.

- **A doubtful fsync read as a failed write** (`boardService.ts`): `durability_uncertain` means the
  batch APPLIED and only the sync is unproven, so refusing contradicted the board the same call
  advanced and skipped the holds and observations for a live entry. Verdict, landed: it answers
  applied, and a crash that loses the unsynced line loses its ledger record with it.
- **An idempotency key that included derived state** (`boardService.ts`): the replay hash covered
  the rank and state the gateway rebuilt from the CURRENT board, so the crash retry the ledger
  exists to cover answered `operation_id_reused`. Verdict, landed: the hash covers the caller's
  intent, which ops over which entries, and nothing derived.
- **A ledger keyed by a value the caller mints** (`boardService.ts`): records had a TTL but no cap,
  so a caller could grow owner state against the Domain quota. Verdict, landed: a per-owner cap,
  oldest first, keeping the retries that could still arrive.
- **"Not yet known" read as "wrong"** (`routerClient.ts`): the new incarnation gate compared against
  a value set a microtask later, so the registration burst the Router pushes immediately was dropped
  and its held inbox rows stranded until the next reconnect. Verdict, landed: only a KNOWN and
  different incarnation is stale.
- **A retry on the debounce timer** (`presenceReporter.ts`): a failed delta re-armed the 250ms
  debounce, spinning at four attempts a second for as long as the Router kept failing. Verdict,
  landed: failures retry on the retry delay, and a landed baseline retires what a failed one armed.
- **An all-or-nothing sweep meeting a new refusal** (`boardService.ts`): the trash sweep ships one
  batch, so the `would_orphan` refusal added this phase let one trashed parent stop reclaiming
  anything for the whole Domain. Verdict, landed: the sweep removes only entries whose live subtree
  is also dead.

### Two mechanisms patched repeatedly

Both were patched to green here. Neither is fixed. Raise them at the next architecture pass.

**`boardService.write()` is one pass doing seven jobs.** Authority, mutation, cascade, durability,
reference bookkeeping, observation delivery, and now idempotency all interleave in one function, and
each round of review found a defect at a seam BETWEEN two of them: holds applied outside the batch,
release queued before hold, a storage outcome minted as a refusal, an applied batch answered as
failed, a replay key covering derived state, a ledger with no cap. The pattern will continue while
the seams are implicit. It needs a written order with each stage's failure answer named, so a new
stage cannot be inserted into the middle of another one by accident.

**`presenceReporter` is a hand-rolled send state machine.** Three rounds found three defects: a
baseline that recursed and deltas that raced, success inferred from the absence of a refusal, and a
retry armed on the debounce timer. Each fix added another latched flag or another timer beside the
ones already there. Four pieces of state, two timers and three arming sites now decide whether a
frame may go. It needs one explicit state machine, not more flags.

A fourth defect of the same shape was found by the architecture pass and fixed here: `markDirty`
armed the debounce with no regard for a pending retry, so a gateway whose rows kept changing still
hammered a failing Router four times a second. The retry-not-debounce fix had only slowed the SELF
retry. A `notBefore` floor now bounds every delta, whoever asks.

### The shapes, chosen and not yet built

Five proposals, two judges, each judging on whether the shape makes the class UNEXPRESSIBLE rather
than less likely.

**The board: a pure decision, then a durable effect.** `decide(before, write, actor, facts)` lives
in `src/shared/`, answers refused, conflict, or a finished transition, and cannot reach a store
because `src/shared/` imports nothing upward. The service stamps versions, commits one batch, and
maps the store's answer once. `stageApplied(tx, ...)` takes the batch's `Tx`, which is constructible
only inside `batch()`, so a ledger record outside the durable batch is not a statement that can be
written. References are DERIVED as a membership diff from pre and post state, the way observations
already are, so there is no ordered log for a release to precede a hold in. Amendments the judge
required: take the fingerprint over `BoardOp[]` alone, so the parameter type forbids hashing
`expectedRevision`; add the residue test that `src/shared/` never imports upward, which nothing
enforces today; pin that a conflict answers PRE-state entries before collapsing the four exits, or
the client loops on stale entries; fold the three refusal-minting idioms into one total switch.
Landed separately, not with this: `shareService`, `presenceService`, `capabilitiesService` and
`readAnchorsService` all throw on a `durability_uncertain` that APPLIED, which is defect 4 living
one directory over.

**Presence: one union, one pump. BUILT.** `Sync = NeedsBaseline | Parked | Streaming{seq, sent}`
replaced the three scalars, and two pure functions in `presenceProtocol.ts` answer the whole
question: `nextFrame` says which frame may go, `applyAnswer` says what a sent one meant. Because
`applyAnswer` cannot reach `send`, no answer handler can start a frame, which is the recursion
defect made unwritable. One pump owns all pacing, and a cue arriving mid-send is seen because the
pump compares the state it sent under against the state it returns to. The `Frame` carries the row
snapshot it commits, so rows that changed during a send stay pending instead of being recorded as
delivered. Two invariant tests were written against the OLD implementation first, where they passed,
then the mechanism was swapped under them.

A red team on the rebuild found two more, both real, both fixed here.

- **One variable carrying two meanings** (`presenceReporter.ts`): `deadline` was written as a retry
  floor by a failure and as a debounce window by `markDirty`, and `markDirty` took the later of the
  two. That makes the window extendable, so churn faster than 250ms pushed it past every fire and
  presence stopped going out entirely. Both meanings actually agree on one rule, which is now the
  code: never move an ARMED deadline later.
- **A field that rides only one frame kind, with no cue to send that kind** (`presenceProtocol.ts`):
  spawn points ride the baseline alone, and the only baseline cues are Router-driven. The gateway
  registers with the Router before the host daemon's socket opens, so the first baseline always
  carried an empty list and nothing ever corrected it. A peer gateway then advertised no shells and
  no session could be launched on it from the console. Predates the rebuild. Fixed: the reporter
  remembers what its last landed baseline put on the wire, and a change forces a new one.

## Phase 6 - Phone transport

Slices: 6.A the Router's console socket and owner delivery; 6.B the Router gaps the phone hits;
6.0 through 6.7 the phone itself, per the bullets below.

The survey found two things that reorder the phase. There is no `/console` WebSocket at all: the
Router's upgrade handler accepted only `/` and `/gateway`, both gated by the federation bearer. And
nothing consumed the owner inbox, because `pushInboxRows` answered `true` for an `owner:` address
without sending, so rows accumulated until the 30-day sweep. The console socket is the first owner
consumer, which is what makes an owner-addressed row mean anything. Both ends are this phase.

A console proves itself by SIGNATURE in its first frame, which no header can carry, so the upgrade
takes the app token and the hello OwnerOp proves the identity through the one intake routine. A push
on that socket is an OPTIMIZATION: the cursor in the consumer registry is the durable part, so an
owner row is never marked waking the way a session row is.

Decided while building: the board's push to the owner is a POKE carrying the revision, not the
board. A writer already holds what it wrote, every other console re-reads, and pushing 5000 entries
per write to every socket would cost more than the read it saves.

**Attachments stay off the Router this phase.** `attachmentsHeld` refuses unless the reference-held
store holds every member, and its only writer is the uploader Phase 5 left unwired because sealing a
blob is unsolved. So the phone's board attachment writes keep the gateway path until sealing is
settled. The READ half is fixed: `blob_fetch` is now an OwnerOp, so a console can pull bytes from the
Router cache or the origin without a gateway.

### The board rewrite, decided while building

**There is no `set_title` or `set_body` op.** A text change is a full `upsert` carrying every other
field. An op built against one revision would therefore replay stale neighbours over the board that
won a CAS race. So the phone holds edits as INTENT and re-materializes them against current stored
state on every attempt. The untouched half rides across as its existing sealed envelope, so editing
a title neither reads nor re-seals the body.

**One opId spans a whole logical write, retries included.** The Router returns a conflict BEFORE
writing any ledger record, so reusing the id across CAS attempts cannot be answered with a stale
recorded result. The id must stay stable anyway, because a reply lost in transit leaves the write in
an unknown state and only the id makes the crash replay dedupe.

**The replay record hashes which ops over which entries.** So a retry that dropped an op because its
entry vanished would come back refused as `operation_id_reused`. The writer compares the op-set
signature between attempts and stops instead, leaving the intents queued.

**Pending board writes live in the board blob, not the mutation journal.** Landing a Router result
and retiring the write it answers has to be one durable transition, or a crash between them either
replays a write that already applied or drops the optimistic row while the board still lacks it.
Only the store holding the board can make that atomic. The journal keeps the mutation kinds with no
such pairing.

**`MutationJournal.claimForReplay` now claims SENT as well as PENDING.** A write sent before the
process died has an unknown outcome, and the opId is what makes re-sending it either a no-op or the
recorded result. Claiming only PENDING silently dropped exactly the writes a crash put at risk. Once
per process, before any live send.

**The Router's attachment record carries no filename**, so the blob id stands in until it does.

### What this phase narrowed, and why

Three bullets were built smaller than written. An alignment audit found that leaving that
unreconciled is what let two real regressions read as authorized deferrals, so the narrowing is
recorded here rather than left implied.

**The socket is PLANES-ONLY, and the poll keeps the rows.** The socket carries the Router's owner
inbox; the poll drains the Gateway's mailbox. Those are separate sources with their own cursors, and
the owner inbox does not carry incoming agent messages at all. It carries this device's own sends
echoed for its other devices, board pokes, and scheduled-send results. Agent messages are
session-addressed and reach the phone through its Gateway. Moving them is Phase 8's mailbox
migration, so "one drain for one source" lands in Phase 8, not here. A planes-only console registers
no consumer, because a cursor at zero would pin the owner inbox's compaction floor forever.

**`refreshDiscovery` is retained for the background.** The socket is foreground-only, so while the
app is backgrounded the interval pull is the only source of discovery. It is gone from the
foreground, where presence now pushes.

**`routeGateway` is retained.** It is what sealing resolves its target Gateway through, and
`send`/`respond` still have to reach an agent on a specific machine. Deleting it means every console
op becomes an OwnerOp, which is the same Phase 8 migration. The gateway board path survives with it,
because board attachments stay there while reference-held blob sealing is unresolved.

**The scheduled-send journal covers a failed FIRE, not composition.** Composing offline never needed
the Router: the record is local and the alarm is local. What was missing is a send that fired into an
outage outliving its one-shot retry, and that is what the journal now holds.

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
- `ConsoleClient` targets the Router only. Delete `routeGateway`, the non-route capability re-report,
  and the per-gateway board pull with it.
- `PollDrain` becomes the one drain for one source. `PresenceOps.refreshDiscovery` and every
  refresh trigger in `TrustOps` and `SessionOps` are deleted once presence is pushed.
- `BoardManager` and `BoardOps` rewritten together around Router versions: the Router payload is
  decrypted into the existing UI model; a title or body edit is journaled, re-sealed, and
  re-applied on a lost CAS race; a `missing_epoch` entry renders its cached text or an explicit
  unavailable state. CAS, attachment availability, refusal persistence, forget disposition, move
  ordering. No per-gateway lanes.
- Persistence journal per its spec: per-kind versioned envelopes of what the Router last said,
  a mutation journal with idempotency keys, ack and retirement, torn-write recovery, and a
  migration for every existing unversioned slot. Read anchors, scheduled sends, and optimistic
  sends reconcile through it. A scheduled send composed with the Router down waits in it.
- `AttachmentOps` fetches the Router cache first and the origin on a typed miss.
- HTTP polling stays until the socket tests pass.

## Phase 7 - MCP plugin and host daemon

A compatibility checklist plus one wire change. The MCP plugin keeps its local gateway base URL.
`send` and `respond` gain a producer-issued `opId`, minted once per invocation and reused on every
retry. The gateway's registration answer advertises an op-ledger protocol version. A plugin that
sends `opId` fails closed with a named error when the version is absent or too old, so an old
gateway cannot silently strip the field and accept a retry twice. Verify against the new gateway:
`fetchCapabilities`, `postBoard` and `fetchAttachments`,
`registerBridgeDiscover`, Codex and Copilot dispatch, `host_op`, `presence_watch`, and
`presence_derive`. The agent routes, session authority, and the daemon protocol are unchanged.

## Phase 8 - Migration

After the Router is live and the key backfill has confirmed every member, before any deletion.
- Fence: a migration epoch every gateway write boundary checks. Phones and agents get "migrating"
  on every mutation; in-flight console ops settle or are failed typed; no in-flight op is
  imported, because `DurableOpStore` keeps only a marker, not the request.
- Cut: with zero writers, immutable hashed snapshots of every gateway store and blob root at one
  epoch. Restore uses offline import mode. It keeps the Router's identity and enrollment state,
  restores every owner store and blob root, and refuses to serve until verification passes. Never
  into a live process. Preserve the Router identity and enrollment state to preserve every pin.
- Import: board envelopes and attachment bytes; mailbox rows, cursors, and epochs with an explicit
  old-to-new mapping; pending deliveries; read anchors; share state with its TTLs. Verify counts,
  hashes, parent and rank invariants, attachment manifests.
- Phone self-migration on first hub connect: scheduled sends and read anchors enter the journal
  from the local records and upload, idempotent by opId, the Router answering the existing state
  for one it already holds; the local alarm is cancelled and the record tombstoned only after the
  Router accepts. Drafts and goals stay where they are.
- Each gateway holds a migration lease: active, offline, retired, or excluded. Router authority
  for owner state turns on when every active gateway reports complete; an offline gateway is
  fenced and reconciles its epoch on reconnect before it may write.
- No deletion until every record has a verified disposition.

## Phase 9 - Cutover and removal

Order: Router (both surfaces live), then every gateway, then every phone, then the plugin bump.
The bump is pushed only after `setup.sh --verify` passes on every gateway host, and it learns to
check the running gateway and Router versions and the protocol version alongside registration.
This gates marketplace auto-update from installing a plugin ahead of its gateway. No pin.
- No rollback. Fix forward; Phase 0's snapshots are the only safety net. Once the gate has passed
  everywhere, delete the old Router console surface and every old gateway path in one commit. Any
  shim that let the two coexist carries a remove-by comment.
- Vault questionaire resumes on the new substrate.

# Specs

Phase 1 output. Each names its residue test. Wire shapes land in `src/shared/schemas*.ts` with
`.meta({id})` for Kotlin; nothing below is a schema yet. Canonical signing bytes follow
`admission.ts`: versioned tag, fixed-order fields, newline-joined, every field newline-free.

## S1 - Content envelope and key delivery

Key. `contentKey(domainId, epoch) = HKDF-SHA256(ikm = owner sign.priv raw 32 bytes, salt =
"switchboard-content-salt-v1", info = "switchboard-content-v1\n" + domainId + "\n" + epoch, length
32)`. Epoch is an integer from 1 to 2^31-1, so both runtimes carry it as a 32-bit int. An ikm that
is not 32 bytes is refused. Derived on the owner phone only; every other holder receives bytes. One
owner key roots exactly one Domain, and the Router refuses a second root under the same key. Epoch
1 is derived at first root, where the Domain id is known, and again when a restored owner learns
its Domain id, so every delivery that follows carries at least one epoch. The owner path verifies
every held epoch against the derivation and sets aside a slot that disagrees.

Envelope. `ContentEnvelope { v: 1, epoch, nonce (12 bytes b64), ciphertext (ct || 16-byte tag,
b64) }`. AES-256-GCM. AAD = `"switchboard-content-v1\n" + domainId + "\n" + ownerSignPub + "\n" +
epoch + "\n" + kind`, kind a slug naming the field: `board.title`, `board.body`, `board.name`,
`inbox.body`, `op.payload`, `op.result`. A scheduled send's body is `inbox.body`, so the same
ciphertext serves the record, the delivered row, and the echo. A ciphertext opened under another
kind fails.

Key envelope. `KeyEnvelope { epoch, signerSignPub, sealed: SealedEnvelope }`, the existing seal of
`"KEYENVELOPE_V1\n" + epoch + "\n"` followed by the 32 key bytes to the recipient's admitted box
key, so a sealed key cannot be relabeled to another epoch and no seal from another context passes
as a key, signed by an admitted console's signing key
(the owner phone at first, any key-holding phone later) and naming it, so a recipient never
guesses the signer. The recipient resolves `signerSignPub` to an admission of
kind `console` through a kind-checking wrapper, as `resolveConsoleBoxPub` does, never bare
`resolveAdmitted`, then stores `epoch -> key`. A gateway key is refused as a signer. Resolution
picks the newest admission for the signing key first and only then requires kind `console`, on both
runtimes, so a key re-admitted as a gateway refuses everywhere. The bootstrap bundle's Domain
snapshot carries the signing console's own admission beside the gateway's, so the gateway resolves
the signer without the full roster.

Delivery.
- New console: `ConsoleTransport.contentKeys: KeyEnvelope[]`, every current epoch, at Add Device.
  The join the new device parks at the Router carries `joinSig`, its console signature over
  `DEVICE_JOIN_V1`, the approval id, the nonce, and both public keys, and the held device refuses
  an unsigned or mis-signed join before it signs or seals anything, so the Router cannot swap the
  box key the keys are sealed to. The install fails when any envelope is refused; an epoch already
  held passes only when the delivered bytes equal the held bytes.
- New gateway: `GatewayBootstrapBundle.contentKeys: KeyEnvelope[]`. Install is staged: admission,
  transport, Domain id, and keys written under `federation/staging/`, every artifact atomic and
  fsync'd, then one `INSTALLED` marker renamed into place, then activation. Activation requires all
  four artifacts and copies each into the live dir atomically, transport last, leaving staging whole
  until every copy landed, so boot recovery re-runs activation after any crash. Boot with a staging
  dir and no marker rolls it back; a marker beside a missing artifact, or beside an allowlist that
  is unrooted or rooted at another owner, is corruption and is rolled back too. Any other
  activation error keeps staging and fails the boot, never a partial live set. The gateway
  `ContentKeyStore` owns the key file format and `Allowlist` the allowlist file format, on the live
  dir and on the staging dir alike. Paste enrollment holds up to 3 epochs in the bundle; LAN
  delivery is not bounded. A corrupt keyring file is set aside, never read as empty and
  overwritten. Re-enrollment of a rooted gateway resolves the frame signer and every key signer
  over the union of the live and bundle admissions with both revocation lists applied, requires an
  admission newer than the one it holds, merges the allowlist, and merges keys: a held epoch the
  bundle omits stays, equal bytes pass, different bytes refuse the whole bundle. First enrollment
  keeps trust on first use.
- Enrolled member: inbox rows (S3). `key_request` to the owner inbox: from a console as an
  OwnerOp, from a gateway as a `key_request` frame over its authenticated WS, either way carrying
  the requester's admitted signing key, `at`, and nonce. The console-only rule above is for
  GRANTS, which only a key holder mints; a request may come from either kind. A key-holding
  phone answers `key_grant`,
  a `KeyEnvelope` to the box key the Router's admission record names for that signer, addressed to
  the gateway inbox `(domainId, gatewayId)` or the console's owner-inbox consumer. The request is
  idempotent by nonce. Confirmation is a `keyReceipt` record (S2), written by the Router only on
  a signed receipt from the recipient naming the installed epoch, sent after the recipient's
  keyring write is fsync'd; the grant row's delivery ack retires the row and confirms nothing.
- Backfill at cutover: the owner phone enumerates admissions and sends one `key_grant` per
  member per epoch; Phase 8 starts when every member has a `keyReceipt` for every epoch.

Keyrings. Phone: `AppStateStore` slot `contentKeys`, Keystore-backed beside the identity, wiped
with `PROVISIONING_KEYS`; a restored owner backup regenerates epoch 1 from the root once the Domain
id is known, and rotation records the current epoch so later epochs regenerate the same way. A
restore replaces a stored owner key that rooted nothing and refuses one that differs from the
Domain's root. Gateway: `DATA_DIR/federation/content-keys.json`, 0600, atomic write; a base64
value is decoded by one strict grammar on both runtimes.

Reader state `missing_epoch`: the row or record is retained and not acked; one `key_request`
now, then every 10 minutes for 24 hours; then reported as an error row to the owner. Distinct from
a bad tag (tamper, dropped and logged) and from a revoked target.

Rotation: derive epoch+1, grant to current members, keep old epochs; nothing re-encrypted.
Revocation is authorization-only.

Residue tests: `tests/fixtures/content-envelope.json` (seed, epoch, key, envelope) opened by both
runtimes; a canary key never appears in any log line the key path emits; a staged install
interrupted after any artifact leaves no active partial state; a recipient that acks a grant and
crashes before its keyring fsync leaves the Phase 8 gate unsatisfied.

## S2 - Router state layer

Layout: `DATA_DIR/owner/<domainId>/<ownerFingerprint>/` holding `MANIFEST.json`,
`snapshot-<gen>.json`, `journal-<gen>.log`. One owner, one writer queue, one manifest.

Record: `{ kind, id, version, clear: object, sealed?: { [field]: ContentEnvelope } }`. Kinds:
`board.entry`, `board.meta`, `scheduled`, `share`, `readAnchor`, `capabilities`, `presence.row`,
`consumer`, `session`, `op`, `inbox.row`, `keyReceipt`.

Write: `put(kind, id, expectedVersion, record)` and `append(address, row)`. A mismatch answers
`conflict` with the current record. Version is per record, monotonic. A write is one journal line,
fsync'd, before its result leaves the Router. Batches share one fsync.

Compaction: write `snapshot-<gen+1>.json` and then `MANIFEST.json` (naming the snapshot and the
journal it continues from), each through `writeFileAtomic` with `fsyncFile` and `fsyncDirectory`,
and delete older segments only after the manifest's directory fsync returns. Premise, stated: the
mounted filesystem honours POSIX fsync. Boot: manifest, snapshot, replay journals after the
snapshot's seq; a torn last line is truncated and logged.

Quarantine: a snapshot or segment that fails to parse is renamed `.quarantine-<ts>`, bytes kept.
The owner enters `quarantined`: reads of the affected kinds answer `durability_uncertain`, appends
are refused with the same, Router health names the owner and the missing seq range. Service
resumes only through an operator command that either repairs the segment or accepts the loss,
recording the discarded seq range; every op in that range gets a durable `durability_failure`
result row so a sender holding `accepted` is told. Never a Router that answers as if the rows
had not existed.

Single writer: `owner.lock` holding a pid, a lock generation, and a heartbeat the writer queue
refreshes every 5 seconds. A second process takes the lock when the pid is dead or the heartbeat
is older than 30 seconds, bumping the generation; every journal write presents the generation and
a stale holder's write is refused. Same pid liveness test as `atomic-write.ts` temps.

Quota: bytes per Domain across owners, configured, accounted by one Domain-level counter the
Router process owns (the per-owner lock is not it). A write refused by quota or by ENOSPC before
the journal line lands answers `durability_failure`; an fsync failure after the line landed
answers `durability_uncertain` (S3). Either flips Router health to `degraded`. A metadata reserve
of 64 MB keeps manifests, locks, and `federation.json` writable; `fileSecretStore` writes count
against the reserve, not the quota. Reads never fail on quota.

Residue tests: crash injected between journal append and manifest rename replays to the same
state; a second process on the directory is refused; CAS conflict returns the live version;
quarantine keeps every byte and the store keeps accepting writes.

## S3 - Inbox, op ledger, registries, delivery, capacity, results

Addresses: `owner:<domainId>/<ownerSignPub>`, `session:<domainId>/<gatewayId>/<sessionId>`,
`gateway:<domainId>/<gatewayId>`.

Console-to-Router op (the signed request that replaces the console seal for tier-1 and tier-2
writes): `OwnerOp { v: 1, domainId, signerSignPub, conversationId, device, opId, at, nonce, op,
signature }`, signature over `["OWNEROP_V1", domainId, signerSignPub, conversationId, device,
opId, String(at), nonce, sha256Hex(canonicalJson(op))].join("\n")`, every field newline-free by
schema. The Router resolves the signer to an admission of kind `console` (kind-checking wrapper,
never bare `resolveAdmitted`), `at` within `REGISTER_MAX_SKEW_MS`, nonce unseen. Every op from an
admitted console is an OwnerOp; `first_root` keeps its own Router intake, authorized by the invite
nonce and the pending tenant, and the gateway-side variant stays a defensive reject.

Two op classes, decided by what the answer is. A DELIVERY op (send, respond, peek, tmux, rename,
close, forget, wake) carries its payload as a `ContentEnvelope` of kind `op.payload`, becomes a
row in the gateway's or session's inbox, and is answered by an `op_result` row from the gateway
with a `ContentEnvelope` body; against a disconnected gateway it is held and reported `waking`. A
VALUE op (`blob_fetch`, `list_dirs`, `create_session`) is Router-forwarded request-response with
a typed `unreachable` at once when the gateway is disconnected. The gateway box seal survives
only for cross-Domain `peer` rows. One ciphertext per message: the row the session receives and
the `sent` echo in the owner inbox are the same bytes, readable by every key holder; the file
materialization id (`messageId`, minted by the gateway in `routes.send`) is producer-issued
and lives inside that ciphertext beside the file manifest, with `contentRefs` as its clear
counterpart.

Row: `{ seq, acceptedAt, size, envelope, producerSig, body }`. `envelope = { origin: { kind:
console|session|gateway|router, domainId, gatewayId?, sessionId?, device? }, opKey: {
conversationId, opId }, epoch: number | "peer" | "clear", kind, contentRefs: blobId[] }`. `kind` is
the current `MailboxEntry.kind` plus `awareness`, `key_request`, `key_grant`, `scheduled_result`,
`board_observation`, `op_result`. `producerSig` signs the envelope bytes with the producer's
signing key; the Router adds `seq`, `acceptedAt`, `size`. `body` is a `ContentEnvelope` (epoch
numeric), a `SealedEnvelope` to a gateway box key (`peer`), or Router-composed clear JSON
(`clear`, only for `board_observation`, `scheduled_result`, and the ledger's own `op_result`
outcomes; a gateway's `op_result` answer carries a `ContentEnvelope`).

Op ledger: record `op:<domainId>/<ownerSignPub>/<conversationId>/<opId> -> { state: accepted |
waking | delivered | failed | expired | complete, opHash, result?, seq?, at }` written in the same
journal batch as the row. `opHash` is the signed `sha256Hex(canonicalJson(op))`: a repeat of an
opKey with the same hash answers the recorded result; a repeat with a different hash answers
`conflict` and is never executed. Retention is a terminal transition: the sweep writes `expired`
in the batch that retires the row, a `waking` row sweeps on the same clock, and a later ack for a
retired seq answers `gone`. Agent `send` and `respond` carry a producer-issued `opId` (Phase 7).
`deliveryId` and `channelJobId` are never the key.

Consumer registry, per owner: `consumer:<signerSignPub> -> { cursor, cursorEpoch, lastSeen,
incarnation }`. Compaction of the owner inbox to the minimum cursor; a consumer idle 30 days is
forgotten and its `cursorEpoch` retired; a revoked console is forgotten at revocation. A cursor
presented under a retired epoch, or below the compaction floor, is answered `cursor_stale` with
the floor and the dropped count, never silently advanced; the phone shows the gap.

Session registry: `session:<domainId>/<gatewayId>/<sessionId> -> { kind, label, lastSeen,
recordExists }` from gateway frames `session_upsert` and `session_forget`. Not expired by
presence; removed only by `session_forget`.

Gateway frames name only themselves. On any frame from a gateway connection the Router takes
`domainId` and `gatewayId` from the authenticated connection; a payload tuple naming another
Domain or gateway is refused, and a `sessionId` is accepted only if the session registry holds it
under that gateway. S5 attestations, S6 session actors, and S8 board ops all pass through this
rule.

Gateway incarnation: `gateway_register` reply carries `incarnation`, Router-assigned, monotonic
per `(domainId, gatewayId)`, persisted. Every frame either way carries it; a frame with another
incarnation is dropped and logged; disconnect cleanup runs only for the incarnation that
disconnected.

Delivery to a gateway: Router push `inbox_deliver { address, rows, incarnation, deliveryEpoch }`;
gateway answer `inbox_ack { address, seq, incarnation, deliveryEpoch, outcome: delivered | waking |
failed, reason? }`. `deliveryEpoch` is per address and bumps when the address is recreated. The
gateway offers a row to the session as `ChannelDeliveryCoordinator` does and acks `delivered` on
the receiver's `channel_delivery_ack`; a `deliveryProtocol < 1` peer is refused at registration
after cutover. A row for a session with no live socket runs `tryWakeTeam`; `wakeStart` reports
`waking`; `WakeResult` timeout and disconnected keep `waking`; a definitive `ok: false` reports
`failed`. Only the gateway named in the address may ack it. The gateway's dedupe is a durable
claim record under `DATA_DIR`, `deliveryId -> { offeredAt, outcome }` per address, fsync'd before
the row is offered to the session and cleared on ack or on a `deliveryEpoch` bump; a redelivery
whose `deliveryId` holds a claim is re-acked, not re-offered.

Delivery to a phone: WS push (S9) or poll; ack by cursor per consumer.

Capacity: owner inbox 10,000 rows or 64 MB of row text; session inbox 200 rows; gateway inbox 200;
Domain total from the S2 quota. The row cap is checked first and answers `refused`; the S2
storage quota is checked next and answers `durability_failure`; both leave every prior row
intact. Nothing evicts an accepted row; the `DeviceMailbox` OOM backstop is not carried. Retention: an undelivered row expires after 30 days with an `expired`
result row to the sender; a delivered row is compacted by cursor.

Result envelope for every append and every OwnerOp: `{ opKey, outcome: accepted | refused |
expired | target_revoked | failed | durability_failure | durability_uncertain | conflict, seq?,
reason? }`. `refused` is a logical cap (inbox rows, per-session count), checked first; `failed` is
a definitive delivery failure reported by the destination gateway or by S7 after its retry;
`durability_failure` is storage: Domain quota or ENOSPC before the journal line lands;
`durability_uncertain` is answered when the journal line was written but its fsync failed.

Cross-Domain rows: the origin gateway seals to the destination gateway's box key; the
Router authorizes by link edge (`hasLinkEdge`) and share state (S5); the row is `peer` in the
destination session's inbox; `response_push` is the same in reverse. The relay gates in A2 stay
at the gateway on open.

Blob fetch: `blob_fetch { opId, blobId, range }` forwarded to the origin gateway with
`GATEWAY_RELAY_TIMEOUT_MS`; late replies dropped by `opId`; outcomes `fetched | absent |
unreachable | timeout`.

Residue tests: every append site in `federation-server` is the ledger transaction; the same
opKey through two gateway connections yields one row; an ack with a stale incarnation is
rejected; a cap refuses without evicting; a row accepted before a crash is delivered after it;
an owner-scoped read without `domainId` does not compile (typed key) and the public methods
reject a Domain the caller is not admitted to.

## S4 - Presence deltas, roster, projections

Gateway frames: `presence_baseline { incarnation, seq: 0, rows: TeamInfo[], spawnPoints }` after
registration; `presence_delta { incarnation, seq, upserts: TeamInfo[], tombstones: sessionId[] }`
on `markDirty`, debounced 250 ms. The Router keeps `(incarnation, seq)` per gateway; a gap or a
foreign incarnation answers `presence_resync` and the gateway sends a baseline.

Socket drop: the gateway's rows get `presenceFresh: "unreachable"` and stay; reconnect brings a
new incarnation and a baseline that replaces them. Rows never expire on their own; `session_forget`
removes a session.

Roster, per Domain: admitted gateways (kind `gateway` in the snapshot) with `{ connected,
incarnation, lastRegisteredAt }`. `rosterKnown` is always true; `asked` = admitted, `answered` =
connected, `unreachable` = admitted minus connected; `spawnPoints` from the baselines.

Projections: owner = every row of the Domain plus each linked Domain's projection as
`CrossDomainPresenceEntry`; friend Domain D = shared sessions only, the `presenceForDomain` field
set (status, queueDepth, working, needsLogin, lastActive, labels). Each projection is a plane with
`{ epoch, version }`, so the poll piggyback and the WS push share one shape.

Residue tests: a seq gap triggers resync; a drop marks unreachable and deletes nothing; a friend
projection fixture never contains an unshared session or a filtered field.

## S5 - Share state and attestation

Record per owner: `share:<sessionTarget>|<targetKey> -> { sessionTarget, target: domain |
everyone_trusted, lastSeenAt, version }`, the `ShareRecord` shape.

Ops (OwnerOp): `cross_domain_share`, `cross_domain_unshare`, `cross_domain_unlink`, `cross_domain_list_shares`,
result shapes unchanged. `touch` is derived: a session `online` or `verifying` in its gateway's
rows refreshes `lastSeenAt`, and so does every permitted cross-Domain delivery to it, the two
sites `teams()` and `gateCrossDomainTarget` touch.

Attestation from a gateway: `share_job_live { sessionTarget, jobIds, observedAt, incarnation }`
on change and each sweep interval; a live job suppresses the sweep for that session, as
`hasLiveCrossDomainThread` does. Stale incarnation is dropped.

Sweep: the TTL `startShareSweep` runs at the Router.

Unlink, everything `unlinkDomain` does, split by owner: at the Router, drop explicit shares
to D, tear down D's projection and the owner's projection of D, drop the link edge; at each
gateway, on the Router's `unlink` frame, `crossDomainPeers.removeByDomain`, `expireByDomain` on
pending jobs, both presence teardowns, and `reconciler.cancel`. Everyone-trusted shares stop
matching (`isLinked` false); relink starts from nothing.

Revocation reaches accepted rows. Every `peer` row's clear envelope carries the share generation
of `(sessionTarget, D)` at acceptance; unshare and unlink bump the generation and, in the same
journal batch, retire every undelivered `peer` row bound to the revoked pair with a terminal
`target_revoked` result to the sender. Delivery re-checks the generation before a row leaves the
Router. This is the one stated exception to S3's "nothing evicts an accepted row": the row is not
lost, its sender is told.

Residue tests: after unshare, a `peer` row from D to that session is refused at the Router, and
an accepted-but-undelivered one is retired with `target_revoked`, never delivered; a sweep never
drops a share with a fresh live-job attestation; an attestation with a stale incarnation changes
nothing.

## S6 - Board

Records: `board.meta -> { revision }`; `board.entry:<id> -> { clear: { id, state, parent, rank,
session?: { domainId, gatewayId, sessionId }, trashedAt?, attachments?: [{ blobId, size, mime,
blobGateway }], version }, sealed: { title: ContentEnvelope, body?: ContentEnvelope, names?: {
[blobId]: ContentEnvelope } } }`. `blobGateway` is the origin a typed cache miss falls back to.
Filenames are sealed under `board.name`, keyed by `blobId` so a reorder cannot mislabel a file.

Writes (OwnerOp, or a gateway op for a session actor): the current op set (upsert, remove, set_state,
set_parent, set_rank, set_attachments, trash, restore) with `expectedRevision`. Authority is
`boardAuthority.mayWrite` with the actor `{ kind: owner } | { kind: session, session: (domainId,
gatewayId, sessionId) }`. Cascade is `applyCascade` on clear state; `CascadeChange` drops `title`
and the answering gateway fills it from the returned entries. `set_attachments` requires every
blob to be present in the reference-held store.

Observations: for each touched id, parties = pre and post sessions minus the writer; a
`board_observation` row (clear, Router-composed) `{ identity, pre: Entry | null, post: Entry |
null }` with the sealed fields copied as stored, to `session:<party>`. The gateway's adapter
derives `sessionKey` from the row address, maps `null` to `undefined`, opens titles, and hands
`{ sessionKey, identity, pre, post }` to the bank as `observationsFor` does; the bank folds
first pre and last post, classifies, holds for a waking session, drops at `MAX_HOLD_MS`, rides
the next message or pushes. The row is acked on receipt into the bank; a crash between receipt
and ride loses it.

Phone: `BoardManager` holds `{ revision, entries }` from the Router, decrypts title, body, and
names into the existing UI model, journals an edit as `{ opId, ops, expectedRevision }`, and on
`conflict` re-fetches and re-applies the ops on the new revision (ops are absolute sets; a parent
cycle answers refusal). A `missing_epoch` entry renders its cached text or an unavailable marker.
No per-gateway lanes; `knownVersion` is `revision`.

Residue tests: `federation-server` imports no content-key symbol; `applyCascade` fixtures pass on
clear entries; an observation row lands in the gateway the session registry names, including a
sleeping session's; a phone conflict rebase produces the same board as a serial apply.

## S7 - Scheduled sends

Record per owner: `scheduled:<domainId>/<gatewayId>/<sessionId> -> { target, fireAt, createdAt,
opId, sender: { conversationId, device }, files: blobId[], body: ContentEnvelope (kind
`inbox.body`, holding text, the file manifest, and the producer-issued `messageId`), state:
armed | firing | fired | error | cancelled, attempts, version }`. Based on `ScheduledSend`:
`text` and `fileRefs` seal into `body` after the files upload, `fireAtMillis` is `fireAt`,
`targetDomainId` plus the map key resolve to `target`, `opId` and `createdAt` carry over;
`sender`, `state`, `attempts`, and `version` are new. One per target; a second schedule is a
replace with `expectedVersion`; cancel is a tombstone with `expectedVersion`. A spawn point is
refused as a target, as `routes.send` refuses it. Files are uploaded to the reference-held
store before the record is accepted.

Firing: a Router timer per record. `armed -> firing` is a `put` with `expectedVersion` on the
version the timer read; a `conflict` (a cancel or replace landed first) aborts the fire with no
append and no result row. Then in one journal batch: the op ledger accepts `opId`, the `message`
row is appended to the session inbox with the record's `body` and
the file references transferred, the record turns `fired`, and a `scheduled_result { opId,
outcome, seq, body }` row goes to the owner inbox carrying the same `body` ciphertext, which the
phones open into the `Message` that `reconcileSent` settles the pending row with. One ciphertext,
as S3 requires. A refused or failed append retries once after 60 seconds (`attempts`), then
`error` with the same result row and outcome `failed` after one bounded retry. A fired row for an
absent session takes the S3 waking path.

Offline: the phone journals the schedule op and its file upload; nothing local fires. Migration:
existing local records upload with their `opId`; the Router answers the existing state for a
known `opId`; the local record is tombstoned and the alarm cancelled after `accepted` or
`already fired`.

Residue tests: two phones scheduling one target produce one record; a Router crash after the
batch does not fire twice; a cancel with a stale version is refused; a fire whose read version
lost to a cancel appends nothing; a reference survives the receiver ack while an owner consumer
cursor still sits behind the result row.

## S8 - Retained gateway endpoints

`/capabilities`: the Router `capabilities` record for the owner composed with
`daemonCapabilityStore`; shape unchanged.

`/task-board` and `/task-board/attachments`: `sessionAuthority` validates the session token
locally; the gateway sends the board op to the Router as `{ actor: session (domainId, gatewayId,
sessionId) }` over its WS; the reply's entries have titles, bodies, names, and cascaded titles
opened by the gateway; `from` is stamped by the gateway, never read from the request. The entry
shape gains `session: { domainId, gatewayId, sessionId }` beside the bare `sessionId`, which is
kept for the plugin build in the field until the Phase 9 removal commit drops it; Kotlin is
regenerated in the same change. Attachment
reads are authorized by `visibleTo` on the clear entry and served from the origin copy or the
reference-held store.

`/discover`: both shapes exactly. A plain call answers `TeamInfo[]`; `?coverage=1`
answers `{ teams, coverage, localGatewayId, localDomainId }`, the roster deriving `coverage`.
`spawnPoints` stays OFF this route, as `routes.discover` strips it: it is a plain HTTP
surface, and a machine's shell list reaches the phone only through the authenticated console
path backed by the S4 spawn-point projection.

Residue tests: per endpoint, the response validates against the schema; a request with a
forged `from` produces a board entry attributed to the token's session.

## S9 - Console WS, transport coordinator, persistence journal

Socket: `wss://<router>/console`, opened on the pinned client from `buildLeafPinnedClient`;
`ws` and `http` refused. First frame: an OwnerOp with `op: { kind: "hello" }` and its own `opId`,
verified by the one OwnerOp routine; the Router answers `welcome { incarnation, cursor,
versions, cursorMap? }`. Router frames: `inbox_rows { rows, cursor }`, `plane { name, version,
payload }`, `presence_delta`. Phone frames: `ack { cursor }`, `ping`. Ops stay HTTP POST, always
an OwnerOp with any gateway payload inside `op` as a `ContentEnvelope` of kind `op.payload`, so
reach failover stays per call and there is one wire form. Reconnect carries a generation; frames
from an older generation are dropped.

Coordinator: the one client of `DeepIdleScheduler` and the one owner of `PollDrain`'s cursor.
States `foreground-socket`, `background-poll`, `offline`. Activity start opens the socket with the
cursor; Activity stop closes it and arms the tiers; socket activity resets the tiers' silence
clock; one drain at a time under a mutex; a row is acked after the drain-gate subscribers ran,
Consumer identity is `signerSignPub` in both modes.

Journal: an append-only file under `filesDir`, one JSON line per entry `{ opId, kind, payload,
createdAt, state: pending | sent | acked | refused | conflict }`, fsync'd before the mutation's
state transition returns; a launch-time recovery pass reads it before any drain. Not a
`SharedPreferences` slot: `apply()` returns before the bytes land and reports no failure, which
the owner's offline scheduled send cannot survive. A failed commit is reported to the caller,
never swallowed as `ChatPersistence` does for its slots. Replayed on connect in order; the ledger
answers a known `opId` with its recorded result. Router-sourced state lives in per-kind
`AppStateStore` slots `{ version, payload }`; every reducer compares `(epoch, version)` with the
applied slot and discards a payload that is not strictly newer, whichever transport carried it,
and socket and poll payloads apply through the drain mutex. Existing unversioned slots are
wrapped as version 0 on first launch; scheduled sends and read anchors become journal entries.

Residue tests (Kotlin): Activity stop during a held socket leaves one consumer and one cursor;
process kill with pending journal entries replays them once; the cursor never regresses; a
frame from an old generation is ignored; a poll response older than an applied socket push
changes no slot.

## S10 - Migration fence, snapshot cut, offline import

Fence: `DATA_DIR/migration-epoch` on the gateway. When present, every writer of MIGRATED state
answers `migrating` (retryable), guarded at the writer rather than its callers: `deliverToOwner`
(reached from the console dispatcher, `routes.respond`, `routes.humanNotify`,
`routes.pluginAction`, and `mirrorPeer` under `routes.send`), `PendingDeliveryStore.enqueue`,
`BoardStore.mutate`, `DurableOpStore.markInFlight`, `ReadAnchors.report`,
`CrossDomainShareState.share` and `unshare`, and `gatewayRelay.handleOp` inbound.
`capabilityStore` is not fenced: capabilities are not migrated, phones re-report on first hub
connect. One guard function, called at each. In-flight console ops settle or are failed typed
after 60 seconds; the persist timer, the trash sweep, and the share sweep stop; every store
`saveChecked`. The residue test enumerates writers, not routes, so a new caller cannot bypass
the fence.

Cut: tar of `DATA_DIR` plus `SHA256SUMS` at epoch E, taken with the fence up.

Export, at the gateway (it holds the key): `switchboard export --epoch E` writes
`export-E.json`: board entries with titles, bodies, and names sealed under epoch 1, each bare
`sessionId` stamped with the exporting gateway's own `(domainId, gatewayId)`, and an entry whose
session is not in that gateway's session store listed in a named refusal list rather than
guessed; mailbox rows with bodies sealed and a `cursorMap` from the owner inbox's `(oldEpoch,
oldSeq)` to the new `(epoch, seq)`, the shape the phone's `SyncCursor` holds; pending deliveries
as session rows; read anchors; shares; consumer cursors.

Import, at the Router, offline: `bun run router:import --from export-E.json`. Keeps
`federation.json`, the identity, and the TLS files; writes the owner directories; refuses to
serve until `SHA256SUMS` and record counts verify. An import marker beside the owner directories
records the accepted export's digest, epoch, gateway, and counts: a second run with the same
digest is a no-op answering the same seqs; a different digest under the same epoch is refused
naming the recorded one. A late export from an offline gateway is imported the same way, its rows
deduped by `dedupeKey` against existing rows.

Lease: record `migration:<domainId>/<gatewayId> -> { state: active | offline | retired |
excluded, epoch }`. Authority turns on when every `active` lease is `complete`; an `offline`
gateway is fenced at reconnect until it exports and imports.

Phone: translation is a repeatable handshake, not a one-shot. The Router keeps the `cursorMap`
for the whole migration window and answers any old-epoch cursor with it again; the phone commits
the translated cursor through the S9 journal and accepts no `inbox_rows` and sends no `ack`
until that commit returns.

Residue tests: a test enumerates the migrated writers and asserts each answers `migrating` under
the fence; import twice yields identical state and a changed export under the same epoch is
refused; every old mailbox has a `cursorMap` entry; a process kill between `welcome` and the
cursor commit replays to the same cursor.

## S11 - Cutover verification gate

`setup.sh --verify` checks per gateway host: Router version and
`FEDERATION_PROTOCOL_VERSION` match, and this host's `(gatewayId, incarnation)` registered, read
from an authenticated Router op and compared with the running gateway's own report;
`/capabilities` and `/discover` asserted against the retained shapes in S8 over the local HTTP
route; the op-ledger protocol version present in the gateway's registration answer; the console
WS opened by a Bun probe through the same pinned dial `pinnedSocket` uses, not `curl`. Prints
PASS or FAIL per check. The plugin bump is pushed only after PASS on every host.

Residue test: the verify script fails against a gateway still running the route-gateway build.

# Phase 1 outputs

## Ledger

Invariant names are the S1 to S11 mechanisms: ONE-WRITER (S3 op ledger), INCARNATION (S3),
HOLD-UNTIL-ACK (S3), ROSTER (S4), SESSION-REGISTRY (S3), PIN-BEFORE-BEARER (carried),
PRESENCE-DELTAS (S4), NO-SYNC-RELAY (S3 wake states), REACH (carried), BOUNDED-HOLDS (carried at
the gateway). IMPOSSIBLE means the trigger cannot occur under the hub; CARRIED means the failure
mode survives and the named code keeps guarding it.

- `e6f70cb4` gateway. A poll hold judged retained rows, not the caller's cursor; a stale sibling
  consumer made the live console busy-loop. Today: `consoleHandler.nothingNew`. CARRIED: S3
  consumer registry, hold decided per consumer cursor. Test: a held poll stays pending while rows
  are pinned only by another consumer.
- `12869b9c` mixed. Verify trusted the gateway's socket state; a half-open link passed as
  healthy. Today: `GatewayBridge.registeredGatewayCount`, `setup-verify awaitGatewayLink`.
  IMPOSSIBLE: INCARNATION, the Router's registration is the only truth. Test: S11.
- `2ce9938f` phone. One Router endpoint; a network change stranded the phone. Today:
  `RouterReach.reachCandidates`, `withReachFailover`. CARRIED: REACH unchanged, socket-aware in
  S9. Test: the reach vector fixtures on both twins.
- `66b71d4d` gateway. Self-signed Router leaf could not use CA validation. Today:
  `pinnedSocket.pinnedDial`. CARRIED: PIN-BEFORE-BEARER. Test: `router-cert-pinning.test.ts`.
- `0a1a5983` mixed. Reach addresses needed an authenticated path, not `/health`. Today:
  `consoleSurface.handleReach`. CARRIED: REACH. Test: `/health` omits reach; the reach op
  returns it.
- `21fbd1a8` mixed. Relay frames lacked `v`; every relay was rejected and read as empty. Today:
  `handleGatewayRelay` stamps `v`. CARRIED for `blob_fetch`, the one relay left; the discovery
  path that hid it is gone. Test: an invalid relay frame is rejected with a diagnostic.
- `2ead9add` mixed. Reconcile guards, proxy dials, handshake state, wake notices held forever.
  Today: `CodexRelay.reconciling`, `CONNECT_DEADLINE_MS`, `HandshakeGate.expired`,
  `ChatState.awaitingWake`. CARRIED: BOUNDED-HOLDS at the gateway and phone. Test: injected
  clocks past each bound release each hold.
- `5495f624` mixed. An unanswered handshake challenge blocked a socket for life. Today:
  `HandshakeGate.expirePending`, `HANDSHAKE_PENDING_TTL_MS`. CARRIED: BOUNDED-HOLDS. Test:
  pre-TTL blocks, post-TTL does not.
- `258e1f51` gateway. Several producers appended to mailboxes; one missed the fan-out. Today:
  `consolePushOps.deliverToOwner`. IMPOSSIBLE: ONE-WRITER, the op ledger transaction is the only
  append. Test: residue scan finds no append outside it.
- `0d4ccd6a` mixed. A send sealed to gateway B echoed only into B's mailbox; a phone polling A
  never saw it. Today: `ConsoleDevices.appendIfLive` relays the echo. IMPOSSIBLE: ONE-WRITER, one
  owner inbox. Test: a send through any gateway yields one `sent` row keyed by `opId`.
- `cb98949d` gateway. `routes.respond` appended locally; the reply was stranded when the phone
  polled elsewhere. IMPOSSIBLE: ONE-WRITER. Test: a reply through any gateway reaches every
  consumer.
- `ac10e5db` mixed. A conversation held on gateway B was invisible to the phone polling A. Today:
  `consolePeer.deliver`, `relayWithRetry`. IMPOSSIBLE: ONE-WRITER. Test: message and reply
  converge with distinct keys.
- `f270dcf4` mixed. Bare addresses routed to the route gateway; capability tools advertised
  without a binding. Today: `Team.gatewayOf`, `sessionAuthority.presentedByRequest`,
  `registerAgentBackend`. CARRIED: session identity is `(domainId, gatewayId, sessionId)`
  everywhere (S3 registry); local authority unchanged. Test: `codex-route.test.ts` unbound
  caller; `MergePresenceTest` routing.
- `cacc8774` mixed. Discovery omitted peers whose relay failed; the phone swept their sessions.
  Today: `discoverFull` coverage, `Team.unreachableKeys`. IMPOSSIBLE: ROSTER, completeness is
  derived from admissions. Test: a disconnected gateway's rows show unreachable, never vanish.
- `054368bb` gateway. The bearer left before the leaf was checked. Today: `pinnedDial`. CARRIED:
  PIN-BEFORE-BEARER, and S9 for the console WS. Test: `never sends the bearer`.
- `d489614f` phone. A stale discovery row passed as current: blank terminals, wrong wake gating.
  Today: `Presence.authority`, `PresenceOps.foldReceipt`. IMPOSSIBLE cause: PRESENCE-DELTAS
  with incarnation and unreachable marks; the phone's authority rules stay. Test:
  `presence-authority-residue.test.ts` and a delta-gap resync test.
- `d7fb5a6a` gateway. A Bun that ignores `createConnection` cannot pin. Today: `assertBunFloor`,
  `check-pinning-runtime.ts`. CARRIED: PIN-BEFORE-BEARER. Test: `bun run check:pinning`.
- `b0a51863` mixed. Awareness pushed too early or was lost across a wake. Today:
  `awarenessBank.takeFor`, `tick`. CARRIED: the bank stays at the gateway as the adapter (S6).
  Test: `awareness-bank.test.ts`, `board-awareness.test.ts`.
- `d1ebf73b` mixed. Phone and gateway disagreed on blank hosts and bad ports. Today:
  `router-reach.ts reachCandidates` and its Kotlin twin. CARRIED: REACH. Test: the shared
  vectors.
- `9ece181c` phone. Background cadence backed off while a watched session worked. Today:
  `IdlePushbackManager.tierFor`, `PollDrain.watchedWorking`. CARRIED: the tiers are untouched
  (S9). Test: `IdlePushbackManagerTest`.
- `a0d18ad0` mixed. Cancellation read as failure; duplicate init; an alarm exception leaked the
  wake lock. Today: `runCatchingCancellable`, `DebugLog.init`, `enterDeepSleep`. CARRIED:
  phone-local. Test: cancellation rethrown; locks released in `finally`.
- `4bee4c04` mixed. Mailbox capacity miscounted, eviction keyed on wire kind, a stale Router
  socket close nulled the live one. Today: `DeviceMailbox.drain`, `trimToMinCursor`, socket
  identity guard in `startRouterClient`. IMPOSSIBLE: HOLD-UNTIL-ACK (no eviction of accepted
  rows) and INCARNATION (stale cleanup rejected). Test: capacity refuses; a stale incarnation's
  close changes nothing.
- `04046284` gateway. A session confirmed before its record existed; a dead holder could not
  hand over. Today: `SessionStore.establishOnConfirm`, `HandshakeGate.expirePending`. CARRIED:
  gateway confirm and handover unchanged; the Router registry mirrors records (S3). Test:
  confirmation needs a record; a live holder rejects a competing claim.
- `18dc9910` mixed. Transient notices overwrote each other; a gap latched; trashed subtrees
  accepted writes. Today: `ChatState.transientMessages`, `PollDrain` gap, `BoardStore`
  `entry_missing`. CARRIED: phone presentation unchanged; `entry_missing` survives in S6. Test:
  FIFO transients; trashed-subtree writes answer `entry_missing`.
- `e10af02c` mixed. Forged cross-Domain origin, revoked consoles lingering in capabilities, wake
  returning before readiness. Today: `verifiedSender`, `gateCrossDomainTarget`,
  `assertCrossDomainReturnRoute`, `ConsoleDevices.removePeer`, `awaitReady`. CARRIED at the
  gateway (open-side gates); revocation cleanup moves to the S3 consumer registry. Test: forged
  origin rejected; revoked console absent from capabilities.
- `f0c2e370` mixed. Resume records grew unbounded; `start-gateway.sh` left the daemon down.
  Today: `SessionStore.sweep`, `MAX_SESSION_RESUME_ENTRIES`, `start-all.sh`. CARRIED: the
  gateway store keeps its cap; the Router registry follows `session_forget`. Test:
  `session-store.test.ts` cap eviction.
- `efe70a45` mixed. A failed mirror failed a delivered send; spoken tiers dropped; a reused
  WebView kept an abandoned load. Today: `mirrorPeer`, `pickTiers`, `DesignerThumbs.renderOn`.
  Mirror half IMPOSSIBLE (ONE-WRITER); the rest CARRIED. Test: `reply-payloads.test.ts`.
- `a321772e` gateway. Relay parsing rejected a title intake accepted; the entry burned retries.
  Today: `NOTICE_TITLE_MAX` at both. IMPOSSIBLE: one intake parser, no relay re-parse of notices.
  Test: a 201-character title truncates once at intake.
- `6ffa04c4` daemon. Shutdown left the reconnector armed. Today: `stopHostDaemon`. CARRIED:
  daemon-local. Test: none today; add one.
- `bbb29426` phone. Poll completion released a pass lock a scheduled send still held. Today:
  `PassOwner`, `passHolders`. IMPOSSIBLE: the phone no longer fires scheduled sends (S7); one
  lock owner remains. Test: the scheduled-send owner no longer exists.
- `83301504` gateway. A wake ack re-armed a deadline; machine and session failures read alike.
  Today: `WakeCoordinator.ackReceived`, `WakeResult.errorKind`. CARRIED at the gateway;
  surfaced as S3 row states. Test: `wake.test.ts` deadline clamp.
- `744f1a59` gateway. Messages evaporated after acceptance; capacity evicted accepted rows.
  Today: `PendingDeliveryStore`. IMPOSSIBLE: HOLD-UNTIL-ACK. Test:
  `pending-delivery-store.test.ts`, then the S3 equivalents.
- `cd1f3df3` gateway. A row retired on socket write, not on the receiver's word. Today:
  `ChannelDeliveryCoordinator.offer`, `channel_delivery_ack`. IMPOSSIBLE: HOLD-UNTIL-ACK,
  unconditional after `deliveryProtocol < 1` is refused. Test: write does not retire; only the
  ack does.
- `4e1e0b43` mixed. A send to an absent session was refused instead of held. Today:
  `routes.send` accepts into `PendingDeliveryStore`; `onTeamConnect` drains. IMPOSSIBLE:
  HOLD-UNTIL-ACK with S3 wake states. Test: an absent-session send is accepted and delivered on
  registration.
- `4963848d` mixed. Every push read as a question. Today: `ReplyDisposition` through
  `SendRequestSchema`, `FederatedOpSchema`, `emitChannelNotification`. CARRIED: disposition
  rides inside the sealed body. Test: `channel-notify.test.ts`.
- `PendingDeliveryStore.enqueue` capacity refusal. IMPOSSIBLE to evict: S3 refuses at the caps.
  Test: refusal, no eviction.
- `PendingDeliveryStore.sweep` expiry. CARRIED: S3 retention emits `expired` to the sender. Test:
  an expired row produces a result row.
- `DeviceMailbox.sweepIdleConsumers`. CARRIED: S3 consumer registry forgets at 30 days idle.
  Test: forget precedes compaction.
- `ChannelDeliveryCoordinator.offer` legacy retire-on-write. IMPOSSIBLE: `deliveryProtocol < 1`
  refused at registration after cutover. Test: a legacy peer cannot register.
- `verifiedSender`. IMPOSSIBLE: `envelope.origin` is stamped by the Router from the
  authenticated connection; no gateway reads a sender field from a payload. Test: a forged
  `op.from` never reaches the projection.
- `createGatewayRelayPump` source verification. CARRIED: the destination gateway verifies the
  seal against `crossDomainPeers` on open. Test: a bad signature never reaches `handleOp`.
- `gateCrossDomainTarget`. IMPOSSIBLE at the Router for unshared targets (S5 filters appends);
  CARRIED at the gateway for session kind. Test: unknown, agent-kind, and unshared targets get
  one indistinguishable refusal.
- `assertCrossDomainReturnRoute`. IMPOSSIBLE: the return route is the Router-stamped origin;
  a payload naming another gateway is ignored. Test: a third-gateway route is refused.
- `handleOp` job binding. CARRIED at the gateway: `PendingJobStore` binding of Domain and
  gateway to a job. Test: wrong Domain, wrong gateway, missing binding all refused.
- `routes.send` forged `dstDomainId` and `sessionId`. IMPOSSIBLE: only Router-stamped origin
  fields reach the job ledger; `trustedInbound` remains the gateway's own marker. Test:
  `routes-send.test.ts` trusted-inbound plus a forged-field case.
- `routes.send` ambiguous Domain. IMPOSSIBLE: ROSTER resolves `(domainId, gatewayId)` from
  admissions and refuses ambiguity. Test: `federation-seal-target.test.ts` collisions.

## Restart matrix

Router fields, by disposition under the hub.

RESTARTS, flows re-arm: `GatewayBridge.gatewayConnections`, `connGateways`,
`pendingHandshakes`, `handshakeAttempts`, `seenRegisterNonces`; `GatewayTransport.connections`,
`reverseConnections`; `RouterServer.sockets`, `rosterNonces`, `transportNonces`,
`trustPendingNonces`; `DeviceApprovalCoordinator.windows`; `EnrollHandshakeCoordinator.windows`;
`TrustRendezvousCoordinator.rendezvous`, `byTarget`; `EnrollmentCoordinator.nonces`,
`nonceCleanups`; `PublicApproval.perId`, `windowStartedAt`, `globalCount`. A registration
after restart gets a new incarnation; every gateway re-registers and resends its presence
baseline; approval, enrollment, and trust ceremonies restart from the phone.

RESTARTS, typed failure: `GatewayBridge.pendingRelays`, which after Phase 5 holds only
`blob_fetch`; an in-flight fetch answers `unreachable`.

REPLACED: `ConsoleSurface.pending` (console ops become ledger records with results, S3);
`RouterServer.coordinators` cache (reads the S2 layer); `FileSecretStore.resourceVersion`,
`writeChain`, `pendingWrites` (S2 owns versions and the writer queue for owner state;
`fileSecretStore` keeps them for enrollment).

DURABLE: `EnrollmentCoordinator.state`, `FileSecretStore.domains`, `seenAdminNonces`,
`identity`. New durable state is all of S2 and S3.

Inbox delivery across a restart: rows and ledger records are on disk before their result is
answered; a gateway reconnects with a new incarnation and the Router redelivers every row with
no `delivered` ack, which the gateway dedupes by `deliveryId`; phones resume from their cursor.

Named-offline contract: `ConsoleSurface.handleRequest` answers 503 for a named gateway
absent from `gatewayIds()`. Under the hub a gateway-bound op (send, respond, peek, tmux, session
controls) to a disconnected gateway is accepted as a row addressed to it and reported `waking`
or held; a request-response op (`blob_fetch`, `create_session`, `list_dirs`) answers a typed
`unreachable` at once, never 503.

## Inventory

Phone symbols that assume a route gateway, by file. Action per Phase 6.

- `ConsoleClient.kt`: `routeGateway` delete; `apiReachable`, `fetchReach` keep;
  `reportPluginsTo`, `teams`, `listTeams`, `boardRead` delete; `send`, `poll`, `boardWrite`,
  `boardBytesReady`, `fetchConnectedGateways` rewrite.
- `ConsoleRelayTransport.kt`: `routeGateway`, `resolveGatewayId` delete; `relay`,
  `gatewayOfTarget`, `targetGatewayOf`, `buildSealedFrame` rewrite.
- `ConsoleClientSessions.kt`: `peek`, `tmuxSend`, `forget`, `closeSession`, `createSession`,
  `listDirs`, `renameSession` rewrite to Router-routed ops with a qualified target;
  `reportRead` rewrite to an OwnerOp.
- `ConsoleClientBlobs.kt`: `blobStat`, `blobPut`, `blobGet`, `uploadBlob`, `downloadBlob`
  rewrite to the Router cache with typed origin miss.
- `ChatRepositoryDomainLink.kt`: `reportEnabledPlugins` delete; `connect`, `displayName`,
  `localDisplayName` rewrite; the `routeGateway` assignment delete.
- `ChatRepository.kt`: `DISCOVERY_REFRESH_MS` delete.
- `PresenceOps.kt`: `refreshDiscovery`, `applyDiscovery`, `refreshAfterAction` delete;
  `refreshTeams`, `applyPlanePresence`, `refreshConnectedGateways`, `reportLocalReadAdvances`
  rewrite.
- `PollDrain.kt`: `start` and the discovery timer rewrite to the S9 coordinator's drain.
- `TrustOps.kt`: `linkedDomains`, `untrust` rewrite; `untrustOwner` refresh delete.
- `SessionOps.kt`: `rememberProject`, `spawnSession`, `listDirs`, `wakeSession`,
  `relaunchSession`, `forget` rewrite; `otherKeyringGateways` delete.
- `AttachmentOps.kt`: `fetchPendingAttachments` rewrite.
- `ChatState.kt`: `gatewaySpawnPoints`, `localGatewayId`, `connectedGateways`,
  `linkedPeerOwners` rewrite; `admittedGateways`, `lastProjectByGateway` keep.
- `Team.kt`: `TeamsAnswer`, `unreachableKeys`, `rowOnUnreachable` delete; `spawnTargetKey`,
  `mergePresence`, `teamInfoToTeam` rewrite; `gatewayId` keep.
- `MessageFile.kt`, `Attachments.kt`, `proto/Protocol.kt` (`ChannelFile.blobGateway`,
  `BoardAttachment.blobGateway`, `DiscoverCoverage`, `ConsoleListTeamsResult.coverage`): the
  wire changes land through the shared schemas; regenerated.
- `BoardOps.kt`: `refreshBoard`, `isNonRouteSession` delete; `boardAssignTargets`,
  `boardGatewayOf`, `boardGatewayOfKey`, `boardCapture`, `kickBoardDownload`,
  `kickBoardUpload`, `boardAssign`, `enqueueMove`, `forgetWithBoardDisposition` rewrite.
- `board/BoardManager.kt`: `routeGatewayId`, `drainLane`, `read` delete; `knownVersion`,
  `sourceGatewayIds`, `applySnapshot`, `enqueueMove`, `drain`, `attachmentBuckets`,
  `blobSources`, `refusals`, `notice`, `dismissRefusal` rewrite, a refusal keyed by the S6
  `conflict` or refusal result and its `opId` once lanes are gone; `BoardOps.boardRefusals`,
  `boardDismissRefusal` follow. `board/BoardState.kt`: lanes and `eligibleActions` delete.
  `board/BoardRows.kt`: `BoardSource` rewrite. `BoardScreen.kt`, `BoardEntryDialog.kt` keep.
- `SessionsScreen.kt`: `CreateDialogTarget.targetFor` rewrite; `groupByGateway` keep.
  `SettingsSections.kt`: `domainResolving` rewrite. `MainActivity.kt`, `TerminalView.kt` keep.
- Comments naming the route gateway: `ConnError.kt`, `Team.kt`, `board/BoardRows.kt`,
  `OwnerFacts.kt`, `DeviceApprovalOps.kt`, `CrossDomainLink.kt`, `ConsoleClientCrossDomain.kt`,
  `AppStateStore.kt`, `Management.kt`, `CrossDomainPresenceUi.kt`: rewrite or delete with
  their code.

Tests, `android/app/src/test`:
- Delete with the mechanism: `MergePresenceTest` coverage cases, `PresenceTest`
  `theBoundOutlastsADiscoveryInterval`, `GroupByGatewayTest.theRouteGatewaySortsFirst`,
  `BoardStateTest.perGatewayLanes...`.
- Rewrite against the Router contract: the rest of `MergePresenceTest`, `PresenceTest`,
  `GroupByGatewayTest`, `HostSpawnChoicesTest`, `FriendOnboardingTest`, `CrossDomainLinkTest`,
  `BoardManagerTest`, `MessageFileRoundTripTest`, `DirListingTest`.
- Keep: `PeerMirrorAttributionTest`, `SttsVoiceTest`, `SigningVectorsManifestTest`,
  `PluginCatalogAgreementTest`, `ZoomMathTest`.

## Connectivity states

What the phone shows, the current producer, and the hub's.

- Connection banner `connected`: current `ChatRepositoryDomainLink.connect` and `Health.ONLINE`;
  hub: the S9 socket is open or the last poll succeeded.
- Gateway row `connected` / `offline`: current `PresenceOps.refreshConnectedGateways` from the
  route gateway; hub: the S4 roster (`connected`, `incarnation`).
- Session row `available` (asleep): current `TeamInfo.status`; hub: unchanged field, from the
  gateway's presence delta.
- Session row `unreachable`: current discovery coverage; hub: `presenceFresh: unreachable` set by
  the Router on socket drop.
- Session row `accepted` and `waking`: current phone `ActionReceipt` and
  `ChatState.awaitingWake`; hub: the S3 op ledger state for the wake or send `opId`, pushed as
  an `op_result` row; the phone's receipt becomes a cache of it.
- Message row `delivered`: current `sent` echo reconciled by `opId`; hub: unchanged, the echo
  is an owner-inbox row.
- Message row `failed`: current `deliver.fail` on a refusal or transport failure; hub: the S3
  result envelope (`refused`, `expired`, `target_revoked`, `durability_failure`) as an
  `op_result` row, plus local transport failure.

## Painpoints

- Codex reports "DONE" for a slice and "not done" only for the item it names, while quietly
  skipping listed tests. Every test-bearing prompt now lists cases by name and the report is
  checked with a grep of `it(` names before the gate. Two of the three Phase 2 test gaps were
  found only by the verifiers.
- Codex cannot run Gradle, so every Kotlin slice costs one gate round trip for type mismatches it
  could not see (Long versus Int, `Crypto.SealedEnvelope` versus the proto twin, JUnit4
  `assertThrows`). Asking for a hand audit against `Protocol.kt` halves the misses; it does not
  remove them.
- `scripts/codegen-kotlin.ts` emits its header comment into `Protocol.kt`, so a comment sweep
  that touches the generator without regenerating leaves CI's drift check red. Regenerate after
  any edit to the generator, even a comment.
- Older tests used placeholder strings such as `"a"` in base64 fields, so tightening `b64Field`
  broke four suites that were never about base64. Placeholders in wire fields should be canonical
  values from the start.
- A session usage limit killed seven verifiers mid-workflow; resume replayed the cached agents and
  re-ran only the failed ones, which worked.
- The Phase 3 audit fanned 76 findings into 152 verifiers in one workflow and the limit killed
  every verifier, leaving the findings unverified. Triage by hand found about twenty real
  defects among them. Finders and verifiers belong in separate workflows, and a verify stage
  should cap its fan-out by severity rather than refute every minor.
- A Codex turn that answers only "Ready for the next task." shipped about half of the named test
  cases and none of its report. The grep of `it(` names caught it; the relay should refuse a
  reply with no checklist.
- A Codex test pass left a stray probe file (`zz-probe-pump.test.ts`) in the tree, found only by
  `git status` before the commit. Every commit step now scans untracked files for names the
  prompt did not ask for.
- Five services built in parallel each shipped a unit test whose inbox was a stub, and the one
  blocker of the phase (result rows sharing the op's ledger key) was invisible to all of them.
  The finders caught it by probing the real store. A service that writes through another
  service needs one test over the real thing, not a fake that answers accepted.
- Finders in one workflow and verifiers in a second, capped to the fixes made, kept the audit
  inside the usage limit this time; the six finders alone cost 1.8M tokens.

- A prose sweep that is told "timeless, no history" strips the failure descriptions out of a
  ledger and the recommendation reasons out of a questionaire, because both read as narration.
  A sweep prompt has to name what counts as content, not only what counts as style.
- A refuter that reads "the spec says the gateway dedupes by `deliveryId`" as proof that a dedupe
  exists refutes the finding that the mechanism is unspecified. Verification prompts must ask
  "is the mechanism specified" apart from "is the claim stated".

- **An edit put a NUL byte inside a template literal** in `boardService.ts`. Lint passed, the whole
  suite passed, and the string still worked at runtime, because NUL is a legal string character. But
  `file` reported the source as binary and every `grep` against it silently answered nothing, which
  read as "the code you are looking for is not there" for a long stretch of debugging. Worth a
  residue test: no source file contains a byte outside the printable set the style rules already
  name. The banned-character grep the rules give does not cover NUL.
- **The plan disagrees with itself, and an audit against it produces false positives.** S8 says the
  board op carries `{ actor: session }`; Phase 4's own bug-class entry removed payload-named
  identity. S6 lists eight board ops; Phase 5 needed a ninth for claim and release. Phase 5's
  deletion list names `discoverFull` while Phase 5's own second bullet requires `/discover` to keep
  answering. Three separate alignment agents filed each of these as a gap and three triage agents
  spent a full pass each proving they were stale spec, not stale code. The S-sections are Phase 1
  output and were never revised as the phases that implement them made decisions.
- **A test that stubs a store wholesale cannot see what the real store did.** `vi.spyOn(store,
  "batch").mockReturnValue({ kind: "durability_uncertain" })` asserts the answer while the real
  `durability_uncertain` has already applied the batch. That is exactly how "an applied write
  answered as refused" passed its own test. A durability outcome needs a fault injected under the
  real store, not a return value substituted for it.
- **`ReferenceHeldStore.has` answered "is referenced" while both callers wanted "is present".** The
  name says neither. A predicate on a store that holds bytes should say which question it answers,
  and this one let a board entry name a file whose upload never finished.
- **A Luna sandbox failure reads exactly like a code failure.** Twice an agent reported the suite red
  when it was `EPERM` on a socket listen and `EROFS` on a home write inside its own sandbox, and
  both cost a verification round. Agent prompts now say to name a sandbox fault as such and move on,
  which worked the third time.
- **`ContentKeyStore` shipped open-only and needed `seal` added mid-phase.** A store built with a
  reader and no writer is a sign the phase that built it had no writer yet, which is fine, but the
  next phase pays for it at an awkward moment.
