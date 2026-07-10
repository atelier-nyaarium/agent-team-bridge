# Team collab sessions (multi-team chat visible in the Console)

Agent-to-agent crosstalk becomes visible, joinable chat. Requirements as stated by the user
(2026-07-09):

- `crosstalk_discover` should list sessions under a team as well.
- `crosstalk_send` param description should say it can collaborate in an existing session if
  invited; otherwise an unsolicited message routes to a NEW session. "Invite gating is not a
  thing; they just join right on in" (etiquette in the description, no enforcement).
- Works without the user having the session tab open: CoolApp may talk to CoolLib autonomously
  to fix an upstream bug.
- The user may jump in like normal: appears as any normal session would from the App. Peeking
  from either CoolApp or CoolLib's session, you see both their messages sent/recv.
- "When CoolApp sends a message to CoolLib, the message is stored in both stores (of each side)."

## Current-state notes (research)

- Agent-to-agent traffic (`crosstalk_send` -> gateway `send()`/`respond()`) never touches the
  console mailbox today; the app never sees it. Channel job key: `conv.<senderConvId>.<targetAddr>`.
- The console's own thread with a session is `conv.<ownerId>.<targetAddr>`; app threads are keyed
  by the peer session's canonical Address. One mailbox entry resolves to ONE thread
  (`ChatRepository` drain, ~line 2530).
- Precedent for mirroring: the `sent` echo (`kind: "sent"`) already mirrors the owner's own
  outgoing message to all their devices, reconciled by opId. `MailboxEntry` already carries `from`.
- The gateway keeps NO chat history; the mailbox is a delivery queue (entries retained until every
  device acks - per-consumer cursors + slowest-device watermark). App history is device-local.
- `crosstalk_discover` today: flat session list, HIDES bare spawn-points; a send to a bare project
  fails fast; a send to a not-yet-existing `project.session` mints it (requires displayLabel).
- Known gap (pain-points.md "Forward-looking"): cross-Gateway `response_push` relay drops
  `title`/`summary` tiers - needs extending if mirrored replies should keep their headline cross-mesh.

## Questionaire

**1. Where does the shared history live?** -> **A) Mailbox mirror.** The gateway taps every
agent-to-agent send/reply and appends display copies into the owner mailbox, one tagged for each
side's thread. History stays device-local like today; no gateway ledger, no backfill.
User: "we don't care about late joiners. as you can tell with an OFF console missing history."
Recommendation reason (chosen): rides two existing patterns (the `sent` echo and per-consumer
mailbox retention); "stored in both stores" = two mailbox entries landing in the two thread
stores, while each agent keeps its own side in its transcript naturally.

**2. When the user jumps into a thread, who receives the message?** -> **A) Pairwise: only the
session the user typed at.** User: "Only the owner of that store, CoolLib. To fan out, CoolLib
will relay goal shifts to the downstream teams." No participant registry, no fan-out machinery;
the mirror is pure display. Typing in CoolApp's thread steers CoolApp.

**3. Cold-contact mechanics** -> **A) Description-only.** Rewrite `crosstalk_send` +
`crosstalk_discover` descriptions: invited (the session messaged you, or your human named it) ->
send into that session; unsolicited first contact -> create a fresh session under the target team
(the existing composite mint path: `to: team.<name>` + displayLabel, gateway mints the opaque id).
No gateway changes, no enforcement. Bare-team sends keep failing fast.
Recommendation reason (chosen): the mint path already gives agents everything; keeping the
spawn-point fail-fast catches typo'd targets, and discover will surface real addresses anyway.

**4. Discover output shape** -> **A) Grouped under team headers, every team shown** (including
session-less teams as bare headers; console/host stay hidden). User refinement: NO inline how-to
notes on empty teams ("The tool description already teaches it how. don't need to flood the
response too") - a bare `coolib:` header suffices.

**5. Notification treatment for mirrored agent chatter** -> **A) Full treatment, gated on the
tab being open.** User: "As long as the tab is not closed. As in if I open a session and leave
the tab, I should still get it. But pressing Close Tab makes it so I only get mailbox updates and
'(unread count)', but no TTS or notification bar pings." So: open tab -> unread + notification +
TTS-eligible, exactly like a message aimed at the user; closed tab -> mailbox still mirrors and
the unread count still ticks, but no pings and no TTS. (Maps onto the app's existing
`openTabs`/followed mechanic.)

**6. File attachments inside mirrored chatter** -> **A) Full bytes always.** User: "Keep it
simple. I'll talk about this on a different day." (Threshold/metadata-only optimizations
deliberately deferred.)

**7. Multi-gateway delivery strategy** -> **A) Broadcast-converge.** A gateway appending a
console-bound entry (mirror or notice) also relays it to every other same-Domain gateway; each
appends into its local owner mailbox, so every gateway's mailbox converges and the phone can
poll any one. Recommendation reason (chosen): zero discovery, zero app changes, stays inside
switchboard's sealed federation vocabulary (evie untouched); N-1 relays per entry is negligible
at 2-3 gateways. Addressed-to-home (B) is the revisit if gateway count or mirrored-attachment
volume grows.

## Model (decided above)

Every agent-to-agent message stays strictly pairwise. Each gateway, for every leg it routes,
appends one display copy ("mirror") into its own Domain-owner's mailbox per LOCAL session
endpoint, tagged for that session's thread. A same-gateway pair yields two entries (both
threads); a cross-Domain exchange yields one entry per side, each on its owner's phone - "stored
in both stores (of each side)" by construction, and neither gateway ever writes into the other
owner's mailbox.

Multi-gateway delivery is IN SCOPE (user ruling: "make sure the plan INCLUDES the fix for that
multi gateway"; they may add a second gateway soon). Root cause being fixed: console-bound
deliveries are LOCAL appends by whichever gateway routes the leg, while the console polls
exactly one gateway. This also strands `notify_human` notices from non-route gateways TODAY
(verified: `routes.ts humanNotify()` appends to the local mailboxStore only, and
`FederatedOpSchema` has no notice relay op) - a latent live bug, same root cause, fixed by the
same phase (Phase 5). Delivery strategy: pending Q7.

## Audit pass (plan-refinement cycle)

A 12-dimension audit fan-out (78 agents, adversarially verified) checked this plan against the
actual code. 66 concerns raised, 48 survived independent verification. All but one are folded
into the phases below as concrete implementation detail the original bullets were missing (caller
identity, dedupe keys, persistence, security gates); none changed what was decided in the
questionaire. One is flagged separately below rather than silently decided.

**Flagged for you, not silently decided:** Phase 2 turns agent-to-agent traffic into real
DeviceMailbox writes for the first time (it never touched the mailbox before this plan). The
audit found this feeds directly into an existing, separately-tracked bug: the app's sticky "gap"
banner (`ChatState.gap`) is set on mailbox-entry eviction but never reset anywhere in the
codebase (see `pain-points.md`'s Phase F note). Autonomous agent-to-agent chatter is
LLM-turnaround-paced, not human-typing-paced, so it can trip the mailbox's byte/entry cap during
ordinary use of this exact feature (a busy CoolApp/CoolLib exchange with attachments), and once
tripped, that banner is stuck for the life of the app process with no dismiss action. I've added
a cheap mitigation below (kind-aware eviction, so agent chatter is evicted before a device's real
unread mail) which reduces how often the cap is hit at all, but it doesn't fix the banner's
missing reset - that's a pre-existing bug in a different subsystem. Recommend fixing the reset
either just before or alongside this plan; happy to scope that separately if you want it now
instead of "a different day."

## Phase 1 - wire schema

- `schemas.ts` MailboxEntry: add `"peer"` to the `kind` enum, add optional `to` (recipient's
  canonical address; lets the app label direction in the SENDER's own thread, where `from` alone
  cannot identify the other endpoint). Kotlin decode-side enums are open Strings, so old apps
  degrade to rendering mirrors as plain inbound messages.
- Add a stable per-entry `dedupeKey` (optional string) to MailboxEntry/MailboxInput. Audit found
  no stable id exists today for a plain text message (a `messageId` is only minted `if
  (hasFiles)`), so neither a local retry nor a cross-gateway relay retry has anything to dedupe
  on for the common fileless case. Built once here; Phase 2 (local/cross-gateway mirrors) and
  Phase 5 (`console_push` convergence) both consume it instead of each inventing their own.
- `bun scripts/codegen-kotlin.ts`; add a golden protocol fixture for a peer entry, with a
  semantic assertion on `kind`/`to` (not just "decodes without throwing" - the existing
  per-kind manifest loop only proves that much).

## Phase 2 - gateway mirror taps + reply-tier relay fix

- Give `respond()` an `opts` parameter mirroring `send()`'s existing `{trustedInbound?,
  consoleSender?}` shape, threaded from all three call sites (the plain agent HTTP route, the
  console's own "respond" op, the federated `response_push` relay). Today all three call
  `respond(req, body)` identically, so the tap cannot tell "is the replier the console" (needed
  for "never mirror when one side is the console") or "did this arrive via the trusted federated
  relay" (needed to know whether to mirror one or two local entries).
- Recognize `send()`'s "local leg" and "the gateway-relay inbound handler" are ONE code path
  (gated by `trustedInbound`/`inboundSessionId`, not two independent tap points). Branch there: a
  real local-to-local send writes two mirror entries; a federated inbound send landing on the
  destination gateway writes only the local target's ONE entry, and must not call
  `localAddress()` on `from` unconditionally - a federated inbound `from` is already a qualified
  4-segment foreign address, not the bare team name `localAddress()` expects.
- In `respond()`, the non-`returnRoute` branch conflates two cases that both lack a returnRoute: a
  genuine local-to-local reply, and this gateway (as the ORIGIN of a cross-gateway send) receiving
  the destination's `response_push` back. Discriminate via `parseStoreKey` on the respond session
  id, comparing the embedded address's gateway/domain segments against `localGatewayId`/
  `localDomainId`, so only the true local participant gets mirrored in case (ii).
- Mirror entry: `kind: "peer"`, `session_id` = the console-thread store key
  `conv.<ownerId>.<localSessionAddr>`, `from`/`to` = sender/recipient canonical addresses,
  body/files/status/title/summary carried through whole (Q6: full bytes). Dedupe key = Phase 1's
  new wire field, not a content hash (a hash would wrongly collide on two legitimately-identical
  consecutive messages). `ownerId` = this gateway's Domain owner (`ownerKeyId(allowlist.
  ownerSignPub)`) - add an owner-id accessor to `RoutesDeps`, which has no such getter today.
- Kind-aware eviction: in `DeviceMailbox`'s OOM-backstop eviction loop, prefer evicting the oldest
  `"peer"` entries before `"message"`/`"reply"`/`"notice"`/`"sent"` entries, falling back to
  strict age-order only within the same tier. Targets the audit's finding that unconditional
  FIFO-by-age means a slow device's real unread mail gets evicted before the fresh agent-chatter
  burst that actually tipped the cap - this makes the chatter evict itself first instead (does not
  touch Q6's full-bytes decision, purely changes eviction order).
- Fold in the cross-Gateway `response_push` tier fix here (was a separate later phase; audit
  found Phase 2 already edits both exact call sites, so doing it in the same pass avoids a second
  visit): the outbound leg (`respond()`'s returnRoute branch) and the inbound reconstruction
  (`gatewayRelay.ts`'s `response_push` case) both need `title`/`summary` added, AND
  `replyAsJson`/`question`/`reason` - the schema already declares the latter three but the relay
  never spreads them either, a gap adjacent to the one originally scoped.
- Acknowledged, not fixed here: the cross-gateway `respond()` relay leg is fire-and-forget
  (`relayWithRetry`), so a mirror written optimistically at that call site can show "delivered"
  even if the relay silently exhausts retries. Pre-existing asymmetry in the reply-forwarding
  mechanism; out of scope for this plan.
- Tests: send + respond produce correctly-tagged pairs; console-endpoint traffic produces no
  mirror; cross-gateway legs mirror only the local endpoint's thread; dedup holds under retry
  (keyed on the new wire field); a cross-gateway reply preserves title/summary/replyAsJson/
  question/reason end to end; kind-aware eviction prefers "peer" entries.

## Phase 3 - tool surface

- Fix `teams()`'s existing double-row behavior: every catalog project already emits BOTH a bare
  `devcontainer`-kind row and its own composite session rows in the same payload (masked today
  only because `bridgeDiscover` blanket-filters `kind !== "devcontainer"`). The new grouping must
  bucket a project's bare catalog row together with its composite session rows under one header
  (by parsed project name), not print both.
- Update `crosstalk_discover`'s DESCRIPTION string and CLAUDE.md's repo-map line - both currently
  state spawn-points are hidden, which becomes false, and Q4's "no inline how-to notes" ruling
  explicitly depends on the description already teaching the new bare-header behavior.
- Each nested session line prints its full resolvable address (not just a trailing segment) -
  `bridgeSend`'s own `to` description tells agents to paste an address straight from discover.
- Add the missing `res.ok` check to `routerGet` (its sibling `routerPost` already has one) while
  its sole caller (`bridgeDiscover`) is being rewritten anyway - near-zero-cost in the same file,
  and a known crust-collection gap from `pain-points.md`.
- `crosstalk_send` description + `to` describe: collaborate in the session that invited you (it
  messaged you, or your human named it); unsolicited first contact creates a fresh session under
  the target team (existing mint path, displayLabel required). Note that the owner sees the
  exchange in their console.
- Cross-reference, not fixing here: promoting unsolicited cold-contact as normal use rides the
  already-tracked unbounded-session-minting gap in `pain-points.md` (no rate limit/cap on
  `send`'s mint path). This plan doesn't add a new capability, but does make the existing gap
  more likely to matter under normal use rather than adversarial use.
- Tests: a synthetic `teams()` array asserted into grouped/header output, including the
  merged-catalog-row case above (Phase 3 currently has none).

## Phase 4 - app (Android)

- Correct premise: the actual notification-bar-ping gate is the global `isVisible` flag (whole
  app foregrounded/backgrounded), not per-team `openTabs` - `openTabs` today is only consumed by
  the STTS pre-warm branch, never by `notifyBurst`. Implementing Q5 needs genuinely new plumbing:
  thread a per-team "is this team's tab currently open" check from the drain loop through
  `onInbound` into `notifyBurst`/`SwitchboardService`.
- Fix drain's hardcoded sender substitution: the inbound branch sets `Message.from = team` (the
  thread's fixed peer), which is a no-op today because every existing thread's one counterparty
  is always also the sender. A `"peer"` mirror entry breaks that: the true sender is the entry's
  own `from` (a third agent), not the thread's peer. Needs its own branch for `kind == "peer"`,
  not reuse of the existing substitution as-is (which would render every peer message as the
  thread's own peer talking to itself).
- Fix persistence: `persistThreads()`/`loadPersistedThreads()` never serialize `Message.from` at
  all - it's unconditionally re-derived from the thread key on load (correct for today's
  single-peer-per-thread invariant, but it would silently erase a `"peer"` row's real sender
  attribution on every app restart). Serialize `from`/`to` for `kind == "peer"` rows; on load,
  use the persisted value when present, falling back to the thread-key derivation otherwise.
- Burst/notification granularity: a single poll cycle's `burst` list can mix a peer-mirror entry
  and a to-user entry for the same team (one all-or-nothing decision per team per cycle today).
  Adopt the explicit rule: any user-aimed entry in a burst forces full treatment for the whole
  burst - a peer entry must never silently downgrade a real ping.
- Correction found during implementation: gating notifications directly on `team in openTabs`
  would have been wrong - a session that was never opened is equally absent from `openTabs` as
  one that was opened and explicitly closed, and the existing STTS pre-warm comment confirms a
  never-opened session is expected to notify normally today. Track "explicitly closed, not yet
  reopened" as its own `ChatState.closedTeams` set instead (added in `closeTab`, cleared in
  `openThread`/`forget`) - a team absent from BOTH `openTabs` and `closedTeams` (never touched)
  still gets full treatment, matching today's behavior; only a team present in `closedTeams` goes
  quiet.
- Note (accepted for v1): `closedTeams`, like `openTabs`, is unpersisted, process-lifetime-only
  state - an OS-initiated process kill silently un-mutes every closed team until it is closed
  again. Low-stakes (worst case is one unwanted notification after a restart, not a missed one).
- Tests: peer-entry drain routing (`PeerMirrorAttributionTest`) + sender-attribution persistence
  round-trip (save, reload, still shows the third-party sender, not the thread's own peer, same
  test file) + notification gating (`ShouldNotifyBurstTest`). Golden fixture decode for a `"peer"`
  `MailboxEntry` was already shipped in Phase 1 (`ProtocolFixturesTest.decodesEveryMailboxKindAndLongAt`
  asserts `kind`/`from`/`to`/`dedupeKey`, not just a decode-without-throwing check) - nothing to
  add here.

## Phase 5 - multi-gateway console-bound delivery (console_push)

- **Mandatory security gate:** `console_push`'s `handleOp` case must reject any
  `srcDomainId !== null` (a cross-Domain sender), matching every sibling `FederatedOp` case
  (send/list_teams/wake/response_push all already gate this way, tested in
  `federation.test.ts`'s "destination gate" suite). Without this, a linked cross-Domain friend's
  gateway - today confined to specific, individually-shared sessions - could inject
  attacker-chosen mailbox content directly into a different owner's phone. Add the matching
  deny-test alongside the existing suite before this ships.
- Name `humanNotify()` as an explicit edit target (the plan previously only asserted the fix,
  never named the function): refactor its delivery off "iterate only mailboxes that already
  exist" (`mailboxStore.forEach`) to "ensure by known owner" (`mailboxStore.ensure(ownerId)`,
  the same deterministic id Phase 2 resolves). Today a gateway with zero currently-registered
  consoles has an empty mailbox map, so `forEach` iterates zero times and the notice silently
  disappears - the actual multi-gateway stranding case. Add a `dedupeKey` (Phase 1's wire field)
  to its append call too, matching the mirror-tap's requirement.
- Thread mailbox-append + owner-id resolution into `GatewayRelayHandlerDeps`/`FederationRoutes`
  and the `index.ts` construction site - `gatewayRelay.ts` has no path to a mailbox at all today.
- Do not rely on `ReplayGuard` for delivery dedup: it's scoped to `(srcGateway, nonce)` and mints
  a fresh nonce on every relay attempt, including retries to the same peer, so it cannot prevent
  a double-append on retry. The real guard is Phase 1's `dedupeKey` feeding
  `DeviceMailbox.append`'s existing `seenKeys` mechanism, which already handles exactly this.
- Enumerate the same-Domain fan-out set via evie's `list_gateways` (the same call `discover()`
  already makes) - no new discovery machinery needed. As defense-in-depth, filter that roster
  through the locally-mirrored Allowlist's admitted gateway ids where possible (trusting evie's
  roster alone for a mailbox-WRITING op is a bigger trust extension than for the already
  self-limiting `list_teams` path). Add a local `gatewayId !== localGatewayId` self-exclusion
  guard as cheap insurance against evie ever including the caller in its own roster.
- Relayed entries must NOT re-broadcast (origin-only fan-out, no gossip loops) - this is a
  discipline the code must enforce structurally (confine the fan-out call to origination tap
  points, never invoke it from within the `console_push` handler itself), not just a convention.
- Tests: a mirrored leg routed on a non-home gateway lands in the home mailbox exactly once
  under relay retry; a notice from a non-home gateway reaches the phone; single-gateway behavior
  byte-identical; the mandatory cross-Domain deny-test above; a receiving gateway never itself
  re-fans-out (no gossip loop).

## Phase 6 - gates + deploy

- Gates: `bun run lint && bun run test`, codegen drift check, Android `testDebugUnitTest`.
- Deploy: push (branch + auto-merge PR), await CI + APK release, gateway rebuild, reload plugins
  on live sessions.

## Crust collected during implementation

Real, out-of-scope-for-this-plan findings surfaced by audit passes. Not fixed here; migrate to
`pain-points.md` when this plan ships.

- [medium] `src/gateway/routes.ts : teams()` - pre-existing, not introduced by this plan -
  `commonFields`'s `domainIdField` omits `domainId` entirely in arming mode (`localDomainId` not
  yet resolved), while every actual address-building path elsewhere in the same file (`localAddress`,
  `send()`'s `parseTarget` call via `localDomain = localDomainId ?? LOCAL_DOMAIN_SENTINEL`) treats
  arming mode as domain `"local"` instead. `bridgeDiscover.ts`'s `displayHeader`/`formatSessionLine`
  fall back to a bare, unqualified team name when `domainId` is missing, so a not-yet-enrolled
  gateway's own discover output prints an unqualified `myproj.mysession` instead of a
  `LOCAL_DOMAIN_SENTINEL`-qualified address - inconsistent with the rest of the system's arming-mode
  convention, though still locally resolvable (not a routing break) since `parseTarget`'s short forms
  default to local. Untested (`bridge-discover.test.ts`'s `entry()` fixture hardcodes a non-empty
  `domainId` in every case). Fix: stamp `domainId: localDomainId ?? LOCAL_DOMAIN_SENTINEL`
  unconditionally in `teams()`'s `commonFields`, matching `localDomain`'s existing convention.
- [low] `src/mcp/bridge/bridgeDiscover.ts` - pre-existing, predates federation entirely (traced via
  `git log -p --follow` to this file's first commit) - the `others` filter's `t.team !==
  bridgeProjectName()` self-exclusion is a bare string compare with no gatewayId/domainId scoping,
  applied uniformly to the federated-merged list. A remote peer whose own team name happens to
  equal my `bridgeProjectName()` gets silently dropped from my own discover output, even though it
  lives on a different gateway/Domain - discovery completeness/availability impact only (confirmed
  no conflation with my own entry, no misrouting via `crosstalk_send`, since that tool resolves
  addresses independently of discover's listing). Fix: scope the comparison to
  `t.gatewayId === localGatewayId` (or equivalent) before comparing team names.
- [low] `src/mcp/bridge/bridgeDiscover.ts : groupDiscoverEntries` - no de-dup of identical `team`
  values within one group. Two entries sharing the same fully-qualified address (possible if a
  gateway is ever double-listed across `discover()`'s local/same-Domain/cross-Domain buckets)
  render as two separate, possibly-contradictory session lines under the same header instead of
  collapsing to one. Not confirmed reachable from this repo alone (depends on evie's roster
  fan-out never double-listing a gateway); log rather than fix blind.
- [low] `src/shared/session-id.ts` (`parseSessionName`/`composeSessionName`/`isComposite`) - a
  project name containing a dot cannot be represented in a fully-qualified address at all: the
  address grammar's slug check (`assertSlug`, no dots allowed) rejects it, so `bridgeDiscover.ts`'s
  `displayHeader`/`displayTarget` fall back to an unqualified bare name for such a project (no
  domain/gateway prefix) rather than throwing - Phase 3's dotted-project-name fix (trusting `kind`
  over a naive dot-split) stops the wrong header/phantom-session symptom, but a session actually
  living under a dotted-name project still can't be unambiguously addressed via the dot-delimited
  grammar (first-dot-split can't tell `project.session` from `pro.ject.session`). Deeper fix would
  need a different separator or an escaping scheme in the core address grammar - out of scope for
  a tool-surface phase; affects every consumer of `parseSessionName`, not just this tool.
- [low] `src/mcp/bridge/bridgeDiscover.ts : groupDiscoverEntries` - a malformed entry (no usable
  `team`) is dropped with zero trace - no counter, no warn - unlike `evieClient.ts`'s established
  convention for a federated-boundary anomaly of the same class (count and warn). Weighed against
  `discover()`'s own sibling convention one layer up (a whole peer that errors or times out is
  "simply omitted", also with no logging), so this isn't a clear-cut violation either way. Display/
  diagnosability only, not a trust or routing issue. Fix, if picked up: have `groupDiscoverEntries`
  return a skip count alongside its groups so the (already-impure) tool handler can log it once.
- [low] `src/mcp/bridge/bridgeDiscover.ts : groupDiscoverEntries` - trusting the wire's `kind` field
  (vs. the old dot-shape derivation) is pre-existing exposure, not a regression: a malicious/buggy
  already-admitted peer could always lie in either `team` or `kind` (neither is schema-validated
  anywhere in the relay chain - `TeamInfoSchema` exists but is never `.parse()`'d against wire
  data). Ceiling is unchanged and low either way - cosmetic distortion of one caller's own
  `crosstalk_discover` text, zero effect on `crosstalk_send` routing (which never reads anything
  `groupDiscoverEntries` computes). A cleaner full-hide already existed pre-fix via `kind:
  "console"` and is untouched by this diff. Not fixing; no test added since it pins a pre-existing,
  low-severity, out-of-scope trust characteristic rather than this phase's own change.
- [medium] Framework-first finding, expanding on the two entries above - `TeamInfoSchema` (fully
  specified in `schemas.ts`, already reused by `ConsoleListTeamsResultSchema`) has never actually
  been runtime-parsed against wire data anywhere: every hop a `TeamInfo[]`/`list_teams` payload
  crosses (`routes.ts:611`/`629`'s peer-relay merge into `discover()`, `bridgeDiscover.ts:131`'s
  `/discover` fetch, `consoleHandler.ts:548`'s console-facing `list_teams`) does a bare `as` cast,
  and `federation-protocol.ts`'s own comment ("the existing route validation handles shape, so no
  result schema is enforced here") describes a safety net that doesn't exist. `bridgeDiscover.ts`
  also hand-rolls a `DiscoverEntry` interface that has already drifted from `TeamInfoSchema`
  (`gatewayId` optional vs. required; `status`/`kind` loose `string` vs. closed enums;
  `displayName`/`isAdminDomain`/`mode`/`version` absent). **Important correction before anyone
  acts on this:** a naive `TeamInfoSchema.safeParse()` would be wrong, not just incomplete -
  `status`/`kind` are closed zod enums, but the generated Kotlin (`android/.../proto/Protocol.kt`)
  deliberately decodes both as open `String`s for forward-compatibility ("the console must
  tolerate values newer than this build" - `codegen-kotlin.ts:219` states the same rule). Reusing
  the closed-enum schema as-is on inbound peer data would silently drop every entry from a peer
  running a newer protocol version - regressing, one layer up, the exact cross-version tolerance
  the Kotlin side was built to preserve. A correct fix needs a deliberately loosened variant
  (strict on `team`/`gatewayId`/`queue_depth`, permissive on `status`/`kind`/`mode`), which is real
  design work, not a drop-in one-liner. The highest-consequence site is actually
  `consoleHandler.ts:548` (not `bridgeDiscover.ts`, an MCP-side nicety): its result reaches a real
  Android device via a single atomic `kotlinx.serialization` decode of `List<TeamInfo>`, which
  fails the *whole array* on one structurally-invalid required field - so one malformed peer entry
  can hide every session, local included, from the phone. Not fixing here (wrong phase for a
  trust-surface schema design, and 5 of the 7 cast sites are same-process JSON round-trips with no
  real boundary, not worth wrapping "for uniformity"). Natural pairing: do this alongside Phase 5,
  which already touches the federation/mailbox trust surface, with its own red-team pass.
- [info] Compliance pass cross-reference, no new tracking needed - the broader "who can call
  crosstalk_discover / join a team with no admission gate" question this phase's grouping change
  surfaces more visibly is already captured, at higher fidelity, in `plans/gateway-auth-surface.md`
  (a dedicated security audit dated 2026-06-25, before this plan existed) - an owner-approved,
  unshipped origin-aware `GATEWAY_TOKEN` gate already covers `/teams`/`/discover`/`/pending`.
  `pain-points.md` already cross-references it as "already-known, already-decided-but-unshipped".
  Nothing to add here beyond noting Phase 3 doesn't change that picture either way.
- [low] `src/gateway/federation/gatewayRelay.ts` (`localShareTarget`) / `src/shared/session-id.ts`
  (`DEFAULT_SESSION`) - pre-existing canonicalization quirk, unrelated to and untouched by this
  phase: sharing a whole bare project (`cross_domain_share`'s `SpawnPoint` form) and sharing a
  session literally named `claude` (`DEFAULT_SESSION`) canonicalize to the identical share key
  (`domain.gateway.<project>.claude`), so either action satisfies the other's share-filter check.
  Not a bypass (both still require an explicit owner `cross_domain_share` call), just an ambiguity
  in "which of two things did the owner mean to share". Fix, if picked up: a distinct sentinel or
  explicit disambiguation for a whole-spawn-point share vs. a session named `claude`.
- [high] `android/.../ChatRepository.kt : forget` / `startPolling` - genuine data-loss race,
  pre-existing (not introduced by this phase) and general-purpose (not peer-mirror-specific):
  `forget()` runs synchronously on the main thread with no mutual exclusion against the poll
  loop's `appendInbound`/`bumpUnread`/`mailboxSync.commit()` sequence running concurrently on
  `Dispatchers.IO` for the same team. Whichever side's `_state` update lands last wins: if
  append/bump wins, a just-forgotten thread reappears as a ghost session and re-notifies; if
  forget wins, a freshly-arrived message is wiped from `_state` (and from disk, since forget
  calls `persistThreads`) while the mailbox cursor has already unconditionally advanced past
  it in the same poll cycle - a silent, permanent, unrecoverable message loss, contradicting
  this codebase's own documented at-least-once mailbox guarantee. A real fix needs a shared
  Mutex (there's already a precedent, `freshTeamsMutex`) serializing `forget()` against the
  poll loop's per-team append/bump/commit sequence - a careful concurrency change, not a
  peer-mirror rendering fix, so deliberately not done in this phase.
- [low] `android/.../ChatRepository.kt : playMessage / preloadMessage` - TTS playback has no
  `closedTeams` check at all (only a message-existence lookup), so closing a tab mid-flight
  (after the poll loop already decided to pre-warm + auto-play a followed thread's burst, but
  before the deferred coroutine actually runs) can still read a just-closed thread's message
  aloud, even though the notification banner itself correctly suppresses. UX inconsistency,
  not data loss; not fixed here.
- [low] `android/.../ChatRepository.kt : forget` - never clears `teamAbsenceStreaks` for the
  forgotten team. Normally harmless (excluded from the next `withFreshTeams` rebuild anyway),
  but a forget-then-relabel-before-next-refresh sequence can reuse a stale streak count and
  shorten the documented two-miss absence grace window to one. Narrow, not fixed here.
- [low] `src/gateway/routes.ts` (`RespondBodySchema.status`) / Kotlin `MailboxEntry.status` -
  both unconstrained strings, not an enum. A future/non-standard reply carrying the literal
  wire value `"waking"` (today only ever a local Android sentinel, never sent by any
  first-party tool) would be silently and permanently dropped by the load-time waking filter,
  losing its `from`/`to` attribution along with it. Not peer-specific (every non-`"sent"` row
  shares this exposure) and not reachable by any current caller; general schema-hardening item,
  not fixed here.
- [flagged for the human, not silently decided] A never-opened team can ping at full strength
  (banner + TTS) the very first time it's merely mentioned in agent-to-agent chatter, since
  `shouldNotifyBurst` only gates on `closedTeams` (explicitly-closed) and a never-opened team
  is deliberately not muted (see the correction bullet above) - that ruling was reached by
  analogy to Q5's "direct message to a fresh session" scenario, not by asking about this
  specific one (a team you've never touched getting a full-volume ping purely for being CC'd
  on someone else's conversation). Shipping as-is; worth a confirm-back on whether this matches
  the intended experience.
- [flagged for the human, not silently decided] Peer-mirror content (another local agent's own
  words, and per the mirroring model potentially a different Domain/tenant's agent's wording)
  now reaches the same unredacted, no-opt-out lock-screen visibility tier as a message directly
  addressed to the console (`notifyBurst` sets no `setVisibility`/`setPublicVersion`.) This is
  the existing default notification visibility, not something this phase changed, but it's the
  first time third-party/cross-Domain content is eligible to reach that tier. Shipping as-is
  (a proper fix - kind-aware visibility, or a per-conversation-kind mute - is real design work,
  not a minimal patch); worth a confirm-back.
