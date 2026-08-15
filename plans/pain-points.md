# Pain points

## Manual host session start is broken in two silent ways (2026-08-07)

Found live, when the owner could not restart the primary session and a hand launch produced a deaf
stranger. Runbook is now CLAUDE.md's "Restart ritual, and starting a host session by hand".

- [high] **A bare `claude --resume` on the host is deaf and misnamed.** Without the daemon's
  `--dangerously-load-development-channels` flag the harness silently skips every channel push
  (handshake included, so the session sits "verifying" forever), and without `PROJECT_NAME` the MCP
  derives a fresh name from the forked harness session id, so the phone thread and board claims keep
  addressing the old name. Neither failure produces an error anywhere; the only traces are the
  harness's "Channel notifications skipped" line in mcp-logs and the gateway's unanswered handshake.
  A guard worth considering: the MCP refusing to register (or loudly warning) when it derived a
  `host.*` name AND the harness skipped its channel subscription, if the harness ever exposes that.
- [medium] **`down.sh` kills the host daemon and `start-gateway.sh` does not restart it.** The
  restart ritual has a missable third step whose omission is silent until wake/peek/spawn fail. It
  bit twice in one day, once during a release and once during the resulting debugging.
- [low] **A deaf manual session lingers as "verifying" while it lives.** It never answers its
  handshake, so it never becomes a record (confirm is what creates one, verified against the durable
  file) and vanishes on exit. The cost is confusion, not residue: the owner sees a session they
  cannot interact with beside the asleep card they meant to revive.

## Codex delegation (`plans/codex-thinking.md`, deleted, shipped - 2026-08-06)

All 8 phases shipped and deployed. Architecture is in CLAUDE.md's "Codex delegation" section; the
deploy-trigger painpoint this plan surfaced became CLAUDE.md's "The four components update on
SEPARATE triggers" subsection and is closed. What follows is what stayed open.

### Uncovered by tests, recorded rather than rushed

A coverage pass mapped the plan's own checklist to named tests: 41 requirements are covered, these
are not.

- [high] `src/mcp/devcontainer/codexTurnTracker.ts : settlePending` - **bug-class** - never called in
  production, and that is a HANG. It exists, it is exported, and only its own unit test invokes it.
  So a turn whose `turn/completed` arrives with `status: "completed"` but whose final-answer item
  never arrives is held forever: the tracker waits for an item that is not coming, no terminal is
  emitted, and the record stays `working`. `codexAwaitAgent` cannot rescue it, because reconciliation
  deliberately skips a record with an active turn. The caller's only escape is guessing to call
  `codexStopAgent`. The fix is a bounded timer in the daemon that settles a held terminal with
  whatever it actually holds, which is exactly what `settlePending` was written for. It needs an
  injectable clock and an `onHeld` callback to stay testable.
- [medium] No large-history test. Exchanges, operations and turns are uncapped and unpaginated by
  design. Nothing builds an agent with hundreds of entries and checks that persistence, restore and
  the list projection still behave. A cost that only appears at scale would land on a long-lived
  session, which is exactly the session that most needs its history.
- [medium] `src/mcp/index.ts` - the conditional registration line is untested.
  `if (hasCapability(...)) registerCodexTools(...)` is one line whose inversion would either expose
  the tools to every session or hide them from every session, and no test would go red.
- [low] `src/mcp/devcontainer/codexAppServer.ts : initialize` - incompatibility is untested. The
  handshake advertises no version, so there is nothing to check against; a future App Server that
  rejects or reshapes it surfaces as an opaque unavailable target rather than a clear signal.
- [low] `registerTool`'s wiring of an MCP input schema to a handler is still uncovered. The body
  building below it now is (`codexRequestBody`, checked against the gateway's own request schema,
  plus `routerPost` driven against a real socket), but the registration itself needs an MCP client.

### Structural, surfaced during the build

- [medium] `src/shared/codex-agent.ts` - its public, persistence, daemon, and App Server
  boundaries occupy one high-conflict module. It intentionally exposes one compatibility import
  today; preserve that barrel and split the implementation by trust boundary when a next consumer
  arrives.
- [medium] `src/shared/codex-agent.ts : OpaqueIdSchema` - **misalignment** - used for ids that
  have real internal structure. `CodexResolvedTarget.targetId` carries a grammar
  (`container:<project>`), but its schema says only "a string up to 512 chars", so neither zod nor
  tsc can catch a mismatch. Where an id has a grammar, the schema should carry it.
- [medium] The Codex contract and persistence tests repeat several valid histories, receipts, and
  restored-service setups. Canonical creating / working / settled / receipt builders would collapse
  them.
- [medium] `src/mcp/channel/channelReply.ts` + `humanTools.ts` - the same `ref://` prose is
  duplicated into the `channel_reply` and `notify_human` tool DESCRIPTIONS, and both are truncated at
  their own harness limit the same way the server instructions were. Moving guidance behind
  `switchboard_capabilities` is the same repair for all three surfaces; only the instructions block
  got it.

### Lessons that cost real rounds

- **A session cannot see its own instructions, and will confidently tell you it can.** Asking one
  what its system prompt says returns the copy the transcript started with, so a resumed session
  reports pre-deploy text as current with no way to notice. This cost several rounds of wrong
  conclusions in BOTH directions. The instrument that works is spawning `dist/main-mcp.js` and
  reading the `instructions` field from its `initialize` reply. Any future "what does an agent
  actually see" question wants that probe, never an agent's self-report.
- **The harness length cap is unobservable from the code.** Nothing errors, nothing logs, and no unit
  test can reach it, because the limit lives in the client rather than in anything this repo runs.
  That is exactly how 931 characters of `ref://` guidance went missing for an unknown length of time,
  including all ten worked examples. The delivered length landing on 2048 exactly is what identified
  it as a fixed limit rather than a token budget. The `capabilityInstructions` length test is a proxy
  at best; the real check is the probe above, and it belongs in the release ritual rather than CI.
- **A test fixture inventing its own shape is worse than no test.** Two separate times, a fixture
  used a shape the real system never produces and the suite passed against code that could not work:
  a launcher read `targetId` as a bare slug while the rest of the repo writes `container:<project>`
  (25 tests green against code that would reject every real target), and an item id did the same.
  Any field whose shape is agreed by CONVENTION rather than by a function both sides call is one
  fixture away from this. Fixtures for wire shapes want to come from the schema or a recorded
  response, never from a helper's imagination.
- **Every fix round introduced a new defect in the code it repaired, seven times running.** Not bad
  luck at that point, it is the shape of the work: a fix moves a decision, and the other readers of
  that decision do not move with it. The cheapest guard found was making ONE accessor the sole reader
  of a fact, which is what `answerOf` and `parseCodexTargetId` now are, backed by a residue test.
- **`git stash` can corrupt a file with null bytes, and every gate stays green.** Stripping them
  deleted four separator spaces inside two key-building template literals, making distinct pairs
  collide. tsc, biome and 2084 tests all passed. `file <path>` is what found it.

## Grepping `SYNC-HASH` lies about which files are synced leaves (2026-08-02)

The obvious way to answer "is this file a synced leaf, so must I re-stamp it after editing?" is to
grep the file for `SYNC-HASH`. That returns a **false positive on two files**, because both discuss
the mechanism in prose while explicitly stating they are not leaves:

- `src/shared/federation-protocol.ts` (the prose sits around line 232)
- `src/shared/cross-domain-sas.ts`

Both look identical to a real leaf under `grep -l "SYNC-HASH"`. The five files that actually carry a
stamp are exactly the five CLAUDE.md's table lists, so the table is right and the grep is what lies.

Two checks that do not:

```bash
grep -q "^// SYNC-HASH:" <file>          # anchored to the marker LINE, not the word
bun scripts/check-sync-hash.ts <file>    # exits 1 on a missing or stale stamp
```

Why it is worth the paranoia: editing a real leaf without re-stamping fails the SIBLING repo's CI on
a hash mismatch, which surfaces after a merge rather than before one, and the recovery is a
cross-repo sync rather than a local fix. Hit while stripping plan references from code comments: a
bare grep said `federation-protocol.ts` was a leaf, and the edit had already been made.

The inverse is the direction that actually bites. A false positive costs time and stops you. A real
leaf that lost its marker while keeping a prose mention would read as fine under the same bare grep,
and nothing local would catch it.

## Versioned state planes (`plans/versioned-state-planes.md`, deleted, closed out - 2026-07-18)

Phase 1 (plane registry framework, presence facade, PollWaitHub, working/needs-login derivation,
intent tracking) shipped and deployed. Phase 2 (legacy-timer deletion, linked-peers plane,
read-anchor sync plane, TerminalView latch rework, hand-rolled-sync-path sweep, docs) shipped.
Item 5 (cross-Domain presence) was never started - closing out this plan is not abandoning it, it
is spinning it off into its own fresh questionaire and plan rather than staying a trailing bullet
on a closed file.

### Phase 1's federation exchange was silently never built

Phase 1 item 6 (a gateway-owned anti-entropy timer for cross-Gateway VERSIONED presence exchange -
`presence_push`, per-source sub-planes, a peer freshness state machine) was fully designed across
three audit laps but never implemented - the shipped presence plane is local-Gateway-only, directly
reversing an explicit user ruling (multi-gateway "should work in parallel, equally") with no
recorded scope cut anywhere. Found by Phase 2's own audited-implementation cycle; the full writeup
and the preserved original design are in `plans/cross-gateway-presence-exchange.md`. The
`presenceFresh` wire field (declared, never assigned a value) and the `planeField()` closed-world
schema-tagging enforcement (promised three times, never built - only the reactive tripwire exists)
are the same gap's direct symptoms.

### Real bugs the read-anchors/Phase-1 audit found and fixed

An adversarial align + red-team pass over the read-anchor sync plane and Phase 1's presence surface
found and fixed several genuine issues, none of which had any prior test coverage: a WebSocket
register path that never announced a fresh connection to the presence plane (stale until an
unrelated bump or the 60s tripwire); an intent-tracking TTL nine times too short relative to the
real poll-hold cadence, falsely dropping the derived peek cadence to background mid-hold on every
healthy session; a `report_read` op with no bound on its `epoch` field, letting a single malformed
op permanently and irrecoverably poison an owner's cross-device read-sync state; the same op's
`team` field having no cap, letting one device grow an owner's read-anchor map (and the gateway's
own disk-write cost) without bound; the plane-registry tripwire having zero per-plane exception
isolation, so any single plane's snapshot/identity computation throwing crashed the entire gateway
process for every connected session; and a WebSocket conversationId collision evicting an unrelated
team's live socket with no team-match check, since a conversationId is not a secret. All fixed and
tested. The WebSocket handshake's `confirmedLeadTeams` team-impersonation gap and the
deterministic-forever channel-job-id reply-forgery gap were NOT fixed at the time - they were
deepenings of the same trust gap rather than new, isolated bugs. The impersonation half was later
closed at cross-project granularity by `artifact-references.md` Phase 0; see the Gateway LAN auth
surface section at the end of this file for what remains.

### A heavily-audited design document still drifted from what shipped, and nothing caught it until an independent align pass checked

This file went through three full audit laps before Phase 1 shipped - real scrutiny, not
rubber-stamping. It still confidently asserted several things as done that were never built (the
federation exchange, `planeField()`, the property-based class-kill-lock test) and one thing as
"will be deleted" that turned out to be load-bearing (`touchLive`). Design-time audit laps check
whether the DESIGN is sound; nothing in that process checked whether the SHIPPED CODE still
matched the design months later. The `audited-implementation` cycle's own align-fan-out step is
exactly that missing check, and it only ran because Phase 2 happened to route back through this
same plan - a plan that ships and is never revisited would keep lying indefinitely. Worth building
that revisit into the standard flow for any plan expected to survive past its own shipping lap.

### Writing a feature's own test suite does not reliably catch its own abuse cases

The read-anchors feature and its 14-test suite were written in the same sitting, by the same
author, and still missed the obvious abuse cases (an unbounded `epoch`, an unbounded `team` count)
until a dedicated red-team pass looked at it adversarially. Feature-authoring instinct covers the
happy path and whatever you were already thinking about (monotonic merge correctness, in that
case) - it does not reliably cover "what if a hostile or buggy caller sends something absurd,"
even when being careful. Concrete case for always running a genuinely separate red-team pass, not
folding it into the same sitting as implementation.

### Minor recurring friction, not worth dedicated fixes

Biome's import-order/line-wrap formatting needed a `bun run lint:fix` pass after nearly every
multi-file edit round in the versioned-state-planes cycle - never once caught a real bug, pure
friction. Also: a stray `cd android` mid-session left the shell's working directory changed for
every later Bash call, which silently broke a `git add` with relative paths (a confusing "pathspec
did not match" rather than an obviously-wrong-directory error) until traced back with `pwd`.

## Console hardening (`plans/console-hardening.md`, deleted, shipped - 2026-07-16)

Migrated from `plans/console-hardening.md` (deleted, shipped - the four phases the idle-pushback
manager's own crust sweep spun off: Phase A's per-team attachment purge on `forget()`, Phase B's
long-poll timeout chain pin, Phase C's consolidation of the 10 duplicated evie-direct request
shapes behind `postEvieDirect`, and Phase D's cancellable `ConsoleClient` transport). Shipped
through a full `audited-implementation` cycle per phase: plan alignment, red-team (Phase D needed
two rounds - the first fix pass introduced two real regressions, a `deliver()` placeholder deleted
on success and a `spawnSession()` clobber race, both caught and corrected before commit), a
framework-first pass (extracted the ~50-site cancellation-rethrow idiom into a new `Cancellation.kt`
helper family after two of three independent audit dimensions converged on it, catching a dead
redundant guard already drifted in `spawnSession` along the way), documentation, and - for Phase D,
the plan's final phase - a full crust-collection scouting sweep across the whole Android app (~38
files). Verified with real Android builds (`testDebugUnitTest`) throughout; committed in small,
separately-verified commits.

Pruned to concrete, reachable findings from all four phases' crust sweeps; confirmed non-issues
(a numeric coincidence between two independently-justified timeout budgets, explicitly NOT a design
relationship) were cut. Five of the Phase D crust-collection findings below (including all three
marked high) were independently verified against the actual code before being recorded, not taken
on the scouting agents' tone alone.

**High:**
- [high] `android/.../TerminalView.kt : TerminalView.fire` - **bug-class** - wraps the suspend
  `onSend` callback (bound to `ChatRepository.tmuxSend`) in a plain `runCatching { onSend(...) }
  .onFailure { sendError = ... }` with no cancellation guard - the same bug class Phase D fixed in
  ChatRepository.kt/ConsoleClient.kt, recurring here because this UI call site was outside that
  phase's scope. Closing the terminal tab mid-`tmux_send` misreports a clean cancel as
  `sendError = "send failed"` on the app's most-exercised terminal interaction path.
- [high] `android/.../SwitchboardService.kt : SwitchboardService.enterDeepSleep` - **bug-class,
  verified** - the `AlarmManager.setExactAndAllowWhileIdle`/`setAndAllowWhileIdle` calls have no
  try/catch, and `decide()` (which reaches this via `IdlePushbackManager`) runs from
  `ChatRepository.startPolling`'s poll loop textually after that loop's own per-pass `catch` closes.
  If either `AlarmManager` call throws (the file's own comment already acknowledges OEM quirks that
  can revoke `USE_EXACT_ALARM`), both wakelocks leak and the exception is uncaught by the poll
  loop's coroutine body. `startPolling` is called exactly once (confirmed - `onCreate`, no other
  call site), so this permanently and silently kills background polling for the life of the service
  instance, with no restart path short of the app being killed and relaunched.
- [high] `android/.../FederationManager.kt : FederationManager.ownerIdentity` - **bug-class,
  verified** - returns the raw owner Ed25519/X25519 PRIVATE keypair, the sole root-of-trust key,
  with default (public) visibility despite zero callers anywhere outside the class itself (confirmed
  by grepping the whole android tree). Every sibling accessor (`ownerSignPub`/`ownerBoxPub`/
  `ownerSas`) is deliberately narrowed to public material only; `FederationManager`/`AppStateStore`
  both have public constructors, so any code in the module could build its own instance over the
  same store and read the raw private key straight out. Marking it `private` would compile clean
  today and turns the (already-intended) restriction into a compile-time guarantee.

**Medium:**
- [medium] `android/.../EnrollCeremonyScreen.kt : EnrollCeremonyScreen.ComparePanel.onDiffer` -
  **bug-class** - re-wraps `repo.enrollCancel(...)` (already `runCatchingCancellable`-guarded
  internally) in a second bare `runCatching { }` whose `Result` is fully discarded, re-swallowing
  the cancellation the Phase D helper exists to let through and separately dropping every genuine
  `enrollCancel` failure with zero signal on a mismatch/tamper-warning path.
- [medium] `android/.../TrustCompareScreen.kt : TrustCompareScreen`'s dispose cleanup uses the
  wrong coroutine scope - **bug-class** - `DisposableEffect(Unit).onDispose` fires
  `scope.launch { repo.trustCancel(rendezvousId) }` on the composable's own `rememberCoroutineScope`
  - the scope being torn down by this same disposal - unlike its two siblings (`LinkWizard.kt`,
  `EnrollCeremonyScreen.kt`), which explicitly launch on `GlobalScope` with a comment stating the
  call "must outlive this composable." The FLOW-2 rendezvous close likely never completes.
- [medium] `android/.../SwitchboardService.kt : SwitchboardService.wakeLock` - **bug-class,
  verified** - plain `var` with no `@Volatile`, mutated from both the main thread and the poll
  loop's `Dispatchers.IO` thread, unlike the companion object's `passLock` (which correctly uses
  `@Volatile` + synchronized double-checked locking for the identical access pattern). A release
  racing an acquire can leak a wakelock nothing will ever release.
- [medium] `android/.../AppUpdater.kt : AppUpdater.downloadAndStage` - **bug-class** - blocks on
  OkHttp's synchronous `.execute()` with no cancellation wiring, the same shape Phase D just
  removed from ConsoleClient. Leaving the update screen mid-download does not stop the network call.
- [medium] `android/.../FederationManager.kt` : the `signRosterRequest`/`signTransportRequest`/
  `signTrustPendingRequest` family - **framework-first** - ~16 functions hand-repeat the same
  fetch-identity/sign-object shape with no shared helper; two of the three carry an explicit
  "(not the console key)" warning comment, evidence the console-vs-owner choice is already
  considered a mistake-in-waiting.
- [medium] `android/.../SttsPlayer.kt : SttsPlayer.playFile`'s MediaPlayer listeners - **bug-class**
  - `setOnCompletionListener`/`setOnErrorListener` release and null `loudness` unconditionally,
  unlike the sibling `player = null` lines gated on `currentKey == k`. A stale callback for a
  just-superseded track can silently kill the NEW track's volume boost mid-playback.
- [medium] `android/.../Attachments.kt : Attachments.storeOutgoing` - **bug-class** - writes each
  outgoing attachment straight to its final path with no tmp-file-plus-rename, unlike `decode()`'s
  documented atomic write for inbound files. A crash mid-write leaves a truncated file that
  `reconcilePending`'s retry path would silently resend.
- [medium] `android/.../ChatRepository.kt : closeTab`/`wakeSession`/`forget` (vs `rename`) -
  **framework-first** - the "is this parsed Address my own (domain, gateway)" predicate is
  hand-copied 6 times across ChatRepository.kt and MainActivity.kt, and only `rename()` tests
  domain AND gateway; the other 5 test gateway alone, against the codebase's own documented
  invariant that a gateway id is unique only within a Domain.
- [medium] `android/.../ConsoleClient.kt : relay()` - **latent logging footgun for future work** -
  Phase C's `postEvieDirect` redaction fix only covers the 9 evie-direct ops; `relay()` (Phase D's
  target) logs nothing today, but several of the ~21 ops it serves carry genuine plaintext secrets
  once `unsealReply()` decrypts them. A future trace line placed on the decoded result (rather than
  the still-sealed raw response) would leak. Not a live issue - nothing logs there yet.
- [medium] `android/.../DebugLog.kt : log()` - **bug-class, pre-existing, unrelated to this plan** -
  `fmt.format(Date())` (the shared `SimpleDateFormat`) runs outside the `synchronized` block
  guarding everything else in the function; `SimpleDateFormat` is documented non-thread-safe and
  this codebase calls `DebugLog.log` concurrently from independent `Dispatchers.IO` coroutines. A
  race can corrupt the timestamp or throw uncaught, aborting whichever op triggered it.
- [medium] `plugins/designer/DesignerCards.kt : relOf` - **dup-logic** - a third, independently
  written copy of the same "strip a src down to its attachments-relative path" parse `Attachments.kt`
  owns; this copy has already drifted (no `takeIf { isNotEmpty() }` guard, so a malformed src
  silently becomes `""` instead of failing safely). `DesignerCards.kt` already imports
  `Attachments`, so delegating is a one-line change.

**Low:**
- [low] (cross-file) the "outlive this composable" cleanup pattern is hand-rolled 3 times
  (`LinkWizard.kt`, `EnrollCeremonyScreen.kt`, `TrustCompareScreen.kt`) with no shared helper
  enforcing the GlobalScope-not-rememberCoroutineScope rule the pattern depends on - exactly how
  the TrustCompareScreen.kt copy above picked the wrong scope.
- [low] `android/.../FederationManager.kt : consoleAdmission` vs `admitConsole` - **naming trap** -
  `admitGateway`/`admitConsole` form a clear `admitX(subjectKeys...)` family for a third party;
  `consoleAdmission(nowMs)` instead self-admits THIS device with no subject-key params, in the same
  section with an easily-confused name. All current call sites are correct today - forward risk.
- [low] `android/.../DebugLog.kt : DebugLog.init` - **bug-class** - installs a chained
  `Thread.setDefaultUncaughtExceptionHandler` with no re-installation guard, called from 3 entry
  points each apparently written as an either/or fallback; `MainActivity.onCreate` re-runs on every
  Activity recreation (e.g. rotation), chaining one more layer each time.
- [low] (framework-first) clipboard access is hand-rolled per-file and has already drifted in UX -
  `Management.kt`/`HostNetworks.kt`/`MainActivity.kt` each redo the same `getSystemService` dance;
  `HostNetworks.kt`'s copy shows a "Copied." status, `Management.kt`'s two copies show none, even
  though one of those screens already renders a status slot next to the button.
- [low] `android/.../ConsoleClient.kt : postPublicApproval` - **low risk, confirmed by two audits**
  - the one response-body log line Phase C's redaction rule doesn't cover; `ConsoleApprovalResult`'s
  fields are public keys/display name/opaque ciphertext, not the onboarding bundle plaintext.
- [low] `proto/Protocol.kt : TrustPendingResult.rendezvousId` - **naming trap, not a bug** -
  confirmed safe to log (evie-served broker data, not a bearer secret), but
  `ChatRepository.trustExchange`'s comments call it "the pin" when passing it to
  `EnrollCeremony.sas`, reading as alarming out of context.

## Idle pushback manager (`plans/idle-pushback-manager.md`, deleted, shipped - 2026-07-16)

Tiered poll-cadence backoff ladder for the Android console's background polling (fast while
active, 1-minute while briefly backgrounded, then wall-clock-aligned 30-min/hourly/12-hour
wakeups the longer it stays silent) - `IdlePushbackManager.kt`, `PollAlarmReceiver.kt`, plus
`AppStateStore`/`ChatRepository`/`SwitchboardService` changes and 17 new tests. Shipped through a
full `audited-implementation` cycle: plan alignment, two rounds of red-team (a service-teardown
wakelock/alarm race and an unbounded notification-wait hang, both fixed), a framework-first pass
(a second live instance of the same timing-budget bug, fixed structurally by deriving three
constants from one root value instead of independent literals), and documentation. A follow-up
autonomous framework-first-design pass then worked the crust sweep's own findings: fixed the
codebase-wide missing-`callTimeout` gap (5 OkHttp client sites, plus a per-call split in
`ConsoleClient.relay()` so poll stays bounded without capping `send()`'s upload), derived or
test-pinned every same-repo comment-only numeric relationship, closed a coroutine
exception-handling gap that could crash the whole foreground service, fixed several incidental
state bugs (a re-provision leak, an attachment-purge gap, a `clearAll`/poll-drain race, a stuck
spinner, a stale roster screen, an unbounded dedup set), and reattached 4 orphaned KDoc comments.
Everything verified with a real Android build (`testDebugUnitTest` + the R8 `assembleRelease` gate)
and the TypeScript suite; committed in small, separately-verified commits. Not yet pushed to
origin as of this entry.

The four above-low items originally listed here (the `ConsoleClient` cancellability rework, the
10x duplicated evie-direct request shape, the `LONG_POLL_HOLD_MS` chain pin, and `forget()`'s
per-team attachment purge) were extracted into `plans/console-hardening.md` (2026-07-16) as
phases A-D with facts-from-code and fix directions. The three low/cosmetic items stay here:

- [low] `ChatRepository.kt : ENROLL_POLL_MS` * `ENROLL_POLL_MAX` (Android) - **cross-repo-drift-risk** -
  must stay under evie-bot's `EnrollHandshakeCoordinator.DEFAULT_TTL_MS` (10 min); the arithmetic
  and the cross-repo claim both live only in one comment, and evie-bot is a separate repo/deploy
  lifecycle this pass could not safely edit.
- [low] `SwitchboardService.kt` (Android) - **framework-first** - notification building/posting
  (`buildStatusNotification`, `teamNotificationBuilder`, `updateStatusNotification`,
  `reconcileTeamNotifications`, `notifyBurst`, `createChannels`, plus companion helpers) is ~40% of
  the file, touches no Service-instance state, and three other files already reach into its
  companion purely for notification constants - a clean extraction candidate. The wakelock/alarm/
  `DeepIdleScheduler` slice is correctly Service-glue and should stay.
- [low] `MainActivity.kt : Repo : get` (Android) - **discoverability** - the process-lifetime
  `ChatRepository` singleton accessor lives in `MainActivity.kt`, used by a Service and three
  BroadcastReceivers that have nothing to do with the Activity. Minor smell, not a correctness issue.

## fullSpoken (`plans/full-spoken.md`, deleted, shipped - 2026-07-11)

Migrated from `plans/full-spoken.md` (deleted, shipped - the fourth notice tier `fullSpoken`, a
spoken copy of the full body: required on both reply tools, carried through every wire hop via the
`NoticeTierWireFields` spread + `pickTiers` projection, and spoken by the console's FULL play in
the retired sanitizer's place; architecture in CLAUDE.md's notice.ts and channel-tools blurbs).
Shipped as PRs #115/#116 (7.7.0). Collected by the close-out crust sweep; already-recorded items
(the consolePeer dead branch, the routes.ts extraction + conservation-harness deferral) stayed in
their existing entries.

- [medium] `src/mcp/channel/channelReply.ts : buildChannelReplyPayload` (also
  `src/mcp/channel/humanTools.ts : notify_human handler's POST body`) - **dormant-fragility** -
  the tier-conservation doctrine has a hole at hop zero, the tool-to-gateway POST: both MCP
  builders hand-list the tiers instead of spreading `pickTiers(args)`, with no compiler error
  (Record<string, unknown>) and no SPOKEN_TIER_FIELDS-driven test pin (reply-tool.test.ts pins a
  hand-listed toEqual). A future tier added to the shared shapes auto-propagates through every
  gateway hop but silently drops here, and every downstream conservation test then "conserves" a
  tier that never arrived. Cheap fix: `{session_id, ...pickTiers(args), response: args.full}`
  style plus a field-list-driven pin on the builders.
- [medium] `src/shared/device-mailbox.ts : entryBytes` - **bug-class** - counts body + fullSpoken +
  attachments but skips title/summary/status on the "small tiers" premise that nothing below the
  tool boundary enforces (NoticeSummary has no max anywhere; RespondBodySchema's trio is uncapped).
  An arbitrarily large summary accrues zero against the 2GB OOM backstop, exactly where a dark
  device's unacked backlog piles up, and the durable snapshot serializes it every persist tick.
  Fix: count them (they are in memory already) or cap the trio at the wire.
- [low] `src/shared/federation-protocol.ts : console_push entry.title override` - **bug-class** -
  the relay hop tightens title to NoticeTitle (max 200) while the intake that feeds it
  (RespondBodySchema -> mirrorPeer) is uncapped, so a >200-char title from a raw /respond caller
  lands locally but the sibling gateway's FederatedOpSchema.parse rejects the whole relayed entry
  ("unseal failed", 5 burned retries) - validation mid-mesh instead of at intake makes an accepted
  entry permanently one-gateway. Multi-gateway Domains only. Fix: cap at intake or truncate at the
  relay hop.
- [low] `src/mcp/designer/designerTools.ts : PushCardSchema : message` (also
  `src/mcp/bridge/bridgeSend.ts : displayLabel`) - **framework-first** - the escaped-newline
  guard's halves drifted in the direction the lint-conformance suite cannot see: both fields are
  ENFORCED but their describes carry no REAL_NEWLINES_GUIDANCE, so an agent gets a hard reject on
  a field whose schema never warned it. The conformance test derives its list FROM
  guidance-marked describes, so enforcement-without-guidance is invisible to it. Fix: append the
  guidance to both describes; optionally pin the reverse direction too.
- [medium] `android/.../ChatRepository.kt : startPolling (drain tier mapping) +
  loadPersistedThreads` - **framework-first** - the tier-field invariant (null or non-blank) is
  applied at the two Message construction boundaries but neither APPLICATION is test-pinned:
  deleting `.tierOrNull()` from either site compiles and leaves the Android suite green while
  re-opening the blank-tier-plays-silence hole (worst at load: every absent tier on every legacy
  row becomes ""). Precedent for the fix is in the same file: extract a pure entry-to-Message
  tier projection the way `resolveMessageAttribution` was extracted and pinned.
- [low] `android/.../SttsPlayer.kt : stripUnspeakable` - **bug-class** - the fence rule is
  unanchored and its `$` alternative means an odd count of inline triple-backticks eats all
  trailing prose to end-of-message (replaced by "Code block omitted", never spoken). Byte-identical
  to the retired sanitize()'s rule (not a regression), but tierless peer asks are multi-KB
  markdown that participates in autoplay, so a brief quoting fence syntax inline drops its tail
  from speech with no cue. Fix direction: anchor the opener (`(?m)^` + fence) or pair-count.
- [low] `android/.../SttsPlayer.kt : key/cacheFile` (+ `ChatRepository : playMessage/preloadMessage`
  lookup) - **dormant-fragility** - the audio cache keys on `at`, which is a per-append
  `Date.now()` stamp, NOT unique: two entries landing the same millisecond in one thread share it
  while staying distinct rows, so Play on one can speak or replay the other and both glyphs light.
  Pre-existing; recorded because the arc re-blessed the keying on the stated-but-false uniqueness
  premise. Fix direction: key wire rows on (epoch, seq), already on Message.
- [medium] `nyaaskills/src/cycle/lib/notify.ts : relayInstruction + NotifyHumanSchema /
  buildNotifyHuman` (+ `cycleCheckpoint.ts : schema`, + `cycle.test.ts` payload pins) -
  **bug-class, rides nyaaskills' next deploy** - the checkpoint relay instruction misleads on BOTH
  branches: it names the retired `respondAsMarkdownString` param (channel_reply's strict schema
  rejects it AND the missing required fullSpoken), and the fallback "call notify_human with the
  payload" carries a required `urgent` boolean switchboard's strict schema rejects as unknown
  (nothing in switchboard ever consumed it). Its field inventory omits fullSpoken. The "skip
  silently" escape gives a confused agent a sanctioned path to drop the report. Fix set: name all
  four tiers, use `full`, delegate fullSpoken authoring to the relaying agent explicitly, stop
  passing urgent, update the schema mirror-claim comment and the test pins in the same commit.
- [low] `skills/crosstalk/SKILL.md : CLI agents section` - **dead-code** - still instructs the
  retired `crosstalk_reply` for CLI agents in two places (the tool and the CLI dispatch mode were
  removed with the host split); the addressed audience can no longer connect, so the only harm is
  misleading a channel agent about the system's shape.
- [medium] `src/mcp/devcontainer/reloadPlugins.ts : spawnReloadPlugins` (+ `routes.ts : health`) -
  **framework-first** - the load-bearing rollout order (gateway rebuild BEFORE the version-bump
  push) is enforced by nothing mechanical; reload_plugins has no gateway pre-flight and /health
  carries no version signal. Half the handshake exists (plugins report packageJson.version at
  register, surfaced in teams()), but nothing gates on it and the reverse direction (gateway
  advertising its version) does not exist. Guard candidates: stamp the gateway version on /health
  + a reload_plugins pre-flight, or a register-time skew warning.
- [medium] `src/gateway/routes.ts : HumanNotifySchema` - **framework-first, recurring deploy
  class** - with marketplace autoUpdate, the fleet-wide 400 window for ANY strict-schema field
  addition opens at the version-bump PUSH (any session restart auto-updates), not at a deliberate
  fleet reload. The fullSpoken arc dodged it per-field (gateway-side optional, ship order:
  gateway rebuild, then bump push), but that is prose-only discipline the NEXT wire field must
  remember. Framework direction: a lenient-at-the-gateway-edge convention for notice/tier fields
  (the RespondBodySchema precedent) or the version handshake above.
- [medium] `start-gateway.sh : git pull / docker compose up --build` - **bug-class** - both git
  ops are `|| true`d with no dirty-tree or HEAD-vs-origin check and the health loop prints ready
  regardless, so a silently-failed pull deploys STALE code while reporting success - and "rebuild
  the gateway" is exactly the step the rollout order depends on. Uncommitted local edits also
  ride into the production image (routine on this machine, the live dev tree). Minimal fix: warn
  or require a flag when dirty / HEAD != origin/main, surface a pull failure.

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
  whether trust or durability wins. ROOT cause (unauthenticated `/bridge` register) is the Gateway
  LAN auth surface section at the end of this file (postponed).

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

Owner-deferred (decision A); the root fix is the Gateway LAN auth surface section at the end of this
file, still unbuilt. These are concrete manifestations of that same known gap, not standalone
theoretical concerns.

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
  items above (the Gateway LAN auth surface section at the end of this file); tracked until a
  LAN-facing gate is built and confirmed to cover this creation path too. `plans/team-collab-sessions.md` Phase 3
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

## Cross-domain presence (`plans/cross-domain-presence.md`, deleted, shipped - 2026-07-23)

A linked Domain's sessions now reach a Gateway's own console as a live push (with a 10s backstop
pull), replacing the old discovery-refresh-only pull for that relationship; Android surfaces it as
a "Linked friends" board section. Shipped across 3 phases (gateway source/consumer planes, wire
shape + reconciliation, Android UI), each independently audited (plan-alignment, red-team,
framework-first). Folding forward the pain points still worth remembering.

### `PlaneRegistry` friction, recurring across phases

- `wake()` only notifies a waiter whose presented map already has a key for the plane that just
  bumped - a LAZILY-registered, N-ary plane family (a per-relationship plane, keyed per linked
  Domain) MUST be eagerly pre-registered for every currently-relevant key before racing
  `waitForBump`, or a brand-new key's first-ever bump can never wake an already-held poll. Not
  documented anywhere on `PlaneRegistry` itself - every OTHER plane in the codebase is either
  always-registered or registered once per request before racing, so nothing about the framework's
  own shape hints that an N-ary lazy family needs a whole sweep first. Found only by tracing the
  membership check by hand; a future author building a similar family would likely rediscover it
  the same way, by shipping the bug first.
- `PlaneRegistry` has exactly one signal (a version bump) for "tell any waiting poller" - this
  feature needed a second, weaker one ("periodically tell them anyway, even if nothing changed", to
  prove a backstop cycle confirmed continued freshness while idle) that had to be smuggled in via a
  coarsened-timestamp hash rather than expressed directly. Works, and is tested, but a
  periodic-refresh-without-a-real-change signal feels like something the framework might want as a
  first-class concept, rather than every such feature reinventing its own bucketing trick.
- Plane names are hand-formatted template strings (`presence:crossdomain-source:<domainId>` vs
  `presence:crossdomain:<domainId>`) with no static check that two prefixes can't collide - picking
  visually-distinct prefixes was a manual, eyeball-it decision. Nothing gives a caller a
  "namespaced plane family" to declare once; every per-relationship-plane feature re-derives
  naming-uniqueness by hand.

### Missed on first write, caught only by a dedicated adversarial pass

- `pullPresenceFromDomain`'s sequential-vs-parallel gateway fan-out bug (a `for...await` loop that
  should have been `Promise.all`) did not surface during implementation review - it reads as
  obviously correct in isolation, and its own sibling functions in the same file already
  established the concurrent convention, yet copying that convention by eye still got missed on
  first write. Only red-team, specifically reasoning about a hung-peer scenario with 2+ gateways,
  caught it. Nothing about writing this kind of fan-out loop prompts the "wait, should this be
  concurrent?" question at write time; it only becomes visible when deliberately asking "what's the
  worst case for the slowest participant."
- Adding a rate-limit floor to a constructor retroactively broke roughly a dozen pre-existing,
  unrelated tests that happened to call the same landing entry point twice in quick succession -
  each needed a magic trailing `0` argument to opt out. A positional-argument constructor makes
  bolting on a new cross-cutting default behavior feel fragile after the fact; an options object
  from the start would have made "this test opts out of the new default" self-documenting instead
  of an unexplained `0`.
- "Does this peer-controlled string need a `Map` instead of a plain object" is tribal knowledge
  re-derived per feature - one part of this plan's own state needed it, a sibling plane's
  owner-keyed state never did (a fixed-format hash key is safe by construction). Nothing flags
  "this key is free-form, not hash-shaped" for a future author to notice on their own; caught only
  because someone happened to red-team it.
- A high-severity Android crash (a linked-but-only-cryptographically-trusted peer's Gateway could
  send two session entries sharing one identity, crashing a Compose `LazyColumn`'s duplicate-key
  check) existed for one full audit lap before red-team caught it - three independent review
  dimensions found the SAME root cause independently, which is reassuring convergence, but the
  underlying gap (no uniqueness invariant on a peer-supplied array, at any layer from wire schema to
  landing to client) had been sitting through an entire prior implementation and align pass first.

### Android/Kotlin-specific

- `Team.gatewayId` (a computed property deriving from the canonical address, not a stored field)
  THROWS on an address whose gateway segment would parse empty, rather than returning `""` - a
  reasonable invariant for real wire data, but a genuine footgun for a test author building
  synthetic fixtures who expects a plain property read to degrade gracefully instead of validating.
  Cost a real debugging cycle before tracing it back to the address parser's own slug validation.
- A Compose screen's board-rendering gates (an empty-state placeholder, a health-status header, and
  the main list's own grouping) all derived from the same few booleans, and the logical
  relationship between them (two of them being exact De Morgan negations of each other, so a guard
  added to one could silently break another's agreement) lived only as prose scattered across
  separate comments on each gate, never factored into one place a future change could reason about
  locally. This is exactly what let a regression happen in one audit lap and very nearly happen
  again in a different direction in the next - three separate audit passes were needed to fully
  converge on a correct state, a lot of adversarial firepower for what is, in the end, four or five
  lines of boolean logic. Worth a single named helper or one unified comment block encoding the
  whole invariant, next time a screen like this gets touched.
- Positive: an established "Android-free, JVM-testable top-level pure helper" convention (already
  set by an older, unrelated comparator) made writing and testing three brand-new small helpers this
  plan needed genuinely frictionless once recognized - a real case of an existing pattern paying for
  itself on the next feature to need it.

### Reused, not re-invented

The same-Domain multi-Gateway presence exchange parked in `plans/cross-gateway-presence-exchange.md`
explicitly deferred its own outbound-coalescing and anti-entropy-timer design pending this plan
shipping first. It has: a real per-destination coalesced-pusher pattern and a real independent-tick
reconciler now exist as shipped, tested code in `src/gateway/federation/crossDomainPresence.ts`, so
picking that plan back up should mean sharing/mirroring this code, not re-deriving the pattern from
scratch. See that file's own "When this is picked back up" section, which points here.

## Console poll drain vs the evie WS frame ceiling (found by the artifact-references plan audit, 2026-07-23)

The console's poll reply ships the ENTIRE unacked mailbox backlog in one sealed
`console_relay_reply`: `drain` returns every entry, the handler returns them wholesale (no
paging), and sealing re-base64s the already-base64-bearing entry JSON (a second 4/3 inflation).
evie's `BridgeTransport` calls `Bun.serve` with no `maxPayloadLength`; Bun's default is 16 MB and
it CLOSES the WebSocket on a larger message. So the effective ceiling on one drain is roughly
9 MB of decoded attachment bytes across the whole backlog. A phone parked on the 12-hour idle
tier while attachment-bearing notices accumulate (screenshots already make this reachable today,
no new feature needed) can cross it, and the failure mode is nasty: the gateway's entire evie WS
drops BEFORE delivery, the console never receives so never acks, and every subsequent poll
re-kills the WS - while the actively-polling console keeps refreshing `lastActivity`, so the 1h
mailbox idle TTL never clears the poison.

Fix directions (either suffices): page the drain (cap entries/bytes per poll response and let the
cursor advance incrementally across polls - verify the console's ack-highest-received semantics
make this a server-side-only change), or set an explicit `maxPayloadLength` on evie's Bun.serve
with a graceful over-limit path. The artifact-references feature bounds its OWN replies (2 MB
per-message aggregate artifact budget) but deliberately does not own this backlog bound, per the
owner's scope ruling on that plan.

## Gateway LAN auth surface (`plans/gateway-auth-surface.md`, DELETED as unsound - 2026-07-24)

That plan was deleted rather than shipped: its central decision does not survive contact with the
code (see "why the gate was unsound" below). Everything still true or still owed is consolidated
here, since this file is where live gaps belong.

**The finding, which stands.** The gateway's whole HTTP+WS API is published to the LAN on port
20000 (`docker-compose.yml` maps `0.0.0.0`) with NO app-layer auth on any handler. Only two things
are gated today: the reserved `host` WS slot (`HOST_WS_TOKEN`) and `/admit-payload` (a one-time
enroll nonce). So any device on the wifi can, with no credential and no relationship: `POST /send`
(prompt-inject any agent, and since session-id-teardown Phase G also MINT records and drive real
container bring-up, an unbounded resource amplifier); `POST /human/notify` and `/plugin-action`
(spoofable `from`, so phishing notices and device-plugin actions attributed to anyone);
`POST /ingest` (unbounded log append, disk-fill, and NO in-repo client posts this gateway route, so
it should simply be deleted rather than gated); `GET /pending` and `/teams` and `/discover` (recon,
and `/pending` leaks every live session_id which then arms `/respond` and `/poll`); and
`WS /connector/{project}/ws`, whose `project` is an unvalidated attacker-chosen hostname the proxy
dials outbound, an SSRF/arbitrary-egress primitive.

**Why the gate it decided was unsound.** The design was origin-aware: trust docker-bridge sources
`172.18.0.N`, require a `GATEWAY_TOKEN` from `172.18.0.1` (host and LAN, indistinguishable under
userland-proxy). Two defects, both verified against the code by the 2026-07-24 session-identity
battle:

- The `172.18.0.*` hinge is pinned to a subnet the machine RE-ROLLS. No subnet is configured
  anywhere (`grep -rnE '172\.1[6-9]\.|ipam|subnet'` over `src/`, `docker-compose.yml`,
  `install.sh`, `scripts/` returns zero hits), and `start-gateway.sh` runs
  `docker compose down --remove-orphans` then `up`, destroying and recreating the network on every
  gateway start. The empirical `172.18.0.0/16` was one boot's observation, not a stable fact.
- Read as a denylist ("not `.1` therefore trusted") it FAILS OPEN for the exact attacker it exists
  to stop: a LAN client at `192.168.1.x` is not `.1`, so it passes. Any future version must be
  deny-by-default (trusted IFF inside the runtime-discovered bridge subnet and not the gateway
  address), which also fails safely and loudly if discovery breaks.

It also never solved token delivery for a HAND-LAUNCHED host Claude window (it assumed the host
daemon, which shares `.env` for free). Gating any route such a window needs either 401s it or
silently degrades it. A 0600 file under `~/.config/switchboard`, mirroring the provisioning blob,
is the obvious shape but is undesigned.

**What got built instead.** The 2026-07-24 battle established that network origin and session
identity are ORTHOGONAL, and that the gate addresses only the former: a compromised devcontainer
sits on the trusted side of it. The identity layer (launcher-injected per-session tokens, `from`
proven against the binding, `/respond` ownership including the handshake and vibe-check branches,
binding-keyed `confirmedLeadTeams`) shipped as `plans/artifact-references.md` Phase 0.
Cross-project impersonation is closed there; same-project panes share one container and one uid,
so they remain mutually impersonable by OS construction, permanently.

**The `host` SPAWN is still unreserved,** and deliberately so. Both host protections match the bare
string `host`, while every real host session is `host.<6hex>`, so a container can register a
`host.*` name no record has armed. Reserving the prefix does not work: a hand-launched host Claude
registers exactly that shape and would be locked out, which the owner's comfort ceiling forbids. A
squat confers no privilege (the tmux drive path is console-side behind the sealed relay) but does
list as a host-machine session on the board, so the owner could mistake it for their own. Closing
it needs a way to tell a legitimate hand-launched host session from a squatter, which nothing
today provides.

**Still owed, nobody assigned:** the LAN-stranger half in any form (the whole list above is still
reachable by a wifi neighbour); deleting the dead `/ingest` route; validating `/connector`'s
project hostname; a body-size cap on `/human/notify`; read-side ownership on `/poll` and
`/pending`; the ungated fan-out (delivery is never gated on handshake confirmation, so a socket
registering a victim's name still receives its pushes); and `bindResume`'s tier-2 path, where
`bind()` matches a record by transcript id regardless of the registering team.

## Console capability union (`plans/artifact-references.md` Phase 1, 2026-07-24)

**A revoked device keeps voting in the capability union for 14 days.** Removing a lost phone
through Your devices drops its admission, so the sealer rejects its frames from then on and its
`lastSeen` freezes. Nothing purges its `CapabilityStore` record: the class has no per-device
delete, and `teardownDevice`/`removePeer` (which do clear bindings, signers, opCache, ownerDevices
and the mailbox consumer) are never reached on revocation. So `snapshot()` counts it as live until
the 14-day TTL expires it.

Two adversarial verifiers split on this, and the surviving harm is small. The union only ever ADDS
ids, so a stale record can never strip a capability a live console has, and it cannot pin different
instruction text either: the text ships in the APK's own `manifest.json`, so every device on a
build reports the same string. The residual is that if the revoked device was the ONLY one with a
plugin enabled, sessions started in that window register its tools and carry its guidance. That is
the same direction the design already fails on purpose (`FAIL_OPEN` is `[{id:"designer"}]`), so it
lands inside the sanctioned posture rather than outside it.

Not built because the obvious hook is wrong. Purging on `teardownDevice` would tie capability
lifetime to the mailbox's 1-hour idle eviction and directly break the plan's own goal that a phone
dozing on the 12-hour tier keeps voting. The correct fix is a revocation-time hook: when
`Allowlist.applySnapshot` drops a console admission, resolve its signing key to a conversationId
(`consoleHandler`'s `signers` map already holds that mapping) and purge the record. That is new
plumbing across allowlist, consoleHandler, and the store for a minor, self-healing issue.

**Refuted in the same pass, recorded so they are not re-raised:** the cache file blocking
`0) Purge Federation` (the `rmdir` is already non-recursive and swallowed, and the cache holds no
secret); an oversized `agent_instructions` bricking register (the 2000-char cap is enforced at the
schema boundary and the plugin is toggleable, so there is no APK-only recovery); unbounded
aggregate instruction text (reachable only by the owner's own admitted console, which already holds
strictly greater power); a newline in `instructions` escaping its bullet (same trust boundary, and
every entry is prefixed under a labelled heading); and a dropped toggle re-register leaving the
gateway stale (best-effort by contract, and it degrades into the fail-open baseline).

**The MIRROR of that last one had teeth, and was fixed.** A verifier noticed that a dropped
toggle-ON report is not symmetric with a dropped toggle-OFF: a fresh install reports `[]` (an empty
array, not absent), so the gateway holds an AFFIRMATIVE union, and an affirmative union is exactly
what the MCP does not second-guess. The owner would silently lose a tool they had just switched on,
until the next process restart re-registered. `reportEnabledPlugins` now arms `pluginReportPending`
on entry and clears it only on a landed report, and the poll loop retries a pending one beside its
other bounded-interval maintenance.

### Framework-first pass, and what it deliberately left

The assessment found two REAL pre-existing durability bugs, both verified by running them, both now
closed by `openDurable`/`restoreDurable` in `shared/durable-store.ts`:

- **A corrupt `mailboxes.json` destroyed the owner's whole session list.** `mailboxStore.restore`
  throws on a snapshot missing `entries` (a shape that passes the `typeof === "object"` guard), and
  it shared one try with `sessionStore.restore`, which therefore never ran. The 3-second persist
  tick then wrote `{sessions:{}}` over a perfectly good file. Silent, permanent, and from an
  unrelated file.
- **A corrupt `replay-guard.json` was an unrecoverable boot loop.** Its restore had no containment
  at all, so a bare number array threw inside `startGateway`; `replayPersist` is assigned on the
  next line, so nothing could ever heal the file.

Both were reachable because "restore this file" and "contain this file's failure" were separate
concerns that each caller improvised, and the capability work added the fifth improvisation. They
are one call now.

**Deferred, with reasons rather than as a backlog dump:**

- **`CapabilityAnswer`, the no-answer as a VALUE** (the `sessionAuthority.ts` treatment). Today
  "the device said nothing" versus "the device reports nothing enabled" is spelled four ways across
  two languages, and every one of them is an absence a caller can fall into. A tagged union would
  make `?? []` stop type-checking. This is the strongest remaining proposal and the one to take
  first; it was left out only because it crosses to Kotlin and this phase had already grown.
- **`DeviceLifecycle`,** allocating device-keyed state through one registry so a satellite store
  cannot outlive its device. This is the by-design fix for the revoked-device staleness above. Not
  taken: it rewrites the teardown ordering invariants in `consoleHandler.ts`, and the per-satellite
  lifetimes are deliberately different (mailbox 1h, intent ~135s, capabilities 14d), so the registry
  has to model tiers rather than one clock.
- **`CapabilityStore` giving up its own file** to join the tick-driven snapshot/restore idiom, which
  would delete the flush-floor machinery entirely. The assessor was straight that this eliminates no
  bug class, and it is duplication removal only.

## Artifact references (`plans/artifact-references.md`, deleted, shipped - 2026-07-25)

All five phases shipped and the feature is confirmed working end to end on a real device: an agent
writes a `ref://` link, the MCP snapshots the target, and a tap opens the code viewer on the resolved
lines. The plan is deleted; what follows is what it left behind.

**Open work, roughly by cost:**

- **Dead style: `a.link-handled.link-fuzzy`.** `thread.css` styles it and no code has ever applied
  that class, so a drifted ref reads the same as an exact one in the chat body. NOT wanted: the owner
  asked twice for the amber SYMBOL highlight inside the code viewer, which was already built and
  works, and confirmed the chat-body tier is not what was meant. Either wire it or delete the rule,
  but a styled class nothing sets is what made this look like a missing feature for a whole evening.
- ~~**The reserved manifest name is claimable when a body carries no detected ref.**~~ RESOLVED, and
  worth reading before anyone reaches for a filename check again. There is no reserved name and no
  positional selection rule: a snapshot declares `role: "ref-snapshot"` at compose time and a
  receiver classifies from the entry it already holds. An attachment named
  `switchboard-references.json` is now an ordinary attachment and must ship, which
  `evieFiles.test.ts` asserts. Adding a compose-boundary filename check would re-derive role from
  content, which is the exact defect six commits were spent removing.
- **No cross-runtime vector pins `safeName`/`uniqueName`.** Its absence is why both filename
  divergences (an astral character splitting into two underscores; dedupe seeded from a set rather
  than the ordered assignment) shipped with a green suite.
- **`referenceRoot()` cannot fall back to cwd inside a container,** because `PROJECT_NAME` is always
  set by then, so any container whose project is not literally at `/workspace/<spawn>` fails every
  ref-bearing send with a root-does-not-exist error.
- **`walkSegments` branches are paths, not nodes,** with no memo on `(node, consumed)`. Measured 2.2s
  on a 724-byte file of deeply nested same-named functions; memoizing collapses it to linear.
- **A C# file-scoped namespace resolves to its own one-line declaration** when it is the final
  segment. `searchAreas` supplies the sibling run for navigation, but the RANGE is still the node's
  own extent.
- **Aliased spellings of one file ship duplicate snapshots** (`src/x.ts`, `./src/x.ts`, and a
  symlinked `lib/x.ts` produced three), because the builder keys on the written path rather than the
  resolved absolute one, so a large file double-counts against the aggregate budget.
- **`coversWholeFile` disagrees with `wholeFile()` by one line** on any file ending in a newline, so a
  matcher-miss on an oversized file gets the wrong error message. Nothing is smuggled past the cap.
- **`columnOf` returns -1** for a match at index 0 when the file begins with a newline.
- **A GDScript highlight grammar is not vendored,** so `.gd` snapshots render unhighlighted.
- **`AttachmentChipDecorator` has no message coordinate,** so the References hide verdict scans every
  summary the team ever recorded rather than the one row's. See the seam lesson below.

**Lessons, the ones that cost something:**

- **A green suite is not evidence that a cross-runtime contract holds.** Both filename divergences
  passed every test, because the only assertions were TS-side echoes of the same assumptions the
  implementation made. Where two runtimes must agree, the shared corpus is the test, not polish.
- **Writing an invariant down is not checking the code against it.** The scanner's own doc comment
  said "over-masking silently drops a ref with no error anywhere", and the masking pass shipped doing
  exactly that across blank lines.
- **An idempotency property wants a fuzzer, not examples.** The canonical key had a hand-written
  every-separator case that passed while `>` and space both broke round-tripping; a 60k-shape
  generator found the class in seconds. Anything contracted as `f(f(x)) == f(x)` gets the generator.
- **Auditing my own claims found more than auditing my own code.** Four audit passes over the
  resolver missed the dotted C# namespace bug; pointing an audit at the sentence "all seven grammars
  resolved exact" found it immediately, because the fixture chosen to prove it dodged the case.
- **Inline-snippet tests encode what you imagine a language looks like.** The committed fixture tree
  exists because a file written the way a person writes it is a different test. A `class_name` at
  file scope, the idiom nearly every real Godot script uses, resolved to a CALL SITE for as long as
  the feature existed, while the only `.gd` fixture used an inner class.
- **The framework seam decides what a plugin can do well.** `TappedLink` carries the resolved row's
  files, so its handler cannot look at the wrong row. `AttachmentChipDecorator` carries only
  `(team, file)`, so its verdict has to scan everything. Same plugin, same session, opposite
  outcomes. Pass the coordinate, not just the payload.
- **A CSS rule can defeat intended behaviour with nothing to fail.** Twice in one night: a claimed ref
  link coloured with a `--accent` that was never defined (so every ref rendered as plain prose, since
  a claimed link deliberately carries no href either), and `#banner { display: flex }` outranking the
  browser's `[hidden]` so the drift banner showed on every reference, empty. Neither is reachable by
  any test on either side of the wire, and both needed a screenshot. `thread-css-variables.test.ts`
  now guards both shapes, and `plans/emulator-sandbox-build.md` exists because of them.
- **A debug log stream found in one pass what hours of reading source did not.** The attachment race
  was diagnosed the moment the device reported `uris=1 read=0` beside a file that existed a
  millisecond earlier. Reach for instrumentation before narrating what has been ruled out.

## Attachment gallery (`plans/attachment-gallery.md`, deleted, shipped - 2026-08-02)

Sections 1-9 and both required intermissions all landed. Nothing was left unresolved; the only
deferral on record is J-1, message-level file metadata, scoped out deliberately rather than skipped.
Its own painpoints were folded into the artifact-references section above as they were found.

## Emulator sandbox build (`plans/emulator-sandbox-build.md`, deleted, shipped - 2026-08-02)

The build type shipped and earns its keep, but it carried three open items its plan never closed.

- **The sandbox cannot fake presence states** (`working`, `verifying`, `available`), which drive the
  pulse bar and the terminal view's own gating. Confirmed as a real gap while shipping the
  usage-limit dialog: the chat dock and board tile were both verifiable by seeding a `Team`, but the
  terminal's own Resume affordance derives from a peeked pane, and there is no canned frame to peek.
  Rendering one needs a seam in shared code, not a fixture edit, which is why that one surface
  shipped compile-verified rather than seen.
- **`SwitchboardService`'s poll loop is left running** in this build rather than suppressed, failing
  into a cosmetic "Gateway not provisioned" banner. Deliberate, and the banner is honest about what
  the build is, but it was never revisited.
- **The board's version column wraps one character per line** for a longer `versionName`. Noticed
  because a `-sandbox` suffix mangled it. The suffix is gone; the weakness is not.

## Scheduled send (`plans/scheduled-send.md`, deleted, shipped - 2026-08-02)

Both phases shipped. The residue is process rather than code, and all of it outlives the feature.

- **An `Edit` call silently wrote a literal NUL byte into a Kotlin source file.** Nothing about the
  call looked wrong and the file read back normally. The only symptom was `grep` and `file` quietly
  starting to treat it as binary, `grep` returning nothing at all rather than an error. If a
  text tool inexplicably goes silent on a file you just edited, suspect a control character before
  anything more exotic.
- **A delegated `var x by remember { mutableStateOf(...) }` is NEVER smart-castable**, because a
  custom-getter property never is, regardless of a surrounding null check. That is what makes
  `MainActivity.kt`'s pervasive `openTeam!!` load-bearing rather than defensive noise: a bare
  `state.scheduledSends[openTeam]` inside the same null-checked branch as a dozen `!!` uses looks
  like it should compile and does not. Match the file's convention instead of reasoning about the
  language rule in the abstract.
- **`minimumInteractiveComponentSize()` and a separately-applied `combinedClickable` have unclear
  composed hit-testing.** Sidestepped rather than proven: put both modifiers on the SAME outer node
  and keep the inner node purely visual, mirroring `IconButtonKt`'s own structure. Worth reusing as
  a recipe the next time a custom clickable needs a non-standard touch target.
- **`Workflow()` scripts are plain JS, and apostrophes are the recurring way they fail to parse.**
  Backticks inside template literals and a shell-quoting artifact pasted into a string literal have
  each killed a script before it could launch. Rewriting to avoid the character has been the
  reliable fix both times, more so than escaping it.
- Its fourth painpoint, not knowing the `~/android-dev` toolchain existed, is already recorded in
  CLAUDE.md and is not repeated here.

## Task board (`plans/task-board.md`, deleted, shipped 7.21.0 - 2026-08-07)

All 3 phases shipped. The architecture is CLAUDE.md's "Task board" section; the rules that must hold
live there or in residue tests. What follows is what stayed open.

### Two known gaps, deliberate

- [medium] **The `/task-board` route's replay record is in memory.** An MCP operation id outlives the
  gateway process, so a restart between committing a write and flushing its reply loses the record
  and the caller's retry re-applies an absolute set. `create` is unaffected - its replay is
  structural, derived from `(from, operationId)` and stored in the board file. Closing it wants this
  route's own durable file: `DurableOpStore` is typed to `ConsoleOpResult` and keyed by conversation,
  so it cannot be borrowed. The comment on `boardOperationReplies` says so rather than claiming
  safety.
- [medium] **`routerPost` cannot report a 500 usefully.** `await res.json()` sits outside the try
  that guards the fetch, so a non-JSON error body rejects OUTSIDE the retry loop: no retry, and the
  status never reaches the caller. A gateway throw becomes exactly that, since `Bun.serve` is
  declared with no `error` handler. Every MCP tool inherits it, so a disk failure reads to an agent
  like a bad request - the opposite of what `BoardStore.commit` preserves when it rethrows. Now
  marked KNOWN GAP at the line itself.

## Task board holes the awareness push surfaced (2026-08-07)

Found by the red team on `plans/no-ack-push.md` phase 2. All four predate that work and none were
fixed there; the notice framework only made them visible.

- [medium] **`claim` and `release` disagree with `mayWrite` about trashed members.** `claim`'s trash
  guard is on the TARGET only; its member loop reads `sessionId` raw, so claiming a parent silently
  takes the owner's trashed children. `release` is the same hole outward. The owner untrashes their
  own set-aside item and it lands under a session that never held it. Both loops need the same trash
  test `mayWrite` and `visibleTo` already apply.
- CLOSED. **`clearDone` and `sessionEnded` could trash a parent out from under a surviving child.**
  `clearDone`'s guard counted only unfinished children, so a done child held by ANOTHER session
  neither protected its parent nor went with it; `sessionEnded` had no guard at all. Both now use
  `prunableSubtrees`: an entry is set aside only when its whole subtree goes with it, so a parent with
  any survivor is kept. `promoteOrphans` stays as the backstop for the one delete that cannot refuse.
- [low] **An assign to a session that is not confirmed-live announces nothing**, and the console offers
  exactly those sessions as targets with no visual distinction. The entry lands, the board plane
  confirms it, and the notice is dropped at the send edge. Either the board should wake the target, or
  the picker should say which targets are live.
- [low] **A dropped take-away is unrecoverable**, and `claude --resume` restores a transcript that still
  believes it holds the entry. The agent then hits `entry_missing` or `held`, which it is taught are
  permanent. Question 4 chose DROP deliberately, but its rationale ("the agent re-reads on receipt")
  only covers `changed`; a take-away leaves no durable fact to re-read.

## One-line display strings on the console (2026-08-07, closed)

`oneLine` collapses ASCII whitespace for a row that cannot show a second line, and every such row now
calls it: the session card's three rungs, the notification shade, and `BoardStrip`'s collapsed live
line and expanded rows. `BoardScreen`'s entry rows and `BoardEditScreen`'s child rows deliberately do
NOT, because they wrap and the whole title is already visible.

**Invisible-character sanitizing was attempted here and is NOT wanted.** A hand-listed strip drew four
audit findings in one round, in both directions at once, and the owner ruled the whole class out: an
agent authoring a title of only zero-width characters is not a real case, and neither is one spaced
with U+2028 or U+00A0. Do not reintroduce a category strip, a bidi rule, or a Unicode whitespace set on
the strength of an audit finding.

### Structural, not board-specific

- [high] **Nothing in the type system separates a qualified address from a bare local field.** Both
  are `String`, and the phase-2 blocker was exactly that confusion: the console sent one where the
  Gateway indexes by the other, so every assign was refused. The follow-on collision (a bare key is
  unique only per Gateway) was the same class again. `shared/session-id.ts` already owns `Address`
  and `SpawnPoint`; a value type for the local field, or a Kotlin value class, would have made both
  rounds compile errors. The single highest-value type change in this codebase.
- [medium] **Idempotency is re-invented per surface.** Console ops have `opCache` plus
  `DurableOpStore`; Codex mints a private operation id; the board route now has a third mechanism,
  keyed differently from both. All three exist because the same fact is true of all three, and each
  was built separately after somebody noticed. A gateway-wide "settled reply for an operation id"
  primitive would have made this phase's record two lines instead of a judgement call.
- [medium] **`MainActivity.kt` is past 3000 lines and its composables are indistinguishable while
  editing.** I added a state variable to `ProvisionScreen` while intending `App`; only the compiler
  caught it. The overlay flags compound it: ~15 booleans across four lists (the `BackHandler`
  predicate, the back `when`, the render `when`, the notification-tap clear list) that must agree by
  hand, with one recorded bug already from missing the third. An ordered overlay declaration list is
  the shape; it wants its own PR on a surface with no tests.
- [medium] **The Kotlin gate is local-only and bites every lap.** `ci.yml` never compiles Kotlin, so
  a green TS suite reads as done. It cost time twice more this run despite being documented. A CI job
  that merely COMPILES Kotlin on a PR closes the whole class; it does not need the unit tests.
- [low] **`src/gateway/routes.ts` is past 2000 lines** and `taskBoard` joined it as another fat
  function. The real problem is `createRoutes`' closure-over-forty-deps shape, so extracting one
  route without deciding the family's contract makes the file less uniform, not smaller.
- [low] **`ChatRepository.kt` is past 5000 lines** and the board added a dozen more methods. Nothing
  is wrong with any one; "where does board behaviour live" just has no answer beyond grep.
- [low] **Test fakes drift from `DurableStore`** because it is a class, not an interface:
  `console-handler.test.ts:fakeDurable` lacked `saveChecked` until a board test needed it. One
  shared, complete fake ends the per-file copies. (`routes.test.ts:makeCtx` silently dropping unknown
  overrides is FIXED - it spreads them last now, after costing a round of mystery 503s.)
- [low] **`codegen-kotlin.ts` reports a conversion-root `$ref` problem as a `.meta` id collision**,
  which reads as a naming accident rather than the real rule (a recursive schema may appear in
  exactly one place in the conversion graph).
- [low] **`MainActivity.kt:renderProject` has a pre-existing unguarded double-render path** for a
  project literally named "host" - the duplicate-key crash class. Still open.
- [low] **`gradlew` needs the repo root resolved for it.** Half my Kotlin gate runs failed with
  `cd: android: No such file or directory` because a previous command had left the shell there. A
  `scripts/kotlin-gate.sh` would remove it.

### The lesson worth keeping

**A comment asserting behaviour nobody implemented is worse than no comment.** I wrote, in four
places including CLAUDE.md, that the console could detect a Gateway downgrading its disposition -
while `ConsoleClient.forget` discarded the reply body. A red team spent real effort disproving prose
I had written confidently. Where an invariant matters, a residue test costs about what the paragraph
does and cannot go stale; `board-refusal-residue.test.ts` is the pattern.
