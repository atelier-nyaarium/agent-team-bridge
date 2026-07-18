# Cross-Gateway Presence Exchange (Phase 1 item 6, found never built)

Parked here to refine later, per user direction (2026-07-18): "write that concern and finding
to a new plan that will refine after we finish." Do not start a questionaire or redesign pass on
this until the user asks to pick it up.

## Finding

`plans/versioned-state-planes.md`'s Phase 1 committed to a gateway-owned anti-entropy timer for
VERSIONED CROSS-GATEWAY presence exchange (item 6, refined across three audit laps and its own
dedicated two-gateway/three-gateway Verify mandate) plus the wire field it feeds (item 7's
`presenceFresh`). Phase 2's align-fan-out audit (an 11-dimension review with adversarial
verification on every claim, run against the actual shipped code rather than the plan's own
prose) found it was never implemented at all - not partially, not stubbed, never started:

- `grep` across `src/gateway`, `src/shared`, `src/mcp` for every term item 6 introduces -
  `presence_push`, `mergeApply`, `localBump`, `bootEpoch`, `sourceGateway`, the `fresh`/`quiet`/
  `unreachable` peer-freshness tri-state as a computation (not just the type declaration) -
  returns zero hits anywhere.
- `src/shared/federation-protocol.ts`'s `FederatedOpSchema` (the exhaustive enum of every op a
  Gateway can send/receive cross-Gateway) has exactly 5 kinds: `send`, `list_teams`, `wake`,
  `response_push`, `console_push`. No `presence_push` kind exists at the wire level at all, and
  `gatewayRelay.ts`'s dispatch switch matches exactly those same 5 cases.
- No 10s (or any) anti-entropy timer exists anywhere in `src/gateway/index.ts` or
  `src/gateway/evie/evieClient.ts` - only the unrelated tripwire (60s), persist tick (3s),
  presence-watch push (2s, local-daemon-only, never touches evie), heartbeat, vibe-check, and
  share-sweep timers.
- `src/__tests__/federation.test.ts` (2200+ lines, extensive `send`/`wake`/`list_teams`/
  `response_push`/`console_push`/cross-Domain-sharing coverage) has zero tests resembling the
  plan's mandated two-gateway/three-gateway harness for outbound coalescing, epoch authority,
  roster-vanish, cost-floor re-arm, or evie-reconnect revalidation.
- Commit `e07dbd5` ("Replace pull-based presence with a versioned, hash-gated presence plane")
  added the entire 843-line plan document (all three audit laps already baked in) in the SAME
  commit as the Phase 1 code - but its diff never touches `gatewayRelay.ts`,
  `federation-protocol.ts`, or `evieClient.ts`. No commit since (`b11cdce`, `f53d082`, `a04dc8c`,
  `45660cc`) touches them either. Commit `f53d082`'s own message admits it directly: "the
  presence plane only ever covered this Gateway's own local sessions."
- Nowhere in the plan's own process-tracking (the flagged-deviations sections, the Phase 2 bullet
  list, CLAUDE.md) is this recorded as a deliberate scope cut. The plan's own lap-3 closing
  assessment (quoted below) explicitly frames the federation design as **finished and ready to
  build**, the opposite of a flagged deferral.

## Why this matters

This directly reverses an explicit user ruling from this plan's own original questionaire (Q4):
when asked whether one gateway should be more authoritative than another, the answer on record
was "It should work in parallel, equally" - rejecting a primary/secondary framing outright.
Shipping a presence plane that is silently local-gateway-only is exactly the primary-gateway
framing that was rejected, just never announced as such.

## Related gaps found in the same audit (entangled with this one)

- **`presenceFresh` is permanently dead.** `TeamInfoSchema` declares a tri-state
  `"fresh"|"quiet"|"unreachable"` field; `PresenceFacade.snapshot()` (the sole producer of every
  row shipped on the wire) never assigns it. It cannot be populated without the peer-freshness
  state machine this item describes, so it is inert wire weight today, not a partial
  implementation. Building this item is what wires it up.
- **The `planeField()` closed-world enforcement mechanism was never built**, despite being
  committed to three separate times (Phase 1 item 1's own spec, a lap-2 audit finding that
  explicitly re-committed to it, and item 3's enforcement clause citing it as one of two
  layers). Only the reactive 60-second tripwire exists; the preventive schema-tagging layer does
  not. This is a distinct, smaller piece of work from the federation exchange itself, but it is
  the reason the register/touchLive/sweep facade-bypass bugs the same audit found (since fixed)
  went undetected for as long as they did - nothing but the tripwire was ever positioned to
  catch them. Worth deciding whether to build this independently of the federation exchange, or
  bundle it in since both are "Phase 1 Verify-gate promises that shipped unbuilt."
- **The "class-kill lock" property/fuzz test was never built either.** The plan explicitly calls
  for "a property test [that] fuzzes EVERY public facade mutator... not a hand-kept list" -
  what shipped is precisely the hand-kept list the plan named as the failure mode to avoid
  (`presence.test.ts`'s "class-kill lock" test, one hand-written call per named mutator). No
  property-testing library (e.g. fast-check) is even installed. This session's align-fix patched
  the immediate symptom (three real mutators - `adoptOrReattach`, `mintOrReattach`,
  `establishOnConfirm` - were missing from that hand-kept list and have been added), but the
  underlying "structural, not enumerated" commitment remains unfulfilled. Smaller, independently
  schedulable work.

## Existing design (carried forward verbatim from Phase 1 items 6-7, already refined across three audit laps)

This substance already exists at `plans/versioned-state-planes.md` lines 363-478 (item 6) and
479-497 (item 7's `presenceFresh` piece) - copied here so this plan is self-contained and does
not depend on that file staying in the tree. When this is picked back up, re-verify every claim
below against whatever the codebase looks like at that time (a lot may have shifted across the
rest of Phase 2) rather than trusting it at face value, the same discipline that caught this gap
in the first place.

**Versioned exchange with a gateway-owned anti-entropy timer, decoupled from console intent.**
Per-source sub-planes keyed `(sourceGateway, bootEpoch, version)`.

- **Two separate timers, one transport:** the anti-entropy exchange is a gateway-lifecycle timer,
  owned by and running for as long as the gateway holds its evie connection - independent of
  whether any console is attached, same lifecycle class as the existing evie heartbeat. Cadence:
  10s (tight enough that "lost push heals within one tick" is a real sub-15s bound, loose enough
  that a single-gateway Domain's cost-floor short-circuit still means near-zero steady-state cost
  for the common case). Intent relay to ramp peer daemons is a separate, genuinely intent-gated
  concern that piggybacks on the same wire call opportunistically when intent exists, but its
  absence never pauses anti-entropy.
- **`presence_push`** relays a source's own sub-plane same-Domain (origin-only, dedup-keyed, hard
  same-Domain deny) - the fast path for a normal flip, healed by anti-entropy if lost.
  Per-destination outbound coalescing: this gateway keeps at most one in-flight `presence_push`
  attempt per destination peer; a new push while a prior attempt to the SAME destination is still
  inside its retry backoff REPLACES that in-flight attempt's payload rather than queuing a second
  one, so a stale retry can never land after a fresher one already succeeded.
- **Merge rule:** a receiving gateway tracks, per source, the last-known `(epoch, version)` it has
  installed. Same epoch: higher version wins, lower/equal dropped. A NEW epoch for source S
  installs ONLY from a frame authoritatively S's own (S's own push, S's own rejoin re-push, or an
  anti-entropy answer FROM S ITSELF) - never third-hand from another peer's anti-entropy answer
  about S, except to fill a genuine gap (no tracked state for S at all). Anti-entropy answers are
  scoped to the answerer's own sub-plane only, never a relayed view of a third source. A gateway
  never `mergeApply`s its own sourceGateway's sub-plane from any inbound frame - the local facade
  is the sole writer of the local gateway's own sub-plane.
- **Structural no-re-fan-out:** two distinct write paths - `localBump()` (facade-originated, fans
  out via `presence_push`) and `mergeApply()` (inbound-originated, applies the merge rule, bumps
  local identity, never itself calls `localBump`'s fan-out). A landed push cannot gossip-loop by
  construction.
- **Peer freshness state machine:** the anti-entropy timer checks the roster every tick
  regardless of cost-floor state, so a known peer simply absent from a fresh roster fetch counts
  as an observation too. Per peer: `fresh` (exchange completed within the last 2 ticks) / `quiet`
  (exchange succeeded, nothing new - healthy idle, not stale) / `unreachable` (2 consecutive
  ticks where either the exchange failed or the peer was roster-absent). Stale-marking lives in
  the aggregator's local view via `mergeApply`, never a forged version in the source's own
  stream.
- **Cost floor:** the roster-check itself (a `list_gateways` call, cheap) runs every tick
  unconditionally; only the expensive per-peer exchange calls short-circuit to zero when the
  roster comes back empty. A single-gateway Domain's steady-state cost is one cheap roster lookup
  every 10s and nothing else.
- **Evie-reconnect immediate revalidation:** on evie WS reconnect, immediately fire one exchange
  attempt against every currently-tracked peer and mark each peer's freshness provisional until
  that round completes, bounding "a peer that died during my own evie outage" detection to
  roughly the outage duration plus one round trip.
- **Console failover:** a console presents its known versions to whichever gateway it currently
  polls; a newly-adopted route gateway applies the poll-wait hub's single compare rule (any
  difference ships current truth). A row the console had fresher via a since-lost prior gateway
  can briefly read as older from the new one; self-corrects within one anti-entropy cycle. Not
  zero-regression on failover by design - a bounded, self-healing one instead.
- **Mixed-version peers:** an old gateway rejects unknown `FederatedOp` kinds; the sender probes
  once per roster tick, marks it legacy, and its rows ride the old discovery-refresh path until
  it upgrades.
- **Cross-Domain:** both new ops (presence exchange and intent relay) land in a default-DENY
  dispatch (allowlist of same-Domain op kinds) - a forgotten gate fails closed.
- **Legacy-peer probe error handling:** distinguishes "unknown op kind" (a clean legacy signal)
  from a seal/transport failure (treated as `unreachable`, never confused with a dead gateway).

**Wire (item 7's relevant piece):** `presenceFresh?` on `TeamInfo`, a tri-state
`"fresh"|"quiet"|"unreachable"` string, present ONLY on a row sourced from a same-Domain PEER
gateway (absent for a row sourced from this gateway's own local sessions - not a fourth "local"
value). The wire-assembly step that turns the internal merged snapshot into `TeamInfo` rows
copies the peer freshness state machine's per-source output onto every row from that source at
assembly time.

## The plan's own closing assessment at the point this was shelved (unimplemented, not unsound)

> Three laps deep, the first two rounds hardened the federation design's INTENDED behavior (what
> the merge/timer/facade rules were supposed to do); [lap 3] found that the PERSISTENCE layer
> underneath them - how a restart, a crash, or a partial write interacts with those rules - had
> never been audited on its own terms... This is reported to the user now rather than looping to
> a lap 4 - the remaining Plan is not "the federation layer might still be unsound," it is
> "verify the fixes above compile and pass the rebuilt test list," which is implementation work,
> not design work; further audit rounds on an unimplemented design face diminishing returns
> against the concrete alternative of building it and letting the Verify section's own new
> assertions... catch a regression.

In other words: at the moment this was written, the design itself was assessed as finished and
ready to build - what was missing was only the build. That never happened. Nothing about the
design has been re-validated since; treat "ready to build" as a starting hypothesis to re-check,
not a current fact, when this is picked back up.

## A smaller, independently-schedulable relative of the planeField() gap

Phase 2's framework-first-audit pass (same cycle that fixed the register/sweep facade-bypass bugs
above) proposed a cheaper, non-production dev/test-mode "assertClean" check: a throwing variant of
the tripwire's own per-plane recompute, wired into the WebSocket message handler and a small
extracted persist-tick function, so a facade bypass shaped like the two this session found fails
the test suite immediately instead of waiting up to 60 seconds in production. It is explicitly
NOT a substitute for planeField() (it is test-coverage-gated, not compile-time-structural - an
entirely new, untested mutation still gets no protection), but it is meaningfully cheaper to build
and would have caught both of this session's real escapes on the very first existing test that
exercises them. Worth building either as a lightweight prerequisite before planeField(), or
independently if planeField() itself keeps getting deferred. Needs `persistDelivery`'s sweep logic
extracted into an exported, directly-testable function first (it currently lives only inside
`startGateway()`'s closure).

## A second, smaller pain point worth remembering when this reopens `consoleHandler.ts`'s poll case

Phase 2's crust-collection pass flagged that the poll case's three plane-piggyback blocks
(presence, linked-peers, read-anchors) were assessed as "not worth extracting into a shared
helper yet" - but that verdict's own reasoning explicitly depended on no fourth static plane being
committed. If this item ships as another static named block (rather than the dynamic
per-source-gateway shape it is actually designed as above), or if the cross-Domain presence item
below lands its own named plane, re-run that extraction assessment rather than assuming the old
"not worth it" still holds with a fourth or fifth block added.

## Status

**Deferred.** `plans/versioned-state-planes.md` (the plan this was found inside) shipped and was
deleted 2026-07-18 - see `plans/pain-points.md` for its closing summary. This item was never
folded into that closure; it stands on its own until picked up.

## When this is picked back up

- Re-verify the design above against the codebase as it stands then - do not assume nothing has
  drifted.
- Reconcile scope with cross-Domain presence (linked friend Domains' tiles - "currently
  discovery-refresh, needs its own questionaire pass if wanted", the last surviving item of the
  now-closed versioned-state-planes Phase 2). That item is cross-DOMAIN, a distinct concern from
  this plan's same-Domain multi-gateway exchange, but both land in the same
  `presenceFresh`/freshness-state-machine neighborhood and are worth designing together rather
  than sequentially if both are wanted. Confirm with the user whether one, both, or neither is
  still desired before scoping either. Same-Domain (this plan) is the one with the explicit prior
  user ruling (Q4) behind it. Cross-Domain has never been ruled on either way - if its own
  questionaire is already underway or done by the time this reopens, read its resulting plan file
  first rather than re-deriving this reconciliation from scratch.
- Decide whether the `planeField()` closed-world mechanism and the property-based class-kill-lock
  test (the two related, smaller gaps above) should ship as prerequisites, alongside, or
  independently of the federation exchange itself.
- Run this through the questionaire skill properly before implementing - this plan captures a
  finding and a prior design, not a fresh, current-context design decision.
