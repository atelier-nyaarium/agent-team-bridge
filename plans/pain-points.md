# Pain points

Residual painpoints from shipped work, collected by crust scouts (record only, not fixed). Refs are
`file : scope : name`; severity in brackets.

## Pre-handshake terminal view (PR #108, 2026-07-07)

Migrated from `plans/pre-handshake-terminal-view.md` (deleted, shipped) so its still-open residuals
are not lost. Verified still-present in current code at migration time.

- [high] `src/gateway/console/consoleHandler.ts : forget` - **bug-class** - `forget` has no
  `isWakeInFlight` guard, though its sibling `close_session` added exactly that guard. A `forget`
  fired mid-wake kills a not-yet-up pane (no-op), then the in-flight wake completes and re-mints the
  record on confirm - resurrecting a session the human PERMANENTLY forgot (worse than close's
  keep-record case). Give forget the same guard.
- [high] `android/.../ChatRepository.kt : forget` - **bug-class** - `forget()` deletes local state
  synchronously then fires `client().forget(team)` in a bare `runCatching` with no `onFailure`, so a
  gateway-side failure is swallowed silently, leaving the UI showing the session gone while its tmux
  + record may still be alive. `closeTab`/`wakeSession` both attach an `onFailure` transient message;
  forget, the more destructive op, was left the odd one out.
- [medium] `consoleHandler.ts : create_session rollback sites` - **bug-class** - both rollback paths
  call `sessionStore.forget(...)` on `!ok` with no re-check of `confirmedAt`/live-incarnation, so a
  launch that reports failure after the session actually confirmed could drop a live record. Same
  class as the (now-deleted) handshake-linkage plan's documented rollback races.
- [medium] `consoleHandler.ts : forget / close_session` - **dup-logic** - close_session
  hand-duplicates forget's target-validate + composeSessionName + resolveTmuxTarget + dedupKey +
  killSession tail; only the error verb and the drop-vs-keep-record delta differ. Should be one
  parameterized helper.
- [low] `consoleHandler.ts : close_session vs assertDaemonDrivable` - **dup-logic** - close_session
  inlines the alias-detection condition already in `assertDaemonDrivable`, and leaves that helper's
  docstring stale ("close_session ... exempt" - it actually enforces the check itself now).
- [low] `android/.../ChatRepository.kt : closeTab/forget/wakeSession` - **dup-logic** - each repeats
  the identical 2-line "is this a local addressable session" guard; extract one predicate.
- [low] `android/.../TerminalView.kt : showOffSession user-launched branch` - **legacy-landmine** -
  the calm-vs-wake distinction keys on `peekError?.contains("user-launched")`, a substring match on a
  gateway message string with no machine-readable errorKind backing it; a message reword silently
  flips the branch.
- [low] `android/.../TerminalView.kt : showOffSession generic branch` - **cosmetic** - a genuine
  non-absent failure (a persistent timeout) renders "This session is asleep." rather than the actual
  error text. Tapping Wake retries, so it self-heals, but the label is imprecise for a true failure.
- [low] `src/shared/host-op.ts : classifyPeekError` + `src/mcp/devcontainer/tmuxCore.ts : run()` -
  **stale-name** - error-message wording still says "tmux command ..." for what is now a shared
  tmux/docker `run()` helper; cosmetic, internal-only strings.

## Handshake-established session linkage (PR #107, 2026-07-02)

Migrated from `plans/handshake-session-linkage.md` (deleted, shipped) so its still-open residuals are
not lost. The plan's own "Cosmetic DRY (declined - no correctness gain)" items are dropped here as
closed decisions, retrievable from git history if reconsidered.

- [high] `src/gateway/websocket.ts : createWebSocketHandlers : establishRecord` - **bug-class** -
  first-binding-holds only refuses a LIVE holder, so an asleep holder lets tier-1 bindBySegment bind
  the same claudeSessionId onto a second record, breaking one-record-per-transcript and spawning
  duplicate `--resume` processes on wake. Needs a resumeRecord check even when the holder is asleep.
- [medium] `src/shared/session-store.ts : SessionStore : sweep` - **bug-class** - TTL sweep can drop a
  still-connected record because lastSeen is refreshed only by teams()->touchLive (never the
  heartbeat), making a live session invisible in teams() and re-mintable while resolveLiveIncarnation
  still routes to it. 30-day window; fix is to touchLive from the heartbeat or spare live records.
- [medium] `src/gateway/websocket.ts : createWebSocketHandlers : resolveHandshake` - **bug-class** -
  `ws.data.handshakeConfirmed` is set before establishRecord, so a first-binding-holds refusal leaves
  a confirmed-but-recordless socket that resolveLiveIncarnation reports as canonical live, producing a
  routable-but-invisible duplicate. Set confirmed only after establishRecord succeeds.
- [low] `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : handleFrame` -
  **bug-class** - opCache evicts oldest past size 256 regardless of settle state; a retried opId older
  than 256 re-runs its op, losing at-most-once for side effects with no host-side dedupKey backstop.
- [low] `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : mintedSessionId` -
  **bug-class** - 6-hex (24-bit) sha256 truncation with no re-roll on the deterministic create path;
  two colliding (conversationId, opId) creates in one spawn silently reattach instead of minting.
- [low] `src/shared/session-store.ts : SessionRecord : workdirHint` - **dead-code** - written,
  sanitized, persisted, restored but never read; the daemon infers workdir from the session id.
- [low] `src/gateway/routes.ts : createRoutes : send (channelOnly CLI-mode guard)` - **dead-code** -
  unreachable since ConnectionMode is single-value "channel"; names a concept retired with the host
  split.
- [low] `android/.../ChatRepository.kt : ChatState : label` - **stale-name** - the localGatewayId
  parameter is unused by the body yet still threaded through all six call sites.
- [low] `src/shared/session-id.ts : Address` - **framework-violation** - Address/SpawnPoint own
  `.canonical` but not a locality predicate or local-team-field projection, forcing every gateway
  caller to hand-reimplement it (feeds the dup-logic items below).
- [low] `src/gateway/routes.ts : createRoutes : localAddress` - **dup-logic** - the
  `parseSessionName -> Address.local(...)` builder is triplicated (routes, consoleHandler,
  gatewayRelay), each carrying a "must match byte-for-byte" comment.
- [low] `src/gateway/console/consoleHandler.ts : local-gateway check` - **framework-violation** - the
  raw `t.domain !== localDomain || t.gateway !== localGatewayId` locality test is reimplemented at 5+
  sites; belongs on an `Address.isLocalTo` predicate.
- [low] `src/gateway/console/consoleHandler.ts : SpawnPoint->local-name collapse` - **dup-logic** -
  the `t instanceof SpawnPoint ? t.spawn : composeSessionName(t.spawn, t.session)` collapse recurs
  across 6 sites.
- [low] `src/gateway/console/consoleHandler.ts : dedupKey / mintedSessionId` - **dup-logic** - the
  `${conversationId}:${opId}` idempotency key is spelled inline in four ops and re-hashed separately.
- [low] `src/gateway/federation/gatewayRelay.ts : createGatewayRelayHandler : localKind` -
  **dup-logic** - "what kind is this session" materializes the whole teams() array and `.find()`s it
  in 3 sites; should share one kind-classifier with teams().
- [low] `src/gateway/index.ts : startGateway : doWakeTeam / relayToHost host-ws resolution` -
  **dup-logic** - the live-host-socket lookup is copied verbatim in doWakeTeam and relayToHost.
- [low] `src/gateway/routes.ts : createRoutes : sealTargetFor` - **dup-logic** - re-encodes the
  sealer's local-then-cross-Domain-then-throw precedence that sealer.seal resolves again.
- [low] `src/gateway/routes.ts : createRoutes : localDomain sentinel normalization` - **dup-logic** -
  the LOCAL_DOMAIN_SENTINEL fallback is applied three inconsistent ways.
- [low] `src/gateway/index.ts : startGateway : SCHEMA_VERSION one-shot wipe` - **legacy-landmine** -
  removable once all gateways have booted past schema-2.
- [low] `src/shared/session-store.ts : SessionStore : restore()` - **legacy-landmine** (tracked) - the
  `!persisted` branch reads the old resume-map shape; dead once all gateways re-write
  session-resume.json.
- [low] `src/gateway/index.ts : startGateway : LOG_DIR legacy-dir cleanup` - **legacy-landmine** -
  dies with the schema-wipe block above.
- [low] `src/shared/schemas.ts : TeamInfoSchema.gatewayId / ConsoleRegisterResultSchema.gatewayId` -
  **legacy-landmine** - comments describe the retired slash grammar; live grammar is the dot path.
- [low] `src/shared/schemas.ts : WsRegisterSchema.claudeSessionId` - **legacy-landmine** (tracked) -
  comment describes a `team -> claudeSessionId` map that SessionStore replaced.
- [low] `src/shared/session-id.ts : module header` - **legacy-landmine** - narrates the unified-address
  migration as in-progress though it is already complete.
- [low] `src/gateway/console/consoleHandler.ts : ConsoleHandlerDeps.domainStatus` -
  **legacy-landmine** - pre-feature-evie fallback branch, removable once all pods report domainStatus.

## Host session resume (PR #100, 2026-06-29)

### In the shipped code - worth a near-term follow-up

- [high] `hostDaemon.ts : handleWake : host branch` - the host reattach runs `awaitReady` (a full
  ~90s poll budget) BEFORE the dead-shell check, then on a dead shell kills and runs `awaitReady`
  again - up to ~180s before `wake_result`. The devcontainer branch avoids this by peeking once for a
  reattach and only `awaitReady`ing a fresh `created` launch. Fix: peek-first in the host reattach
  (return immediately if ready/working), reserve `awaitReady` for the post-relaunch path.
- [medium] `hostDaemon.ts : buildLaunchCommand : effort` - the model/effort flags are hardcoded for
  every host session including resumes, so a host agent relaunches on its hardcoded tier on each wake
  with no signal. STILL OPEN: `handshake-session-linkage.md` deliberately left SessionRecord carrying
  no model/effort (out of that plan's scope); persisting/restoring them, or surfacing the reset, is
  follow-up work.
- [medium] `shared/host-op.ts : HostOp : createSession` (+ `hostDaemon.ts : hostOpRunner.createSession`)
  - the `create_session` op carries no `resumeSessionId`, so tapping "New Session" on a host name the
  gateway already has a resume id for starts fresh and abandons the saved transcript. Only the wake
  path resumes. Decide whether create_session should offer resume.
- [medium] `hostDaemon.ts : hostOpRunner.createSession` - returns `{created:true}` as soon as the tmux
  exists (fire-and-forget `awaitReady`), while `handleWake` blocks on readiness; the asymmetry means a
  console create_session reports success before the REPL is up.

### Trust surface - all chain off the unauthenticated `/bridge` register + `/send`

Owner-deferred (decision A); the root fix is `plans/gateway-auth-surface.md`. The host-resume lift
widens the blast radius of the pre-existing hole, it does not create it.

`plans/handshake-session-linkage.md` PARTIALLY closed the seeded-phantom-card sting below: a record
now needs a completed lead handshake (the raw register path does zero store work), and a failed
send-wake rolls back the provisional record it created, so a typo'd or dead send no longer leaves a
phantom "available" card. It did NOT close the underlying unauthenticated `/bridge` surface - a
malicious unauthenticated flood still grows the store unboundedly (no count cap) - so full closure
stays with `gateway-auth-surface.md`. The `host.foo` reserved-guard and `claudeSessionId`-format
items below are unchanged.

- [high] `websocket.ts : createWebSocketHandlers : message` - the host-token gate + `RESERVED_TEAM_NAMES`
  match the bare `host` exactly, so a composite `host.foo` bypasses both. Recording moved to
  confirm-time (`establishOnConfirm`), so writing an attacker-controlled `claudeSessionId` now needs a
  completed lead handshake or a send-wake (see the partial-closure note above); a bare register writes
  no record.
- [medium] `routes.ts : teams` - an attacker-seeded `host.foo` passes the asleep-listing guards
  (`host` is a valid slug) and surfaces as a phantom available card.
- [medium] `index.ts : doWakeTeam` - the reserved guard only blocks `host-daemon`; any other `host.*`
  is woken with the attacker's `resumeSessionId` forwarded.
- [medium] `index.ts : sessionResume` - no entry-count ceiling (only the 30-day TTL), so unauthenticated
  composite registers can grow the map and `session-resume.json` unboundedly.
- [medium] `routes.ts : isDevcontainer` - unions trusted `offlineCatalog` with untrusted
  `knownTeamPaths` (also tracked in `plans/host-daemon-cleanup.md`).
- [low] `schemas.ts : WsRegisterSchema : claudeSessionId` - `z.string().optional()` with no format
  constraint at the wire boundary; the only defense is `buildLaunchCommand`'s regex in another module.

### Naming / dead code (mostly pre-existing)

- [medium] `host-op.ts : TMUX_NAME_RE` + `session-id.ts : SLUG_RE` + `host-op.ts : CONVERSATION_ID_RE`
  - the same `/^[a-z0-9][a-z0-9-]*$/` defined in three places (differing only in length caps).
- [medium] `host-op.ts : TmuxTarget : kind` - the string `"host"` carries five roles (address spawn
  segment, reserved WS slot, `TmuxTarget.kind`, the reserved-session host, the daemon register name);
  easy to conflate.
- [low] `hostDaemon.ts : findProjectPath` vs `resolveHostWorkdir` - parallel projectDirs walkers with
  divergent fallbacks (`findProjectPath` falls back to `projectDirs[0]` only; `resolveHostWorkdir`
  tries all then HOME).
- [low] `routes.ts : getTeamMode` - its own docstring says it is effectively always `"channel"` (the
  CLI dispatch path was retired); the non-channel branch is dead.
- [low] `tmuxCore.ts : STARTUP_PROMPT_RE` / `isAgentReady` / `isAgentWorking` / `isLoggedOut` and
  `host-op.ts : classifyPeekError` - wake/chip/logout detection is coupled to Claude-Code TUI strings +
  glyphs and docker/tmux stderr text; already tracked as fragility in `plans/host-daemon-cleanup.md`.

## Console device-name address (PR #99)

### init-order `_state`-access NPE class
`loadPersisted*` run during `_state` construction (before `_state` is assigned), so anything they
reach that reads `_state.value` NPEs and a surrounding `runCatching` swallows it silently (exactly the
`isAddressKey` bug, now fixed by passing `""`). These siblings read `_state.value` via `localDomain()`
-> `confirmedDomainId()` and are SAFE today only because nothing calls them during construction - each
breaks the moment it becomes init-reachable:
- `ChatRepository.kt : canonicalTarget`
- `ChatRepository.kt : fromCanonical`
- `ChatRepository.kt : thisDeviceAddress`
- `ChatRepository.kt : forget` (also reads `_state.value.localGatewayId` directly)
Durable fix (deferred): make `confirmedDomainId()` / `localDomain()` null-safe (return `""` when
`_state` is not yet initialized), retiring the class.

### `PROJECT_NAME` / `from` not slug-validated -> `localAddress` throws
`PROJECT_NAME` is read from env and propagated as the sender `from` with no slug check, so a non-slug
value (spaces/caps) makes `localAddress(from)` throw uncaught:
- `src/mcp/index.ts : startMcp` - the root: `PROJECT_NAME` is never asserted to be a slug
- `src/gateway/routes.ts : humanNotify` - `localAddress(from)` (the schema validates length, not slug); a non-slug `PROJECT_NAME` crashes `/human/notify`
- `src/gateway/routes.ts : sendCrossGateway` - `localAddress(from)` on an agent cross-Gateway send throws on a non-slug team field

### non-address fallback leaks
- `ChatRepository.kt : canonicalTarget` - `runCatching { parseTarget(...).canonical }.getOrDefault(team)` returns the raw `team` on failure, then used as a thread-lookup key + openTabs membership; the same class fixed in `fromCanonical` (which now returns null). A malformed team silently misses rather than corrupts, so lower severity.

## Session id teardown (`plans/session-id-teardown.md`, found during Phase B red-team)

- [low] `android/.../MainActivity.kt : RenameDialog` - **bug-class** - the blank-vs-prefill guard
  `if (current == team) "" else current` compares a `spawn.session`-shaped `team` against a bare-segment
  `current` (from `sessionLeaf()`), a structural mismatch that can never actually equal for a non-empty
  project name - so an unlabeled session's Rename field always pre-fills with the raw id instead of
  starting blank. Rarely fires today (sessionLabel is populated from the user's typed text at creation
  time), and pre-dates the id-minting work entirely (the guard would misfire identically for a slug or a
  hex id). Fix: compare `current` against the session's own leaf segment, not the qualified `team`.
- [low] `android/.../ChatRepository.kt : spawnSession` - **bug-class** - `runCatching { withContext(Dispatchers.IO) { client().createSession(...) } }` catches `CancellationException` like any other `Throwable`, so if the Activity's coroutine scope is cancelled (a config change, e.g. device rotation) while the blocking OkHttp call is still in flight, a create that actually succeeded server-side still surfaces a "Failed to create" Snackbar on the freshly recreated Activity (`_state` is a process-lifetime singleton, so the stale message reaches the new Activity's `LaunchedEffect`). Self-correcting (the real session appears via the next `teams()` poll) and non-destructive, so left unfixed; a proper fix would re-throw `CancellationException` rather than let `runCatching` swallow it.
- [low] `android/.../ChatRepository.kt : rename` - **bug-class** - no debounce, cancellation of a prior in-flight attempt, or per-team sequencing exists for `rename()`, so submitting several rapid renames on the SAME team before any of them resolves lets the final label be decided by whichever network reply lands last rather than by click order. Each call's own staleness guard (added in the Phase C red-team pass) stops any of them from clobbering a value a later call already established, so the failure mode is "an earlier click can still win over a later one," not data loss. A full fix needs per-team request sequencing (a generation counter or a cancelling `Job` per team, keyed like `recentSpawnOpIds` in `spawnSession`).
- [low] `android/.../ChatRepository.kt : shareableSessions` - **bug-class** - the filter reads `localGatewayId`, a `ChatRepository`-private `@Volatile var` distinct from `ChatState.localGatewayId` (the field Compose actually observes via `collectAsState()`); `admitGateway()` writes the former with no corresponding `_state.update`, so the two can transiently diverge with nothing to force a recomposition when only the private var changes. Pre-existing (predates the id-teardown work); narrow (the var only ever changes once, at enrollment).
- [medium] `android/.../Sharing.kt : SharingScreen` - **bug-class** - the per-session share-audience map (`shares`, Private/Everyone/Specific) and the "trust first" roster (`trustFirst`) are populated only once via `LaunchedEffect(Unit)` and re-populated only by this same screen's own mutating actions (`onSetMode`/`onToggleDomain`, each calling the shared `refresh()`); neither reacts to `state` changing for an external reason (a Domain linked/unlinked elsewhere, a session appearing/disappearing) while the screen stays mounted. Two concretely reachable consequences: `modeSummary()`'s fallback renders the raw internal `domainId` string once a shared Domain drops out of the live `people` list but is still recorded in the stale `shares` entry; the Specific-people picker can show the same person twice in contradictory states (a live, correctly-checked row from `people`, and a stale disabled "trust first" row from the one-shot snapshot, since `trustFirst` never removes someone once they become linked). Pre-existing, unrelated to the id-teardown work (Phase D's `collectAsState()` change only touched `sessions`/`people`, not `shares`/`trustFirst`); the only present workaround is leaving and re-entering Sharing. Would need `refresh()` (or at least `trustFirst`'s recompute) wired to the same state-driven recomposition Phase D added for `sessions`/`people`.
- [low] `android/.../Sharing.kt : onSetMode/onToggleDomain` - **bug-class** - each handler launches an independent coroutine (write, then `refresh()`) with no per-domain merge, sequencing, or debounce; two fast taps on different rows can race so the first tap's `refresh()` overwrites `shares` with a snapshot that does not yet reflect the second tap's write, visibly reverting that checkbox for a moment until the second tap's own later `refresh()` corrects it. Self-healing (no permanently wrong end state), so lower severity than the frozen-snapshot issue above, but a real, reachable flicker under ordinary fast tapping in the same screen.
- [high] `src/gateway/console/consoleHandler.ts : create_session` (host target) / `gateway/index.ts : inflightCreates` - **bug-class** - a host-target `create_session` never goes through `tryWakeTeam`/`wakeCoordinator` (that path is gated to `target.kind === "devcontainer"` only); it wraps just the fast host-op RPC in `markCreateInFlight`/`releaseInFlight`, and that RPC resolves as soon as `tmux new-session -d` itself launches, not once the Claude CLI inside has booted and completed its MCP handshake (the host daemon's own `createSession` handler fires `awaitReady` fire-and-forget specifically so the RPC stays fast). So `inflightCreates` clears, and `teams()` reports plain `"available"`, while the freshly spawned Claude is still cold-starting - `SessionCard`'s spinner (gated solely on `status == "verifying"`) drops early, showing a state visually identical to a genuinely idle session. Reachable via the board's synthetic Host spawn-point header (any "+" tap on Host). The devcontainer wake path is unaffected - it correctly awaits `wakeCoordinator.waitFor(...)` for the entire boot. Wake-coordination timing, not id/label plumbing; found via Phase F's red-team pass while checking the "live spinner through boot" manual-test claim.
- [low] `android/.../ChatRepository.kt : spawnSession` (labelSanitized Snackbar), `ChatState.withFreshTeams` (vanish-counter window) - **test-coverage** - both mechanisms have gateway-side and/or pure-function test coverage, but the Android-visible behavior they drive is untested: `spawnSession`'s "unsupported characters" Snackbar has zero Android-side coverage (no `ChatRepositoryTest.kt` or `androidTest` suite exists anywhere in the module to extend), and `withFreshTeams`'s `ABSENCE_PRUNE_STREAK` vanish-counter is verified only as a pure function (`ChatStateLabelsTest.kt`) - the actual ~60s on-screen window where a vanished team keeps showing its stale label is not independently verified. Consistent with this codebase's existing testing boundary (pure `ChatState` functions get tests; `ChatRepository`'s suspend/network functions and Compose rendering do not), so left as a documented gap rather than a reason to build new test infrastructure.
- [low] `android/.../ChatRepository.kt : peerSessions/shareableSessions`, `MainActivity.kt : sessionOrder` - **perf** - all three now call `label()`/`labelOrNull()` inside their `sortedBy`/`thenBy` comparator, and `labelOrNull` falls through to an `O(n)` linear scan of `teams` whenever the `O(1)` `labels[team]` map misses - the common case, since `withFreshTeams` actively prunes a team's `labels` entry the moment the server's own `sessionLabel` lands. Degrades an `O(n log n)` sort to worst-case `O(n^2 log n)`. Negligible at this app's realistic session counts (a personal/small-team tool, not thousands of sessions); would need a precomputed `team -> label` map built once before sorting if it ever mattered.
- [high] `android/.../ChatRepository.kt : transientMessage` - **bug-class** - a single nullable `String?` field on `ChatState`, written by five independent async call sites (`spawnSession`, `closeTab`, `wakeSession`, `rename`, and now `rename`'s new foreign-target branch) and drained by exactly one consumer, a `LaunchedEffect(state.transientMessage)` that only exists in composition while `SessionsScreen` is on screen (`MainActivity.kt`'s top-level `when` renders `ThreadScreen` instead whenever a thread is open). Two independent loss mechanisms, pre-existing and not introduced by any single writer: (1) StateFlow conflation - two writes close together can collapse to one emission, silently dropping the earlier message; (2) any write while a thread is open (e.g. a background `closeTab`/`wakeSession`/`rename` failure fired from `ThreadScreen`'s own tab strip) is invisible until the user backs out to the board, and since every write is an unconditional overwrite of the single field, only the last write before that remount can ever surface - an earlier, possibly more actionable message (e.g. a definitive close-refusal reason) is silently discarded in favor of whatever landed last. A proper fix needs either a small queue (list of pending messages, drained one at a time) or an app-scoped consumer (hoisted above the board/thread split) instead of a single nullable field with a screen-scoped reader. Found via Phase F's red-team pass while adding a fifth write site (rename's foreign-target feedback); left as pre-existing architecture rather than redesigned in that same pass, since a queue/consumer-scope change touches all five writers, not just the one being added.
- [low] `android/.../ChatRepository.kt : pendingSpawns` - **note** - has no explicit expiry of its own (unlike `recentSpawnOpIds`'s 40s sweep), so a "merely slow, not failed" create hard-blocks a retry under the same `(project, label)` for as long as the network call takes to settle. In practice this is bounded by `ConsoleClient`'s own OkHttp timeouts (~35-60s), which always eventually resolve the call (success or failure) and clear the entry - not truly unbounded - but there is no app-level timeout tied to the field itself if a future transport change removed that implicit bound.
- [low] `android/.../ChatRepository.kt : label()` - **note** - takes a `localGatewayId` parameter (called with `state.localGatewayId` from `sessionOrder`, `shareableSessions`, etc.) that its body never reads (`labelOrNull(team) ?: sessionLeaf(team)`). Not a live bug (nothing behaves incorrectly), but a reader skimming a call site could reasonably expect the label to vary with gateway id and be surprised it currently cannot.
- [low] `src/gateway/routes.ts : send`'s `to` field - **bug-class** - `parseTarget(to, ...)` is called with no try/catch (unlike every other validated field in the same request), so a malformed `to` (an out-of-range arity, an invalid slug segment) throws a raw exception instead of the established `jsonResponse({error}, 400)` shape; `send()` is async with no wrapping try/catch anywhere in its caller chain and `Bun.serve` has no `error:` handler configured, so this surfaces as an unhandled rejection rather than a clean 4xx. Predates the session-id-teardown work (the calls themselves are untouched by it); found during Phase G's red-team pass while tracing `to`'s handling.
- [low] `src/shared/session-store.ts : findByMintedFrom` - **note** - its own doc comment already treats a `(mintedFrom, spawn)` collision as anomalous ("only reachable via a corrupted or hand-edited persisted file") and correctly declines to guess, but logs nothing when it happens - a corrupted-file scenario the code already anticipates would compound silently (every subsequent call with that `mintedFrom` mints yet another record) with no operator-visible signal, unlike the otherwise-verbose `[wake]` logging nearby. Pre-existing Phase A code; Phase G only added a second caller.
- [low] `src/gateway/index.ts : doWakeTeam` - **unconfirmed lead** - flagged by a red-team pass but not fully chased down (needs `src/mcp/devcontainer/hostDaemon.ts`, outside that pass's scope): after a mint, a caller that keeps re-addressing the session by its ORIGINAL typed name (instead of switching to the resolved address the reply carries) would repeatedly miss the live-incarnation short-circuit (which checks the pre-mint `team`, not the minted `wakeTeam`) and re-trigger `doWakeTeam`/a host wake dispatch on every subsequent send, reattaching via `mintedFrom` each time. Whether this resolves quickly or stalls depends on whether the host daemon's wake handler emits a `wake_result` for a target that already has a live tmux/registration - not verified.

## Session id/name teardown closeout (`plans/session-id-teardown.md`, deleted, shipped - Phases A-G complete, 2026-07-09)

Migrated from `plans/session-id-teardown.md` (deleted, shipped) so its still-open residuals are not
lost. The "Session id teardown" section above this one was already migrated earlier, during the
plan's own execution (its Phase B/D/F red-team passes pointed at it directly). This batch closes out
the rest: Phase A/G's own logged-but-unfixed gaps, plus the Phase F crust-collection sweep in full (a
scouting pass over the Android app, the gateway's console/routing layer, and the shared wire protocol
- not run through a second adversarial verify pass, so treat each as a lead to re-check before acting
on it, not a confirmed finding). Non-goals the plan explicitly declined (workdirHint re-derivation on
rename, server-side prefix resolution for `crosstalk_send`/`wake`, gateway/host-daemon log
readability) are dropped as closed decisions, retrievable from git history if reconsidered.

### Phase A/G residuals (not part of the crust-collection sweep below)

- [high] `src/gateway/routes.ts : send` / `src/gateway/wake.ts : decideWakeCreate` - **bug-class** - no
  rate limit or size cap on session minting. A caller with ordinary `crosstalk_send` access can mint an
  unbounded number of phantom `SessionStore` records and drive real host-daemon wake dispatches
  (container bring-up included) with a plain loop over distinct `to`+`displayLabel` pairs -
  `mintedFrom` retry-safety only collapses a *repeated* request, never bounds *distinct* ones, by
  design. Compounds an already-known, already-decided-but-unshipped gap: `plans/gateway-auth-surface.md`
  documents plain `POST /send` as unauthenticated resource amplification via self-wake; Phase G adds
  outright record *creation* on top of that. A rate limiter is a cross-cutting concern deserving its
  own design, not a bolt-on to this phase - tracked here until `gateway-auth-surface.md`'s origin-aware
  gate (itself still unshipped) is built and confirmed to cover this creation path too.
- [medium] `src/gateway/federation/gatewayRelay.ts` / `FederatedOpSchema` - **note** - a cross-Gateway
  mint never surfaces the destination's resolved address back to the origin caller; the wire protocol's
  reply shape has no field for it. Adding one would need to span `FederatedOpSchema`, `gatewayRelay.ts`'s
  reply construction, and `sendCrossGateway`, mirroring the `displayLabel` threading Phase G already did
  in the other direction. Left as a documented limitation, not a same-pass wire-protocol addition.
- [low] `src/shared/session-store.ts : SessionStore.mintOrReattach`'s `mintedFrom` - **tradeoff** - has
  no expiry, unlike Android's own `recentSpawnOpIds` (a 40-second retry-collapse window). A
  `crosstalk_send`'s `fromConversationId` is process-lifetime (potentially days), so the SAME
  conversation addressing the SAME typed target weeks apart with a genuinely new, different
  `displayLabel` intent still silently reattaches to the old session and drops the new label -
  indistinguishable, from the reply alone, from a fresh mint. Deliberate: the alternative (an unbounded
  duplicate-mint risk on any delayed retry) was judged worse. Worth reconsidering with a bounded window
  if it proves confusing in practice.
- [low] `src/gateway/websocket.ts : establishOnConfirm` - **note** - this self-heal path remains
  structurally unable to stamp `mintedFrom` (it has no request provenance in scope at all), so a mint-path
  record confirmed through it can't be found by a later retry via `findByMintedFrom`. Fully closing this
  means threading provenance through the confirm path, a materially larger change than "make the mint
  path collision-safe."
- [low] `src/shared/session-store.ts` (persistence model) - **note** - an abrupt, non-graceful crash
  (SIGKILL/OOM, not a graceful restart - those already flush via the SIGTERM/SIGINT handlers) inside the
  ~3s window between persist ticks can lose any just-created record. Pre-existing property of the whole
  persistence model, not specific to any one phase.
- [low] `src/shared/session-store.ts : findByMintedFrom` - **bug-class** - the ambiguity guard (falls
  through to a fresh mint rather than trusting either of two colliding records) has no recovery path -
  every retry against an already-ambiguous `mintedFrom` mints one more record instead of resolving the
  ambiguity, so a sustained retry storm against an already-corrupted/hand-edited store grows unboundedly.
  Low severity since reaching the initial ambiguous state already requires that disclaimed precondition;
  a full fix (reconciling or pruning ambiguous records) is a separate feature.
- [low] `src/shared/session-store.ts` (legacy mint records) - **note** - time-bound, likely already
  expired: a `SessionRecord` minted by the OLD, now-deleted deterministic-hash `mintedSessionId` scheme
  (pre-dating the Phase A deploy) has no `mintedFrom`, so a retry of that exact original
  (conversationId, opId) landing after the Phase A deploy could not find it via `findByMintedFrom` and
  would mint a second, independent record. Bounded to the transition window around that one deploy
  (non-destructive - a duplicate mint, never someone else's session getting deleted); judged not worth
  resurrecting the deleted deterministic-hash mechanism as a fallback-only lookup to close.

### Phase F crust-collection sweep (scouting pass, not independently verified)

Four parallel scouts over the Android app, the gateway's console/routing layer, and the shared wire
protocol, seeded with leads from the plan's own red-team rounds. Record only, not fixed - out of scope
for that plan, or too broad for a proportionate in-pass fix.

**High:**
- [high] `android/.../ChatRepository.kt : isAdmin / confirmedDomainId / refreshDisplayNameFromTeams` -
  **dup-logic** - all three pick "my own Team" from `state.teams` using gateway-id equality alone, no
  domain check (`(it.gatewayId.ifEmpty { gw }) == gw`) - the same class of gap `rename()`'s isLocal guard
  was written to close, and the sibling `shareableSessions()` a few lines below already ANDs a domain
  check in. Since a gateway id is only unique within a Domain (documented elsewhere in this same file) and
  defaults to the sanitized hostname, a linked peer's gateway coincidentally sharing your own gateway id
  string could make these three silently report the peer's domain id / admin flag / display name as your
  own - most dangerous if the colliding peer happens to be the admin you're a guest of.
- [high] `android/.../ChatRepository.kt : ChatState.gap` - **bug-class** - set to `true` on a dropped-
  mailbox-entries pulse but never reset anywhere (no matching `false` write, unlike `transientMessage`'s
  `consumeTransientMessage()`), even though the pulse that set it (`SyncCursor.advance`'s edge-triggered
  `gap`) resolves itself the very next poll cycle. The sticky "Some messages were dropped" banner it drives
  has no dismiss action, so the first mailbox-eviction event a device ever experiences leaves that banner
  on screen for the rest of the process's life.
- [high] `android/.../ChatRepository.kt : setDeviceName` (found independently by two scouts) - **bug-
  class** - fired the same fire-and-forget way as rename/closeTab/wakeSession/forget
  (`scope.launch { repo.setDeviceName(it) } }`, no CoroutineExceptionHandler anywhere in the app), but
  unlike its neighbor `provision()` - whose own comment explains it wraps its JSON parse specifically
  because "callers launch this from coroutines with no catch" - `setDeviceName` does not wrap its
  `JSONObject(blob).put("device", name)` at all. A corrupted stored provisioning blob throws uncaught and
  crashes the app on a routine device rename.
- [high] `android/.../TrustCompareScreen.kt : DisposableEffect(Unit).onDispose` - **bug-class** - cancels
  the rendezvous via `scope.launch { repo.trustCancel(...) }` on the plain `rememberCoroutineScope()`
  `scope`, which Compose cancels as part of the same disposal pass - so the cancel very likely never runs.
  Two sibling ceremonies (`LinkWizard.kt`, `EnrollCeremonyScreen.kt`) hit and fixed this exact bug by
  moving their own onDispose cancel onto `GlobalScope.launch` with a "must outlive this composable"
  comment; `TrustCompareScreen.kt` never got the same fix, so backing out of a trust compare leaves the
  rendezvous open until its own TTL sweep instead of tearing down immediately.

**Medium:**
- [medium] `src/gateway/console/consoleHandler.ts : dispatch` - **framework-first** - `rename_session`'s
  case body opens with the identical validate-target-and-resolve-name preamble already known to be
  hand-copied between `forget`/`close_session`; a third copy, same fix (`requireNamedLocalSession`
  helper) would close all three at once.
- [medium] `src/gateway/wake.ts : WakeCoordinator`, `src/gateway/hostOpCoordinator.ts : HostOpCoordinator`,
  `src/gateway/evie/evieClient.ts`'s `pendingCalls` - **framework-first** - three independent hand-rolled
  copies of the same "keyed waiter map with a timeout and a fail-all" primitive, aware of each other only
  through prose comments cross-referencing the siblings rather than one shared `Correlator<T>`.
- [medium] `src/gateway/routes.ts : send`, `src/gateway/console/consoleHandler.ts` (3 sites) - **framework-
  first** - the "is this address actually mine" `t.domain !== localDomain || t.gateway !== localGatewayId`
  check is hand-copied 5 times across the gateway (plus a 6th, independent copy in the Android client's
  `rename()`); `Address`/`SpawnPoint` have an `equals()` but no `isLocal(domain, gateway)` method to own
  the comparison once.
- [medium] `android/.../ChatRepository.kt : closeTab/wakeSession/forget` (vs `rename`) - **bug-class** -
  all three gate on gateway-id equality alone (no domain check), the exact gap `rename()`'s own doc
  comment names and fixes for itself; `forget` is the most consequential since it's the most destructive
  op of the three.
- [medium] `android/.../ChatRepository.kt : send/retrySend/deliver(fail)` vs `ChatState.transientMessage`
  - **bug-class** - these write one-off send-failure text into the STICKY `error` field instead of
  `transientMessage`, the exact violation `transientMessage`'s own doc comment warns against ("would bleed
  into an unrelated later health render"); `error` is only cleared at connection-lifecycle events, so a
  failed send's text can linger in the connection-health banner well past the failure.
- [medium] `android/.../ChatRepository.kt : ChatState.needsGateway` and `MainActivity.kt`'s ThreadScreen -
  **legacy-landmine** - two independent places pattern-match the free-text `error` string to recover a
  `ConnKind` classification (a `.startsWith("Add a Gateway")` check and a separate `.endsWith("retrying")`
  convention) instead of storing the enum itself; the two conventions are already inconsistent with each
  other's assumptions (some TRANSIENT messages don't end in "retrying").
- [medium] `android/.../MainActivity.kt : SessionsScreen`'s `SpawnDialog` call site - **bad-naming** -
  the one hop where the typed-label value is destructured as `session` instead of `label`, inviting a
  reader to treat pre-sanitization user text as a stable session id; every other hop of the same value
  (App's `onSpawn`, `spawnSession`'s own parameter) calls it `label`.
- [medium] `android/.../ConsoleClient.kt : listTeams` - **dead-code** - zero call sites anywhere in the
  repo (Kotlin or TS); every real caller uses `teams()` directly. Leftover from a migrated-away call site.
- [medium] `android/.../HostNetworks.kt`, `Management.kt`, `LinkWizard.kt` - **dup-logic** - three
  independent clipboard-copy implementations for the same user action (two hand-rolled via the old
  `ClipboardManager` API, one via the newer `LocalClipboard`), where a shared home for this exact
  composable family (`Federation.kt`) already exists.
- [medium] `android/.../Sharing.kt : SharingScreen.onToggleDomain` - **bug-class** - discards the result
  of its everyone-clear call entirely (no `.onFailure`/`.getOrThrow()`) before unconditionally applying
  the specific-share write, unlike the sibling `applyMode()` branch that `.getOrThrow()`s the identical
  call so a failure aborts the whole operation; a transient failure here can leave a session shared to
  both "everyone" and a named person at once, the exact overlap a neighboring comment says must never
  happen.
- [medium] `android/.../CrossDomainLink.kt : mergeLinkedDomains`'s `adminDomain` parameter - **bad-
  naming** - actually means "my own confirmed domain id" (fed from `confirmedDomainId()`), not the
  network's privileged admin Domain that `Team.isAdminDomain` (a different, wire-stamped field) refers to
  elsewhere in the same federation/cross-domain code - easy to conflate given how similarly they're
  spelled and how close together they live.
- [medium] `android/.../AppStateStore.kt : saveGatewayId`'s doc comment - **legacy-landmine** - describes
  the pre-migration `(gatewayId, name)` composite-key grammar this repo's own CLAUDE.md documents as
  retired, but the field is still load-bearing today for a different, undocumented purpose (the persisted
  fallback `ConsoleClient.kt` reads to resolve which Gateway to seal a relay op to before a fresh register
  re-learns it) - a maintainer trusting the stale comment could conclude it's dead and remove it.
- [medium] `android/.../Management.kt : AddGatewayScreen`'s Approve action (one instance of a ~9-site
  pattern) - **framework-first** - every async screen action hand-rolls its own busy/status state plus a
  bespoke `scope.launch{}` with no shared "always reset busy, always surface a message" helper; Approve
  specifically has no try/catch around a call that documents itself as intentionally throwing on a
  corrupt stored key, so that failure leaves the button stuck on "Enrolling..." forever with no error
  shown.
- [medium] `scripts/codegen-kotlin.ts : SEALED_ROOTS`'s `CrossDomainShareTargetSchema` entry - **bug-
  class** - listed as sealed (encode-side-only, per the file's own header rule) but the same schema is
  also embedded decode-side inside a gateway reply; today's Android callers happen to wrap the decode in
  `runCatching` so it fails safe, but the day a new variant ships, every not-yet-updated console's share
  checkmarks and counts will fail to decode at all - the exact forward-compat break this file's own rule
  exists to prevent everywhere else.
- [medium] `src/shared/schemas.ts : ResponseStatusSchema` - **dead-code** - documented as "the single
  truth" for response-status wire enums but never actually `.parse()`d anywhere; every real status field
  is a bare `z.string().optional()`, and at least one consumer's own comment admits the gap this schema
  was supposedly there to close ("an absent status would otherwise fall through silently").

**Low:**
- [low] `src/gateway/index.ts : doWakeTeam/relayToHost` - **dup-logic** - both hand-roll the identical
  "find the host daemon's live socket" two-liner that `websocket.ts`'s existing `getAllActiveWs(subs)`
  already does (and `routes.ts` already reuses).
- [low] `src/gateway/console/consoleHandler.ts : dispatch`'s `create_session` case - **bad-naming** - its
  local `sessionId` holds a short leaf id, while `sessionId`/`session_id` means the fully-qualified store
  key everywhere else in the same switch statement.
- [low] `src/shared/session-store.ts : SessionStore.restore` - **legacy-landmine** - its one-shot legacy-
  migration branch (marked for deletion "once every gateway has re-written session-resume.json") has no
  version sentinel gating it, unlike the codebase's other one-shot migration (a persisted schema-version
  file); it shape-sniffs on every boot indefinitely with nothing verifying its own removal precondition.
- [low] `android/.../ChatRepository.kt : ChatState.label`'s `localGatewayId` parameter - **dead-code** -
  never read in the function body; all 8 call sites thread a gateway id through for nothing.
- [low] `android/.../MainActivity.kt : SessionCard` - **dup-logic** - hardcodes `Color(0xFFD29922)` and
  `Color(0xFFDA3633)` for the verifying/working/check-terminal chip colors instead of calling
  `presenceColor(...)`, the function documented as the single owner of this exact vocabulary, which
  already yields the identical values.
- [low] `android/.../ChatRepository.kt : firstRootIfPending` - **dup-logic** - the durable
  `store.firstRooted` and the in-memory `ChatState.firstRooted` must be kept in sync by hand at each of
  four call sites instead of one setter writing both; holds today only because of call-site discipline,
  not a structural guarantee.
- [low] `android/.../proto/SessionId.kt : ParsedSessionName.project` - **bad-naming** - names the address's
  `spawn` segment `project`, while every sibling type in the same file spells the identical concept
  `spawn`; the two vocabularies meet only positionally at one call site with same-typed arguments, so a
  future field reorder could silently swap segments with no compiler error.
- [low] `android/.../SttsPlayer.kt : currentKey/currentTeam/currentAt` - **bug-class** - "what's playing
  now" is three separate `@Volatile var`s updated together only under `@Synchronized` writers, while the
  Compose-thread reader path reads all three unsynchronized - a torn read mid-transition can show a
  momentarily wrong play/stop glyph. One atomic `@Volatile var current: NowPlaying?` would close it.
- [low] `src/shared/schemas.ts : TeamInfoSchema.queue_depth` - **dead-code** - the lone snake_case field
  in an otherwise camelCase schema; both producers hardcode it to `0`, and the one consumer that branches
  on it (`bridgeDiscover.ts`) can never take its "busy" arm. Decoded and stored on the Android side too,
  but read by nothing.
- [low] `src/shared/types.ts : RegisterMessage, CatalogMessage` - **legacy-landmine** - zero references
  anywhere in the repo; `RegisterMessage` has also drifted from the real wire schema it once mirrored
  (missing several fields `WsRegisterSchema` has since gained), and `CatalogMessage` describes a message
  shape from the retired CLI-dispatch protocol.
- [low] `src/shared/session-id.ts : isConvId/MAX_CONV_ID_LEN` vs `src/shared/host-op.ts`'s
  `CONVERSATION_ID_RE`/`MAX_CONVERSATION_ID_LEN` - **dup-logic** - two independently-defined,
  byte-identical-today validators for the same conversationId concept; tightening one silently stops
  being enforced by the other.
- [low] `src/gateway/routes.ts : send/resolveLocalTarget` - **dup-logic** - both parse the same `to`
  string and re-run the identical SpawnPoint-reject-plus-locality check independently; a third,
  independent copy of the same rule lives in the Android client's `rename()`.
- [low] `src/shared/schemas.ts : MailboxEntrySchema/ChannelReplySchema`'s `session_id` field - **bad-
  naming** - actually the fully flattened `storeKey()` output (a 5-6 segment compound job/store
  correlation key), not the `Address.session` single-segment concept the name suggests to a reader
  familiar with `session-id.ts`'s grammar.
- [low] `src/shared/schemas.ts : ConsoleRegisterResultSchema.domainStatus` - **dead-code** - computed,
  wired, and codegen'd, but zero reads anywhere in the Android app; the app's actual first-root decision
  is driven by the provisioning blob's `pendingTenant` field instead, per this repo's own CLAUDE.md.

## Reply-tool redesign (`plans/reply-tool-redesign.md`, deleted, shipped and deployed - 2026-07-09)

Migrated from `plans/reply-tool-redesign.md` (deleted, shipped - `channel_reply` split into two tools,
deployed live and verified: gateway rebuilt, all live sessions reconnected and confirmed lead with no
evictions) so its still-open residuals are not lost. The plan's own numbered decisions, rejected
alternatives, and implementation/verification sections describe now-shipped code and are dropped as
closed, retrievable from git history. What follows is everything that was still open: its own
"Forward-looking" section, one "Gotchas" item explicitly out of scope, one pre-existing regex
fragility the plan's own "What was rejected" section earmarked for this file, a fresh operational
finding from the live deploy itself, and the full crust-collection sweep (3 parallel scouts over the
console reply path, the rest of `src/mcp/bridge/`+`src/mcp/channel/`, and the devcontainer wake/boot
path) run against the shipped implementation. Refs are `file : scope : name`; severity in brackets.

### Forward-looking (recorded, not yet needed)

- Multi-way chats rising to the Console: the `{title, summary, full}` triple on `channel_reply` is
  the groundwork, but the cross-Gateway `response_push` relay (`src/gateway/routes.ts`, inside
  `relayWithRetry`) forwards only `status`/`response`/`files` and DROPS `title`/`summary` - the
  uniform-headline premise holds only for same-Gateway replies until that relay is extended to carry
  the tiers.
- Real structured validation for `channel_reply_structured`'s `responseData`: only achievable if the
  request side emits a real JSON Schema, persisted by `session_id` and validated in `/respond` at
  runtime. The single current producer (the handshake) doesn't justify building it yet.

### Crust-collection sweep (scouting pass, not independently verified except where noted)

**High:**
- [high] `src/mcp/bridge/helpers.ts : routerGet` - **bug-class** - unlike its sibling `routerPost` in
  the same file, `routerGet` never checks `res.ok` before returning `res.json()`, so a non-2xx
  gateway response (e.g. a 500 with an `{error}` body) resolves successfully instead of throwing.
  Its only caller, `bridgeDiscover.ts`'s `/discover` fetch, then calls `.filter()` on that
  error-shaped object, surfacing a confusing generic "not a function" error instead of the real
  server error. `routerGet`'s retry loop also silently drops the `console.error` logging its sibling
  has on each retry attempt. A copy-pasted twin where one side got an error-handling fix the other
  never received.
- [high] `src/mcp/devcontainer/helpers.ts : ensureContainerUpAsync / isContainerReady /
  hasPluginSettings / provisionPluginSettings` - **architecture** - the devcontainer boot path never
  re-checks or refreshes plugin freshness. The common case (`isContainerReady()` true - the container
  was merely session-asleep, not actually stopped) returns immediately with zero plugin logic at
  all; even the cold-boot branch only checks whether the plugin key EXISTS in
  `installed_plugins.json`, never whether it's current, and skips `provisionPluginSettings` (the
  only place `claude plugin install` runs) once it has ever run once. A devcontainer asleep during a
  live "reload all live sessions" sweep boots on whatever plugin code its cache last had, and nothing
  at boot catches it up - confirmed live during this plan's own deploy (see the reload_plugins finding
  below). Two sub-questions can't be verified from this repo alone: whether a target project's own
  devcontainer config persists `~/.claude` across a container recreate, and whether Claude Code's own
  CLI self-updates a marketplace flagged `autoUpdate:true` at its own launch.
- [high] `src/mcp/devcontainer/hostDaemon.ts : handleWake` (devcontainer branch) /
  `buildLaunchCommand` - **architecture** - confirms the above directly: after
  `ensureContainerUpAsync` resolves, the wake handler goes straight to `buildLaunchCommand`'s single
  `bash -c` launch - there is no boot-time equivalent of the `reload_plugins` op (no `/plugin
  update`, no `/mcp reconnect`) anywhere between container-up and launching Claude. `reloadPlugins.ts`
  is reachable only via a live MCP tool call or console op against an already-running session.
- [high] `src/mcp/devcontainer/reloadPlugins.ts : registerReloadPlugins` (self-targeting) -
  **confirmed live during this plan's own deploy** - `reload_plugins` targeting "self" drives the
  calling session's own tmux pane via keystroke automation, the same underlying mechanism
  `compact_session`/`set_effort_level` document as requiring the session to be IDLE to register
  (the REPL prompt must be accepting input). Calling it against an actively-busy session (mid
  tool-call chain, never idle) does not error, reports `initiated: true`, and silently fails to take
  effect - confirmed directly: this session's own self-targeted reload during the redesign's live
  deploy did not update its tool schema, and the new-vs-old handshake mismatch had to be resolved by
  falling back to the old tool's equivalent wire field rather than the new one, until the human
  manually ran `/plugin`, `/reload-plugins`, `/mcp` themselves later at a natural idle point. Neither
  `reload_plugins`' own tool description nor this file's existing "no closed-loop verification"
  finding names this specific mechanism (idle-required for self-target) - worth surfacing explicitly.

**Medium:**
- [medium] `src/gateway/websocket.ts : resolveHandshake` - **bug-class** - earmarked for this file by
  `plans/reply-tool-redesign.md`'s own "What was rejected" section: the `/true/i.test(response)`
  prose fallback mis-resolves a reply lacking the literal substring "true" to WORKER (permanent
  eviction, `suppressReconnect` never resets). Pre-existing, independent of any specific plan; was
  briefly elevated to "harden this" during the redesign's rollout-skew analysis, then correctly
  de-scoped once the owner accepted a coordinated restart instead of a rolling deploy (no skew window
  left to harden against) - but the regex itself was never tightened, so the underlying fragility
  remains for the next transition-affecting change.
- [medium] `skills/crosstalk/SKILL.md : Receiving a Request / CLI agents` section + `Response
  Statuses` section - **legacy-landmine** - independently found twice (a coding-guidelines audit and
  a crust sweep). Instructs an agent to reply via `switchboard:crosstalk_reply()`, a tool that exists
  nowhere in current source (CLI dispatch mode was retired per this repo's own CLAUDE.md), and
  documents `clarification`/`deferred`/`needs_human` as reachable outcomes when neither live reply
  tool (`channel_reply`/`channel_reply_structured`) nor the console's `respond` op can produce them
  anymore (see the vestigial-status-vocabulary finding below). Also: `README.md`'s `crosstalk_wait`
  row still says "retrying a deferred request", the same dead-vocabulary echo.
- [medium] `src/gateway/routes.ts : RespondBodySchema` / `src/shared/types.ts : ResponsePayload` /
  `src/shared/federation-protocol.ts : FederatedOpSchema` - **dead-code** - the whole
  clarification/deferred/needs_human negotiation protocol (`question`, `reason`,
  `estimated_minutes`, `what_to_decide`, `message`, plus those three `ResponseStatusSchema` enum
  values) is vestigial: no code path anywhere sets status to any of the three, since neither current
  reply front door can express them. Kept alive only by `src/mcp/bridge/bridgeSend.ts`'s
  `formatResult()`, which still switches on them.
- [medium] `src/mcp/channel/evieFiles.ts : materializeFiles / renderFilesBlock / safeFilename /
  MaterializeFilesParams / RenderFilesBlockParams` - **legacy-landmine** - pervasive stale "Discord"
  naming survives the Discord file path's retirement (CLAUDE.md: "the Discord file path was retired
  with the human bridge"). A half-finished rename: one comment in `renderFilesBlock` already says
  "Console files always arrive with bytes..." while sibling comments a few lines away in
  `materializeFiles`/`safeFilename` still say "Discord-supplied", "Discord caps a message at 10
  attachments", "real Discord snowflakes". The only real caller (`channelNotify.ts`) already calls
  these "Console-origin files" in its own comment.
- [medium] `src/mcp/bridge/helpers.ts : connectToRouter` (`isChannel`) + `src/mcp/bridge/
  registerBridgeTools.ts : registerBridgeTools / detectAgentType` - **dup-logic** - three independent
  computations of "is this a channel-capable (Claude) agent" exist (`mcp/index.ts`'s own check,
  `helpers.ts`'s separate copy gating whether channel_push/response_push ever get delivered, and
  `registerBridgeTools.ts` re-running `detectAgentType()` a second time). Sibling dead-branch class to
  `routes.ts : getTeamMode`, already tracked above in this file, but that entry doesn't cite this
  occurrence. `detectAgentType()`/`AGENT_CLI_NAMES` still fully probes for cursor-agent/copilot/codex
  on PATH though CLI dispatch was retired; effectively unreachable today (always falls back to
  `"claude"`) but a latent landmine if that ever changed.
- [medium] `src/mcp/bridge/helpers.ts : setIsMainOrLeadAgent` / `isMainOrLeadAgent` - **dead-code** -
  zero callers repo-wide, independently reconfirmed multiple times during the redesign - the dead
  code itself is still shipped, and a reader of `connectToRouter` alone would not know the auto-reply
  branch it gates is unreachable.

**Low:**
- [low] `src/shared/schemas.ts : NoticeTitle/NoticeSummary/NoticeFull` (`src/shared/notice.ts`) -
  **note** - all three use `.min(1)`, which accepts whitespace-only content (`" "`/`"\n"`).
  Pre-existing; tightening to `.trim().min(1)` touches the SYNCED `notice.ts` leaf (needs a copy into
  nyaaskills + SYNC-HASH restamp), so it was left out of scope by the reply-tool redesign - record
  only.
- [low] `src/shared/schemas.ts : MailboxEntrySchema` - **dead-code** - `question` and `reason` are
  dead fields (also codegen'd into Android's `MailboxEntry` Kotlin data class); no producer anywhere
  sets them, no Android code reads them. Every sibling field on this schema carries an explanatory
  comment; these two are the only undocumented ones - an unremoved fossil of the retired CLI
  clarification-reply flow.
- [low] `src/mcp/bridge/helpers.ts : bridgeAgentType` - **dead-code** - exported getter with zero
  callers anywhere, unlike its siblings `bridgeProjectName`/`bridgeConversationId` (both actively
  consumed elsewhere) - a symmetry leftover that never got a consumer.
- [low] `src/mcp/bridge/bridgeDiscover.ts : registerBridgeDiscover` (the `others` filter) -
  **legacy-landmine** - excludes `kind !== "console"`/`"host"`, but the gateway's `teams()` only ever
  emits `"loose"`/`"devcontainer"` (console/host peers are already hidden upstream by being
  recordless, and `"host"` isn't even in the shared `TeamKindSchema` enum) - likely vestigial
  defensive filtering from before that upstream rule existed. Also hand-types the response inline
  instead of importing the shared `TeamInfo` type, so a future wire-shape change wouldn't be caught
  by the compiler here.
- [low] `src/mcp/devcontainer/hostDaemon.ts : handleWake` / `wake_result.pluginsProvisioned` -
  **dead-code** - a computed, forwarded signal with zero consumers anywhere on the gateway side (not
  part of any wire schema either) - reinforces that there is no closed-loop plugin-freshness tracking
  between the daemon and the gateway/console layers.
- [low] `plans/host-daemon-cleanup.md`'s "Phase 5 - Fragile TUI automation" tracking - **verified,
  still accurate as of 2026-07-09** - `reloadPlugins.ts`'s screen-scraping `buildScript` was untouched
  by the one commit that had touched the file since that tracking was written (which only threaded a
  minted-id session name through, not the TUI-driving body). No drift found at verification time.
