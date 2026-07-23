# Cross-Domain Presence (Phase 2 item 5 of the now-closed versioned-state-planes plan)

## Questionaire

**1. What's actually the goal here?**

Context: a linked friend's sessions are pulled via a plain HTTP request (`discover()`) that runs
synchronously before the console's own message poll every 30s - a hung (not cleanly offline)
linked gateway can stall the console's OWN message delivery for up to a minute. Separately, there
is no freshness indicator at all: a peer's session either shows or silently vanishes/degrades to a
generic "ended" look, indistinguishable from something actually forgotten.

- A) Fix the reliability bug narrowly - decouple discovery from the poll loop.
- **B) Build the real live-updating version** - matches what's already fully designed (never
  built) for same-Domain multi-gateway presence: freshness indicators, fast push updates. Also
  structurally fixes the blocking bug, since a versioned push replaces the synchronous pull.
- C) Something else.

**Answer: B.** ("B")

**2. Build cross-Domain presence on its own, or bundle it with the parked same-Domain design?**

Cross-Domain crosses a real trust boundary (explicit per-session sharing, Private/Everyone-I-
trust/Specific-people, enforced at the source gateway) that the same-Domain design never had to
consider at all.

- **A) Build cross-Domain as its own separate thing now** - reuses the existing versioned-plane
  framework (one-call registration, hash-gated updates), but scoped to just this. The parked
  same-Domain design stays parked, picked up independently.
- B) Bundle both into one unified build now.
- C) Something else.

**Answer: A.** ("A. After we ship, we talk about that next.") - same-Domain federation exchange
is confirmed still wanted, just sequenced after this ships, not bundled in.

**3. One plane per linked friend, or one shared plane for all of them?**

- **A) One plane per linked Domain** - a wire-assembly bug for one friend's data can never leak
  into what you see about another; the framework already supports this lazy-registration pattern.
- B) One shared plane covering every linked Domain's sessions at once - simpler, but a mistake in
  one place risks touching everyone's data, and any single friend's update wakes every console
  watching any friend.

**Answer: A.**

**4. Keep the flattened board, or split cross-Domain friends into their own view?**

Context: `SessionsScreen` currently shows every session from every gateway, yours and linked
friends' alike, on one flattened board grouped by `(domainId, gatewayId)` headers. Dead code
already exists for a per-Domain grouped view (`peerSessions(domainId)`), never wired up.

- A) Keep the single flattened board, just add freshness indicators to the existing headers.
- **B) Give linked friends' sessions their own separate section**, distinct from your own
  Domain's board.
- C) Something else.

**Answer: B.** ("B. keep it consistent to how \"Sakura\" shows up in ours. Would see a drop-down
for \"Kashia\" after all of my own.") - a friend's section mirrors the exact same header/dropdown
visual pattern already used for the user's own gateway groupings, listed after the user's own.

## Audit round 1

First draft audited across 8 dimensions (wire codegen, trust boundary, PlaneRegistry fit,
cold-start, linked-peers lifecycle, failure/retry, fan-out cost, UI dead-code) via independently
verified agents. All 14 raised concerns survived verification, including one blocker. Resolutions
below; the revised `## Plan` reflects them.

- **Blocker, trust boundary:** the draft claimed a landing-side "share-gate mirroring
  `gateCrossDomainTarget`" - impossible as stated, since a push's landing side never owns the
  sender's share state to check against (that gate only works for a PULL, where the side answering
  owns the data). Resolved by dropping the claimed content gate and reasoning explicitly about
  `presence_push`'s actual threat model instead (see "Trust boundary" below) - meaningfully
  different from `console_push`'s, which is why identity-only trust is the right call here.
- **Major, trigger set:** `presence.markDirty()`'s call sites cover session/WS/wake state only,
  never share grants/revocations or link/unlink - a revoked share would stay visible until
  unrelated churn. Fixed by wiring the missing triggers directly (below).
- **Major, cold-start:** a change-gated push can never fire for content already present at plane-
  registration time (the hash baseline absorbs it silently). Fixed with an explicit first-
  computation exception, mirroring `changedSince()`'s own "!have => changed" rule on the
  consumption side.
- **Major, no PlaneRegistry hook:** there is no "fire a callback when a plane's hash actually
  changed" mechanism in the framework today. Needed as real, scoped plumbing (a new optional
  `onBump` at `registerPlane` time), not glossed over as something already there.
- **Major, no teardown:** `PlaneRegistry` has no unregister path; a per-friend plane would outlive
  a removed link forever, growing the durable-state file without bound. Needs a real
  `unregisterPlane` addition, wired into the existing `unlinkDomain`/`untrustOwner` cleanup.
- **Major x2, retry/cadence:** `relayWithRetry` doesn't thread a destination Domain id (a
  pre-existing gap `discover()` and `respond()` already have today - out of scope to fix
  everywhere, but this plan's own new call sites must not copy it); no cadence was ever given for
  the backstop pull, and a fully-retried push had no compensating recovery. Resolved by leaning on
  the backstop instead of chasing push retries, with a concrete cadence and a freshness-timestamp
  tie-in (below).
- **Major, no coalescing:** unlike this draft, the parked same-Domain sibling design
  (`plans/cross-gateway-presence-exchange.md`) already fully specifies per-destination outbound
  coalescing. Reused verbatim rather than re-invented.
- **Major x3, Android:** reviving `peerSessions(domainId)` as-is would read from the same racy,
  wholesale-replaced field causing the ORIGINAL staleness bug this feature exists to fix; the
  existing flattened board would double-render every friend once the new section also exists; no
  freshness field exists anywhere between the wire and `GatewayHeader`. All three need real (small)
  new surface, not just a wire-up.
- **Minor x3:** the wire shape's cited precedent was wrong (a real one exists, just a different
  one - see "Wire shape" below); the "enumerate the live roster fresh" fix scoped too narrowly in
  the first draft (needed everywhere the linked-Domain set is walked, not just `waitForBump`'s
  `scope`); no cap on linked-Domain fan-out (added below, sized like the `read-anchors` precedent,
  though the threat model differs since linking is owner-gated, not attacker-forceable).

### Trust boundary: why `presence_push` doesn't need `console_push`'s cross-Domain lockout

`console_push`'s hard same-Domain-only rule exists because its payload can claim ARBITRARY
`from`/`to` attribution (a mirrored exchange between two other parties) - a malicious cross-Domain
sender could fabricate a fake exchange appearing to involve people it has no relationship to,
displayed in the victim's own chat history. `presence_push` carries no such attribution: every
entry it can possibly carry describes the cryptographically-verified sender's OWN sessions only -
the same content that Domain's `list_teams` answer already carries today, trusted identically, no
independent re-verification. There is no third party to impersonate, and never message content
(per Q1's own scoping - presence/freshness only). So identity verification - already automatic,
free, and universal for every `gateway_relay` frame via the sealer - is the correct and sufficient
gate for AUTHENTICITY, not a gap needing a bespoke content check.

That said, `TeamInfoSchema`'s `sessionLabel`/`description` fields ARE free-form, sender-controlled
text with no length bound today - a compromised or careless linked Domain could still fill them
with misleading text while truthfully "describing its own session." This doesn't reopen the
authenticity question above (the same unbounded text already flows through the shipped, unvalidated
pull path today, rendered as inert single-line plain text with no links/markup on both own- and
peer-Domain rows alike), but a landed push is stickier than a pull result - it's written into a
plane and re-served on every poll until superseded, not just shown once. So this needs real size
hygiene, not just an authenticity gate:

- `presence_push` is its own new, narrow, DELIBERATE case in the relay dispatch switch - never a
  silent fallthrough default-allow.
- The handler always uses the sealer-verified `srcDomainId` as the stored entry's `domainId` and
  ignores/rejects any conflicting value the payload itself might carry - never trust a self-
  reported domain id over the cryptographically verified one (closes a confused-deputy mistake).
- Each push is size-capped: a bound on session-array length, AND a per-field length cap on the new
  `CrossDomainPresenceEntry` schema's free-text session fields - an array-length cap alone does not
  bound total payload size when the per-entry strings themselves are unbounded.

## Audit round 2

Focused re-audit of just the reworked mechanism (6 dimensions: PlaneRegistry extension safety,
trigger completeness/cost, cold-start precision, trust-boundary adversarial re-check, reconciliation
decoupling, Android integration completeness). 8 of 12 raised concerns survived verification (4
refuted) - no blockers this round, a healthier ratio than round 1's 14-for-14, but still real
correctness gaps. Resolutions below; the `## Plan` reflects them.

- **Major, plane naming collision:** the Source side's internal change-detector plane and the
  Consumer side's landed plane were both named `presence:crossdomain:<domainId>` - the same name,
  same registry, same process, for two planes holding completely different content. For the common
  case (a mutual friend you both share with and share back to), whichever registers second either
  throws (crashing the gateway via the process-wide `uncaughtException` handler) or silently
  no-ops and permanently misbinds one side's data. Fixed by giving the internal one its own prefix.
- **Major, `onChange` can't identify "the specifically affected Domain(s)":** `CrossDomainPeers`'s
  `onChange` is argument-less by construction - it cannot literally scope to one Domain the way the
  plan claimed. Also surfaced the real scenario this was hiding: an `everyone_trusted` share can
  exist before any Domain is linked, so a Domain can become linked-and-shared at the LINK instant
  (not any `share()` call) - a grant-on-link case the plan's "specifically affected" framing never
  walked through. Fixed by having the `onChange` path fall back to a full sweep of the current
  linked-and-shared roster (still bounded by the existing cap) instead of claiming precision it
  cannot deliver - which also correctly covers grant-on-link for free.
- **Major, no overlap guard on the backstop cadence:** a 10s tick against a peer riding out the
  full 120s relay timeout could pile up ~12 concurrent fan-out attempts before the first tick even
  resolves - reproducing the original hung-peer problem at the mesh level instead of the console
  level. Fixed by adopting the same in-flight-guard pattern already used elsewhere in this codebase
  for exactly this hazard (`vibeCheck.ts`'s `peekInFlight`, `presence.ts`'s `wakeInFlight`).
- **Major, Android field's write/removal semantics were wrong:** "additively merged, mirroring
  `linkedPeerOwners`" doesn't hold up - `linkedPeerOwners` is actually a wholesale replace with ONE
  writer; the new field has TWO writers (a single-domain push landing, a possibly-multi-domain
  backstop pull) and copying `linkedPeerOwners`'s real code would let one friend's push wipe every
  other cached friend. Fixed by specifying a genuine per-domainId keyed upsert, with an explicit
  prune-on-unlink step (since a keyed upsert, unlike a wholesale replace, does not self-clean).
- **Major, dropdown roster source unspecified:** nothing said which domain ids actually get a
  section. A naive implementation (grouping over the new session-content field, mirroring the old
  flattened board's own approach) would hide a linked-but-currently-empty friend - contradicting
  Q4's own answer, which wants to see a friend's dropdown regardless of shared content. Fixed by
  explicitly sourcing the section roster from the existing, already-tested `linkedDomains()`.
- **Minor, `unregisterPlane` didn't wake an in-flight waiter:** the framework addition from round 1
  only removes a plane; it never settles a `waitForBump` caller already waiting on that name, so a
  removal with no coincidentally co-occurring bump elsewhere could leave a poll hanging up to the
  45s hold cap. Fixed by having `unregisterPlane` settle any waiter referencing the removed name.
- **Minor, trust-boundary payload wording overclaimed:** `TeamInfoSchema`'s `sessionLabel`/
  `description` are free-form, sender-controlled text with no length bound, so "no content richer
  than connectivity/freshness signals" overstated what a push can actually carry, and "size-capped
  (session-array length)" doesn't bound total payload size given unbounded per-entry strings (does
  not overturn the identity-only trust conclusion - the same free text already flows unvalidated
  through the shipped pull path today - but the wording and the safeguard both needed a fix).

## Plan

Confirmed via research: cross-Domain `discover()` already reuses the exact same evie-mediated
sealed transport as same-Domain federation (`sealTargetFor` -> `relayToGateway` -> `gateway_relay`,
resolving a `SealedBodyV2` for a cross-Domain target via `CrossDomainPeers`, distinct from the
same-Domain `Allowlist`). There is no separate cross-Domain wire mechanism to build - only a new
op kind riding the existing one, with its own retry call sites correctly threading `dstDomain`
through `relayToGateway`'s existing (but so far unused-for-this) third parameter.

Implementation is split into three phases: framework + source-side push mechanism (gateway TS),
consumer-side plane + wire shape + reconciliation (gateway TS + Kotlin codegen), then Android UI.
Each phase builds on the last - the consumer-side wire shape needs the source side's actual push
content to codegen against, and the Android UI needs that wire shape landing in real poll
responses.

## Phase 1: PlaneRegistry framework + source-side push mechanism

**PlaneRegistry gains two small, general capabilities** (not cross-Domain-specific - any future
per-relationship plane benefits):
- An optional `onBump(version)` callback at `registerPlane` time, invoked synchronously right after
  a `recompute()` call actually bumps the counter (content hash changed). This is the missing hook
  the source side's "push on change" design needs; nothing today can observe a bump except a
  `waitForBump` poller.
- `unregisterPlane(name)`, dropping a plane from the registry (and, on the next persist tick, from
  the durable-state file). Needed for any plane whose lifetime is shorter than the process's. Also
  settles (wakes, as removed) any in-flight `waitForBump` waiter whose presented/scope map
  references that name directly - a caller must not have to rely on some other plane's coincidental
  co-occurring bump to notify a waiter that the plane it was tracking is gone.

**Source side** (this gateway, computing what a linked friend sees of it):
- One internal change-detector plane per linked-and-shared-to Domain X, named
  `presence:crossdomain-source:<domainId>` - a DISTINCT prefix from the consumer-side plane below
  (`presence:crossdomain:<domainId>`), since the two hold unrelated content (this one is a live
  computed derivation; the consumer-side one is a stored landing zone for a friend's push) and
  would otherwise collide under the same registry, for the same Domain id, in the same process, for
  the common case of a mutual friend. Registered (not lazily on first touch, but explicitly)
  whenever X becomes linked-and-shared for the first time. Its snapshot is "what does Domain X
  currently see of my sessions" - the exact filter `list_teams`'s `shareState.sharesFor(srcDomainId)`
  already computes for pull, called fresh each time, never cached against a hand-maintained "last
  known" copy.
- Trigger set for the recompute pass, covering BOTH ways a Domain's view can change:
  1. The same local presence-mutation call sites that already call `presence.markDirty()`
     (session/WS/wake/working-state changes) - but instead of firing one flat `markDirty()`, the
     call now recomputes for every CURRENTLY linked-and-shared Domain (enumerated fresh from
     `CrossDomainPeers`/`CrossDomainShareState` each time, never a cached roster - the same "no
     stale membership list" requirement the consumer side's `scope` needs, generalized to every
     call site that walks the linked-Domain set, not just `waitForBump`).
  2. New hooks on `CrossDomainShareState.share()`/`.unshare()`/`.dropDomain()` (each already takes
     the affected domain id as its own argument, so these recompute exactly the domain(s) named)
     and on `CrossDomainPeers`'s existing `onChange` (today wired only to `linked-peers`'s
     `markDirty`; argument-less by construction, so it CANNOT identify which Domain changed - it
     instead re-sweeps every currently linked-and-shared Domain, same as trigger 1, bounded by the
     same cap below). This sweep is what makes a revocation, an unlink, or a fresh link retract or
     grant promptly instead of waiting on unrelated churn - including the grant-on-link case where
     a Domain becomes linked-and-shared purely by being linked, because an `everyone_trusted` share
     already existed before the link (a real, owner-reachable ordering, not just the revoke/unlink
     direction).
- Cold start: a Domain's very first successful snapshot computation (at the moment its
  change-detector plane is registered - i.e. exactly the "just linked and shared for the first
  time" moment from trigger 2 above) always pushes, unconditionally, bypassing the hash-bump gate -
  mirroring `changedSince()`'s own "!have => changed" rule on the consumer side. Every push after
  that first one goes through `onBump` as normal.
- On a bump (first-ever or hash-changed), push a `presence_push` FederatedOp - size-capped
  (session-array length AND a per-field length cap on free-text session fields like `sessionLabel`/
  `description`, since an array-length cap alone does not bound total payload size), per-
  destination outbound-coalesced (reusing `cross-gateway-presence-exchange.md`'s already-specified
  "at most one in-flight attempt per destination; a new push while one is in-flight REPLACES its
  payload rather than queuing" design verbatim) - to Domain X's gateway, via `relayToGateway`'s
  3-argument form (`dstGateway`, op, `dstDomain`) so an ambiguous bare-gateway-id collision across
  two different linked Domains can never misroute it.
- Landing side: verifies the sealed frame (automatic, universal, already true for every
  `gateway_relay` frame), then only ever appends/replaces the local
  `presence:crossdomain:<srcDomainId>` plane's content (using the VERIFIED `srcDomainId`, never a
  payload-supplied one) and calls `markDirty()` - never re-fans-out (the same origin-only invariant
  `console_push`'s landing side already follows). See "Trust boundary" above for why no additional
  content gate belongs here.
- Teardown: `unlinkDomain`/`untrustOwner` (the existing itemized cleanup in `gateway/index.ts`)
  gain a new step calling `unregisterPlane` on that Domain's `presence:crossdomain-source:<domainId>`
  plane, alongside the existing peer/share/job cleanup they already do.

## Phase 2: Consumer-side plane, wire shape, and reconciliation

**Consumer side** (this gateway, showing linked friends to its own console):
- New plane per linked-and-sharing-back Domain: `presence:crossdomain:<friendDomainId>`, lazily
  registered the same way `read-anchors:${ownerId}` is - but ALSO torn down via the same
  `unregisterPlane` teardown path above when that Domain is unlinked, unlike `read-anchors` (owners
  have no revocation concept; linked Domains do). Content = the latest snapshot landed by that
  friend's push.
- Wire shape: an ARRAY of `{domainId, version, sessions}` entries. NOT a mirror of presence's
  existing shape (presence is actually two separate flat parallel arrays - `presence`/
  `presenceVersions` - never one nested `{source, version, sessions}` entry); the real precedent is
  `MailboxEntrySchema`'s own array-of-named-entry-with-a-nested-array-field shape, already proven
  through codegen. Two NEW named schemas are needed (a `CrossDomainPresenceEntry` and its `version`
  sub-object, each with its own `.meta({id})`) - an inline object here fails codegen loudly, exactly
  as `CrossDomainPeerEntrySchema`'s own comment already documents from the `linkedPeers` case. The
  poll response's `settled` priority chain (mailbox > presence > linkedPeers > readAnchors > domain
  > timeout) gains a `crossDomainPresence` entry. The array is built (and `waitForBump`'s `scope`
  is computed) from the SAME freshly-enumerated live roster the source side now uses - never from
  "whatever `PlaneRegistry` happens to have registered," since the registry itself has no
  enumerate-by-prefix capability and a stale roster would show or wait on a removed friend.
- Each entry carries a last-pushed timestamp, refreshed on EITHER a landed push OR a successful
  backstop pull (see Reconciliation) - so a friend's dropdown never keeps showing stale/greyed
  after the backstop has, in fact, just refreshed it. Staleness is a client-side computed display
  (an "unknown"/greyed state past some threshold) against that timestamp, never a gateway-side
  boolean.

**Reconciliation:**
- `discover()`'s existing pull stays as the backstop, but runs on its own independent cadence
  (proposed: 10s, matching the gateway-owned timer already specified for the parked same-Domain
  sibling design, rather than inventing a new number) fully decoupled from the console's own
  message poll loop - this is what resolves the original blocking bug (a hung linked peer can no
  longer stall the console's own mailbox poll).
- The tick guards each destination peer with an in-flight set (mirroring `vibeCheck.ts`'s
  `peekInFlight` / `presence.ts`'s `wakeInFlight` pattern already used for this exact hazard
  elsewhere) - a peer still mid-attempt from a prior tick is skipped, not piled onto. Without this,
  a persistently hung peer (the scenario motivating this whole feature) would accumulate up to
  ~12 overlapping relay attempts within one 120s timeout window at a 10s cadence, reproducing the
  original problem at the mesh level instead of fixing it.
- A successful backstop pull refreshes the same per-entry timestamp a landed push does (see
  Consumer side) - the backstop is a full substitute for a missed push, not a second-class signal.
- `presence_push` itself does not get its own long-running retry chain (the existing
  `relayWithRetry` gives up after ~10 minutes with nothing to catch that): a failed/exhausted push
  is simply caught by the next backstop cycle a few seconds later, so the feature leans on ONE
  recovery mechanism instead of two competing ones.
- Cap: linked-and-shared Domain count feeding the source-side recompute pass gets a bound sized
  like `readAnchors.ts`'s `MAX_TEAMS_PER_OWNER` (500) - primarily a performance/sanity bound against
  an organically large friend list turning every local presence mutation into unbounded synchronous
  work, since (unlike `report_read`'s free-form input) linking is owner-gated and not itself
  attacker-forceable.

## Phase 3: Android UI

Android gets three concrete new pieces, not just a wire-up of the existing dead code:
1. `peerSessions(domainId)` gets a dedicated backing field, keyed by domain id as a genuine
   per-domain UPSERT - NOT a wholesale replace like `linkedPeerOwners`'s actual code (that field
   has exactly one writer with an always-complete payload; this new field has TWO writers - a
   landed push carrying only ONE domain's data, and a backstop pull that can refresh several at
   once - so replacing the whole map on a single push would wipe every other cached friend).
   Pruned against the existing, already-correct, promptly-updated `linkedDomains()` roster
   whenever it changes, since a keyed upsert (unlike a wholesale replace) does not self-clean an
   unlinked/untrusted friend's last-known entry.
2. The existing flattened board's per-`(domainId, gatewayId)` grouping loop excludes cross-Domain
   peer groups once the new dedicated section ships, so nothing double-renders.
3. A freshness field travels end to end: the wire timestamp from Phase 2, a new field on the
   client-side session model for a cross-Domain entry, and a 3-state (fresh / stale / unknown)
   variant of `GatewayHeader` (or a values-only fork) - it only takes a binary `online` today.
4. New dropdown section, one per domain id from the EXISTING `linkedDomains()`/
   `mergeLinkedDomains()` roster - never derived from the new session-content field's own keys,
   which would hide a friend before their first session or push arrives (a freshly-linked friend
   with nothing shared back yet, exactly the "Kashia" example from Q4) and contradict Q4's own
   answer, which wants to see a friend's dropdown regardless of shared content.
   `linkedDomains()` already handles this correctly and has existing test coverage for it.

**Deferred (per Q2):** same-Domain multi-Gateway presence exchange
(`plans/cross-gateway-presence-exchange.md`) stays parked; revisit after this ships. Its already-
designed outbound-coalescing and anti-entropy-timer mechanisms are reused above rather than
re-invented, so picking it up later should mostly be sharing code, not resolving new conflicts.

## Phase 1 implementation - align & red-team findings

Phase 1 code audited twice after implementation: a plan-alignment pass (2 laps, 4 confirmed
findings - a naming collision between the source/consumer planes, a redundant O(N^2)
re-enumeration, a premature push racing teardown, and a coalescer catch/then asymmetry) and an
adversarial red-team pass (1 lap, 9 confirmed findings). All were fixed except one, deferred below.
Full finding text lives in the align/red-team Workflow transcripts; this is the durable summary.

Red-team findings and their fixes:
- **Blocker:** `presenceForDomain` used the throwing `localAddress` instead of `tryLocalAddress` -
  an ordinary devcontainer directory name that isn't a valid slug (uppercase, underscore, space,
  >64 chars) crashed the entire gateway process via the process-wide `uncaughtException` handler.
  Fixed: skip the row via `tryLocalAddress` instead.
- **Major, no inbound rate limit:** nothing bounded how often a hostile-or-buggy admitted peer
  could force a full `stableHash` recompute by resending `presence_push` (a fresh `seal()` mints a
  new nonce every time, so the replay guard can't reject a resend). Fixed: `MIN_LAND_INTERVAL_MS`
  (1s) floor per Domain in `CrossDomainPresenceConsumer.land()`.
- **Major, cap not enforced on the landing side:** `land()` discarded `ensureRegistered`'s
  cap-refusal return value and wrote state anyway - a permanent leak with no teardown path once a
  Domain landed past the 500-cap. Fixed: `ensureRegistered` now returns whether the Domain is
  safely trackable (already-registered OR freshly registered), and `land()` returns early if not.
- **Major, uncached O(sessions) scan per Domain:** every local presence mutation recomputed
  `presence.snapshot()` fresh once per linked-and-shared Domain (domain-independent work redone up
  to 500x per mutation). Fixed: `presenceForDomain` caches the underlying snapshot for the
  remainder of the current synchronous tick only (cleared on the next microtask), so one mutation's
  cascade pays for one computation, not one per Domain, while any unrelated later caller still gets
  a fresh one.
- **Major, prototype pollution:** `CrossDomainPresenceConsumer.state` was a plain object keyed by
  the peer's self-reported `srcDomainId` - a domainId of `"__proto__"` would hijack the object's
  prototype chain via the inherited setter. Fixed: `state` is a `Map`, immune to this class of key.
- **Minor, unsanitized free text:** `sessionLabel`/`description` were length-capped but not
  charset-filtered, unlike the identical field names/caps already sanitized in `session-store.ts`
  for the same risk. Fixed: `land()` now runs both fields through `sanitizeLabel`/
  `sanitizeDescription` before storing.
- **Minor, teardown didn't reach the pusher's pending state:** a fast unlink-then-relink's
  cold-start push could silently stall behind a stale in-flight/retrying attempt for up to ~120s.
  Fixed: `createCoalescedPresencePusher` now exposes `cancel(domainId)`, called from `teardown()`.

**Deferred, not fixed - pre-existing, out-of-Phase-1-scope:** two cryptographically distinct linked
peers can register with the SAME self-reported `friendDomainId` (`CrossDomainPeers.add()` is only
idempotent on the composite `(friendDomainId, friendGatewayId)` pair; the cross-Domain handshake's
`domainId` field is never checked for uniqueness against other already-linked peers - `z.string()`,
no registry cross-check). Phase 1 inherits this by keying its new plane/state purely off that same
untrustworthy label - two colliding peers' presence data would commingle in one
`presence:crossdomain:<domainId>` entry. The root cause lives in `crossDomainHandshake.ts`/
`crossDomainPeers.ts`, neither touched by this plan; a real fix means enforcing domainId uniqueness
at link time (or keying presence state by a stronger identity than the bare label), which is a
same-Domain/cross-Domain trust-model change bigger than this plan's own scope. Requires an
already-completed, human-verified SAS ceremony to reach - not casually triggerable. Tracked here
rather than fixed now; revisit if/when the cross-Domain trust model itself is next touched.

## Phase 1 implementation - red-team lap 2 (re-auditing the red-team fixes themselves)

A focused second red-team pass, targeting only the code the first lap's fixes touched (the rate
limiter, the cap-refusal fix, the same-tick cache, the `Map` conversion, the sanitizer, and
`cancel`/`teardown` wiring) - mirroring the align pass's own 2-lap precedent, since a fix can
introduce its own new bug. All 9 raised findings were confirmed (0 refuted); all 9 fixed.

- **Major, rate limiter could permanently discard a legitimate update:** `land()`'s rate limit
  DROPPED a call arriving inside the window outright, with `gatewayRelay.ts` reporting `{ok:true}`
  regardless and no backstop pull wired yet (Phase 2). A legitimate sender's own source side fires
  on every local mutation undebounced, so two genuine changes within 1s meant the second (more
  current) one was lost with no recovery path - not just "a few seconds stale" but potentially
  permanent. Fixed: `land()` now coalesces the latest payload behind a per-Domain timer
  (`schedulePendingLand`/`applyLand`) and applies it once the window elapses, mirroring the outbound
  side's own `CoalescedPusher` - bounds cost without ever losing content.
- **Major, teardown silently skipped state restored from a prior process:** `restore()` populated
  `state` directly but never `registered` (only a live `land()` call did that), so `teardown()`'s
  `if (registered.delete(domainId))`-gated cleanup was a no-op for a Domain that had been restored
  from disk but not yet re-landed in this process - `unlinkDomain`/`untrustOwner` on such a Domain
  left its stale session data in `state` forever, re-persisted every tick. The same root cause let
  the 500-cap be exceeded across a restart (`registered.size` resets to 0 while `state` may already
  hold up to 500 entries). Fixed two ways: `restore()` now eagerly re-registers every restored
  Domain's plane via `ensureRegistered` (so `registered`/`state` never diverge after a restart), and
  `teardown()`'s cleanup runs unconditionally rather than gated on `registered.delete`'s return
  value.
- **Major, the same-tick presence cache could swallow a legitimate corrective push:** two genuinely
  separate local mutations landing in the SAME synchronous tick (e.g. a reconnect's remembered-lead
  fast path, which calls `markDirty()` twice before either await) each triggered their own
  `recomputeAll()` - the second one compared against the FIRST one's already-cached (and possibly
  transient/intermediate) snapshot instead of the true current state, concluded nothing changed, and
  skipped the corrective push. A session coming back online after a reconnect could get stuck
  showing offline to every linked peer until an unrelated mutation or the 60s tripwire self-healed
  it. Fixed: a new `invalidatePresenceSnapshotCache`/`invalidatePresenceCache` hook, called once at
  the top of every `recomputeDomain`/`recomputeAll` entry, forces a fresh read per top-level call
  while still sharing one computation across that call's own per-Domain loop.
- **Major, `cancel()` broke the coalescer's single-flight invariant:** `cancel()` did a bare
  `pending.delete`, so a fast unlink-then-relink (cancel, then an immediate fresh push before the
  stale in-flight attempt settled) left the stale attempt's own `.then()` unable to distinguish
  "cancelled out from under me" from "mutated in place" - it wrongly re-dispatched a second,
  redundant, concurrent send of whatever the fresh push already sent. Fixed: each pending entry now
  carries a generation token; a stale attempt checks the token, not just payload identity, before
  concluding it should resend.
- **Minor, `lastLandedAt` recorded before the cap check:** a permanently cap-refused Domain still
  grew the rate-limit tracker forever (no teardown path ever reaches an unlinked-because-never-truly-
  linked domainId). Fixed: `applyLand` now sets `lastLandedAt` only after a successful
  `ensureRegistered`.
- **Minor, `team`/`gatewayId` unsanitized:** only `sessionLabel`/`description` were charset-filtered;
  a peer's landed `team`/`gatewayId` (required, non-empty fields) reached durable state and would
  reach the console verbatim once Phase 2/3 ship. Fixed: both now run through a
  strip-with-fallback sanitizer (`sanitizeLandedIdentifier`, wrapping `sanitizeDescription` - the
  reject-outright `sanitizeLabel` is wrong for a field that can never be empty).
- **Minor x2, test-coverage gaps with no implementation bug:** the sanitize test only ever landed
  one session per call (never proved every array element gets sanitized), and no test exercised
  `restore()` with a `"__proto__"`-keyed payload (only `land()`'s write side was proven safe - the
  read side happens to be safe today only because zod's `z.record` parser skips a literal
  `"__proto__"` key, unpinned by any test). Both closed with dedicated regression tests; no code
  change needed for either.
