# Pain points

## Announce chip (`plans/announce-chip.md`, deleted, shipped - 2026-07-11)

Migrated from `plans/announce-chip.md` (deleted, shipped - the attachment-chip decoration seam +
the Designer's rel-keyed card-title decorator; architecture in CLAUDE.md "Android plugin
framework"). Collected by its close-out crust sweep over the surfaces touched since the prior
sweep, including the fast-tracked `DesignerThumbs` thumbnails work that had skipped a full cycle.

- [medium] `android/.../ThreadRendererPool.kt : get : playEnabled` - **bug-class** - `playEnabled`
  is copied BY VALUE onto a renderer at creation, unlike `resolveFrom`/`selfLabel`/`decorateFile`
  (live-reading closures). `MainActivity` re-assigns the pool's var every recomposition, but
  nothing re-copies it to existing renderers - STTS provisioning mid-session never lights the Play
  buttons on any already-open thread. Functionally dead, not cosmetically stale. Fix: a live
  closure like its siblings, plus `fingerprint()` awareness so already-rendered rows re-push.
- [medium] `android/.../plugins/designer/DesignerThumbs.kt : renderOn` - **bug-class** - a timed-
  out render never `stopLoading()`s and registers no `invokeOnCancellation`; a straggling
  `onPageFinished` from the abandoned load can fire against the NEXT render's client and resolve
  its visual-state gate early, capturing a stale/partial frame that is cached permanently under
  the new card's rel (cache hits never retry). Narrow window (a 4s-blowing card immediately
  followed by another render). Fix: per-render generation check in the client + `stopLoading()`
  on cancel.
- [medium] `android/.../plugins/designer/DesignerThumbs.kt : cache` - **bug-class,
  privacy-relevant** - the 6MB bitmap LruCache is never evicted on thread forget or account wipe;
  `designer:forget`/`designer:wipe` clear `DesignStore` but a forgotten conversation's decoded
  thumbnails stay in process memory until LRU pressure or process death. Never re-surfaces in the
  UI, but inconsistent with the lifecycle-handler contract the store honors. Fix: team-aware
  eviction at the forget/wipe handlers.
- [medium] `android/.../plugins/Plugins.kt : build (inboundMessages bridge)` - **dup-logic** -
  hand-rolls the loop + `runCatching` + log idiom `PluginRegistry.forEachCaught` now owns;
  migrating also upgrades the log to the registry's claim-identifying message. (The
  `pluginActions` bridge stays: single-key `get()` dispatch has no matching registry primitive.)
- [low] `android/.../plugins/designer/DesignerThumbs.kt : attach/detach` - **dormant fragility** -
  the single-`var` WebView pool assumes exactly one `DesignerThumbHost` composed at a time (holds
  today: one `ThreadScreen` call site, plain conditional). A future dual-pane layout or animated
  transition silently starves the losing host's thumbnails (the `===` guard prevents corruption).
  Worth an assertion/log on a second attach.

## Plugin actions (`plans/plugin-actions.md`, deleted, shipped - 2026-07-11)

Migrated from `plans/plugin-actions.md` (deleted, shipped - the generic `plugin_action` mailbox kind,
gateway composer, Android dispatch, and the Designer's `designer_push_card`/`designer_delete_card` MCP
tools). Full design + red-team history in git (commits `dc28dbb`, `95e82c8`, `f35c008`); architecture
is in CLAUDE.md's "Console Bridge (Android channel)" section. Pruned to concrete, reachable findings
from the plan's own Phase 3 crust sweep - dead code with no behavioral consequence and pure dup-logic
were cut per this file's own convention.

- [medium] `src/mcp/bridge/helpers.ts : setIsMainOrLeadAgent` - **bug-class** - unreferenced anywhere,
  and it is the ONLY writer of the module-level `isMainOrLeadAgent` flag that `connectToRouter`'s
  handshake handler branches on. Since nothing ever calls the setter, `isMainOrLeadAgent` is
  permanently `null` at runtime, so the auto-reply branch (answer a lead/worker handshake
  automatically) never fires in practice - every handshake falls through to "let the LLM decide"
  instead. Either wire a real caller or delete the dead branch.
- [medium] `src/mcp/devcontainer/reloadPlugins.ts`, `setEffortLevel.ts`, `compactSession.ts` -
  **bug-class** - all three tool schemas are plain `z.object({...})` with no `.strict()`, the only
  tool-registration files left in `src/mcp/` that silently strip an unknown/typo'd field instead of
  rejecting it (every other tool - channel, human, designer - uses `.strict()`). Same three files also
  report failures as a JSON-stringified `{errors:[...]}` blob, structurally different from the flat
  `{content, isError:true}` string shape every other `mcp/` tool uses - a caller assuming tool errors
  are a flat string gets a nested JSON blob from just these three instead.
- [medium] `android/.../ChatRepository.kt : pollJob` (the `kind == "plugin_action"` drain branch) -
  **bug-class** - every sibling drop/skip path in the drain loop logs a `DebugLog` line with its drop
  reason (`DROPPED`, `SKIPPED`) unconditionally; this branch only logs inside the
  `if (pluginId != null && actionType != null)` guard, so a malformed plugin-action entry (null
  `pluginId`/`actionType`) is silently `continue`'d with zero trace - the one drop path that breaks
  CLAUDE.md's documented `[Drain]` log coverage ("kind, resolved thread, OR the drop reason").

Residual painpoints from shipped work, collected by crust scouts (record only, not fixed). Pruned to
concrete, reachable issues - dup-logic, naming nits, dead code with no consequence, and anything
gated behind a disclaimed precondition ("only reachable via a corrupted file", "negligible at this
app's realistic scale") were cut. Refs are `file : scope : name`; severity in brackets.

## Host daemon cleanup (`plans/host-daemon-cleanup.md`, deleted, shipped - 2026-07-11)

Migrated from `plans/host-daemon-cleanup.md` (deleted; its phases 1-4 shipped in PRs #96/#97, its
parked Phase 5 + dead-launch hardening moved to `features-and-fixes.md` Item 16). These are the
deferred follow-ups its audits surfaced, verbatim at migration time.

### Trusted-vs-untrusted catalog conflation

`isCatalogProject` and its clone union a TRUSTED source (`offlineCatalog`, host-token-gated) with an
UNTRUSTED, durable one (`knownTeamPaths`, written by the unauthenticated `/bridge` register). The
connector now gates on `offlineCatalog` only; these other sites still union, so an unauthenticated
register can influence them:

- [medium] `src/gateway/routes.ts : createRoutes : isDevcontainer` - sets `TeamInfo.kind`; an
  attacker-registered name can make a loose team show as a devcontainer spawn-point (console UI
  confusion, failed terminal-view).
- [low] `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : isProjectName` -
  device-name collision gate; an attacker register of a device name blocks that console from
  registering (transient DoS).
- [low] `src/gateway/console/consoleHandler.ts : resolveTmuxTarget` - terminal-view devcontainer
  resolution; benign today (the `docker exec` on a bogus `<name>_devcontainer-dev-1` fails
  gracefully) but inconsistent.
- [low] `src/gateway/index.ts : startGateway : isCatalogProject` (+ its `doWakeTeam` use) - the
  shared union predicate; `doWakeTeam` is currently safe (composites can never be catalog members)
  but reads on the untrusted half.
- Systemic fix: a named trusted predicate (`isTrustedCatalogProject` = offlineCatalog-only) or a
  typed `Catalog` value object exposing trusted vs any membership, applied per site. The tradeoff:
  `knownTeamPaths` is the durability fallback for a host-daemon outage (offlineCatalog clears on
  disconnect), so flipping a site to trusted-only degrades it during an outage. Decide per site
  whether trust or durability wins. ROOT cause (unauthenticated `/bridge` register) is
  `gateway-auth-surface.md` (postponed).

### Outbound-target validation pattern

- [medium, large-defer] `src/gateway/connectorProxy.ts : setupProxy` - dials `ws://<project>:20002`
  and trusts the caller validated `project` (documented via JSDoc, gated in index.ts). There is no
  systematic outbound-target validator (contrast the sealed-frame pumps' schema-then-semantic
  validation). An `outbound-validators` module with a guard per outbound class would make SSRF
  prevention systematic rather than per-call.

### Graceful-shutdown reconnector cleanup

The shared `Reconnector` exposes `cancel()`; evieClient and `closeRouter` use it, but two shutdown
paths still leak a pending reconnect timer. Cosmetic on a process that is exiting, but inconsistent.

- [low] `src/mcp/devcontainer/hostDaemon.ts : reconnector` - module-scoped, never cancelled;
  `main-host-daemon.ts` registers no SIGTERM/SIGINT handler. Needs an exported `stopHostDaemon()`
  calling `reconnector.cancel()` + signal handlers.
- [low] `src/gateway/index.ts : activateFederation` - the SIGTERM handler calls `evieClient.stop()`
  but SIGINT does not, so a Ctrl-C leaks evieClient's reconnector + heartbeat timers. Consolidate
  SIGTERM/SIGINT into one shutdown handler.
- [low] `src/gateway/evie/evieClient.ts : connect : ws.on("close")` - pre-existing: a stale socket's
  close handler unconditionally `ws = null` + `onDisconnect`; if it fired after a new socket
  connected it could null the new one. Guard the handlers on socket identity. Low risk in practice
  (the reconnect delay outlasts the close event).

### Coordinator / timeout pattern consolidation (large-defer)

- The four waiter/timeout coordinators (`WakeCoordinator`, `gateway/hostOpCoordinator`,
  `evie/evieClient` pendingCalls, `shared/pending-job-store`) share a request-wait-resolve-timeout
  shape; a `TimedWaiter` abstraction could consolidate them. Over-abstraction caveat: they differ
  (multi-waiter vs single, the mutable re-arm in `ackReceived`, persistence + TTL in
  PendingJobStore). Only worth it if a clean shared core emerges; otherwise tailored is clearer.
- Wake timeouts are split: `WAKE_TIMEOUT_MS` (`gateway/index.ts`) and `REGISTER_WINDOW_MS`
  (`gateway/websocket.ts`). A single timeout-config owner would make them discoverable. Minor.

### In-process tmux driver consistency

- [medium, large-defer] `src/mcp/devcontainer/reloadPlugins.ts : registerReloadPlugins` - still
  drives its own pane by GENERATING and spawning a detached bash script (the old pattern), while
  `set_effort_level` / `compact_session` route through `tmuxCore.sendText` + the shared
  `selfSessionTarget()`. Migrating reloadPlugins to a structured op through tmuxCore would unify all
  three in-process drivers and drop the shell-script generation. Intertwined with the Phase 5 TUI
  fragility (features-and-fixes.md Item 16).
- [low] `src/shared/host-op.ts : classifyPeekError : PEEK_ABSENT_PATTERNS` - inherent to classifying
  tmux/docker stderr: a future tmux/docker that renames a "session absent" message would fall
  through to `failure`. Acceptable (the list is in ONE place); validate the patterns on a major
  tmux/docker upgrade.

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
  `knownTeamPaths` (also tracked under "Host daemon cleanup" above).

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
  built and confirmed to cover this creation path too. `plans/team-collab-sessions.md` Phase 3
  promotes unsolicited cold-contact to normal, encouraged use (not just a tolerated edge case),
  which makes this gap more likely to matter under ordinary use rather than only adversarial use -
  it doesn't add a new capability, so it's noted here rather than fixed there.

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
  the groundwork. CORRECTED 2026-07-11: the "relay drops title/summary" claim originally recorded
  here was stale the day it was written - `response_push` gained the tier fields in f38b04c, and the
  fullSpoken work (`plans/full-spoken.md`) added `fullSpoken` beside them plus regression tests
  pinning that all tiers survive both `response_push` and `console_push`. The remaining
  forward-looking part stands: the user flagged multi-way chat as the actual direction they want.

### Crust-collection sweep

**High:**
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

## Team collab sessions (`plans/team-collab-sessions.md`, deleted, shipped and deployed - 2026-07-10)

Migrated from `plans/team-collab-sessions.md` (deleted, shipped and deployed - PR #111 merged,
live-verified: gateway rebuilt, all sessions reconnected, multi-team crosstalk confirmed working via
both user testing and direct log inspection). Pruned to concrete, reachable findings from the plan's
audit passes across all 6 phases; already-fixed and purely informational items dropped.

**High:**
- [high] `android/.../ChatRepository.kt : forget / startPolling` - **bug-class** - `forget()` runs
  synchronously on the main thread with no mutual exclusion against the poll loop's
  `appendInbound`/`bumpUnread`/`mailboxSync.commit()` sequence on `Dispatchers.IO`. Whichever side's
  `_state` update lands last wins: a just-forgotten thread can resurrect as a ghost session, or a
  freshly-arrived message can be silently and permanently wiped (the mailbox cursor has already
  advanced past it) - contradicting the app's own at-least-once mailbox guarantee. Needs a shared
  Mutex (precedent: `freshTeamsMutex`) serializing `forget()` against the poll loop's per-team
  sequence.
- [high] `src/gateway/routes.ts : respond / mirrorPeer` - **bug-class** - `respond()` has no try/catch
  around any of its 3 `mirrorPeer` calls; an uncaught throw from the cross-gateway mirror call is
  reported to the origin as a relay failure, so `relayWithRetry` retries up to 5 times (2s-16s
  backoff) and each retry re-runs the full `respond()` body - re-appending to the console mailbox
  with no dedupeKey and re-pushing over the live WS, duplicating an already-delivered reply 2-5x over
  a purely cosmetic downstream failure. Root cause: `mirrorPeer`'s own try/catch doesn't cover
  `ownerId?.()`, which runs before the try block, contradicting its doc comment's "never surfaces to
  the caller" guarantee. Untested.
- [high, pre-existing, predates this plan] `src/shared/federation-protocol.ts` (`send.from`) /
  `src/gateway/routes.ts : mirrorPeer` - **bug-class** - `send.from` is an unauthenticated free
  string with no binding to the cryptographically-verified `srcDomainId`/`srcGateway`. A federated
  inbound send's `mirrorPeer` call uses this wire `from` verbatim as the mirrored entry's sender -
  reachable by any admitted same-Domain or shared-cross-Domain peer, letting it attribute an inbound
  message to any arbitrary string up to 320 chars in the receiving owner's own console mailbox and
  live agent. Misattribution within an otherwise-legitimate delivery, not a routing bypass. Needs a
  dedicated look at `send`'s sender-identity model.
- [high] `src/shared/device-mailbox.ts : DeviceMailbox.evictOneForCapacity` (vs
  `console_push.entry.kind`) - **bug-class** - the OOM backstop's peer-priority eviction trusts a
  wire-supplied `kind` that a `console_push` sender now controls. A same-Domain sibling Gateway
  (compromised or buggy) can flood `console_push` entries stamped `kind: "notice"` (never a
  peer-priority eviction candidate) to trip the 10,000-entry cap, and once genuine `"peer"` entries
  are exhausted the fallback evicts the oldest entry of ANY kind - a real reply the owner is waiting
  on, or a real notice. Defeats the eviction priority's documented purpose using nothing but a
  same-Domain flood; needs a provenance concept `DeviceMailbox` doesn't have today.

**Medium:**
- [medium] `src/gateway/routes.ts : teams()` - pre-existing - `commonFields`'s `domainIdField` omits
  `domainId` entirely in arming mode, while every actual address-building path elsewhere in the file
  treats arming mode as domain `"local"`. `bridgeDiscover.ts` falls back to a bare unqualified team
  name in this case - inconsistent with the rest of the system's arming-mode convention, though
  still locally resolvable. Fix: stamp `domainId: localDomainId ?? LOCAL_DOMAIN_SENTINEL`
  unconditionally in `commonFields`.
- [medium] `src/shared/schemas.ts : TeamInfoSchema` - **framework-first** - fully specified but never
  runtime-parsed against wire data anywhere; every hop a `TeamInfo[]` payload crosses does a bare
  `as` cast, and `bridgeDiscover.ts` hand-rolls a drifted `DiscoverEntry` interface. A naive
  `.safeParse()` would be wrong, not just incomplete: `status`/`kind` are closed zod enums but the
  Kotlin side deliberately decodes both as open Strings for forward-compatibility, so reusing the
  schema as-is would silently drop every entry from a peer running a newer protocol version.
  Highest-consequence site: `consoleHandler.ts`'s `list_teams` result reaches Android via one atomic
  `kotlinx.serialization` decode of `List<TeamInfo>`, so one malformed peer entry can hide every
  session, local included, from the phone. Needs a deliberately loosened variant (strict on
  `team`/`gatewayId`/`queue_depth`, permissive on `status`/`kind`/`mode`).
- [medium] `src/gateway/routes.ts : send` - **bug-class** - the channel-mode branch's two
  local-participant `mirrorPeer` calls are unguarded sequential statements; if the first throws, the
  second (the recipient's own mirror copy) never runs, and the enclosing catch misreports the whole
  request as a 500 even though the real message already delivered - a caller retrying after seeing
  this would duplicate the actual channel_push too, not just its mirror copy. No shared dedupeKey
  links the mirror calls of one exchange, so there's no way to reconcile a one-sided mirror after the
  fact.
- [medium] `android/.../ChatRepository.kt : ChatState` - **framework-first** - flag-soup trending
  real: 4 of its 8 team-keyed collections are plain per-team scalars manually enumerated together at
  3 separate lifecycle boundaries, and `forget`'s own comment admits it ("key every field removal
  ... so a non-canonical spelling can't leave a field's entry behind" - a human working around a
  missing type). The same problem has already escaped into `ChatRepository.drafts` and
  `SttsPlayer`'s cache. Proposed fix: a `SessionUiState(closed, unread, working, needsLogin)` value
  type collapsing the 4-map cluster into one `sessionUi: Map<String, SessionUiState>`.
- [medium] `src/gateway/routes.ts : consolePush` - **bug-class** - `entry.session_id`/`from`/`to` are
  free strings with zero correlation check against any real pending job, session-store record, or
  registry entry. Same-Domain gateways are already fully trusted, but this is sharper: a compromised
  sibling Gateway can set `entry.session_id` to collide with an EXISTING trusted thread and craft
  `from`/`to`/`body` to look like a fabricated continuation of that conversation, with no UI cue
  distinguishing it from a genuine relay. Bounded by the already-accepted same-Domain trust model; a
  real fix (message-level signing so a recipient can verify authorship across a relay) is materially
  bigger than a patch.
- [medium] `src/gateway/routes.ts : fanOutConsolePush` - no caching/coalescing of the `list_gateways`
  roster fetch and no fan-out concurrency cap: a hot loop of local `send`/`respond` traffic or
  repeated `notify_human` calls each independently re-fetches the roster and re-fires the full
  fan-out. Per-destination retry/backoff is sane and bounded; a robustness gap, not a security hole.
  Worth a roster TTL-cache or fan-out debounce if Domain sizes grow.
- [medium] `src/shared/device-mailbox.ts : DeviceMailboxStore.sweepExpired` - a pure time-based scan
  with no concept of "a relay is currently targeting this key," while `relayWithRetry` can keep a
  delivery in flight for up to ~10.5 minutes. An ordinary transient relay retry straddling a sweep
  tick near the 1-hour idle TTL tears the mailbox down mid-flight; the compound case - an earlier
  attempt landed but its ack was lost, and eviction lands between that silent success and the retry's
  redelivery - produces a genuine user-visible duplicate with no coordination anywhere to prevent it.
  Same class as the `ChatRepository.forget` race above; cosmetic-only consequence.
- [medium] `src/shared/device-mailbox.ts : DeviceMailbox.append`'s dedupeKey/seenKeys - only ever saw
  a locally-minted key before `console_push`; now a same-Domain peer chooses the key and it's trusted
  verbatim (requires an already-highly-trusted peer to misbehave to matter). Separately, the
  pre-existing gap where an outer HTTP-level retry of `send()`/`respond()` re-runs `mirrorPeer` with
  a fresh dedupeKey now has a wider blast radius: a retry-produced duplicate previously showed up
  twice on one gateway; now it can appear mesh-wide, on any gateway the console might be polling.
- [medium, framework-first, logged as a future candidate] `src/gateway/routes.ts` is ~1400 lines
  (refreshed 2026-07-11 by the fullSpoken framework audit; the original ~1290 figure went stale in
  two days), the largest file in `src/gateway/`. The console mailbox delivery concern is now FIVE
  functions - `mirrorPeer`/`consolePush`/`fanOutConsolePush`/`humanNotify`/`pluginAction` (plus
  `PluginActionRequestSchema` and `HumanNotifySchema`) - and passes the ownership test as a
  genuinely separable sub-concern from core session routing. Worth extracting into its own module
  (natural home: `src/gateway/console/`), taking `mailboxStore`/`ownerId`/`evieClient`/
  `localGatewayId`/`resolvesLocalGateway`/`relayWithRetry` as explicit injected deps, matching the
  precedent `gatewayRelay.ts`'s narrow `FederationRoutes` dependency already sets. If picked up,
  bundle with hoisting `localAddress`/`tryLocalAddress`/`consoleSelfAddress` first, and treat
  `send()`/`respond()` (262/233 lines) as a separate, likely higher-priority target in the same
  file. Negative result worth recording: the fullSpoken commit would NOT have been smaller or
  safer with the extraction done - most of its routes.ts hunks landed in `respond()`, outside the
  would-be module. The honest trigger is the next console-bound mailbox kind or the next wire tier
  field, and the extraction should then land with a test-helper dedup (`makeCtx`/`fakeEvie`/
  `gateRoutes` exist as divergent copies in routes.test.ts and federation.test.ts) plus a
  table-driven tier-conservation harness over every mailbox-writing hop (deferred from the
  fullSpoken framework audit - the spread-once `NoticeTierWireFields` + `pickTiers` shipped
  instead and covers the declaration/compose halves of that bug class).
