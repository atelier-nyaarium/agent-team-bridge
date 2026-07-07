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
