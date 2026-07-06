# Pre-handshake terminal view

Give a human a way to see AND reach a session that has no chat history yet (no handshake has
confirmed), for both a brand-new `create_session` and an existing session waking from asleep.
Replaces the reverted ConnectDialog (typed-address) approach from commit 609e8a9/dc36152 - the
owner rejected manual address entry as the UX for this problem.

## Problem

Live-tested tonight: creating a `story-designer` session went silently stuck because the
devcontainer's Claude Code had never been logged in - it sat at a first-run login prompt inside
tmux. The human had no way to see this, because:

- The `PendingCreate` placeholder card (client-only spinner, `ChatRepository.kt:188-195`) is not
  navigable - it shows "Creating..."/"Waking Docker..." text but has no tap target.
- Once a real session record exists (`SessionStore`, per `handshake-session-linkage.md`, already
  shipped), a `verifying`-status `SessionCard` IS tappable into the normal `ThreadScreen`, and
  `terminalEligible` (`MainActivity.kt:567-568`) already permits toggling to the terminal view
  (tmux peek) for any local composite session - so the pane WOULD have been visible if only the
  human had known to navigate there. The real gap is discoverability/timing, not the tmux-peek
  mechanism itself.
- Before the container/tmux pane exists at all (mid-`docker compose up`/devcontainer-CLI boot),
  a tmux peek has nothing to show anyway - no capability exists today to show container boot
  progress (image pull, postCreate scripts, etc). Confirmed via research: no `docker logs`
  fetching exists anywhere in the repo (no dockerode, only `docker exec`/`docker compose`/
  `docker network` subcommands - `tmuxCore.ts:91`, `helpers.ts:69,77`).

Owner's stated direction (verbatim): "the placeholder should probably be the actual session. No
chat history yet since there was no handshake. But instead peeks the docker logs and then TMUX.
Regardless of new vs resume, Docker logs peek viewable as the terminal view during this phase of
wake."

## Relevant existing mechanics (confirmed by research)

- **Terminal view today**: `ThreadScreen`'s top-bar icon toggles `terminalMode`
  (`MainActivity.kt:1693-1701`), gated by `terminalEligible` (local composite session only,
  `:567-568`), rendering `TerminalView(...)` (`:1744-1750`) backed by `repo.peekTerminal` /
  `repo.tmuxSend` -> `ConsoleClient.peek`/tmux_send (`ConsoleClient.kt:815-816,830`).
- **verifying status**: same `SessionCard` for every status, just a different chip color/text
  (`statusWord()`/`presenceColor()`, `MainActivity.kt:1350-1364`, amber, same bucket as
  "working"/"waking"). No distinct card, no distinct navigation.
- **PendingCreateCard**: `MainActivity.kt:1523-1542`, backed by `PendingCreate`
  (`ChatRepository.kt:188-195`). Two text states only ("Creating..." / "Waking Docker...").
  Spinner + text, not clickable, no `StatusChip`.
- **create_session already mints synchronously**: the gateway mints/adopts the session's `id`
  (the address segment) via `SessionStore` BEFORE the wake even starts, and returns it in the
  reply even on the bound-timeout/pending path (`{created:true, id, sessionLabel,
  status:"pending"}`). The client already knows the full address the moment `create_session`'s
  reply lands - well before the container or tmux pane exist.
- **HostOp extension point**: `shared/host-op.ts` union (`peek`/`sendText`/`sendKey`/
  `createSession`/`reloadPlugins`/`killSession`), dispatched by `hostOpRunner.ts`'s `TmuxOps`
  seam, implemented in `tmuxCore.ts`/`reloadPlugins.ts`, wired in `hostDaemon.ts:355-376`. Adding
  a new op = new union variant + `TmuxOps` method + implementation + wire + dispatch case - a
  well-worn, consistent pattern.
- **Container name resolution is a pure naming convention, no lookup needed**:
  `containerName(team) = \`${team}_devcontainer-dev-1\`` (`tmuxCore.ts:17`), fed straight into
  `docker exec` argv. A "peek docker logs" op can reuse this same convention with no new
  discovery logic.

## Questionaire

**Q1 - When does the create-session placeholder become a real, navigable session thread?** ->
**A) Immediately once `create_session`'s reply returns the minted id** (near-instant, since the
gateway mints synchronously before the wake even starts) - tapping opens the normal thread right
away: empty chat + terminal view starting in docker-logs mode.
Recommendation reasoning: the id already exists synchronously server-side, and a docker-logs-first
view is specifically meant to have something useful to show before tmux does, so there's no reason
to wait for a `teams()` poll or for the tmux pane itself.

**Q2 - Auto-switching view, or a manual toggle between docker-logs and tmux?** -> Neither of the
offered options; owner's own answer, simpler than all three: **strict two-state machine, no
override**. "Docker logs are only relevant while waking. Terminal view will ONLY be a read only
docker log while waking. and ONLY tmux when a tmux is spawned." Docker-logs mode is read-only (no
input capability - there's nothing to send input to). The instant tmux is spawned, the view is
tmux and only tmux, for the rest of that session's life.

**Q3 - Does opening the terminal view on an asleep session auto-trigger a wake, stay passive, or
expose an explicit action?** -> **C) Passive by default, with an explicit "Wake" button centered
in the terminal view** for an asleep session. Owner: "a wake button center of the terminal view
sounds simple enough."
Recommendation reasoning (accepted): navigating into a screen silently spinning up a Docker
container is a surprising side effect; an explicit button keeps look/act separate while still
giving a fluid tap-in, tap-Wake, watch-it-boot flow.

**Q3-followup (owner-raised) - does the current system distinguish 3 chip states, or fewer?**
Owner's model:
- **Live** - devcontainer on AND this session's tmux ready
- **Available** - devcontainer on, tmux NOT up for THIS session (e.g. a sibling session already
  woke the shared container)
- **Offline** - devcontainer itself off, awaiting a boot command

Confirmed by research: today's code only has 2 buckets. `TeamInfo.status` "available" means "no
live incarnation for this exact session name," full stop - it carries no awareness of whether the
underlying container happens to already be warm from a sibling session. An internal check for
this DOES exist (`isContainerReady`/`wasAlreadyRunning`, `mcp/devcontainer/helpers.ts:103-113,
193-244`) but the result is computed and discarded - `hostDaemon.ts:273` destructures only
`{ pluginsProvisioned }`, nothing downstream reads `wasAlreadyRunning`. So the owner's 3-state
model is correct and names a real, currently-unsurfaced gap.

Follow-on technical finding: `docker logs` only ever shows a container's own PID-1 output: a tmux
pane launched via `docker exec` never writes to it. So during an Available-&gt;Live transition
(container already warm, only this session's tmux is being created), docker logs would show
nothing new - just stale content from whenever the container originally booted (possibly hours/
days old). I asked whether to special-case that phase with a plain "Spawning session..." message
instead of stale logs.

**Answered: no special-casing.** "we would typically only pay attention to the docker logs on
wake. Devcontainers very often fail due to configuration after all. Just being able to peek at it
from any new or existing session tells so much. And yeah they would all point to the same Docker
container logs. Once again, only shown as long as tmux not up." Even stale/frozen container logs
carry diagnostic value (a misconfigured devcontainer's failure is visible in them regardless of
which session peeks). The terminal view's rule stays the single simple switch from Q2: docker
logs whenever tmux is not up for this session, tmux once it is - no third state, no
container-warmth awareness needed IN THE TERMINAL VIEW.

Consequence: the Wake button's action needs no warmth-awareness either - the existing wake path
(`ensureContainerUpAsync`) already internally fast-paths an already-warm container (skips
`devcontainer up` entirely), it just never surfaced that fact. Tapping Wake can always call the
same `tryWakeTeam` regardless of Live/Available/Offline. The board-chip 3-state display itself
(a `TeamInfo.status`/wire change to actually surface `wasAlreadyRunning`) is therefore a fully
separate, optional enhancement, not required by - or entangled with - this plan.

**Answered: out of scope.** "we can omit the chips as long as current code makes it clear
already." Noted for the record: it does not (today's "available" bucket conflates Offline and
Available), but nothing in this plan depends on the distinction, so it is deliberately deferred
rather than folded in - a candidate for `plans/pain-points.md`, not this plan.

**Q4 (owner-raised, mid-questionnaire) - "Forget Tab" vs "Close Tab": Forget has special
handling, Close doesn't. Owner wants Close to end the tmux session and keep the store** ("Good
for restarting sessions. Or just mopping up"). Directly relevant: Close becomes the deliberate way
to send a session back through the exact docker-logs/tmux state machine this plan builds.

Confirmed by reading the code: `forget` (`consoleHandler.ts:807-823`) is exactly `killSession`
HostOp + `dropSessionResume(name)`. `killSession` (`tmuxCore.ts:208-222`) is only ever `tmux
kill-session` inside the container - it never touches the Docker container itself, so it is cheap
regardless of how many sibling sessions are still up. Today's `closeTab` (`ChatRepository.kt:
2680-2682`) is 100% local (removes the team from `openTabs`, no server call at all) - confirmed
this is the exact gap the owner meant.

Design (derived, not asked as a multiple-choice - the mechanics fell out directly from the two
functions above): a new `close_session` console op, separate from `forget` (matching the two
distinct existing UI actions/labels) - same target validation as `forget` (reject a bare
spawn-point), same `killSession` HostOp call, same idempotency dedup key, but WITHOUT the
`dropSessionResume` call. No other new code needed: once the live connection drops, `teams()`
already reports the record as `available` via existing liveness machinery
(`resolveLiveIncarnation`), unchanged.

**Confirm dialog on Close, now that it kills a live remote process?** -> **No.** "no need to
confirm. it's safe and restorable." Matches the recommendation (record/label/history all survive;
the session is simply idle until re-woken).

## Refinement (lap 1) - 12-angle audit, read-only, 30/52 findings confirmed real

Two BLOCKERS were caught, both concrete plan-writing errors that would have caused a silent
Android-breaking or dead-launch-detection regression if implemented as originally worded (not
scope changes - fixed directly below, folded into Phase A/B):

1. **`peekPane()` has 3 unnarrowed internal consumers the plan never listed**:
   `tmuxCore.ts:304` (`awaitReady`'s dead-launch detection), `hostDaemon.ts:243-244` and `:300`
   (`handleWake`'s reattach-recheck, both branches) all call `peekPane` directly and destructure
   `.ansi` unconditionally, with zero `kind` narrowing. Worse than a compile error: `awaitReady`'s
   `DEAD_LAUNCH_PROBES` bail-out depends on `peekPane` REJECTING while tmux doesn't exist yet - if
   the container-logs fallback lives inside `peekPane` itself, that reject becomes a resolve, and
   dead-launch detection is silently defeated. **Fix**: `peekPane()` itself is UNCHANGED (same
   signature, same reject-on-absent behavior, same flat `{ansi,hash}` return) - `awaitReady` and
   both `handleWake` call sites keep calling it directly, untouched. The container-logs fallback
   lives in a NEW wrapper, `peekWithFallback(target)`, used ONLY by the daemon's console-facing
   wiring (the `TmuxOps.peekPane` assignment in `hostDaemon.ts:355-356` points at this new wrapper
   instead of raw `peekPane`) - the one seam that actually feeds the console's peek op.
2. **The console-facing peek result's `kind` discriminant cannot be a real `z.discriminatedUnion`**:
   `scripts/codegen-kotlin.ts`'s `SEALED_ROOTS` set only covers ENCODE-side unions (composed by the
   console, e.g. `ConsoleOpSchema`); a DECODE-side union root (which `ConsolePeekResultSchema` is -
   the console receives and decodes it) hits the codegen's final bare `else {}` and emits NOTHING
   for that type, silently. `bun scripts/codegen-kotlin.ts` does not throw; CI's drift check only
   diffs the committed output against a fresh run, so a silently-empty regeneration passes clean
   and the Android build breaks on `Protocol.kt` referencing a type that no longer exists - the
   exact CLAUDE.md-documented incident class (a schema change that passes every TS gate and breaks
   Android, invisible to `ci.yml`). **Fix**: the console-facing peek result stays a FLAT object,
   extended additively (same shape family as today's `{ansi?, hash, unchanged?}`): add `text?:
   string` and `kind?: "tmux" | "container-logs"` as new OPTIONAL fields, never a discriminated
   union. This is also the correct fix for two confirmed majors below (wire-compat, deploy skew):
   an old app decoding a new gateway's reply, or a new app decoding an old gateway's still-bare
   reply, both degrade safely under kotlinx's nullable-optional defaults - no `MissingFieldException`
   risk, unlike a required discriminant would create.

Confirmed majors folded into the plan (each maps to a Phase edit below): the tmux ambiguous
prefix-match risk on session names (ANY session-name-targeted tmux op, not just the new fallback -
closed by exact-match target syntax); `close_session` silently no-oping during an in-flight wake
(a "closed" session could resurrect once the wake completes); `terminalMode`'s default needing a
durable signal (session `status`) rather than a one-time "just created" flag, so a stuck session
rediscovered later - not just at creation - still opens into the terminal view; the daemon's
shared peek-concurrency budget needing to account for `docker logs`'s more variable cost; missing
`close_session` unit tests and a backward-compat decode test. The `PendingCreateCard`
retire-vs-sliver question (flagged non-blocking last lap) was confirmed by the audit to actually
matter - not a wash either way - so it is now settled below rather than left open.

Deferred as genuinely out-of-scope/minor (not folded in, no plan risk): a handful of file-list
completeness reminders (consoleHandler.ts's peek case, existing unit test updates, Android's
current null-checked-but-kind-unaware peek consumers) that are natural consequences of the Phase A/
B edits already specified, not separate design decisions; race #3 (a peek racing the exact
not-existing-to-existing transition) is a bounded, cosmetic flicker with no correctness impact;
`close_session`'s exemption from `assertDaemonDrivable` matches `forget`'s existing, deliberate
precedent.

## Known residuals (backend lap, red-team-accepted)

- **close-vs-wake TOCTOU is narrowed, not eliminated.** `close_session`'s `isWakeInFlight` check is
  a single synchronous read before the kill's `await`; a wake triggered in that window (another
  window's `crosstalk_send`, a concurrent `create_session`) by a DIFFERENT actor can still complete
  after the kill and re-launch the session. Accepted: it requires two actors racing the same session
  inside a sub-second window, is human-recoverable (close again), and matches the codebase's existing
  posture on wake races (see `plans/pain-points.md`). A full fix (a close-in-progress lock the wake
  side consults) is deferred, not built this lap.
- **close keeps no explicit liveTeam bookkeeping.** After a successful kill, `close_session` relies
  on the killed pane's own WS teardown to clear `liveTeam` (the same mechanism `forget` uses), so
  `teams()` may briefly still read the session online until that WS drop lands. Inherent and
  consistent with `forget`.
- **peek's container-logs leg adds a third sequential exec, but cannot exceed the 20s host-op
  timeout.** The fallback is reached only on an `absent` capture (a fast non-zero exit, never an 8s
  timeout - a capture TIMEOUT classifies as `failure` and skips the fallback), so the worst
  reachable path is resize (<=8s, near-instant in practice) + fast absent capture + `docker logs`
  (<=5s) ~= 13s, under the 20s budget.

## UX correction (owner feedback, supersedes the placeholder + navigate-on-create decisions)

The owner rejected the two-card board (a separate spinner placeholder card alongside the real
session card) shown in a live screenshot: "replace that spinner tile with the main tile as soon as
docker responds... the placeholder should probably be the actual session." Corrected model:

- **One tile per session.** The whole `PendingCreate` placeholder mechanism is DELETED (data class,
  `reconcilePendingCreateList`, state, `beginCreateSession`/`endCreateSession`, `PendingCreateCard`,
  its test, the timeout const). The gateway adopts a session's record synchronously on
  `create_session`, so the normal `SessionCard` (via `teams()`) is the only tile.
- **Spinner on the session tile while it comes up.** The gateway now reports an asleep record with a
  wake in flight as `verifying` (not `available`) - `routes.ts teams()` reads an injected
  `isWakeInFlight`. So a spawned/woken session reads `verifying` from spawn through the MCP
  handshake, and `SessionCard` shows a `CircularProgressIndicator` for `status == "verifying"`. This
  is the reliable signal; the earlier `working`-based guess never fired during the actual boot.
- **Spawn stays on the board** (no auto-navigate). `onSpawn` just calls `repo.spawnSession`.
- **Tap opens the terminal until fully handshaked.** `terminalMode` defaults on for
  `status in {null, available, verifying}` (terminal view: docker logs then tmux); `online`
  (handshake confirmed) opens chat. `wakePending` keys off `verifying` too.

Accepted tradeoff: a backgrounded (post-25s-bound) cold-container create failure drops its tile off
the board on the next `teams()` refresh with no message (the vanishing tile is the signal); the old
11-minute placeholder timeout message is gone with the placeholder.

## Known residuals (Android lap, red-team-accepted)

- **Close removes the tab optimistically.** `closeTab` drops the local tab immediately, then fires
  `close_session` best-effort; a gateway refusal (mid-wake, or a user-launched session) surfaces a
  transient message but the tab is already gone. Accepted by design: a tab is a local view, the
  session's record survives (Close keeps the store), so it stays on the board and is reopenable, and
  the refusal message explains why it was not killed. Blocking the tab close on a network round-trip
  would be worse UX.
- **The terminal view peeks continuously while open, with a capped backoff.** Since the view always
  peeks (needed so a booting session shows its logs), an asleep/stuck/user-launched session that is
  left open keeps peeking. It backs off to 8x the base cadence on consecutive failures and only runs
  while the thread is open and RESUMED (foreground), so it is bounded, not a background drain.

## Implementation status

- **Lap 1 (backend): DONE + gated green.** Phase A (daemon peek fallback + exact-match tmux
  targeting), Phase B (gateway peek discriminant + `close_session` op), and Phase D's TS+Kotlin
  fixtures are implemented. Gates passing: `bun run lint` clean, `bun run test` 865 passing,
  codegen idempotent (no drift), Android `:app:testDebugUnitTest` BUILD SUCCESSFUL (Kotlin compiles,
  fixture decoders pass). Additive-safe: old app ignores the new optional peek fields; `close_session`
  is a new op an old app never sends; peek still returns `ansi` for a live pane.
- **Lap 2 (Android UI): pending.** Phase C - navigation on create, terminal-view rendering of the
  container-logs vs tmux frame, the Wake button, Close Tab wiring.

## Plan

### Phase A - daemon: peek falls back to container logs

- `mcp/devcontainer/tmuxCore.ts`: new `captureContainerLogs(target)` - `docker logs --tail <N>
  <containerName(target.name)>` (same container-name convention `peek`/`tmux_send` already use,
  no new discovery logic), bounded tail + a byte cap mirroring `MAX_CAPTURE_BYTES`. Give it its own
  (shorter) timeout rather than reusing `EXEC_TIMEOUT_MS` unexamined - a heavily-logging
  devcontainer's `docker logs` call is a materially different cost profile than a tmux
  capture-pane, and must not be able to starve `hostOpRunner.ts`'s shared peek concurrency slots
  for OTHER unrelated sessions' cheap, healthy tmux peeks.
- All session-name-targeted tmux invocations (`hasSession`, capture-pane, `kill-session` - both the
  existing ones and this new fallback path) use tmux's exact-match target syntax (`-t =<name>`)
  rather than a bare `-t <name>`, closing the ambiguous-prefix-match risk on sibling session names
  (e.g. `story` vs `story-designer`) outright rather than relying on the current naming convention
  never colliding. This applies to `killSession` too (shared by `forget` and the new
  `close_session`), since a same-project sibling-session mismatch there would kill the wrong pane.
- **`peekPane()` itself is UNCHANGED** (signature, reject-on-absent behavior, flat `{ansi,hash}`
  return) - `awaitReady` (`tmuxCore.ts:304`) and both `handleWake` call sites
  (`hostDaemon.ts:243-244`, `:300`) keep calling it directly, preserving dead-launch detection and
  the reattach-recheck exactly as today.
- NEW `peekWithFallback(target)`: tries `peekPane`, and on an `errorKind:"absent"` classification
  (the existing "calm, still-booting" bucket - not a real failure), falls back to
  `captureContainerLogs` instead of surfacing the absence as an error. If the container itself
  isn't running yet either (docker logs also fails - the true Offline sub-moment), surface today's
  existing absent/failure result unchanged; the client already has a generic waking fallback for
  that brief window, no new UI needed for it. `hostDaemon.ts:355-356`'s `TmuxOps.peekPane`
  assignment (the seam `hostOpRunner.ts`'s console-facing peek case actually calls) points at this
  new wrapper instead of raw `peekPane` - the ONLY call site that changes.
- `shared/host-op.ts`: `HostPeekResult` (the type `peekWithFallback` returns) becomes a
  discriminated union (`{kind:"tmux", ansi, hash} | {kind:"container-logs", text, hash}`) instead
  of the current flat `{ansi, hash}` - safe here specifically because this type is host-WS-only
  (type-only, no codegen, no console-facing exposure per the file's own header), unlike the
  console-facing schema in Phase B.

### Phase B - gateway: console-facing peek result + new `close_session` op

- Extend the console-facing peek result schema (`ConsolePeekResultSchema`, `shared/schemas.ts:
  579-588`, today a flat `{ansi?, hash, unchanged?}`) ADDITIVELY: add `text?: string` and `kind?:
  z.enum(["tmux","container-logs"])` as new optional fields - explicitly NOT a
  `z.discriminatedUnion` (see Refinement above: the codegen's `SEALED_ROOTS` only covers
  encode-side unions; a decode-side union root silently emits no Kotlin class at all). Regenerate
  `Protocol.kt`; confirm the regenerated class still has every field the flat shape needs.
- New sealed op `close_session {target}` (identical shape to `forget`) added to `ConsoleOpSchema`;
  new `ConsoleCloseSessionResultSchema {closed: boolean}` added to the result union (a named
  member is required for codegen, per the existing convention). Add `"close_session"` to
  `isMutatingOp`'s literal list explicitly (easy to silently omit, since it is not called out
  anywhere else - would otherwise skip the idempotency cache for this op).
- `consoleHandler.ts`: new `case "close_session"` - copy `forget`'s body (`:807-823`) verbatim
  minus the `dropSessionResume?.(name)` line. Same target validation (reject a bare spawn-point,
  the same reserved-host-session and cross-gateway guards `forget` already carries via
  `resolveTmuxTarget`), same `killSession` HostOp call (now exact-match per Phase A), same
  `(conversationId, opId)` dedup key. Before issuing `killSession`, check whether a wake is
  currently in-flight for this team (the same in-flight-wake bookkeeping `tryWakeTeam` already
  keeps) - if so, reject with a clear "a wake is in progress; wait for it to finish before
  closing" error instead of silently no-op-succeeding (a no-op close would let the in-flight wake
  complete afterward and resurrect the session the human just closed).
- Regenerate Kotlin via `bun scripts/codegen-kotlin.ts`.

### Phase C - Android: navigation, terminal view, Wake button, Close Tab

- The moment `create_session`'s reply carries `{id, sessionLabel}` (already wired per the shipped
  create_session v2 path), open the thread immediately at that address instead of waiting on a
  `teams()` poll to reflect it - satisfies Q1. **Settled (was flagged non-blocking last lap; the
  audit confirmed it actually matters)**: `PendingCreateCard` is retired the instant the id is
  known, in favor of the normal session-list rendering picking it up (fully unifying the create
  and resume paths) - keeping the standalone card any longer produces a non-clickable ghost
  placeholder sitting next to (or instead of) the real, now-navigable entry for the same session.
- `TerminalView`: render the (now flat, optional-`kind`-carrying) peek result - `kind ===
  "container-logs"` as read-only scrollable text (no input bar, no `tmux_send` affordance at all);
  `kind === "tmux"` (or absent, for back-compat against an old gateway) exactly as today. Default
  `terminalMode` on based on the session's CURRENT `status` field (`available`/`verifying` ->
  terminal mode; `online` -> normal chat default) rather than a one-time "just created" flag - a
  stuck session rediscovered later (a fresh app launch, a different device) must also open into
  the terminal view, not just the session that was present at creation time.
- A centered "Wake" button when peek indicates no container/tmux for this session and no wake is
  already in flight. Taps call the existing `tryWakeTeam` path unchanged - no warmth-awareness
  needed (Q3-followup). A redundant tap is already safe: `tryWakeTeam` dedups in-flight wakes
  per-team server-side, so the button need not track in-flight state precisely.
- `terminalEligible` (`MainActivity.kt:567-568`) likely needs NO change - it already does not
  gate on status/liveness, only on local-composite + matching gateway, so an `available`/
  `verifying` session should already pass it today; confirm this holds once wired end to end.
- `ChatRepository.closeTab`: keep the existing local `openTabs` removal, add a `close_session` op
  call (tolerate failure with a snackbar, matching the app's existing transient-error pattern; the
  local tab-close is not blocked by it; surface the new "wake in progress" rejection from Phase B
  the same way).

### Phase D - fixtures, docs, gates

- New golden protocol fixtures for the extended (flat) peek result and the new `close_session`
  op/result, registered in `_manifest.json` and both runtimes' hardcoded schema maps (vitest +
  `ProtocolFixturesTest.kt`). Include a backward-compat decode pair: an old gateway's bare
  `{ansi?, hash, unchanged?}` reply decoding fine against the NEW Kotlin class (no
  `MissingFieldException`), and vice versa (old app decoding a new gateway's reply with the extra
  optional fields present, via `ignoreUnknownKeys`).
- `src/__tests__/console-handler.test.ts`: behavioral unit tests for `close_session` mirroring the
  `rename_session` precedent already in that file (target validation, dedup, the in-flight-wake
  rejection).
- `CLAUDE.md`: Console Bridge ops list gains `close_session`; Console terminal view section notes
  the docker-logs/tmux state machine.
- Gates: `bun run lint && bun run test`; Android `testDebugUnitTest`; live-verify against the
  actual `story-designer` stuck-at-login case from tonight (docker logs visible while it's still
  Offline/Available, tmux visible the moment it exists - including showing the stuck login prompt
  itself, which is exactly the case that started this whole investigation).

Open, non-blocking questions for the next refinement pass or implementation time: the exact name
for the new peek-result fields (`text`/`kind` as drafted above, open to a better name); exact
read-only-log-view visual treatment (a banner label, monospace styling, etc); whether tmux's `-t
=<name>` exact-match syntax needs any compatibility check against the installed tmux version.

## Painpoints

Read-only crust sweep of the touched surface (5 scouts). Record only, NOT fixed - follow-up work,
not gates on this plan. Most-actionable first.

**Pre-existing bug-classes this feature threw into relief (worth a near-term follow-up):**
- `src/gateway/console/consoleHandler.ts : forget` - **bug-class** - `forget` has NO
  `isWakeInFlight` guard, though `close_session` (its new sibling) added exactly that. A `forget`
  fired mid-wake kills a not-yet-up pane (no-op) then the in-flight wake completes and re-mints the
  record on confirm - resurrecting a session the human PERMANENTLY forgot (worse than close's
  keep-record case). Give forget the same guard.
- `android/.../ChatRepository.kt : forget` - **bug-class** - `forget()` deletes local state
  synchronously then fires `client().forget(team)` in a bare `runCatching` with NO `onFailure`, so a
  gateway-side failure is swallowed silently, leaving the UI showing the session gone while its tmux
  + record may still be alive. `closeTab`/`wakeSession` (same commit) both attach an `onFailure`
  transient message; forget, the more destructive op, was left the odd one out.

**Dead code from the `updateCreateSession` removal (a clean-up cascade this feature opened):**
- `android/.../ChatRepository.kt : PendingCreate : expectedTeamName, status` - **dead-code** -
  both fields are now write-once-to-default (nothing sets them); the kdoc admits it but the fields
  remain live and are still read downstream.
- `android/.../ChatRepository.kt : reconcilePendingCreateList : matched-by-expectedTeamName branch`
  - **dead-code** - `matched` can never be true in prod (expectedTeamName always null); retirement
  now happens via `onSpawn`'s direct `endCreateSession`, bypassing this function's success path. It
  only ever returns still-pending or timed-out now.
- `android/.../MainActivity.kt : PendingCreateCard : status == "waking-docker" branch` -
  **dead-code** - unreachable (status never leaves "creating"); the card renders "Creating..."
  unconditionally, the "Waking Docker..." string is inert.
- `android/.../PendingCreateReconcileTest.kt` - **dead-code / stale-name** - three tests exercise
  the dead matched-by-name branch (false confidence); one comment references the removed
  `updateCreateSession`. The real retirement path (onSpawn -> endCreateSession) is untested.
  A clean follow-up removes `expectedTeamName`/`status` from `PendingCreate`, simplifies
  `reconcilePendingCreateList` to timeout-only, collapses `PendingCreateCard` to one text, and
  rewrites the test.

**Dup-logic introduced by close_session (a shared helper would fold it):**
- `consoleHandler.ts : forget / close_session` - **dup-logic** - close_session hand-duplicates
  forget's target-validate + composeSessionName + resolveTmuxTarget + dedupKey + killSession tail;
  only the error verb and the drop-vs-keep-record delta differ. Should be one parameterized helper.
- `consoleHandler.ts : close_session vs assertDaemonDrivable` - **dup-logic** - close_session
  inlines the alias-detection condition already in `assertDaemonDrivable`, and leaves that helper's
  docstring stale ("close_session ... exempt" - it actually enforces the check itself now). A future
  edit to the condition silently diverges the copy.
- `android/.../ChatRepository.kt : closeTab/forget/wakeSession` - **dup-logic** - each repeats the
  identical 2-line "is this a local addressable session" guard; extract one predicate.

**Stale names from run() now serving docker too (commit 3f165e8):**
- `src/shared/host-op.ts : classifyPeekError` - **dead-code** - the `"tmux command exited"`
  substring branch is now partly dead: `run()`'s fallback message became `"command exited N"`, so
  that branch only matches a caller still emitting the tmux wording; the default already returns
  "failure", so behavior is unchanged.
- `src/mcp/devcontainer/tmuxCore.ts : run()` - **stale-name** - the timeout rejects with
  `"tmux command timed out"` even for a `docker logs`/`docker exec` argv (run() is shared now). The
  message is internal-only (captureContainerLogs swallows + rethrows the original), so it is cosmetic.

**Minor Android state-machine watch items (post-fix):**
- `android/.../TerminalView.kt : showOffSession user-launched branch` - **legacy-landmine** - the
  calm-vs-wake distinction keys on `peekError?.contains("user-launched")`, a substring match on a
  gateway message string. The gateway does not surface a machine-readable errorKind to the console
  result, so this is the only signal; a message reword would silently flip the branch.
- `android/.../TerminalView.kt : showOffSession generic branch` - **cosmetic** - a genuine
  non-absent failure (a persistent timeout) renders "This session is asleep." rather than the actual
  error text (peekError is used only to gate + test the user-launched substring). Tapping Wake
  retries, so it self-heals, but the label is imprecise for a true failure.
- `android/.../MainActivity.kt : ThreadScreen : terminalMode` - **cosmetic** - the comment says
  "an unrecognized status opens chat" while the seed lumps `null` (unknown) in with the
  asleep/booting set that opens terminal; the intent (null = a fresh create) is right, the comment
  wording is loose.

**Also flagged (pre-existing, out of this feature's scope):**
- `consoleHandler.ts : create_session rollback sites` - **bug-class** - both rollbacks call
  `sessionStore.forget(...)` on `!ok` with no re-check of `confirmedAt`/live-incarnation, so a launch
  that reports failure after the session actually confirmed could drop a live record. (Same class as
  the handshake-linkage plan's documented rollback races.)
