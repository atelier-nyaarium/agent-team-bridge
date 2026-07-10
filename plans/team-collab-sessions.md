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
- [medium] `android/.../ChatRepository.kt : forget` - the compliance audit's other finding this
  phase, now fixed: `forget()` only dropped its own team's thread, leaving an identical
  peer-mirror row (real address, message text, attachments) intact in a sibling thread, since
  the gateway mirrors one exchange into both participants' mailboxes as separate thread keys.
  Fixed via `threadsAfterForget` (sweeps every remaining thread for a peer row naming the
  forgotten address); `sessionLeaf`'s unparseable-input fallback hardened from echoing the raw
  string to a safe placeholder, and `loadPersistedThreads` now validates a peer row's persisted
  `from`/`to` the same way an ordinary thread key is validated. Noted here only for the audit
  trail - already committed (`af67d13`), not a deferred item.
- [high] `src/gateway/routes.ts : respond` / `mirrorPeer` - pre-existing (Phase 2's own code,
  surfaced by this phase's crust sweep), genuine duplicate-delivery risk, not merely a misleading
  log line. `respond()` has no try/catch around any of its 3 `mirrorPeer` calls. On the
  cross-gateway reply path, an uncaught throw from the `isRemoteAnchor` mirror call propagates out
  of `respond()`, is caught only at `gatewayRelay.ts`'s pump level, and gets reported to the
  origin as a relay failure - which makes `relayWithRetry` retry up to 5 times (2s/4s/8s/16s
  backoff). `PendingJobStore.deliver()`'s "stored" re-delivery branch doesn't distinguish a
  genuine not-yet-delivered retry from this case, so each retry re-runs the full `respond()` body:
  it re-appends to the console mailbox (`mailbox.append` called with no `dedupeKey`, so never
  deduped) or re-pushes over the live WS, genuinely duplicating an already-successfully-delivered
  reply to the original asker 2 to 5 times over a downstream, purely-cosmetic mirror failure.
  Root cause (finding 4 of the sweep): `mirrorPeer`'s own try/catch doesn't cover `ownerId?.()`,
  which runs before the try block - contradicting its doc comment's "never surfaces to the
  caller" guarantee, and untested (`routes.test.ts`'s "mirror taps" suite never injects a
  throwing `ownerId`/`mailboxStore`). Not fixed here - out of Phase 4's scope (Android), needs its
  own careful pass over `routes.ts`'s error boundaries.
- [medium] `src/gateway/routes.ts : send` - same sweep, a related but distinct gap: the
  channel-mode branch's two local-participant `mirrorPeer` calls are unguarded sequential
  statements inside the same try as the already-completed channel_push delivery loop. If the
  first mirror call throws, the second (the recipient's own mirror copy) never runs (an
  asymmetric, one-sided mirror with nothing to detect it later), and the enclosing catch
  misreports the whole request as a 500 even though the real message already delivered. Compounds
  the finding above: a caller retrying after seeing this spurious failure would re-fire the real
  `ws.send` channel_push too, duplicating the actual message, not just its mirror copy. No shared
  dedupeKey links the two (or three, cross-Domain) independent mirror calls of one exchange, so
  there is also no way to reconcile a one-sided mirror after the fact. Not fixed here.
- [low] Cross-runtime "twin" pair with no shared fixture: `android/.../AgentScreen.kt`
  (`isReady`/`isWorking`/`isLoggedOut`/`strip`) and `src/mcp/devcontainer/tmuxCore.ts`
  (`isAgentReady`/`isAgentWorking`/`isLoggedOut`/`stripAnsi`) both hand-parse the identical tmux
  ANSI literals independently, and each side's doc comments call the other "the twin" - but unlike
  every other hand-synced twin in this codebase (`SessionId.kt`/`session-id.ts`,
  `SasCrypto.kt`/`cross-domain-sas.ts`, `OwnerId.kt`/`owner-id.ts`, `SyncCursor.kt`/`sync-cursor.ts`,
  all pinned equal by a committed `tests/fixtures/*/vectors.json`), this pair has no shared
  fixture - each side's test hand-duplicates its own example strings. A heuristic tweak on one
  side (a Claude Code UI change to the spinner glyph or login wording) can pass its own suite
  while silently leaving the other runtime's ready/working/logged-in decision wrong. Fix pattern
  already established 4 times elsewhere in this repo; not applied here (out of Phase 4's scope).
- [medium] `android/.../ChatRepository.kt : ChatState` - flag-soup trending real, not
  hypothetical: 4 of its 8 team-keyed collections (`closedTeams`, `unread`, `sessionWorking`,
  `sessionNeedsLogin`) are plain per-team scalars manually enumerated together at 3 separate
  lifecycle boundaries (`openThread`, `closeTab`, `forget`), and `forget`'s own comment says so
  outright ("key every field removal by [the canonical key] ... so a non-canonical spelling can't
  leave a field's entry behind"; that's a human working around a missing type). The same problem
  has already escaped `ChatState` itself into `ChatRepository.drafts` and `SttsPlayer`'s cache,
  both requiring the identical manual-sweep discipline with no compiler enforcement tying the
  three together. Proposed fix (not applied): a `SessionUiState(closed, unread, working,
  needsLogin)` value type replacing the 4-map cluster, `sessionUi: Map<String, SessionUiState>` -
  collapses `forget`'s 4 separate removals into one `sessionUi - key`. `Message.from`/`to`/`isPeer`
  is the same pattern already half-applied this phase (`MessageAttribution` exists only as a
  computation intermediate; `Message` itself still flattens back to 3 loose fields rather than
  nesting the value object) - a natural next increment alongside the `ChatState` work, not on its
  own.
- [low] `android/.../ChatRepository.kt : Message.status` / `.opId` - a 4-state delivery machine
  ("pending"/"waking"/"running"/"error"/null) as a raw nullable `String`, compared by literal at
  roughly a dozen call sites. The illegal combination (`status == "pending"` with `opId == null`)
  is real enough that load-time code already detects and repairs it as a legacy-row migration.
  Candidate for a sealed `DeliveryState` type so the illegal state becomes unrepresentable by
  construction; the bug it guards against is a one-time migration path, not a live defect, so
  lower priority than the `ChatState` item above.
- [low] `android/.../ChatRepository.kt : Message.title` / `.summary` - always constructed,
  persisted, and loaded together; two nullable Strings standing in for one "this row is a notice"
  sub-shape that is already a formalized wire type (`NoticeSchema {title, summary, full}` in
  `src/shared/notice.ts`) never mirrored into Kotlin as its own type. Same family as the
  `ChatState`/`MessageAttribution` item above; bundle together if picked up.
- [low] Vestigial `localGatewayId` parameter, same root cause as the already-known `label()` case
  (dead since the address-grammar migration made per-call re-canonicialization unnecessary):
  `android/.../ChatRepository.kt : ChatState.sessions` never references its own `localGatewayId`
  parameter either, and every call site still threads `state.localGatewayId` through for nothing.
- [low] Four `ChatRepository` methods have zero remaining callers, each stranded by an earlier UI
  reshuffle rather than a recent regression: `localDisplayName` (superseded by `displayName()`,
  which adds a `confirmedDomainId()` fallback), `peerSessions` (superseded by `shareableSessions()`
  in `Sharing.kt`), `sttsProviderMissing` (the "selected voice vanished from the catalog" warning
  it was written for is never surfaced by `SttsVoiceSection`), and `unlinkDomain` (the per-Domain
  "untrust" action now goes through `untrustOwner()`'s owner-keyed revocation loop instead) - the
  latter's sole gateway-side dependent, `client().crossDomainUnlink`, is stranded with it.
- [low] TypeScript dead code with a live consequence, not just unused weight: `src/mcp/bridge/
  helpers.ts : setIsMainOrLeadAgent` has zero callers anywhere in `src/`, and it is the ONLY thing
  that could ever move `isMainOrLeadAgent` off its `null` default - so the `isMainOrLeadAgent !==
  null` branch in `connectToRouter`'s message handler (an auto-reply path for a handshake) is
  permanently unreachable; every handshake always falls through to "let the LLM decide via channel
  notification" instead. Ambiguous whether this is an intentionally-abandoned code path (fine, in
  which case the dead setter and branch should just be deleted) or a silently-broken auto-reply
  feature nobody noticed stopped firing - flagging rather than guessing which.
- [low] `src/mcp/bridge/helpers.ts : bridgeAgentType` and `src/mcp/devcontainer/helpers.ts :
  execInContainer` - zero-caller exports, likely leftover infra from before the host-daemon split
  (container command execution now goes through `hostOpRunner`/`tmuxCore.ts`'s tmux-based path per
  this repo's own CLAUDE.md).
- [info] `skills/crosstalk/SKILL.md` still documents a "CLI agents (cursor, copilot, codex)"
  receive path (`crosstalk_reply()`, prompt-injection dispatch) that CLAUDE.md's Architecture
  section says was retired with the host split; the `crosstalk_reply` tool no longer exists in
  `src/mcp/bridge/registerBridgeTools.ts`. Doc/code staleness, not a rename-residue artifact -
  the skill doc needs the same retirement note CLAUDE.md already has.
- [info] Dedicated sweep for the historical Team-to-Gateway rename class of mistake (the one
  CLAUDE.md documents slipping past grep + the full TS suite twice, breaking Android only after
  merge) found zero residue anywhere in the current tree - git-archaeology-verified against the
  actual prior incidents (`arbiter`/`gatewayes`/the stale admission vector), all three confirmed
  still fixed, no recurrence. Logged for the audit trail, not an open item.
- [high, pre-existing, NOT introduced by Phase 5] `src/shared/federation-protocol.ts :
  FederatedOpSchema` (`send` variant) / `src/gateway/routes.ts : mirrorPeer` - `send.from` is an
  unauthenticated free string (`z.string().min(1).max(320)`, no grammar, no binding to the
  cryptographically-verified `srcDomainId`/`srcGateway`). A federated inbound send's `mirrorPeer`
  call uses this wire `from` verbatim as the mirrored entry's sender - reachable not just
  same-Domain but by an admitted CROSS-Domain friend whose target session has been explicitly
  shared (a materially lower bar than `console_push`'s blanket same-Domain-only rule). Net effect:
  a same-Domain or shared-cross-Domain peer can make the receiving owner's own console mailbox and
  live agent attribute an inbound message to any arbitrary string up to 320 chars, not the verified
  sender - misattribution within an otherwise-legitimate delivery, not a routing bypass (the
  entry's thread/session_id is still server-derived from the real destination). Predates this
  phase (the `send` op and its schema are Phase 2-era); surfaced by this phase's red-team sweep
  while auditing `console_push`'s own trust boundary for comparison. Needs its own dedicated look
  at `send`'s sender-identity model, not a Phase 5 patch.
- [medium, Phase 5-specific] `src/gateway/routes.ts : consolePush` - `entry.session_id`/`from`/
  `to` are free strings with zero correlation check against any real pending job, session-store
  record, or registry entry; the landing side just appends whatever arrived. Same-Domain gateways
  are already fully trusted (can relay real sends/replies/wakes), but this is a sharper capability
  than "can add new content": a compromised sibling Gateway can set `entry.session_id` to collide
  with an EXISTING, already-trusted thread and craft `from`/`to`/`body` to look like a fabricated
  continuation of that specific conversation (impersonating a devcontainer agent or peer the owner
  already trusts), with no UI cue distinguishing it from a genuine relay. Bounded by the
  already-accepted same-Domain trust model (requires a sibling Gateway compromise), so not fixed
  here; flagged since a real fix (message-level signing so a recipient can verify authorship
  across a relay) is a materially bigger feature than this phase's scope.
- [high, Phase 5-specific] `src/shared/device-mailbox.ts : DeviceMailbox.evictOneForCapacity` /
  `src/shared/federation-protocol.ts` (`console_push.entry.kind`) - the OOM backstop's
  peer-priority eviction (prefers the oldest `"peer"` entry so agent chatter evicts itself before
  real unread mail) trusts a wire-supplied `kind` that a `console_push` sender now controls
  (`"notice"` or `"peer"`, both legal). A same-Domain sibling Gateway (compromised or buggy) can
  flood `console_push` entries stamped `kind: "notice"` - never a peer-priority eviction
  candidate - cheaply enough to trip the entry-count cap alone (10,000), and once genuine `"peer"`
  entries are exhausted the fallback evicts the oldest entry of ANY kind: a real reply the owner is
  waiting on, or a real notice. This defeats the eviction priority's documented purpose using
  nothing but a same-Domain flood; no cross-Domain gate applies within a Domain, and there is no
  independent signal (provenance, rate limit, or an unforgeable "this really came from a verified
  local mirrorPeer/humanNotify call") backing `kind` once it has crossed the wire. Not fixed here -
  a real fix needs a provenance concept `DeviceMailbox` doesn't have today (e.g. tagging a
  relayed-in entry as always evict-first regardless of its claimed `kind`), which is a genuine
  design addition, not a phase-appropriate patch.
- [medium] `src/gateway/routes.ts : fanOutConsolePush` - no caching/coalescing of the `list_gateways`
  roster fetch and no fan-out concurrency cap: a hot loop of local `send`/`respond` traffic (each
  triggering up to 2 `mirrorPeer` calls) or repeated `notify_human` calls (no rate limit on that
  MCP tool at all) each independently re-fetches the roster and re-fires the full fan-out. Per-
  destination retry/backoff is sane and bounded (5 attempts, 2s-30s), so this is a "legitimate but
  unbounded pattern" robustness gap, not a security hole, and the realistic blast radius today is
  modest given the architecture's assumed small/cooperative Domain sizes. Worth hardening (a
  roster TTL-cache, or a debounce on the fan-out trigger) if Domain sizes grow; not urgent now.
- [low-medium] `src/gateway/routes.ts : DeviceMailbox.append`'s dedupeKey/seenKeys dedup only ever
  saw a LOCALLY-minted key before this phase; `console_push` is the first path where a same-Domain
  PEER chooses the dedupeKey and it's trusted verbatim. If a peer Gateway ever reuses/collides a
  dedupeKey across two logically-distinct entries (a caller bug, not a legitimate relay retry -
  which is the intended, correct use of key reuse), the second entry is silently discarded with no
  logging. Requires an already-highly-trusted peer to misbehave; loss is limited to one
  non-load-bearing display entry. Separately: the pre-existing, already-documented gap where an
  outer HTTP-level retry of `send()`/`respond()` re-runs `mirrorPeer` from scratch with a FRESH
  dedupeKey (mirrorPeer's own doc comment already calls this out as unsolved) now has a wider
  blast radius - previously a retry-produced duplicate could only show up twice on the ONE gateway
  that handled the retry; now each of the two `mirrorPeer` calls independently fans out to every
  same-Domain sibling, so the duplicate can appear mesh-wide, on any gateway the console might be
  polling. Root cause is unchanged and out of scope; noting the amplification only.
- [medium, narrow] `src/shared/device-mailbox.ts : DeviceMailboxStore.sweepExpired` racing an
  in-flight `console_push` relay - `sweepExpired` is a pure time-based scan with no concept of "a
  relay is currently targeting this key," while `relayWithRetry` can keep a delivery in flight for
  up to ~10.5 minutes (5 attempts, exponential backoff, 120s tool-call timeout each). If a sibling
  Gateway's copy of the owner mailbox is near its 1-hour idle TTL, an ordinary transient relay
  retry (evie reconnect, pod rollover) can straddle a sweep tick that tears the mailbox down;
  `mailboxStore.ensure(owner)` then lazily mints a fresh, empty box (correct behavior on its own).
  The sharper compound case: if an EARLIER attempt actually landed but its ack back to the origin
  was lost (an ordinary at-least-once RPC gap, exactly what dedupeKey/seenKeys exists to cover),
  and the eviction lands between that silent success and the retry's redelivery, the retry lands
  in a brand-new mailbox instance whose `seenKeys` never saw the key - producing a genuine
  user-visible duplicate display entry with no coordination anywhere to prevent it. Same class of
  issue as the already-logged Android `forget()`-vs-poll-loop race (a real, narrow, uncoordinated
  hazard, cosmetic-only consequence per the "purely additive display, never load-bearing" design,
  not data corruption). Not fixed here.
- [low, extends an already-logged item] `plans/team-collab-sessions.md`'s own earlier finding on
  `RespondBodySchema.status`/Kotlin `MailboxEntry.status` being unconstrained strings (a
  non-standard `"waking"` value silently and permanently dropped client-side) was scoped to
  `kind: "reply"` rows; `"peer"`-kind rows are actually exempt from that specific Android drop
  filter (`!it.isPeer` in the check), a minor correction to that finding's own stated scope.
  `console_push`'s wire schema now lets a same-Domain sibling combine `kind: "notice"` with a
  `status` field for the first time (no first-party local path could produce that combination
  before) - reaching the exact same drop mechanism through a path that didn't previously exist.
  Same severity/scope as the original finding; not a new mechanism, just a new way to reach it.
- [low, pre-existing, noticed in passing] `src/gateway/routes.ts : respond` - two unguarded
  operations one function away from `mirrorPeer`'s own well-documented "must not turn an
  already-succeeded op into a spurious failure" concern: the actual console-reply mailbox append
  (runs AFTER `store.deliver()` has already committed - precisely the "already-delivered primary
  operation" scenario `mirrorPeer`'s comment warns about) and a `senderWs.send()` call, both
  unguarded, unlike the structurally-identical broadcast fallback a few lines later which DOES
  wrap its send in try/catch. `humanNotify`'s own `localAddress(from)` call (now routed through
  `landMailboxEntry` for the append itself, but the `storeKey`/`localAddress` composition above it
  is unchanged) is similarly unguarded and reachable via a misconfigured non-slug `PROJECT_NAME` -
  confirmed byte-identical to pre-Phase-5 code, just relocated. Neither introduced by this phase;
  flagging since they surfaced while auditing the new `console_push`/`humanNotify` error paths for
  comparison.
- [info, cross-references an existing dedicated audit] `humanNotify`'s "agent-only tool" framing
  has no enforcement at the HTTP boundary (`/human/notify` has no token/origin/header check, same
  as every other plain HTTP route) - already documented, dated before this plan, in
  `plans/gateway-auth-surface.md` (an owner-approved, unshipped origin-aware `GATEWAY_TOKEN` gate
  already covers this). This phase's fan-out measurably widens REACH of that pre-existing gap in a
  multi-gateway Domain (a forged notice, previously landing only wherever it was posted and maybe
  never seen, now reaches every sibling Gateway including wherever the console actually polls) -
  not a new capability, not a new bypass, just wider delivery of an already-tracked hole. Nothing
  to add here beyond noting this phase doesn't change that picture either way.
- [info] No cross-Gateway relayed op of ANY kind (`send`, `respond`/`response_push`, `wake`, or the
  new `console_push`) has a durable, content-keyed delivery record - `relayWithRetry` logs nothing
  on success and only a generic failure line (gateway id + error, no `dedupeKey`/`session_id`) on
  total exhaustion. A compliance reviewer asking "show every gateway that ever held a copy of X"
  gets no answer from any of these paths today; the only trace is an entry's live presence in a
  bounded, evictable `DeviceMailboxStore`. System-wide and pre-existing (not introduced or
  regressed by this phase, which just adds one more relay kind sharing the identical non-pattern).
  If ever picked up, scope it at the federation-transport level (one ledger for all relayed op
  kinds), not as a `console_push`-only fix.
- [framework-first, logged as a future candidate, not done now] `src/gateway/routes.ts` is now
  ~1290 lines, the largest file in `src/gateway/`. `mirrorPeer`/`consolePush`/`fanOutConsolePush`/
  `humanNotify` (console mailbox delivery) pass the ownership test as a genuinely separable
  sub-concern from core session routing (`send`/`respond`/`teams`/`discover` would exist unchanged
  for a hypothetical console-less application; `mailboxStore`/`ownerId` are referenced nowhere else
  in the file). Worth extracting into its own module (natural home: `src/gateway/console/`,
  alongside `consoleHandler.ts`/`consolePeer.ts`) taking `mailboxStore`/`ownerId`/`evieClient`/
  `localGatewayId`/`resolvesLocalGateway`/`relayWithRetry` as explicit injected deps, matching the
  precedent `gatewayRelay.ts`'s narrow `FederationRoutes` dependency already sets. Not worth doing
  as a rider on this phase's own commit (existing tests already cover the behavior thoroughly
  through its real call sites; bolting a structural extraction onto a still-fresh feature diff
  doubles the verification surface for no correctness gain). If picked up, bundle three things in
  one dedicated pass rather than just the mailbox slice alone: (1) hoist `localAddress`/
  `tryLocalAddress`/`consoleSelfAddress` first (pure functions of `localDomain`/`localGatewayId`
  only, shared by the routing side too, so lifting them first makes the real extraction cleaner);
  (2) the console-mailbox-delivery extraction itself; (3) treat `send()` (262 lines) and
  `respond()` (233 lines) as a separate, likely higher-priority target in the same file, since they
  are the actual majority of its bulk and the mailbox extraction alone won't move that needle.
