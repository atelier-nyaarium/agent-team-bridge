# Handshake recovery: re-push a lost `hs-*` id on the outbound reply gate

## Symptom (hit live, 2026-07-15)

A channel session received a work message on `host.575175` and tried to answer with `channel_reply`.
The gateway rejected it: *"Your bridge handshake is still pending. Reply to the handshake session
first with channel_reply_structured, then resend this reply."* But the session had **no `hs-*` id to
answer with** - the handshake notification was never in the LLM's reachable context (a long,
previously-compacted session). Every subsequent `channel_reply` is then permanently refused: the
outbound reply deadlocks with no recovery path.

## Root cause

- `src/gateway/websocket.ts : sendHandshake` mints `hsSessionId = hs-<random>` and stores it ONLY in
  the in-memory `handshakePending` map. Random (not derivable), never persisted.
- `src/mcp/bridge/helpers.ts` auto-answers only when its `handshakeRole` cache is non-null. On a
  fresh process the cache is null, so it emits the handshake as a channel notification and relies on
  the LLM to answer with `channel_reply_structured`. `noteReceived(hsSessionId)` records the id
  inside the cache, but nothing can answer it without the LLM supplying the id back.
- If that notification is missed (dropped, batched behind a work message, or aged out of a compacted
  session), the LLM no longer has the id.
- `src/gateway/routes.ts : respond()`'s reply gate then 409s every `channel_reply`, and - per the
  shipped red-team fix that removed hs-id disclosure to close a spoofing hole - the 409 does NOT name
  the pending id. The legitimate self-caller can neither learn the id nor answer.

Net: the id is random + in-memory-only + withheld + answerable only via the LLM's transient context.
Lose that context once and the session can never send another reply. **Scope correction from the
audit:** this is a purely OUTBOUND deadlock - inbound delivery already reaches an unconfirmed socket
(see Questionaire Q3), so a "dark lead" still receives its messages; it just cannot reply.

## Questionaire

Constraint from the code: the MCP process has **no** lead/worker signal of its own - `handshakeRole`
only fills when the LLM answers a handshake, and `AGENT_TYPE` is agent-kind (claude/cursor). The
gateway already tracks each socket's pending `hs-*` (`findPendingHandshakeId(team, subId)`).

**1. Recovery strategy.** Answer: **A) Gateway re-pushes the handshake on a gated reply.** When
`respond()`'s gate 409s a reply, the gateway also re-sends that socket's pending handshake
`channel_push`; the MCP handles it identically to the first (`noteReceived` + emit), so the LLM gets
a fresh prompt, answers, and resends. Reason (chosen): smallest, safest - reuses gateway state,
keeps the LLM as the sole lead/worker decider, leaves the anti-spoof id-withholding intact. Corollary
(from code, not a choice): the fix is **gateway-side only** - no MCP/plugin change, version bump, or
reload.

**2. How the original reply lands after the answer.** Answer: **A) LLM resends manually.** The
`channel_reply` tool relays the 409 ("answer your handshake, then resend"); the re-pushed handshake
notification arrives alongside; the LLM answers via `channel_reply_structured`, then re-calls
`channel_reply`. MCP stays stateless. Reason (chosen): matches the shipped "one bounce in a rare
race" stance; the deadlock is rare, so ~2 extra turns beats new MCP pending-reply state.

**3. Inbound "dark lead" case - REVISED after the audit.** Original answer (bounce a delivery error
to the sender) rested on a FALSE premise. The audit proved against the code that inbound sends
already deliver to an unconfirmed socket today: `resolveLiveIncarnation` returns `canonical[0]` even
when unconfirmed (`websocket.ts:121`), and `send()` broadcasts with no `handshakeConfirmed` filter
(`routes.ts:996`; `routes.test.ts:908-937` delivers to exactly this state). The live incident
confirms it - the stuck session *received* its work message. A bounce would also fire on every normal
cold-wake first send (unconfirmed for the 3s wake window, cannot confirm within an inference
round-trip). **Resolution: drop the inbound bounce entirely; do NOT add a `handshakeConfirmed` gate
to `send()`.** The deadlock is outbound-only.

**4. Terminal behavior when recovery does not converge - REVISED.** Considered a fail-open ("deliver
the reply anyway after N blocked attempts"). Answer: **A) No fail-open - re-push only.** User's
framing: *"I don't want a messed up session as part of the equation, so don't 'send anyways'. Mayhaps
it's lagging behind a version and I just need to restart it. whatever. Wait for handshake or consider
it some internal error."* So an unconfirmed/possibly-stale session never has its reply forced
through; it either answers the re-pushed handshake or the block is surfaced as an honest internal
error the human resolves by restarting.

## Plan

Gateway-side only. `src/mcp/bridge/helpers.ts` already treats a re-pushed handshake identically to
the first (`noteReceived` + emit on a null role cache), so **no MCP/plugin change, no version bump,
no reload** - deploy is a gateway rebuild alone. No inbound/`send()` change at all.

1. **Split `sendHandshake`** (`src/gateway/websocket.ts:177-190`, currently monolithic - mints id +
   inserts pending entry + sends in one unit) into:
   - `mintHandshake(ws, team, subId)` - mints the `hs-*` id, inserts the pending entry (widened to
     `{team, subId, sentAt, repushCount}`), sends. Called once at register (unchanged behavior).
   - `buildHandshakePush(hsId)` - pure builder of the exact push object
     (`{type:"channel_push", from:"gateway", session_id:hsId, replyJsonSchema, body}`). Must stay
     byte-identical to what the MCP's `noteReceived` branch keys on (`from==="gateway"` +
     `replyJsonSchema`), or the later confirm is rejected by `receivedIds.has()`.
   - `repushHandshake(team, subId)` - resolves the EXISTING id via `findPendingHandshakeId`,
     re-sends `buildHandshakePush(id)` to the live socket (`registry.get(team).get(subId)`, gate
     `readyState===1`, wrap `send` in try/catch), bumps the guard. **Never** mints a new id/entry
     (asserts the pending-map size invariant). No-op if no pending id.

2. **Outbound re-push** (`src/gateway/routes.ts : respond()`, the existing 409 branch ~`:1082-1100`):
   immediately before returning the 409, call `repushHandshake(callerWs.data.teamName,
   callerWs.data.subId)` (both in scope; `teamName` is proven non-null by the enclosing pending-id
   check; field is `teamName`, not `team`). The 409 body keeps withholding the id.

3. **Guard on the entry** - two bounds, both stored ON the `handshakePending` entry so `forgetPending`
   auto-cleans them on close/evict, and both reset on reconnect (a fresh incarnation gets a fresh id
   and a fresh attempt):
   - **Rapid-fire de-dupe** (`sentAt`, initialized to the mint time so the register push counts as
     push-1): skip a re-push within a couple seconds of the last, collapsing a same-batch double
     `channel_reply`. It must NOT suppress a genuine *next* reply-attempt past that short window - each
     real attempt still needs a fresh notification, since a suppressed retry would get a bare 409 with
     no id, reproducing the exact failure being fixed.
   - **Per-connection CAP** (`repushCount`, small fixed budget per unconfirmed-socket lifetime):
     because `/respond` is unauthenticated and `conversationId` is non-secret + spoofable, the re-push
     is a NEW outbound reach into a victim's pre-confirm window that `/send` never had. The cap bounds
     an attacker injecting gateway-authored handshake prompts indefinitely. Self-closes once the
     victim confirms (`resolveHandshake`/`forgetPending` clears the entry).

4. **Honest terminal state (no fail-open).** Once the cap is spent and the socket is still
   unconfirmed, `respond()` keeps 409ing, escalated to an observable message (e.g. "session still
   unconfirmed after N handshake prompts - it may be stale/lagging; restart it") so a permanently-dark
   lead is visible to the human rather than silently looping. Recovery is: the LLM answers the
   re-pushed handshake, or a human restarts. A delivered-anyway reply is explicitly rejected.

**Tests:**
- End-to-end: 409 -> re-push -> LLM confirms -> the previously-blocked reply LANDS (the deadlock's
  real exit, not merely "a handshake got re-sent").
- `repushHandshake` never grows `handshakePending` (size invariant across N re-pushes).
- Guard: a genuine second reply-attempt past the rapid-fire window still gets a fresh re-push; a
  same-batch double-call collapses to one.
- Cap: after N re-pushes, no further pushes and the 409 escalates to the stale-session message.
- Regression: a normal inbound `send()` to an unconfirmed (just-woken / verifying) socket STILL
  delivers - no inbound gate was added.
- Host slot / virtual `ConsolePeer` / loose peers unaffected (host is `handshakeConfirmed=true` with
  no pending entry; virtual peers excluded from `getAllActiveRealWs`).

**Out of scope:** fail-open delivery (rejected - no "send anyway"); the inbound bounce (dropped -
inbound already delivers); disk-persisting the role cache (deferred by the shipped design - "one
prompt per reload is honest"); MCP-side buffered auto-resend (Q2 = manual resend).

**Deploy:** gateway rebuild only - `./down.sh && ./start-gateway.sh && ./start-host-daemon.sh`. No
plugin push/reload. **Deploy validation:** confirm empirically that the Claude Code harness does not
dedup a repeat-`session_id` `notifications/claude/channel` (out of this repo's control; if it did,
the re-push would silently no-op) - send a re-push and observe a second `<channel>` injection.

## Audit (plan-refinement, lap 1)

12-dimension parallel audit against the code; 21 verified real-gaps, resolved into the design above:

1. **[critical] Inbound "dark lead" premise false** - inbound already delivers to unconfirmed
   sockets; a bounce would regress every cold-wake send and the incident itself proves delivery
   worked. -> Dropped item 3; deadlock is outbound-only (Q3 revised).
2. **[blocker] `sendHandshake` is monolithic** - can't be "reused" for a same-id re-push without
   minting a new id + entry (the pileup). -> Split into `mintHandshake` / `buildHandshakePush` /
   `repushHandshake` (Plan 1).
3. **[correctness] Rate-limit guard could block recovery** - suppressing the re-push on a real retry
   leaves the LLM a bare 409 with no id. -> Guard keyed to genuine reply-attempts, not wall-clock
   (Plan 3, rapid-fire clause).
4. **[convergence] Recovery depends on the lossy notification channel** whose miss caused the
   incident. The audit's suggested fail-open was **rejected by the user** ("don't send anyways"). ->
   Terminal state is an honest, observable internal error the human resolves by restart (Plan 4).
5. **[security] Re-push is a new outbound reach** into a victim's pre-confirm window via spoofable
   `conversationId` on unauthenticated `/respond`. -> Per-connection total CAP (Plan 3), self-closing
   on confirm.
6. **[pin] Guard state** = `lastRepushAt`/`repushCount` ON the pending entry (auto-cleaned by
   `forgetPending`), not a separate leaking map; init to mint time; reset on reconnect (Plan 3).
7. **[location] Detect at the send site**, field is `teamName`; identifiers in scope at the 409
   branch (Plan 2).
8. **[tests]** Prove the reply actually UNBLOCKS, the verifying window is NOT bounced, and the guard
   re-opens/caps correctly (Tests).

**Verified non-issues:** "no MCP change" is TRUE provided the re-push reuses the full body; the host
slot, virtual `ConsolePeer`s, and loose peers are immune; a spoofed `conversationId` cannot redirect
the re-push to the attacker (it resolves to the victim's own socket) and the 409 still withholds the
id.

## Implementation (audited-implementation cycle)

Built per the Plan above: `mintHandshake`/`buildHandshakePush`/`repushHandshake` in
`src/gateway/websocket.ts`, wired through `src/gateway/routes.ts`'s `respond()` 409 branch and
`src/gateway/index.ts`. Gateway-side only, as designed - no MCP/plugin change.

**Align-fix (plan-alignment audit, lap 1):** two real gaps found and fixed - `repushHandshake`'s
`ws.send` lacked the try/catch the plan explicitly specified (added, returns `"socket-gone"` on
failure); the plan's "regression: inbound `send()` to an unconfirmed socket still delivers" test was
missing (added, explicitly named and asserting `res.status === 200`).

**Red-team round 1:** 5 real gaps, all fixed - `mintHandshake`'s own `ws.send` was unguarded (a much
higher-frequency hot path than the repush call the align-fix had already hardened; a throw there
crashes the whole gateway via `uncaughtException`, not just one socket) - wrapped in try/catch,
logs and leaves the entry in place so a later `repushHandshake` can retry; `mintHandshake` never
cleared a same-(team,subId) orphaned entry on a same-socket re-register - now calls `forgetPending`
first; the per-entry cap/dedupe had no cross-subId ceiling, so a caller who knew several of one
team's sub-session `conversationId`s could round-robin past the per-entry 3s floor - added a
team-level dedupe (`teamLastRepushAt`); two test-integrity gaps (the "pushed" vs "capped" 409
messages were never distinguished by any assertion; no test drove `ws.send` to throw on an open
socket) - both closed with new/strengthened tests.

**Red-team round 2 (targeted re-audit of round 1's own fixes, since a fix changed something
non-trivial):** the new team-level guard itself had a **HIGH severity regression, empirically
reproduced against the live code**: it serialized ALL repushes across a team to one success per 3s
window shared by every sub-session, so several legitimate siblings recovering at once (the exact
scenario `repushHandshake` exists for) could starve each other for many multiples of the window
instead of each just getting delayed by one cycle. **Fixed**: an entry's own per-entry dedupe check
(collapses a same-instant double-trigger on THAT entry) now always applies unconditionally, but the
team-level check only applies from an entry's SECOND attempt onward - every sibling's first
recovery shot always goes through regardless of a sibling's more recent success, closing the
starvation while still bounding a round-robin attacker's THROUGHPUT after the first free hit per
known sub-session. Also fixed: `teamLastRepushAt` was an unbounded `Map<string, number>` whose
comment incorrectly claimed team names are a "small stable keyspace" like `knownTeamPaths` - team
names actually come from an unauthenticated `/bridge` register with only format validation, so an
attacker could churn arbitrary names to grow the map forever; swept it via the existing
`heartbeatTick` (an entry past its dedupe window has zero remaining throttling effect regardless of
whether it is deleted, so this is pure cleanup with no behavior change). Also fixed for symmetry:
`repushHandshake`'s catch block logged nothing on a send failure, unlike `mintHandshake`'s (added a
matching log line); a test gap where the only throwing-send test fired the throw AFTER a successful
register, never exercising `mintHandshake`'s own new catch branch (added a dedicated test).

**Deferred (recorded, not fixed - diminishing returns after two red-team rounds):** a dead-but-
not-yet-heartbeat-reaped socket makes `repushHandshake` return `"socket-gone"` without advancing the
entry's `repushCount`, so `routes.ts`'s message picker (which only escalates on `"capped"`) shows the
same generic "still pending, resend" text on every retry instead of surfacing that the push itself
is undeliverable. Bounded and self-healing: the heartbeat's missed-ping close (~60s at default
config) eventually reaps the dead socket, after which the `/respond` gate fails open per the
already-settled fail-open design. Low severity, self-correcting within a bounded window - fixing it
would mean growing `routes.ts`'s message-selection branching for cosmetic benefit on an edge case
already covered structurally. A separate, explicitly pre-existing and out-of-scope finding (the
"remembered lead" register branch never calls `forgetPending`, so a same-socket double-register after
a team earns the remembered-lead shortcut could orphan a stale answerable `hs-*` id) predates this
diff entirely and sits in code this diff never touches - left alone, matching how the ORIGINAL
shipped handshake design's own red-team recorded rather than fixed an analogous pre-existing,
narrow-trigger register-handler finding.

## Framework-first audit (audited-implementation cycle)

4-dimension parallel review (rate-guard duplication, handshake-state cohesion given the new
`teamLastRepushAt`, the outcome-to-message ternary, and fit against the codebase's existing
`createReconnector`/`PendingJobStore`/`ReplayGuard` abstractions), each checked against actual
codebase precedent rather than in the abstract. All four returned **no-change-needed**:

- The per-entry and team-level dedupe checks are NOT the same duplicated concept - different keys,
  different applicability (the team check only applies from an entry's second attempt), different
  storage/cleanup rationale. `src/mcp/devcontainer/hostOpRunner.ts` hand-rolls the identical
  `now - t < window` shape with MORE repetitions in this same codebase without ever unifying it -
  established, deliberate convention, not an oversight.
- Re-examining the ORIGINAL shipped design's own rejected "HandshakeRegistry" extraction with fresh
  eyes (state has grown since: `teamLastRepushAt` is new): still fails the ownership test.
  `mintHandshake`/`repushHandshake`/`resolveHandshake` are defined by direct access to the exact
  `registry`/`sessionStore` resources `createWebSocketHandlers` exists to own - there is no seam to
  inject. Contrasted against two ACTUALLY-extracted classes in this codebase
  (`WakeCoordinator`/`HostOpCoordinator`, pure promise-correlation with zero registry dependency) and
  a third literally named `CrossDomainHandshakeCoordinator` (extracted specifically because its I/O
  is seamed through an injected router interface, never touching `TeamRegistry`) - none of those
  conditions hold here.
- The `outcome === "capped" ? ... : ...` ternary matches this codebase's own established idiom for
  "outcome union, one or two variants special-cased, rest fall to a generic default" (verified
  against `HostOpResult`'s `errorKind` handling in `consoleHandler.ts`'s `friendlyPeekError()`, the
  closest same-shaped precedent). A table was considered and rejected as it would force explicit
  handling of a provably-unreachable variant (`"no-pending"`, ruled out by tracing `respond()`'s
  fully-synchronous control flow) for a union with exactly one consumer.
- `repushHandshake`'s caller-triggered, id-continuity guard is a genuinely distinct shape from all
  three existing abstractions checked (`createReconnector` is timer-driven with no cap;
  `PendingJobStore` is a passive correlator with no outbound side effect; `ReplayGuard` has inverted
  polarity - reject-on-seen rather than reuse-the-same-id) - not a divergent reimplementation of any
  of them.

**One incidental pickup, applied:** the outcome-message audit independently re-confirmed round 2's
deferred low-severity finding (a `"socket-gone"` repush outcome fell into the same generic message as
a fresh `"pushed"`/`"throttled"` one) and, given the proportionate fix is trivial (widen the existing
ternary by one arm, explicitly NOT a table), applied it: `"socket-gone"` now gets its own distinct
409 message ("could not be re-delivered... try again shortly") instead of the misleading standing
"reply to the handshake session" instruction.

## Provenance

This file previously held the shipped "remember the answer, stop re-asking" design (one LLM handshake
per process, silent reconnects, the reply-gate, the red-team hs-id-disclosure fix). That work shipped
and its writeup lives in git history for this path. This is a fresh gap the shipped design did not
cover: it optimized the happy path (answer once, cache it) but left no recovery for a session that
never got to answer even once.
