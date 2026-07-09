# Pain points

Residual painpoints from shipped work, collected by crust scouts (record only, not fixed). Pruned to
concrete, reachable issues - dup-logic, naming nits, dead code with no consequence, and anything
gated behind a disclaimed precondition ("only reachable via a corrupted file", "negligible at this
app's realistic scale") were cut. Refs are `file : scope : name`; severity in brackets.

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

## Handshake-established session linkage (PR #107, 2026-07-02)

Migrated from `plans/handshake-session-linkage.md` (deleted, shipped) so its still-open residuals are
not lost.

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

## Host session resume (PR #100, 2026-06-29)

### In the shipped code - worth a near-term follow-up

- [high] `hostDaemon.ts : handleWake : host branch` - the host reattach runs `awaitReady` (a full
  ~90s poll budget) BEFORE the dead-shell check, then on a dead shell kills and runs `awaitReady`
  again - up to ~180s before `wake_result`. The devcontainer branch avoids this by peeking once for a
  reattach and only `awaitReady`ing a fresh `created` launch. Fix: peek-first in the host reattach
  (return immediately if ready/working), reserve `awaitReady` for the post-relaunch path.
- [medium] `hostDaemon.ts : buildLaunchCommand : effort` - the model/effort flags are hardcoded for
  every host session including resumes, so a host agent relaunches on its hardcoded tier on each wake
  with no signal.
- [medium] `shared/host-op.ts : HostOp : createSession` (+ `hostDaemon.ts : hostOpRunner.createSession`)
  - the `create_session` op carries no `resumeSessionId`, so tapping "New Session" on a host name the
  gateway already has a resume id for starts fresh and abandons the saved transcript. Only the wake
  path resumes. Decide whether create_session should offer resume.
- [medium] `hostDaemon.ts : hostOpRunner.createSession` - returns `{created:true}` as soon as the tmux
  exists (fire-and-forget `awaitReady`), while `handleWake` blocks on readiness; the asymmetry means a
  console create_session reports success before the REPL is up.

### Trust surface - all chain off the unauthenticated `/bridge` register + `/send`

Owner-deferred (decision A); the root fix is `plans/gateway-auth-surface.md`, still an active,
unshipped plan. These are concrete manifestations of that same known gap, not standalone theoretical
concerns.

- [high] `websocket.ts : createWebSocketHandlers : message` - the host-token gate + `RESERVED_TEAM_NAMES`
  match the bare `host` exactly, so a composite `host.foo` bypasses both.
- [medium] `routes.ts : teams` - an attacker-seeded `host.foo` passes the asleep-listing guards
  (`host` is a valid slug) and surfaces as a phantom available card.
- [medium] `index.ts : doWakeTeam` - the reserved guard only blocks `host-daemon`; any other `host.*`
  is woken with the attacker's `resumeSessionId` forwarded.
- [medium] `index.ts : sessionResume` - no entry-count ceiling (only the 30-day TTL), so unauthenticated
  composite registers can grow the map and `session-resume.json` unboundedly.
- [medium] `routes.ts : isDevcontainer` - unions trusted `offlineCatalog` with untrusted
  `knownTeamPaths` (also tracked in `plans/host-daemon-cleanup.md`).

## Console device-name address (PR #99)

### `PROJECT_NAME` / `from` not slug-validated -> `localAddress` throws
`PROJECT_NAME` is read from env and propagated as the sender `from` with no slug check, so a non-slug
value (spaces/caps) makes `localAddress(from)` throw uncaught:
- `src/mcp/index.ts : startMcp` - the root: `PROJECT_NAME` is never asserted to be a slug
- `src/gateway/routes.ts : humanNotify` - `localAddress(from)` (the schema validates length, not slug); a non-slug `PROJECT_NAME` crashes `/human/notify`
- `src/gateway/routes.ts : sendCrossGateway` - `localAddress(from)` on an agent cross-Gateway send throws on a non-slug team field

## Session id teardown (`plans/session-id-teardown.md`, found during Phase B red-team)

- [medium] `android/.../Sharing.kt : SharingScreen` - **bug-class** - the per-session share-audience map (`shares`, Private/Everyone/Specific) and the "trust first" roster (`trustFirst`) are populated only once via `LaunchedEffect(Unit)` and re-populated only by this same screen's own mutating actions; neither reacts to `state` changing for an external reason while the screen stays mounted. Two concretely reachable consequences: `modeSummary()`'s fallback renders the raw internal `domainId` string once a shared Domain drops out of the live `people` list but is still recorded in the stale `shares` entry; the Specific-people picker can show the same person twice in contradictory states. The only present workaround is leaving and re-entering Sharing.
- [high] `src/gateway/console/consoleHandler.ts : create_session` (host target) / `gateway/index.ts : inflightCreates` - **bug-class** - a host-target `create_session` never goes through `tryWakeTeam`/`wakeCoordinator` (that path is gated to `target.kind === "devcontainer"` only); the RPC resolves as soon as `tmux new-session -d` itself launches, not once the Claude CLI inside has booted and completed its MCP handshake. So `teams()` reports plain `"available"` while the freshly spawned Claude is still cold-starting - `SessionCard`'s spinner drops early, showing a state visually identical to a genuinely idle session. Reachable via the board's synthetic Host spawn-point header (any "+" tap on Host). The devcontainer wake path is unaffected.
- [high] `android/.../ChatRepository.kt : transientMessage` - **bug-class** - a single nullable `String?` field on `ChatState`, written by five independent async call sites and drained by exactly one consumer that only exists in composition while `SessionsScreen` is on screen. Two loss mechanisms: StateFlow conflation (two writes close together collapse to one emission), and any write while a thread is open is invisible until the user backs out to the board - an earlier, possibly more actionable message is silently discarded in favor of whatever landed last. Needs either a small queue or an app-scoped consumer instead of a single nullable field with a screen-scoped reader.

## Session id/name teardown closeout (`plans/session-id-teardown.md`, deleted, shipped - Phases A-G complete, 2026-07-09)

Migrated from `plans/session-id-teardown.md` (deleted, shipped) so its still-open residuals are not
lost. Pruned to concrete, reachable findings from the plan's own Phase A/G notes and its Phase F
crust-collection sweep.

### Phase A/G residual

- [high] `src/gateway/routes.ts : send` / `src/gateway/wake.ts : decideWakeCreate` - **bug-class** - no
  rate limit or size cap on session minting. A caller with ordinary `crosstalk_send` access can mint an
  unbounded number of phantom `SessionStore` records and drive real host-daemon wake dispatches
  (container bring-up included) with a plain loop over distinct `to`+`displayLabel` pairs -
  `mintedFrom` retry-safety only collapses a *repeated* request, never bounds *distinct* ones, by
  design. Compounds the same already-known, already-decided-but-unshipped gap as the Trust Surface
  items above (`plans/gateway-auth-surface.md`); tracked here until that plan's origin-aware gate is
  built and confirmed to cover this creation path too.

### Phase F crust-collection sweep

**High:**
- [high] `android/.../ChatRepository.kt : ChatState.gap` - **bug-class** - set to `true` on a dropped-
  mailbox-entries pulse but never reset anywhere, even though the pulse that set it resolves itself
  the very next poll cycle. The sticky "Some messages were dropped" banner it drives has no dismiss
  action, so the first mailbox-eviction event a device ever experiences leaves that banner on screen
  for the rest of the process's life.
- [high] `android/.../ChatRepository.kt : setDeviceName` - **bug-class** - fired the same
  fire-and-forget way as rename/closeTab/wakeSession/forget, no CoroutineExceptionHandler anywhere in
  the app, and unlike its neighbor `provision()` does not wrap its `JSONObject(blob).put("device",
  name)` at all. A corrupted stored provisioning blob throws uncaught and crashes the app on a
  routine device rename.
- [high] `android/.../TrustCompareScreen.kt : DisposableEffect(Unit).onDispose` - **bug-class** -
  cancels the rendezvous via `scope.launch { repo.trustCancel(...) }` on the plain
  `rememberCoroutineScope()` `scope`, which Compose cancels as part of the same disposal pass - so the
  cancel very likely never runs. Two sibling ceremonies (`LinkWizard.kt`, `EnrollCeremonyScreen.kt`)
  hit and fixed this exact bug already; `TrustCompareScreen.kt` never got the same fix.

**Medium:**
- [medium] `android/.../ChatRepository.kt : closeTab/wakeSession/forget` (vs `rename`) - **bug-class** -
  all three gate on gateway-id equality alone (no domain check), the exact gap `rename()`'s own doc
  comment names and fixes for itself; `forget` is the most consequential since it's the most destructive
  op of the three.
- [medium] `android/.../ChatRepository.kt : send/retrySend/deliver(fail)` vs `ChatState.transientMessage`
  - **bug-class** - these write one-off send-failure text into the STICKY `error` field instead of
  `transientMessage`; `error` is only cleared at connection-lifecycle events, so a failed send's text
  can linger in the connection-health banner well past the failure.
- [medium] `android/.../Sharing.kt : SharingScreen.onToggleDomain` - **bug-class** - discards the result
  of its everyone-clear call entirely before unconditionally applying the specific-share write,
  unlike the sibling `applyMode()` branch that aborts on failure; a transient failure here can leave a
  session shared to both "everyone" and a named person at once, the exact overlap a neighboring
  comment says must never happen.
- [medium] `android/.../Management.kt : AddGatewayScreen`'s Approve action - **framework-first** - no
  try/catch around a call that documents itself as intentionally throwing on a corrupt stored key, so
  that failure leaves the button stuck on "Enrolling..." forever with no error shown.

## Reply-tool redesign (`plans/reply-tool-redesign.md`, deleted, shipped and deployed - 2026-07-09)

Migrated from `plans/reply-tool-redesign.md` (deleted, shipped - `channel_reply` split into two tools,
deployed live and verified: gateway rebuilt, all live sessions reconnected and confirmed lead with no
evictions). Pruned to the forward-looking note the plan's own author flagged as a real future
direction, plus the crust-collection findings with a concrete, reachable failure mode - two of which
(the devcontainer stale-plugin gap and the `reload_plugins` self-target limitation) were directly
confirmed live during this plan's own deploy, not just theorized.

### Forward-looking

- Multi-way chats rising to the Console: the `{title, summary, full}` triple on `channel_reply` is
  the groundwork, but the cross-Gateway `response_push` relay (`src/gateway/routes.ts`, inside
  `relayWithRetry`) forwards only `status`/`response`/`files` and DROPS `title`/`summary` - the
  uniform-headline premise holds only for same-Gateway replies until that relay is extended to carry
  the tiers. The user flagged multi-way chat as the actual direction they want.

### Crust-collection sweep

**High:**
- [high] `src/mcp/bridge/helpers.ts : routerGet` - **bug-class** - unlike its sibling `routerPost` in
  the same file, `routerGet` never checks `res.ok` before returning `res.json()`, so a non-2xx
  gateway response (e.g. a 500 with an `{error}` body) resolves successfully instead of throwing.
  Its only caller, `bridgeDiscover.ts`'s `/discover` fetch, then calls `.filter()` on that
  error-shaped object, surfacing a confusing generic "not a function" error instead of the real
  server error. A copy-pasted twin where one side got an error-handling fix the other never received.
- [high] `src/mcp/devcontainer/helpers.ts : ensureContainerUpAsync / isContainerReady /
  hasPluginSettings / provisionPluginSettings` - **architecture, confirmed live** - the devcontainer
  boot path never re-checks or refreshes plugin freshness. The common case (`isContainerReady()` true
  - merely session-asleep, not actually stopped) returns immediately with zero plugin logic at all;
  the cold-boot branch only checks whether the plugin key EXISTS, never whether it's current. A
  devcontainer asleep during a live "reload all live sessions" sweep boots on whatever plugin code
  its cache last had, and nothing at boot catches it up - this is the structural reason the reply-tool
  redesign's own deploy needed a manual per-session `reload_plugins` call rather than one fleet-wide
  sweep being sufficient.
- [high] `src/mcp/devcontainer/hostDaemon.ts : handleWake` (devcontainer branch) /
  `buildLaunchCommand` - **architecture** - confirms the above directly: there is no boot-time
  equivalent of the `reload_plugins` op (no `/plugin update`, no `/mcp reconnect`) anywhere between
  container-up and launching Claude. `reloadPlugins.ts` is reachable only via a live MCP tool call or
  console op against an already-running session.
- [high] `src/mcp/devcontainer/reloadPlugins.ts : registerReloadPlugins` (self-targeting) -
  **confirmed live during this plan's own deploy** - `reload_plugins` targeting "self" drives the
  calling session's own tmux pane via keystroke automation, the same underlying mechanism
  `compact_session`/`set_effort_level` document as requiring the session to be IDLE to register.
  Calling it against an actively-busy session does not error, reports `initiated: true`, and silently
  fails to take effect - confirmed directly: this session's own self-targeted reload during the
  redesign's live deploy did not update its tool schema until the human manually ran
  `/plugin`/`/reload-plugins`/`/mcp` themselves at a natural idle point.

**Medium:**
- [medium] `src/gateway/websocket.ts : resolveHandshake` - **bug-class** - the `/true/i.test(response)`
  prose fallback mis-resolves a reply lacking the literal substring "true" to WORKER (permanent
  eviction, `suppressReconnect` never resets). Directly relevant given a mid-transition agent can end
  up on a stale tool and fall back to this exact prose path, as happened during this plan's own
  deploy - the regex itself was never tightened.
