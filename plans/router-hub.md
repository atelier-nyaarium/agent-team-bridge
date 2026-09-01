# Questionaire

Total restructure: the Router becomes the hub, gateways become symmetric leaves. Supersedes the
route-gateway model. `plans/vault.md` is parked until this lands; the board holds plugin ideas.

> "Currently it's all centralized and revolved around an arbitrary Gateway. True Sync is impossible
> and shimmed here and there. TBH I didn't come up with it, it just sort of happened with Opus."

## Proposal - Router as hub, transport layer rewritten, everything else kept

Q: Ground-up foundational rewrite with the Router as the centralized hub?
A: Router as hub, yes. Ground-up, no. Rewrite one layer: phone <-> Router <-> gateway transport.

WHAT MOVES TO THE ROUTER
- The owner's mailbox. Every gateway appends; the phone polls once and sees every gateway.
- Presence. Gateways push signed session rows on change; the Router folds one mesh snapshot.
  Discovery stops existing as a concept.
- Console op routing. The phone addresses a gateway by id; the Router forwards; the reply lands in
  the Router mailbox. No route-gateway anchor, no relay-back leg.
- Owner facts the phone reports once: capabilities, read anchors.

WHAT SHRINKS AT THE GATEWAY
- Loses mailbox ownership, `discoverFull` fan-out, `DISCOVERY_REFRESH_MS`, the route/non-route
  split, the per-gateway capability re-report, the reply-anchor relay.
- Keeps session store, local presence, `host_op`, wake, board store (pending a later question),
  Codex and Copilot services.

WHAT IS UNTOUCHED
- Trust: owner root, admissions mirrored on Router and gateways, Ed25519/X25519, sealing,
  `ReplayGuard`, TLS pinning, SAS enrollment, trust-on-first-enroll. Rewriting crypto is where a
  rewrite is most dangerous and this part is the part that works.
- The app's non-transport surfaces: thread, terminal view, playback, attachments, board UI, drafts,
  zoom, settings. Only `ConsoleClient`, `PollDrain`, `PresenceOps`, the plane cursors, and
  `RouterReach` change.
- MCP tools, capabilities, refs, designer, delegation. They talk to the local gateway.
- Host daemon.

DEGRADED MODE
Today, Router down already means "one gateway": `discoverFull` returns local-only with
`rosterKnown: false`. Under the hub, Router down means the phone talks to a gateway directly on
LAN for that gateway's own slice, using the same sealed ops. Symmetric gateways ARE the fallback.

THE RISK, stated plainly
This is a rewrite of the layer that took 37 hold/wake/deliver/stale/evict/deadline fixes in the
last 120 commits. Each of those encodes a real failure mode. The plan must map every one to either
"impossible by construction under the hub" or "carried over", or the rewrite rediscovers them.
Examples: "hold a send for an absent session" becomes the Router holding the row until a session
claims it, with no refuse path to patch; "a stale socket clearing a live one" becomes the Router
owning the socket registry with a generation fence.

### Assumption A1 - Clean break, coordinated cutover

The four components update on separate triggers, and an old phone cannot talk to a hub Router. A
single-owner self-hosted system can cut over all four at once. No wire compatibility with the
route-gateway model is kept. Say so if that is wrong.

### A2 resolved - Cross-Domain is same-Router; the hub is coherent for friends

Verified: the Router never talks to another Router (no forwarding code in `federation-server`).
`gatewayBridge` keeps `gatewayConnections` as a map of domainId to a map of gatewayId to
connection: ONE Router hosts MANY Domains, and `crossDomainPeers` is keyed `(friendDomainId,
friendGatewayId)` on that same Router. A friend's gateways are already connected to the hub.
Consequence: `sharesFor` and the cross-Domain presence filters become Router-side rules on the
folded presence and on inbox routing, instead of gateway-side relay filters.

### Inventory - what rides `gateway_relay` today

Eight `FederatedOp` kinds: `blob_fetch`, `console_push`, `gateway_relay`, `list_teams`,
`presence_push`, `response_push`, `send`, `wake`. Seven relay call sites: `blobFetch` (blob_fetch),
`presenceExchange` twice (presence_push to friends, list_teams discovery), `consolePushOps`
(console_push fan-out to other gateways' consoles), `sendCrossGateway` (send), and two inside
`relayWithRetry` (response_push back to origin, and the retry loop itself).

Under the hub: `list_teams`, `presence_push`, and `console_push` die outright, since the Router
folds presence and owns the mailbox. That is four of seven call sites gone before Question 3 is
even asked. What remains is `send` and `response_push` (Question 3), and `wake` and `blob_fetch`
(genuine request-response, later question).

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
re-applies client-side, the model every E2EE sync app uses. `fileSecretStore`'s bounded atomic CAS
is already that primitive.

Three tiers:
  1. CLEAR SHARED - Router is authority and reader: presence, capabilities, read anchors, mailbox
     envelopes.
  2. SEALED SHARED - Router is authority on the envelope, blind to content: board, drafts,
     scheduled sends, armed goals, Vault entries and notes.
  3. SEALED ROUTED - Router is courier, holds no state: message bodies, terminal frames, files.

Consequence, not a choice: the owner content key is SYMMETRIC and held by every phone (via the
synced keyring) and every gateway (delivered in the enrollment bundle, sealed to the gateway's box
key). Gateways must read the board and write bodies; the Router is the one party without it. That
matches the trust model exactly: gateways are loopback-only owner machines, the Router is the only
public port. Revoking a gateway does not erase its copy; rotation is a key-epoch bump, a plan item.

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
Router holds open for up to 120s. Under the hub, do they become Router-held inbox rows like phone
traffic, or does the sync relay stay for agents?

  A) One primitive. Router-held inboxes addressed by OWNER (phone) or by SESSION (agent). `send`,
     `response_push`, `console_push` are inbox appends. The Router acks "accepted" at once; the
     destination gateway acks "delivered to session" as a row the sender can read. `wake` and
     `blob_fetch` stay as Router-forwarded request-response with a SHORT per-call timeout;
     `gateway_relay` survives only as their envelope.
  B) Two primitives. Router inboxes for phone traffic; keep `gateway_relay` plus `relayWithRetry`
     and the hold/ack machinery for agent-to-agent. Less to rewrite; crosstalk keeps its own 120s
     sync shape and its own failure modes.

A: A - one primitive. Router-held inboxes addressed by owner or by session. `wake` and
`blob_fetch` remain request-response with a short per-call timeout.

> "A"

Recommendation reason, chosen: the last three commits already moved agent delivery to
hold-until-the-session-says-it-took-it, which is the inbox model; the 120s Router-holds-the-call
shape is what produced the discovery hang; and the 37 failure modes map to one place under A.

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

### Consequences settled by Questions 1-4, not separately asked

- The Router is authoritative for every owner-scoped thing; the phone is a CACHE with offline
  reads, not a second source of truth. `ChatPersistence` and `AppStateStore` persist what the
  Router last said, keyed by Router version, never a divergent local truth.
- The gateway is STATELESS for owner state. It keeps only what it physically owns: the session
  store (tmux), the origin blob copy, Codex and Copilot threads, `ReplayGuard`, its own identity
  and admissions. `boardStore`, `capabilityStore`, the device mailbox, and `awarenessBank`'s
  subscriber deadlines leave the gateway.
- Tenant isolation at the Router becomes load-bearing: it now holds each Domain's inboxes, state
  and blob cache. `tenantAdmin` grows a residue test that no owner-scoped read can cross a
  domainId.

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

# Plan

Scale, measured: the phone's transport layer is about 3,300 lines across ten files, with 17 files
carrying a route-gateway assumption. About 5,900 lines of gateway modules leave the gateway or
die (board store, authority, cascade and awareness; the device mailbox; the plane registry;
`consolePushOps`; `presenceExchange`; `blobFetch`; the whole console handler directory). `routes`
and the gateway entry point (about 3,200 lines) are partially affected. The Router is about 3,400
lines today and roughly doubles. MCP tools and the host daemon are near zero.

## Phase 0 - Backup and freeze

Export the owner key backup from Management. Tag the current release. `plans/vault.md` stays
parked. No code.

## Phase 1 - Failure-mode ledger

Take the 37 hold/wake/deliver/stale/evict/deadline commits from the last 120 and map each to one
of: IMPOSSIBLE BY CONSTRUCTION under the hub (and which invariant makes it so), or CARRIED OVER
(and where). Every "impossible" row names the residue test that will prove it. Output is a table
appended to this plan. No code. Gates Phase 2: the invariants it names are the Router's spec.

Known mappings to seed it: "hold a send for an absent session" becomes the Router holding the
inbox row until a session claims it, no refuse path; "a stale socket clearing a live one" becomes
the Router owning the gateway socket registry with a generation fence; "count what the mailbox
actually holds" becomes one mailbox writer at the Router with a residue test; the 120s relay
timeout versus the phone's 35s becomes a per-call timeout on the two surviving request-response
ops, pinned in a constants test the way `ChatRepositoryConstantsTest` pins the poll chain.

## Phase 2 - Router: owner-scoped state (tiers 1 and 2)

Additive; old surfaces untouched.
- A versioned state store keyed `(domainId, ownerId, kind, id)`: clear envelope plus sealed body,
  CAS on version, built on the bounded atomic CAS `fileSecretStore` already has.
- Presence fold: gateways push signed session rows on change over the gateway WS they already
  hold; the Router marks a gateway's rows unreachable when its socket drops. Gateway liveness is
  the Router's; session liveness stays the gateway's.
- Board: `boardAuthority`, `boardCascade`, `boardAwareness` move to the Router and run on the
  clear envelope (id, parent, rank, state, session, version, attachment manifest). Titles and
  bodies are sealed. The phone's Kotlin board reducers shrink to "apply what the Router says".
- Capability fold and read anchors as tier-1 state.
- Cross-Domain: `sharesFor` and the friend-presence filters become Router-side rules.
- Residue test: no owner-scoped read crosses a `domainId`.
- New wire shapes in the shared Zod schemas, Kotlin regenerated.

## Phase 3 - Router: inboxes, request-response, blob cache

- Inboxes addressed by owner or by session: append with clear envelope (origin, seq, epoch, size,
  dedupe hash, title) and sealed body; "accepted" ack at append; "delivered" ack from the draining
  gateway as a row the sender reads; bounded retention; dedupe on envelope hash; one writer,
  residue-tested.
- `wake` and `blob_fetch` as Router-forwarded request-response with a SHORT per-call timeout
  through the `relayTimeouts` the Router already has. `gateway_relay` survives only as their
  envelope.
- Blob cache: content-addressed, sealed, size quota, LRU sweep; origin gateway stays
  authoritative and answers a miss.

## Phase 4 - Owner content key

- Derive a symmetric key from the owner root by HKDF; a key epoch on every sealed envelope.
- Deliver to phones through the synced keyring `buildConsoleTransport` already ships, and to
  gateways through the sealed enrollment bundle Gateway Setup already waits for.
- Rotation procedure: bump the epoch, re-deliver, old epochs stay readable. Documented, not
  automated.
- Residue test: the key never appears in a log line or a debug ingest.

## Phase 5 - Gateway client

- Push presence on change; append outbound rows for its sessions; drain its sessions' inboxes
  as the Router pushes them over the existing WS; read capabilities and board from the Router;
  upload blobs to the cache and keep the origin copy.
- Delete: `discoverFull` and every `DISCOVERY_REFRESH_MS` consumer, `consolePushOps` fan-out,
  the `list_teams` and `presence_push` legs of `presenceExchange`, the device mailbox, the plane
  registry, `boardStore` and the three board modules, `capabilityStore`, the subscriber deadlines
  in `awarenessBank`, `sendCrossGateway`, and `relayWithRetry` for messages.
- The gateway holds no owner state on disk. Residue test.

## Phase 6 - Phone transport

- `ConsoleClient` targets the Router only; `routeGateway` is deleted, and with it the non-route
  capability re-report and the per-gateway board pull.
- `SwitchboardService` holds a pinned WS to the Router in the foreground; the Router pushes inbox
  rows, state versions and presence. `IdlePushbackManager` and the background tiers are untouched.
- `PollDrain` becomes the one drain for one source. `PresenceOps.refreshDiscovery` is deleted.
- `BoardOps` writes with CAS and re-applies on a lost race. `AttachmentOps` fetches the Router
  cache first and the origin on a miss. `ChatPersistence` stores what the Router last said, keyed
  by version.
- `RouterReach` stays: it is the Router address logic and is still needed.
- 17 files carry the route-gateway assumption; each is touched.

## Phase 7 - MCP plugin and host daemon

Near zero. The MCP talks to its local gateway; the gateway's owner-facing ops change shape
internally. Verify every tool against the new gateway. `host_op` stays gateway to daemon. The
Codex and Copilot daemon services are unaffected.

## Phase 8 - Cutover and removal

Order: Router (both surfaces live), then every gateway, then every phone, then the plugin. Then
delete the old Router console surface and every old gateway path in one commit. Any shim that
lets the two coexist during the window carries a remove-by comment. `setup.sh --verify` learns the
new registration. Vault questionaire resumes on the new substrate.
