# Scheduled Send

Long-press the send button to schedule a message for a picked wall-clock time; the app sends it on
its own even if backgrounded or killed in the meantime. Questionaire complete; see `## Plan` below.

## The ask, as given

- Long-press the send button opens a context menu. For now: `Schedule Send`, `Send`.
- `Schedule Send` opens a calendar/time dialog.
- At the picked wall-clock time, the app sends the message on its own - even if backgrounded or
  killed by Android's power management in the meantime.

## Decisions so far

- Picking `Schedule Send` clears the composer immediately - the text is banked into the schedule,
  not left sitting in the box.
- While something is scheduled: a docked indicator near the composer, "Sending at `xxx` (in `yyy`)"
  (absolute time + relative countdown), tappable to edit the text, change the time, or cancel. This
  is also the answer to "how does it render before it fires" (a dock, not inline in the thread) and
  to "what's the cancel/edit entry point" (the dock itself).
- The session-list tile also gets a clock icon when that session has something scheduled, so it's
  visible from the board without opening the thread.
- Only 1 scheduled send per session at a time (not a queue) - a new `Schedule Send` on a session
  that already has one presumably replaces/edits it rather than stacking a second.
- Does NOT sync across the owner's other devices/consoles - purely local to the device that
  scheduled it. This keeps the whole feature client-local: no gateway involvement, no new plane, no
  wire shape - just the Android app, `AlarmManager`, and local storage.
- Forgetting a conversation cancels any scheduled send in it too - nothing left to send it into.
- Not specially persisted against re-provisioning - lives in the same disposable storage class as
  drafts. If an alarm fires after a re-provisioning has happened, the send naturally fails against
  the new identity and exhausts its retries on its own; no dedicated persistent key needed.

## Questionaire

**1. Does a scheduled send survive re-provisioning?**
Not specially handled - lives in the same disposable storage as everything else (see Decisions
above). Re-provisioning is rare enough ("nobody reprovisions unless a FATAL issue happened") that a
dedicated persistent key isn't worth it; a fired-late attempt just fails against the new identity
and retries out on its own.

**2. The double-send gap - fix now, or document and defer?**
Research confirmed the plan's own flagged-but-unanswered worry is real: the gateway's `send`/
`respond` idempotency is in-memory only (wiped on restart) with no independent protection beneath
it, so a replayed op genuinely re-delivers. **Fix it first, as its own phase** - real, persistent,
restart-proof idempotency for `send`/`respond`, before building scheduled-send itself. This isn't
caused by scheduled-send (the live send button has the same exposure, just less likely to hit it) -
but scheduled-send fires while the phone may be asleep, which is exactly the kind of moment a
process could die between the gateway confirming a send and the phone recording that. Closes the
gap for both paths at once rather than leaving scheduled-send's reuse of `deliver()`+`opId` as a
caveated risk.

**3. Does firing a scheduled send count as activity for the idle-pushback ladder?**
Yes - resets the silence clock back toward the fast tier, same as opening the app. Sending is a
strong signal of imminent live interaction, and the ladder already resets on any real activity.

**4. What happens if you try to schedule a second one on the same session?**
The `Schedule Send` context-menu option is greyed out once one's already active for that session -
the docked indicator is the sole edit/reschedule/cancel surface, no second path. ("the docked
schedule is clear enough")

**5. Dock visual design.**
Mocked up via the in-app Switchboard Designer dock (not the web DesignSync tool): a clock icon,
"Sending at `<time>`" as the primary line, a live countdown as the secondary line, small edit/cancel
icon buttons. Approved. Code research confirmed it can be a plain sibling in the SAME Compose
`Column` `ThreadScreen` already renders the Designer dock's `threadDockSlots` loop in - both stack
naturally above the composer with zero collision-avoidance logic needed, since a dock with nothing
to show contributes no space at all.

**6. Does the countdown tick live, or show a coarser bucket?**
Live-ish - recomputed roughly every minute while the thread is open, reusing the periodic-ticker
pattern already built for the cross-domain-presence friend-freshness chip. Something counting down
to a real pending action should look alive, unlike a passive staleness hint.

## Audit round 1

27 candidate concerns fanned out against the real codebase, 17 confirmed under adversarial
verification, collapsing to 9 distinct root causes - all folded into the Plan below:

- **[high] Phase 1's original "persist the reply before returning" shape was wrong** for the send
  op's backgrounded path (`{ok, status:"running"}` at 25s while the real work continues): durably
  replaying that reply post-crash converts today's clean re-execution recovery into silent message
  loss, in scheduled-send's own fire-at-night mainline. Replaced with the two-state
  (in-flight/complete) record with settle-time completion writes.
- **[high] The attachment orphan sweep would silently delete banked attachments** waiting >10min
  across any service restart (it only considers thread rows referenced). Added the sweep extension
  + explicit bucket cleanup on cancel/edit/forget.
- **[med] The plan cited two contradictory persistence models** (the 3s tick its named precedents
  actually use vs write-before-return) - pinned to synchronous save on state transitions, and the
  verify test gained a SIGKILL variant (a graceful-restart-only test passes under both models).
- **[med] TTL bounds were modeled on the wrong precedents** (minutes) vs the real retry horizon
  (`reconcilePending`, days), and the natural implementation spot inherits `teardownDevice`'s
  1h-idle eviction - bounds re-sized, lifecycle decoupled.
- **[med] The wakelock formula double-counted** (`SEND_BOUND_MS + PINNED_READ_TIMEOUT_MS` overlap
  by design) and omitted the cold-start terms (revival + `connect()`'s sequential round trips) -
  replaced with a derived constant + derivation comment.
- **[med] Cross-Domain targets break on a cold fire** (`deliver()` resolves the seal target from
  `state.teams`, empty until `connect()`) - record gained `targetDomainId` banked at schedule
  time, and fire-processing sequenced after `connect()`.
- **[med] "Exhausts its retries on its own" assumed retry machinery that doesn't exist** (a failed
  attempt settles to `"error"`, which `reconcilePending` never touches) - added the bounded
  one-retry + failure-notification policy.
- **[med] The record-to-row conversion needed its own idempotency** (process death between row
  append and record clear leaves both durable; a re-fire would duplicate the row locally even
  though the wire is safe) - added the row-exists-for-opId check.
- **[low] The "reuse IdlePushbackManager's DST math" claim was looser than the code supports**
  (poll-tier marks only; its clamp guards a past-tracking value and must NOT touch `fireAtMillis`)
  - rewritten as "same discipline, fresh math, overdue-fires-immediately".

Also recorded in Phase 1: an honest non-goal (not strict exactly-once - a ms-scale at-least-once
window survives) and a pre-existing known limitation (a `"running"` reply followed by gateway death
before the background push is silent loss today and stays out of scope).

## Audit round 2 (re-auditing round 1's corrections)

12 candidates, 9 confirmed, collapsing to 6 distinct root causes - every one a precision gap in a
round-1 correction rather than a new design flaw. All folded in:

- **[high] The two-state record needed an explicit layering rule against the surviving opCache:**
  as literally written ("a known in-flight opId RE-EXECUTES"), a same-process retry during a
  backgrounded send's up-to-10-minute window would re-execute concurrently with the still-running
  attempt - reintroducing the exact double-delivery Phase 1 exists to close. The opCache stays as
  the per-process single-flight layer (it holds the live promise; the durable record structurally
  can't); the durable store is consulted only on opCache miss. The verify case was scoped to match.
- **[high] The warm path had no fire trigger:** the service is a persistent START_STICKY foreground
  service, so at fire time it's usually ALREADY RUNNING and a startup-chain-only hook never runs in
  the mainline. Adopted `PollAlarmReceiver`'s own dual shape (start + repo-level kick), both paths
  funneling into one serialized fire-processor; also fixed the alarm-shape wording (a
  BroadcastReceiver can't run a multi-minute send in `onReceive`) and made the cold-chain fire step
  explicitly unconditional (`connect()` swallows failures; gating on it would starve the
  failure-retry policy).
- **[high/med] The failure arm was unspecified, three ways:** an op settling as an ERROR never
  writes `complete` (delete or leave in-flight - mirroring the opCache's load-bearing
  drop-on-failure rule; a durable complete-with-error would replay the stale failure for days
  against same-opId retries, including Phase 2's own retry alarm); respond's federated settle
  writes `complete` only on relay SUCCESS (`relayWithRetry` is `void` and RESOLVES on exhaustion -
  it needs a real outcome surface, and hooking "on resolve" would stamp `{delivered:true}` over a
  fully failed relay); a failure-outcome verify case was added.
- **[med] The bounded retry was keyed on a non-durable id:** `Message.id` is reassigned densely on
  every load, so an id banked in a PendingIntent goes stale across a process death and the retry
  (and its failure notification) could silently no-op. Re-keyed to the persisted opId, resolved to
  the current row at retry-fire time.
- **[med] The banked `targetDomainId` had no path into the wire:** `deliver()` derives the seal
  target internally and takes no such parameter - following "call the SAME deliver()" literally
  would silently discard the banked field and resurrect the cold-fire cross-Domain break round 1
  fixed. `deliver()` gains an optional `targetDomain` override, named in the plan.
- **[med] The failure notification was under-sized:** it's a genuinely new third notification
  category - a team-range id would be wiped by the level-based `reconcileTeamNotifications` (a
  fromMe error row never counts as unread), and `closedTeams` muting must deliberately NOT apply.
  Sized explicitly: own id outside the team range, explicit channel, closedTeams-exempt,
  `canNotify()`-gated, tap-through to the error row.

## Audit round 3 (convergence)

A tightly-scoped lap verifying ONLY round 2's edits. 2 candidates raised, both refuted under
adversarial verification (the code each edit would produce is correct) - but each landed one real
prose imprecision, both tightened rather than left overstated:

- The opCache-layering justification overstated its own coverage ("coalesces a concurrent
  same-process retry") - true only while the entry is cached; a `capFifo` eviction or teardown
  DURING a backgrounded send's up-to-10-minute window drops the entry, so a same-opId retry then
  re-executes and duplicates. Verified as a PRE-EXISTING corner (today's opCache-only code does the
  identical thing) inside the phase's already-accepted at-least-once tail, NOT a regression the edit
  introduces - the operative instructions produce correct code. Rewritten to say so honestly and to
  scope the residual window explicitly.
- The retry's `targetDomain` override needed one clarifying clause: both `opId` and `targetDomainId`
  are banked into the retry alarm's PendingIntent at ARM time (record still in scope), so they
  survive the durable record being cleared before the retry fires - the two edits compose, they
  don't contradict.

No design change; the plan is considered converged.

## What already exists that this has to live alongside

- **The only scheduling primitive in the app today is `AlarmManager`**, via `PollAlarmReceiver` +
  `SwitchboardService` (as `DeepIdleScheduler`) + a companion-object timeout `WakeLock` +
  `BootReceiver`. It's a complete, tested, exact-alarm + dead-process-revival pipeline - but built
  for ONE outstanding alarm (a single fixed request code) driving the idle-pushback poll ladder,
  not for arbitrary user-picked instants. No `WorkManager`/`JobScheduler` anywhere in the app.
- `USE_EXACT_ALARM` is already declared and auto-granted for this sideloaded build - no new
  permission UI obviously needed, though it's Play-policy-gated to alarm/calendar-category apps if
  distribution ever changes (a scheduled-send feature arguably strengthens that justification
  rather than weakens it, being more calendar-shaped than a poll cadence).
- `opId` is minted client-side (UUID) at send time and reused on every retry so the gateway's
  idempotency cache replays instead of double-delivering. `reconcilePending()` already re-delivers
  any message stuck `status: "pending"` once per service start, using its original `opId` - but this
  only recovers an ALREADY-ATTEMPTED send interrupted mid-flight. There's no existing concept of
  "durably queue this, not yet attempted, deliberately deferred to later."
- The gateway's own opId dedup cache (`consoleHandler.ts`'s `opCache`) is in-memory only, wiped on a
  gateway restart. Unconfirmed whether `routes.send()` itself has independent idempotency beneath
  that layer - worth checking before leaning too hard on "reused opId always makes a retry safe."
- The draft store (`drafts: MutableMap<String,String>` + `AppStateStore.saveDrafts`/`loadDrafts`) is
  the closest storage-pattern precedent (SharedPreferences JSON blob, in-memory map, persist/load
  pair) but is single-per-team with no timestamp/attachments - a pattern to mirror, not a map to
  literally repurpose.
- No calendar/date/time picker UI exists anywhere in the app yet - new UI either way.

## Plan

Two phases. Each goes through the full `audited-implementation` cycle (implementation, plan-
alignment audit, red-team audit, framework-first audit, documentation, crust-collection),
same as `cross-domain-presence.md` before it.

## Phase 1: Persistent, restart-proof idempotency for `send`/`respond` ✅

Closes the confirmed double-delivery gap for gateway restarts, and shrinks the hard-crash window
to milliseconds. Deliberately NOT claimed as strict exactly-once: an irreducible window remains
where the side effect fires and the process dies before the completion marker hits disk - a retry
then re-executes, exactly as today. That window is milliseconds instead of today's "any restart,
ever".

- **A two-state durable record, not a cached-reply store.** The naive shape ("persist the reply
  before returning, replay it") is WRONG for this codebase and would convert today's clean crash
  recovery into silent message loss: `consoleHandler.ts`'s send op races `routes.send` against
  `SEND_BOUND_MS` (25s) and on timeout returns `{ok, status:"running"}` while the real work (a
  wake up to 10min, then the `channel_push`) continues in a background promise. Durably replaying
  that "running" reply to a post-crash retry would tell the client "sent" while nothing ever
  delivers - today the same retry re-executes and recovers. So the store is keyed
  `(conversationId, opId)` with two states:
  - `in-flight` - written synchronously BEFORE dispatching the op's work.
  - `complete` + the settled result - written synchronously only when the side effect SUCCEEDS:
    for a fast send, at successful completion; for a backgrounded send, inside the same background
    `.then` where the durably-deduped `sent:` echo already lands; for respond's federated branch
    (which returns `{delivered, federated}` after merely STARTING its fire-and-forget relay), only
    on relay SUCCESS - `relayWithRetry` is currently `void` and its internal chain RESOLVES on
    exhaustion too, so it needs a real outcome surface (return the outcome, or a success callback)
    rather than hooking "on resolve"; writing `complete` on exhaustion would stamp
    `{delivered:true}` over a fully failed relay and a later replay would silently drop the reply.
  - FAILURE never writes `complete`: an op settling as an error DELETES the record (or leaves it
    `in-flight`), mirroring the in-memory opCache's own load-bearing drop-on-failure rule ("a
    failed op performed no side effect, so it must be retriable") - the client reuses the ORIGINAL
    opId on every retry (`retrySend`, `reconcilePending`, and Phase 2's retry alarm), so a durable
    complete-with-error would permanently replay the stale failure for days instead of
    re-attempting.
  - Replay rule + layering: the in-memory opCache STAYS, as the per-process single-flight/replay
    layer - while a send's opCache entry is live it coalesces a concurrent same-process retry onto
    the running attempt (a role the durable record, storing no promise, structurally cannot take
    over). The durable store is consulted only on an opCache MISS (post-restart, post-teardown, or
    a `capFifo` eviction): a known `complete` opId replays the stored result; a known `in-flight`
    opId RE-EXECUTES (the crash-mid-work recovery, preserved); unknown executes fresh. This layering
    is what keeps the COMMON same-process retry - during a backgrounded send's up-to-10-minute
    window, entry still cached - from re-executing concurrently with the running first attempt.
    It does NOT fully close the in-process window: if that entry is EVICTED (256-op cap) or torn
    down while the background push still runs, a same-opId retry misses the cache, hits `in-flight`,
    and re-executes - a duplicate. That corner already exists in today's opCache-only code
    (identical eviction + retry -> re-run, since `routes.send` has no dedup beneath the cache) and
    falls inside this phase's accepted at-least-once tail (below); the durable store never worsens
    it and strictly improves the post-window case (a retry after the push lands hits `complete` and
    replays instead of re-running, which today cannot). Fully closing it would need pinning the
    opCache entry across the whole background window - out of scope here.
- **Write model: synchronous save on state transitions,** not the 3s `persistDelivery` tick every
  cited precedent (`DeviceMailbox`/`ReplayGuard`/`SessionStore`) actually rides - the tick loses
  up to 3s on a hard crash, which sits exactly on the window this phase exists to close.
  `DurableStore.save` is already a synchronous write+rename, so this is mechanically cheap; the
  store is small (see bounds) so a per-transition full write is fine.
- **Bounds sized to the REAL retry horizon - days, not minutes.** The client's replay window is
  `reconcilePending()` (re-sends any still-`pending` row with its original opId once per service
  start - hours or days later), so `ReplayGuard`'s 300s TTL and `opCache`'s 256-per-conversation
  cap are the WRONG models. TTL on the order of `SESSION_RESUME_TTL_MS` (days), plus a per-
  conversation entry cap. Lifecycle explicitly DECOUPLED from `teardownDevice`/mailbox idle
  eviction - today's opCache dies after ~1h of console silence via the mailbox LRU sweep, which is
  precisely the lifetime bug this store must not inherit.
- **Verify:** the restart test must include a SIGKILL variant (a graceful-shutdown-only test passes
  even under the broken 3s-tick model and proves nothing), plus: a replayed `complete` opId
  returns the stored result without re-delivering; a replayed `in-flight` opId re-executes ONLY on
  the opCache-miss/post-restart path (a same-process replay of a genuinely running op must
  coalesce via the opCache, not re-execute); a FAILED op's retry re-executes rather than replaying
  the failure; a backgrounded send's record only flips `complete` when the background push lands.
- **Known limitation, pre-existing, NOT fixed here:** if the phone receives the `"running"` reply
  (marks its row sent) and the gateway then dies before the background push, the message is lost
  silently today and still is after this phase - the client believes it sent, so nothing retries.
  The federated respond has the same mirror window (`{delivered:true}` received, gateway dies
  before the relay lands). Fixing either needs client-side tracking of not-yet-echoed replies; out
  of scope, recorded so it isn't mistaken for a regression later.
- **Known limitation, accepted tradeoff, NOT fixed here: `persist()` re-serializes the WHOLE store,
  not just the touched conversation.** `DurableOpStore.persist()` writes a fresh JSON snapshot of
  every tracked conversation on every single state transition anywhere, so one busy conversation's
  send/respond traffic pays a write cost that scales with the total store size (up to 500
  conversations x 256 ops each), not just its own. This is the correct tradeoff for the synchronous-
  write model's own goal (closing the crash window to milliseconds - a per-conversation delta write
  would need a separate file per conversation, a bigger structural change), but it does mean a
  busy/near-cap gateway pays a larger blocking write on every op than the plan's original "the store
  is small, so a full write is fine" framing assumed. Mitigated, not eliminated: `sweep()` (wired
  into the existing 3s `persistDelivery` tick alongside `sessionStore.sweep`) actively removes
  TTL-expired records instead of leaving them as dead weight that gets re-serialized forever, so
  ordinary (non-abusive) usage trends toward a much smaller steady-state size than the hard cap. A
  proper fix (per-conversation-sharded storage, one file per conversation) would remove the
  cross-conversation cost entirely if this becomes a real production bottleneck; out of scope for
  this phase, recorded so it isn't mistaken for an oversight.
- **Deferred, out of scope: two cross-store extraction opportunities a framework-first pass
  surfaced, but did not implement here since both would touch already-shipped, unrelated code.**
  (1) `DurableOpStore`'s generation-token guard (mint a token on begin, gate the eventual "undo"
  on that same token still being current) is now the THIRD independent hand-rolled instance of
  this exact mechanism in the codebase - `crossDomainPresence.ts`'s `CoalescedPusher` and
  `CrossDomainPresenceReconciler` both already do the identical thing with their own `token`/
  `nextToken` bookkeeping, and both already say so in their own comments ("mirrors CoalescedPusher's
  own token"). A shared `begin(key)->token` / `isCurrent(key,token)` / `end(key,token)->bool`
  primitive would remove three parallel re-derivations of the same reasoning - worth building, but
  as its own follow-up, since it means touching cross-Domain presence's already-shipped code for a
  DRY win unrelated to this feature. (2) `DurableOpStore.restore()`'s validate-schema/drop-expired/
  re-apply-live-caps convention is stricter than three siblings that predate it -
  `DeviceMailboxStore.restore()`/`fromSnapshot()` do no shape validation at all and never re-check
  `maxDevices`, and `readAnchors.ts`'s `restore()` has the identical gap against
  `MAX_TEAMS_PER_OWNER`; `SessionStore`/`ReplayGuard` validate shape but never count or log a
  rejection. Backporting this convention would improve operability (a corrupted/foreign snapshot
  today silently drops state in three other stores with zero log signal, and since
  `gateway/index.ts` restores `store`/`mailboxStore`/`sessionStore` inside one shared try/catch, an
  unvalidated throw in any one of them today would silently discard ALL THREE stores' restored
  state) - but again is a change to other, unrelated, already-shipped files. Both are real, worth
  doing, and explicitly NOT done in this phase.

## Painpoints (Phase 1)

- **The generation-token pattern already existed twice in this codebase and I didn't know it until
  the very last audit pass.** `crossDomainPresence.ts`'s `CoalescedPusher` and
  `CrossDomainPresenceReconciler` already solve "a stale attempt's continuation must recognize a
  newer one has taken over" with the identical mint-a-token/check-before-acting shape
  `DurableOpStore` needed. I re-derived the whole CAS/generation reasoning from first principles
  across two separate audit laps (the eviction-race bug, then its own incomplete fix) instead of
  going in already knowing the shape and copying the reasoning wholesale. A quick "does anything
  else in this codebase already do X" sweep before designing a new concurrency primitive would have
  saved real iteration.
- **A Map-reinsertion "touch to move to the end for recency" fix applied at one nesting level but
  missed at another.** The conversation-cap fix (`byConversation`) and the op-cap fix (`perConv`)
  are the SAME idiom at two levels of one two-level store, and I only fixed the outer one on the
  first pass - the inner one (the level `capFifo` for ops actually caps) stayed a plain,
  non-recency-respecting insert for a full audit lap before it was caught. Whenever a fix needs
  "the same treatment at every nesting level a structure has," that's worth explicitly checking off
  level-by-level rather than fixing the first one that surfaces and assuming symmetry.
- **Concurrency-guard code is disproportionately bug-prone relative to its line count.** Across six
  audit laps, nearly every genuinely NEW bug found (not a re-flag) lived in the generation/
  eviction/opCache-interaction logic, including bugs introduced by the PREVIOUS lap's own fix for a
  different bug in the same area (the lap-2 `evictOpCache` fix created the lap-3 regression; the
  lap-3 generation fix's own LRU touch was incomplete, caught by lap 4). A shallow fix that closes
  one reported symptom in this class of code deserves an explicit "does this fix's OWN mechanism
  have the same shape of race it was built to close" self-check before moving on, not just a test
  for the reported scenario.
- **`capFifo` has no eviction-visibility hook, so every call site that wants one hand-rolls a
  before/after size-diff.** `durableOpStore.ts` needed this and ended up writing its own
  `touchCapped` wrapper; `DeviceMailboxStore`'s and `ReplayGuard`'s own `capFifo` calls stay
  silently unlogged today. An optional `onEvict` callback on `capFifo` itself (`shared/cap-fifo.ts`)
  would let every caller opt into this for free instead of reinventing the size-diff dance per
  file - a narrower, cheaper win than either of the two bigger deferred cross-store extractions
  above, and one that could genuinely be retrofitted to the other two call sites too.
- Not a code pain point, but a process one worth recording: this session's `Workflow()`-spawned
  audit subagents run against the SAME on-disk checkout with no per-agent worktree isolation, and
  more than one adversarial-verify agent independently did its own "temporarily remove the guard,
  run the tests, observe, restore" experiment on the exact same file at the same time. It produced
  a confusing false alarm mid-session (looked like an external actor editing the repo) before the
  real explanation (sibling verify agents, not an intruder) became clear. Nothing in the shipped
  code is affected, but a workflow authoring convention for "this verify step needs to mutate a
  shared file to test something" should probably call for worktree isolation on that agent, or at
  least a shared lock, rather than relying on nobody colliding.

## Phase 2: Scheduled Send (Android, client-local)

- **Menu & compose:** long-press send opens `Schedule Send` / `Send`; `Schedule Send` greyed out if
  one's already active for that session. Confirming a time clears the composer immediately and
  banks `{team, targetDomainId, text, fileRefs, fireAtMillis, opId, createdAt}` into a new store,
  pattern-mirroring `drafts` (`team -> record` map, SharedPreferences JSON, same disposable storage
  class - no special re-provisioning survival). `opId` is minted at schedule time, not fire time.
  `targetDomainId` is resolved at schedule time from the SAME live `teams` entry the composer has
  on screen - `deliver()` resolves a cross-Domain seal target from `state.teams`, which is EMPTY on
  a dead-process cold fire until `connect()` completes, so the record must carry it rather than
  re-derive it. The picker rejects a past time (minimum ~1 minute out).
- **Attachments:** any `content://` file reference is eagerly copied into the app's own attachments
  storage at SCHEDULE time (mirroring `Attachments.storeOutgoing`), keyed under the record's opId
  bucket - a transient grant may not outlive the wait. CRITICAL companion change: the orphan
  sweep (`sweepOrphanAttachments` -> `Attachments.sweepOrphanBuckets`) builds its referenced-srcs
  set SOLELY from thread rows and deletes unreferenced buckets older than 10 minutes on every
  service start - a banked record is deliberately not a thread row until fire, so without extending
  the sweep's referenced set with the scheduled store's fileRefs, any scheduled attachment waiting
  >10min across a service restart is silently deleted (the message would fire text-only). Cancel/
  edit-removing-files/Forget must conversely delete the banked bucket explicitly - the existing
  file cleanup also only walks thread rows.
- **Alarm shape:** one single "next-due" `AlarmManager` alarm, always re-armed to the EARLIEST
  pending record across all sessions. The receiver only TRIGGERS processing (a BroadcastReceiver
  cannot run a multi-minute network send in `onReceive`); the actual due-or-overdue sweep and
  re-arm live in the repository's fire-processor (below). Own receiver/request code, fully
  independent of the poll alarm - conceptually unrelated wakeups that must never clobber each
  other. Uses `setExactAndAllowWhileIdle` (existing `USE_EXACT_ALARM` grant covers this; the
  existing battery-exemption settings row is the same story the poll alarm already relies on).
- **Firing sequence - BOTH paths, one serialized fire-processor:** the service is a persistent
  START_STICKY foreground service, so at fire time it is usually ALREADY RUNNING - a cold-start-
  only hook never fires in the mainline. Mirror `PollAlarmReceiver`'s own dual shape
  (`SwitchboardService.start()` + `kickPoll()`): the receiver starts the service AND kicks a
  repo-level fire entry point. Cold path: the startup chain runs the fire-processor as an
  UNCONDITIONAL step after `connect()` (`connect()` swallows failures internally and must not gate
  the fire - only an unconditional step reaches `deliver()`'s failure path so the bounded-retry
  policy triggers when firing offline). Warm path: the receiver's kick funnels into the SAME
  mutex-guarded fire-processor, so a warm kick can never DOUBLE-CONVERT the same due record
  concurrently with a cold start. That mutex does NOT, by itself, make the warm kick wait for
  `connect()` to have run first (round-1 audit's own wording overclaimed this - "can never race a
  cold start's not-yet-connected state" - align-audit-round-1 below tightened it): a dead-process
  revival's alarm receiver calls `SwitchboardService.start()` (async - `onCreate()` runs later on
  the main thread) then immediately kicks the repo, which can reach the mutex before `onCreate()`'s
  own synchronous wiring step has run. `awaitSchedulerWired()` closes the ONE concretely harmful
  consequence of that gap (a retry/notification silently no-op-ing on a null scheduler callback);
  the milder "state.teams still empty" ordering gap is left as an accepted, low-stakes corner
  (`deliver()`'s targetDomainOverride and `ConsoleClient`'s own persisted-gatewayId fallback already
  degrade it safely today - see the Phase 2 implementation notes). Wakelock: a new derived constant
  with its own derivation comment (the `IdlePushbackManager.kt` discipline), NOT
  `SEND_BOUND_MS + PINNED_READ_TIMEOUT_MS` - those two overlap by design (the client read ceiling is
  pinned to outlast the gateway bound), and the real cold path adds terms that formula misses:
  `REVIVAL_OVERHEAD_MS` (15s) + `connect()`'s FOUR sequential round trips (each up to 15s connect +
  20s read, 140s total) + the send's own 15s + 35s = 205s summed, rounded up to 240s for real
  margin. An attachment UPLOAD is uncapped by design (600s per-write inactivity), so a huge upload
  on a slow link can outlive the lock - acceptable, because an interrupted attempt is recoverable
  (below), and holding multi-minute wakelocks is worse.
- **Fire-time conversion, idempotent and atomic:** the record-to-row conversion must not be able
  to double-run. Before converting, check the thread for an existing row bearing the banked opId -
  opId IS persisted per row, so this check survives restarts (a process death between appending
  the row and clearing the record leaves both durable; the re-arm path must treat "row already
  exists" as already-fired and just clear the record). Then convert to an ordinary optimistic
  `"pending"` `Message` and call `deliver()` with the pre-minted opId AND the banked
  `targetDomainId` - `deliver()` today derives the cross-Domain seal target internally from
  `state.teams` and takes no such parameter, so it gains an OPTIONAL `targetDomain` override the
  fire/retry paths supply (without this named seam, "call the same deliver()" would silently
  discard the banked field and resurrect the cold-fire cross-Domain break). Nudges the
  idle-pushback silence clock back toward the fast tier (same as opening the app).
- **Failure policy (the plan's earlier "retries out on its own" assumed machinery that doesn't
  exist):** `deliver()` settles a failed attempt to `"error"` (tap-to-retry), which
  `reconcilePending()` never touches - only INTERRUPTED (still-`pending`) rows get the next-start
  mop-up. So the fire path adds one bounded recovery: on a failed attempt, re-arm ONE retry alarm
  (~5 minutes out). The retry resolves the row BY OPID at retry-fire time - never by `Message.id`,
  which is deliberately not persisted (ids are reassigned densely on every load, so an id banked
  in a PendingIntent goes stale across a process death and would silently no-op or hit the wrong
  row) - then retries it (the existing `retrySend()` semantics, same opId, plus the
  `targetDomain` override). Both `opId` and `targetDomainId` are banked into the retry alarm's
  PendingIntent at ARM time, while the just-failed record is still in local scope, so they survive
  the durable record being cleared by the idempotency rule before the retry fires. If that also fails, leave the error row and post a local notification
  so unattended failure is never silent. That notification is its own category, sized explicitly:
  its own notification id OUTSIDE the per-team 1000+ range (the level-based
  `reconcileTeamNotifications` cancels any team-id notification with zero unread, and a fromMe
  error row never counts as unread - a team-id failure notice would be wiped on the next
  reconcile), an explicit channel choice, deliberately NOT muted by `closedTeams` (a user who
  closed the tab after scheduling still needs to hear the failure), `canNotify()`-gated, tapping
  it opens the thread at the error row. Process-death-mid-send stays covered by
  `reconcilePending()` for free.
- **Reboot survival:** `BootReceiver` (or the service's own startup path) explicitly re-arms every
  still-persisted record after a reboot - `AlarmManager` alarms don't survive one on their own, and
  this has no other implicit re-arm the way the poll alarm gets for free.
- **Clock weirdness:** write the small time math fresh with the same `ZonedDateTime` discipline
  `IdlePushbackManager` uses - there is no literally-reusable helper there (`nextAlignedMark`
  computes poll-tier marks only), and its hydration clamp clamps a PAST-tracking timestamp:
  applying it to `fireAtMillis` (legitimately future) would be a bug. The analogous need here is an
  overdue check at arm/fire time - anything due-or-past fires immediately.
- **UI:** the docked indicator is a plain sibling composable in the SAME `Column` `ThreadScreen`
  already renders the Designer dock's `threadDockSlots` loop in (stacks naturally, no collision
  logic). Clock icon, "Sending at `<time>`" primary line, a countdown recomputed roughly every
  minute as the secondary line (reusing the cross-domain-presence freshness-chip ticker pattern),
  small edit/cancel icon buttons, tap-anywhere-on-the-body also opens edit. Session-list tile gets a
  clock icon when that session has an active scheduled send. Firing while the thread is open uses
  the identical path - the dock clears when the record does, and the pending row appears in the
  transcript like any live send.
- **Forget:** clears any scheduled send for that conversation (record, its alarm re-arm if it was
  the earliest, AND its banked attachment bucket) along with everything else Forget already drops.

## Phase 2 implementation notes

First implementation pass complete (data model, persistence, alarm scheduling, fire-processing,
retry, notifications, attachment lifecycle, Forget integration, UI). Not yet through the
align/red-team/framework audit rounds Phase 1 had - that is the immediate next step. Recorded here
so the scope decisions below survive into that audit rather than being re-derived or second-guessed
from scratch.

- **Storage/reactivity split:** the persistence SHAPE mirrors drafts exactly (SharedPreferences JSON
  blob, `isAddressKey`-filtered load, in both `SCHEMA_WIPE_KEYS` and `PROVISIONING_KEYS`) but the
  LIVE state deliberately does NOT mirror drafts' bare-ChatRepository-field shape - `scheduledSends`
  is a `ChatState` field instead (like `labels`/`unread`), since the dock and the session-tile clock
  icon both need Compose reactivity that a bare field wouldn't give them for free.
- **Fire-processor concurrency:** a dedicated `scheduledSendFireMutex` (Mutex) serializes
  `fireDueScheduledSends()` so the cold-boot chain's own unconditional call and a warm alarm-kick's
  call can never both convert the same due record - directly reapplying Phase 1's generation-token
  lesson to this client-side concurrency point instead of re-deriving it from scratch. A dedicated
  always-on `repoScope` (SupervisorJob + Dispatchers.IO, never cancelled - ChatRepository has no
  teardown of its own) backs the warm kick, since `pollScope` is null until `startPolling` runs and a
  missed scheduled send has no "next cold start heals it" backstop the way `scheduleAttachmentDelete`
  does.
- **Retry is deliberately NOT part of the persisted store.** A failed fire's bounded one-shot retry
  banks `team`/`opId`/`targetDomainId` directly as PendingIntent extras (ACTION_RETRY on the same
  `ScheduledSendAlarmReceiver`), not as a `ScheduledSend` record - it acts on an already-fired,
  already-in-the-thread "error" row, a different shape than "not yet attempted." Consequence: a
  retry alarm does NOT survive a reboot (BootReceiver never re-arms it, unlike the primary next-due
  alarm, which the cold chain's own `fireDueScheduledSends()` re-arms for free on every start). This
  is accepted, not fixed - the ultimate backstop (the error row's tap-to-retry, plus the eventual
  failure notification) is unaffected by whether the ONE automatic retry happens to be skipped by a
  rare reboot-during-a-5-minute-window coincidence.
- **Two teams' retries must not collide.** The retry PendingIntent's request code is hashed per-team
  (`SCHEDULED_SEND_RETRY_RC_START` + range, mirroring `teamNotificationId`'s own shape) rather than a
  single fixed code - a shared code would let a second team's `scheduleRetry` silently replace the
  first team's still-pending retry via `FLAG_UPDATE_CURRENT` (extras are not part of PendingIntent
  identity). Realistic trigger: several scheduled sends across different chats all become overdue
  after an extended offline stretch, fire in the same pass, and multiple fail together.
  `PendingIntent`s otherwise disambiguate by component+action too (the primary alarm and every
  retry share `ScheduledSendAlarmReceiver` but differ by action; POLL_ALARM_RC's own comment already
  documents this cross-component safety) - the per-team hash is specifically for the one case that
  doesn't disambiguate on its own (two retries, same component, same action).
- **"Edit" is deliberately time-only, not a full text/attachment re-edit.** The dock's tap-to-edit
  reopens the same date/time picker seeded at the record's current fire time and calls a new
  `rescheduleSend(team, atMillis)` that changes only `fireAtMillis` via `.copy()`, leaving
  text/fileRefs/opId/targetDomainId untouched. A fuller edit (also letting the text or attachments
  change) was scoped out for this pass: the banked `fileRefs` are already-copied `MessageFile` refs,
  not the live `content://` Uris `scheduleSend` takes, so folding both through one call risks
  silently dropping attachments on a "just change the time" edit unless given its own dedicated
  seam. Worth a follow-up if a fuller edit turns out to matter in practice; not implemented now.
  Cancel-and-reschedule-fresh remains the way to change text or attachments.
- **`deliver()` and `retrySend()` both gained an optional `targetDomainOverride`/`targetDomainOverride`
  parameter** (default null, preserving every pre-existing call site's behavior unchanged) rather than
  a parallel code path - the fire processor and the scheduled-send retry both need the banked
  `targetDomainId` to survive a cold process where `state.teams` is still empty.
- **`rebuildFiles` gained a `List<MessageFile>` overload** (the `Message`-taking original now
  delegates to it) so the fire processor can convert a banked record's `fileRefs` back into
  `OutgoingFile`s using the exact same logic `retrySend`/`reconcilePending` already trust, rather than
  a second hand-rolled copy.
- **Countdown/absolute-time formatting is new, small, and deliberately not shared with
  `relativeTime`** - that helper computes a "time since" delta from a PAST instant and reads as
  nonsense for a future one (a negative delta is still `< 60_000`, so it would print "now" for
  something hours away). `countdownText`/`absoluteTimeText` are fresh, narrow functions for a
  remaining-duration and an absolute clock time respectively.
- **Exception-safety of the cold-boot chain's new `fireDueScheduledSends()` step was checked
  against, not assumed:** in normal operation `deliver()` never throws (it internally catches every
  `Exception` and settles the row to `"error"` instead) - the only latent escape is an `Error` (e.g.
  OOM) or a `CancellationException`, and `reconcilePending()`, already shipped in the exact same
  chain one line above, has the identical property (its own `catch (e: Throwable)` around `deliver()`
  cleans up bookkeeping and re-throws, rather than swallowing). `fireDueScheduledSends()` sitting
  beside it with the same profile is consistent with an already-accepted risk at this call site, not
  a new regression - not additionally hardened here to avoid holding this new code to a stricter
  standard than its immediate, already-shipped neighbor in the same chain.
- **Update: a real toolchain and a booted emulator were found on this machine
  (`~/android-dev/{jdk,sdk,gradle}`, AVD `phone35` already running) after this note was first
  written.** `./gradlew compileDebugKotlin`, `testDebugUnitTest`, and `assembleDebug` all pass; a
  fresh install launches on the emulator with no crash in logcat. Pushing an existing (differently-
  identitied) provisioning blob in via the `provisioning_b64` intent extra got the app past Set Up
  into a real connect attempt against a live local gateway, correctly reporting "Not enrolled" for
  this fresh install's own identity - a genuine protocol-level response, not a crash. Completing
  enrollment (to click through the actual schedule/dock/fire/cancel/reschedule golden path) was
  deliberately deferred rather than attempted by touching the live gateway's admission state, since
  it is serving real sessions, not a throwaway instance - the user confirmed doing this a different
  day is fine. So: compiled and unit-tested for real, but the golden path itself is still only
  manually-reasoned-through, not click-tested.

## Phase 2 align audit round 1

A `Workflow()` fanned out 11 audit dimensions against the real diff and the plan text, each
followed by a 3-way adversarial refute pass. 11 candidates raised, 10 confirmed, collapsing to 6
distinct root causes (a few dimensions independently found the same underlying gap from different
angles) - all resolved:

- **[high] The warm alarm-kick could run before `SwitchboardService.onCreate()` had wired
  `scheduledSendScheduler`/`onScheduledSendFailed`,** so a fire (or retry) that failed in that
  window silently skipped arming the automatic retry and silently skipped the "unattended failure
  is never silent" notification - the two concrete promises this whole failure-policy bullet exists
  to keep. Fixed with a bounded wait (`awaitSchedulerWired`, `SCHEDULER_WIRE_WAIT_MS` = 5s) at the
  top of both warm-kick entry points; the cold-boot chain's own direct call never needed this (its
  `onCreate()` already wired the scheduler synchronously, earlier in the same function, before
  reaching the chain). Verified the fix by temporarily reverting it and confirming the reasoning
  held (a null-scheduler window genuinely exists per the receiver/onCreate ordering - Android's
  `startForegroundService` is asynchronous, `onCreate()` is not guaranteed to have run by the time
  the SAME `onReceive` call's next line executes).
- **[medium] The plan's "a warm kick can never race a cold start's not-yet-connected state" claim
  was not actually true** - `scheduledSendFireMutex` only prevents double-converting the SAME due
  record, it does not enforce that the cold chain's `connect()` has run first. Tightened the
  "Firing sequence" bullet's wording to state what is actually guaranteed (no double-conversion)
  versus what is not (connect-freshness ordering), and recorded why the residual gap is low-stakes
  in practice (deliver()'s targetDomainOverride bypasses the empty state.teams for a cross-Domain
  target; ConsoleClient falls back to the persisted gatewayId when routeGateway is unset) rather
  than building further synchronization to close it outright.
- **[medium] `SCHEDULED_SEND_PASS_TIMEOUT_MS`'s own derivation comment summed to 205s but the
  constant was 180_000L** - 25 seconds short of what the comment itself claimed to generously round
  up from. Recomputed honestly (15s + 4x35s + 50s = 205s) and set the constant to 240_000L, with
  the comment's own arithmetic corrected to match.
- **[medium] The retry PendingIntent's request code hashed on team name alone,** so two SEQUENTIAL
  failures for the same team within the ~5 minute retry window (possible since a record is cleared
  at fire time regardless of outcome, so a fresh schedule for the same team is immediately allowed
  again) would silently replace each other's retry alarm via FLAG_UPDATE_CURRENT - the exact
  failure mode the per-team hashing was introduced to prevent, just not scoped to cover this case
  too. Fixed by folding opId (unique per schedule) into the hash alongside team.
- **[medium] A user Cancel or Forget racing a live fire could delete the attachment bucket a
  freshly-appended thread row had just started depending on** - `fireOne`'s append-then-clear order
  is intentional (crash-recovery, see its own doc), so the record and the row briefly coexist, and
  `cancelScheduledSend` (unsynchronized against `fireOne` - making it suspend to share the mutex
  would ripple into every UI call site) could delete files a live row now needs. Fixed narrowly:
  `cancelScheduledSend` now checks whether a thread row already carries the same opId before
  deleting, skipping the delete if a fire has already claimed it - closing the concretely damaging
  case without the broader (and here, disproportionate) cross-coroutine locking a fully airtight
  fix would need.
- **[medium] `forget()` never dismissed `SCHEDULED_SEND_FAILED_NOTIFICATION_ID`,** unlike the
  analogous per-team message notification, which both `onForget` call sites already cancel for the
  identical stated reason (a forgotten team drops out of every state map the level-based reconcile
  logic could otherwise use to notice and clean it up). Fixed with a
  `cancelScheduledSendFailedNotification(context, team)` companion method, tracking which team's
  failure currently occupies the single shared notification slot so forgetting a DIFFERENT team
  never wipes a still-relevant one, called from both `onForget` sites alongside the existing
  `cancelTeamNotification`.
- **[low, accepted, not fixed] `forget()` is not synchronized against `scheduledSendFireMutex`
  either,** so a user Forget landing within a few CPU instructions of that same team's alarm firing
  could theoretically have `fireOne`'s `append()` re-create a thread entry `forget()`'s own drop had
  just emptied, delivering a message into a conversation the user believed fully forgotten seconds
  earlier. Left as an accepted, extremely narrow residual (the window is a handful of in-memory
  operations with no I/O in between) rather than adding the same cross-coroutine locking discussed
  and rejected above for the attachment case - fully closing it would need the identical invasive
  change (making `forget()` suspend and share the mutex, rippling through every UI call site for a
  vanishingly rare interleaving).

One candidate (a claimed missing `!!` on `openTeam` at the ThreadScreen call site, `state.
scheduledSends[openTeam]`) was raised but refuted by the adversarial pass. Added the `!!` anyway for
zero cost and consistency with every other `openTeam` use in that same call - Kotlin smart-cast
behavior for a `by remember { mutableStateOf(...) }` delegate under nested-lambda reassignment is
subtle enough that "the verifiers said it compiles" was not worth trusting over a free, zero-risk
fix, especially since this could not be independently compile-checked at review time.

All fixes verified against the real toolchain (see the note above this section): `./gradlew
compileDebugKotlin` and `testDebugUnitTest` both pass after every fix in this round, not just at
the end.

### Follow-up focused re-check (not a full re-audit)

A single targeted Agent re-read all six fixes above for correctness and regressions, rather than
re-running the full 11-dimension workflow - proportionate to how surgical each fix was, and cheaper
than a full re-audit for changes this small. Found one more real bug, one more accepted residual,
and confirmed the rest:

- **[fixed] `notifyScheduledSendFailed`'s field-write and its `notify()` call were two separate,
  unsynchronized steps.** `kickScheduledSendRetry` runs each team's retry on its own
  `repoScope.launch` coroutine - genuinely concurrent `Dispatchers.IO` threads, not just interleaved
  suspension points - so two teams failing close together could post-then-write in an order where
  `lastScheduledSendFailureTeam` ends up naming a DIFFERENT team than whichever notification's
  content is actually showing, silently breaking the just-added forget-dismiss fix in the exact
  scenario it exists for. Fixed with a plain JVM monitor (`scheduledSendFailureLock`, a `synchronized`
  block around both the field-write and the notify()/cancel() calls in both directions) - a
  suspend-based Mutex was not the right tool here since neither caller is a suspend function.
- **[accepted, not fixed, added to the residual above] A second narrow window in the SAME
  cancel/forget-vs-fireOne family:** `claimedByLiveRow` closes the case where cancel runs AFTER
  `fireOne`'s `append()`, but there is a symmetric window BEFORE it - if `cancelScheduledSend` runs
  between `fireDueScheduledSends()` reading a due record and `fireOne`'s own `append()` call,
  `claimedByLiveRow` correctly (at that instant) sees no row yet, deletes the attachment bucket, and
  `fireOne` - already holding the record locally - appends the row and delivers anyway;
  `rebuildFiles()` silently drops any file whose copy is gone, so the send can go out (or the row
  can render) missing its attachment depending on which async op lands first. Same family as the
  already-accepted `forget()`-vs-`scheduledSendFireMutex` residual above (narrow, no-I/O, would need
  the identical invasive suspend-ify-and-share-the-mutex change to close outright) - folded into that
  same accepted-risk bucket rather than treated as a new, separate gap.
- **[not adopted] `onScheduledSendFailed` could theoretically use `@Volatile`** for the same
  JMM-piggyback-on-a-volatile-write reasoning `scheduledSendScheduler` already gets, since it is
  written right next to it in `onCreate()`'s synchronous prefix. Declined: this field is declared to
  mirror `onInbound`'s own exact shape, and `onInbound` is a plain (non-`@Volatile`) `var` with the
  identical theoretical property - hardening only the newer field would be an inconsistent,
  isolated deviation from the pattern it explicitly mirrors, not a fix to something Phase 2
  introduced. If this is worth closing, it belongs as its own pass across both fields together, not
  smuggled into this feature's diff.
- Items 3 (retry request-code hashing) and 6 (the build itself, re-verified with `--rerun-tasks` to
  force genuine recompilation rather than trust a cached UP-TO-DATE result) came back clean, no
  further action.
- One cosmetic-only observation (a sibling `state.threads[openTeam]` read at the same call site
  still lacks the `!!` the round-1 fix added elsewhere) is pre-existing code Phase 2 did not touch -
  left alone rather than editing already-shipped, unrelated code for a style-only reason.

Re-verified again after this round's fixes: `./gradlew compileDebugKotlin testDebugUnitTest
--rerun-tasks` - BUILD SUCCESSFUL, all 26 tasks freshly executed (not cached), same two
pre-existing, unrelated warnings as before.

## Phase 2 red-team round 1

A separate `Workflow()` red-teamed the implementation for gaps the plan itself never thought to
specify - security/input-handling, resource exhaustion, lifecycle edge cases (rename, unlink, config
change, clock change) - deliberately NOT re-covering the concurrency/ordering ground the align audit
already worked. 6 angles, 22 candidates raised, 17 confirmed. Fixed:

- **[high] The composer cleared draft/attachments synchronously the instant Schedule was tapped,
  before the async, authoritative time check was known to succeed** - and that check could fail
  silently (the picker's own gate is evaluated once per recomposition and never re-validated against
  a live clock while the user idles on the dialog; a stale pick, or a clock change, made it trip with
  zero error surfaced). Fixed properly, not patched: `onScheduleSend`/`onReschedule` changed from
  fire-and-forget `Unit` callbacks to `suspend ... -> Boolean`, `ThreadScreen` now awaits the real
  outcome before clearing anything, and `scheduleSend`/`rescheduleSend` both gained an error message
  on the past-time branch they previously left silent. This also closed the accompanying double-tap
  race for free: the Schedule button disables (`submitting`) the instant it is tapped until the
  awaited call resolves, so two overlapping taps can no longer race on the same draft/attachments.
- **[medium] `loadPersistedScheduledSends` wrapped its whole per-team parse loop in ONE runCatching**
  - a single malformed row threw away every OTHER team's still-good record too, and the cascade
    reached further than just data loss: the next cold start's unconditional `fireDueScheduledSends()`
  would find nothing due and call `rearmScheduledSendAlarm()`, which CANCELS the real, still-armed
  AlarmManager alarm for every affected team. Fixed by parsing each row under its own runCatching.
- **[high] `SCHEDULED_SEND_FAILED_NOTIFICATION_ID` was a single shared slot across every team** -
  two teams failing close together (the exact scenario the retry request-code hashing fix already
  names as realistic) silently overwrote each other's still-unread notification content, since
  `NotificationManagerCompat.notify` replaces in place. Redesigned properly rather than patched
  again: gave the failure notification its own per-team hashed id (its own range, disjoint from both
  `TEAM_ID_RANGE` and the retry request-code range), which ALSO let the round-1
  `lastScheduledSendFailureTeam`/`scheduledSendFailureLock` tracking machinery be deleted outright -
  a per-team id makes the whole "which team is showing" consistency problem it existed to solve moot.
- **[high] No `android:configChanges` is declared anywhere in this app, and `scheduleDialogSeed`/
  `pickingTime`/`attachments` were all plain `remember`, not `rememberSaveable`** - a rotation, theme
  switch, or font-scale change destroys and recreates the Activity, silently closing an in-progress
  Schedule Send dialog (any step) and dropping picked attachments, with zero feedback. Fixed by
  switching all three to `rememberSaveable` (dateState/timeState already saved themselves internally,
  confirmed by decompiling the project's own Material3 aar - only the enclosing flags were the gap).
- **[medium] The Surface+combinedClickable send-button replacement regressed accessibility versus
  the FilledIconButton it replaced** - missing `minimumInteractiveComponentSize()` (a real 40dp vs
  48dp touch-target shrink, confirmed by decompiling IconButtonKt) and missing `Role.Button`/
  `onLongClickLabel` (TalkBack lost the button trait and the long-press affordance description).
  Fixed by restructuring: `minimumInteractiveComponentSize()` + `combinedClickable` (now carrying
  `role`/`onLongClickLabel`) on an outer Box, the 40dp Surface as a purely visual inner child.
- **[medium] `CHANNEL_SCHEDULED_SEND_FAILED` never called `enableVibration(true)`** unlike
  `CHANNEL_MESSAGES` - a vibrate-only ringer got zero physical cue for the one notification whose
  whole job is "unattended failure is never silent". Fixed (this channel is new to this feature, not
  pre-existing code, so unlike the two declined items below it is squarely in scope).
- **[medium] No upper bound on how far in the future a send can be scheduled** - Material3's
  DatePicker defaults to an 1900-2100 year range with nothing narrowing it, so a stray far-future tap
  banked an attachment bucket for a multi-decade span. Added `SCHEDULED_SEND_MAX_HORIZON_MS` (30
  days, generous for an hours-to-days-out reminder feature) as an authoritative repo-side check
  (`scheduleSend`/`rescheduleSend`) plus a matching UI-side gate/error text in the picker.
- **[high, mitigated not fully solved] `RTC_WAKEUP` alarms are wall-clock based and nothing
  re-evaluates them on a system clock or timezone change** - a backward clock jump silently defers a
  pending send far past its picked time, with no re-arm and no error. Added `ClockChangeReceiver`
  (`ACTION_TIME_CHANGED`/`ACTION_TIMEZONE_CHANGED`, both exempt from the Oreo+ implicit-broadcast
  manifest-registration restrictions) that re-syncs by calling the SAME `kickScheduledSendFire()` the
  warm alarm path already uses. **Verified for real, not just reasoned through:** ran
  `su 0 date 010112002030.30` on the live emulator to genuinely jump the system clock, confirmed via
  logcat that Android delivered the broadcast to this static receiver and that it ran
  (`ActivityManager: Start proc ... for broadcast {...ClockChangeReceiver}` then this feature's own
  log line), then restored the real time immediately after. This is a defensive re-sync, not a full
  fix for the deeper, genuinely ambiguous product question of whether a relative scheduling intent
  ("10 minutes from when I tapped Schedule") should be preserved across a clock jump at all - that
  would need banking a relative delta alongside the absolute epoch and deciding what "the user's
  intent" even means once the two disagree; left as a known, harder follow-up.
- **[low] Zero automated test coverage existed for any scheduled-send logic.** Added
  `ScheduledSendTest.kt` covering the pure, cheaply-testable pieces: `countdownText`/
  `absoluteTimeText`'s boundary cases, and the two notification/request-code hash functions
  (`scheduledSendRetryRc`, `scheduledSendFailedNotificationId` - bumped from `private` to `internal`
  for testability, mirroring `IdlePushbackManager`'s own `tierFor`/`nextAlignedMark` precedent for
  exactly this reason) for determinism, input-distinctness, and declared-range membership. A full
  `ChatRepository`-level integration test (scheduleSend/fireOne/the retry policy end to end) is NOT
  included - this project has no Robolectric/mocking library on its test classpath, so exercising an
  actual `ChatRepository` instance would need a bigger test-infrastructure investment than fits this
  pass; noted as a real gap, not silently ignored.

Declined, with reasoning (not silently dropped):

- **Reading full attachment bytes into memory before the MAX_OUTGOING_BYTES check** (an OOM risk
  distinct from the disk-side eager-copy, which IS correctly gated) - confirmed byte-for-byte
  identical to the pre-existing live `send()` path, not something Phase 2 introduced. A fix belongs
  to both call sites at once, as its own unrelated change.
- **No ambient board-level signal once a fire AND its one retry both fail with notifications fully
  off** - `Message.countsUnread()` is unconditionally `!fromMe`, so a fromMe error row never bumps
  unread for a live send either; this is an existing, app-wide property, not unique to scheduled-send.
- **`canNotify()`'s coarse-only permission check and no `setBypassDnd` on either channel** - applies
  identically to the pre-existing `CHANNEL_MESSAGES`, not a Phase-2-specific gap.
- **No cap on how many different teams can simultaneously hold a pending schedule** (unlike the
  gateway's own Phase-1 `DurableOpStore`, deliberately capped with an active sweep). Real, but a
  proper fix needs its own rejection UX ("too many pending schedules") - deferred as a follow-up
  rather than designed under this round's time budget; the new 30-day horizon cap at least bounds
  the DURATION half of the same storage-liability concern.

All fixes rebuilt and re-tested for real after every change in this round (not just at the end):
`./gradlew compileDebugKotlin testDebugUnitTest assembleDebug --rerun-tasks` - BUILD SUCCESSFUL, all
42 tasks freshly executed. Reinstalled on the live emulator and relaunched - no crash in logcat.

### Follow-up focused re-check (the two largest rewrites)

Rather than a full second red-team fan-out, one Opus agent re-checked the two largest rewrites from
this round specifically: the composer-clearing suspend/Boolean redesign, and the per-team
notification id redesign. The notification redesign came back clean (lock/field fully removed, no
dangling references, the new id range genuinely disjoint from both the team-message range and the
unrelated PendingIntent request-code space, the `init` require() correctly enforces it). The
composer fix surfaced one real, concrete gap:

- **[fixed] The onConfirm continuation can outlive its own dialog.** `scheduleSubmitting`/
  `scheduleScope` are `ThreadScreen`-scoped, not scoped to the dialog instance - if the user dismissed
  the dialog while a schedule/reschedule call was still in flight and then reopened a NEW session
  (fresh Schedule Send, or a dock edit) before the first call resolved, the stale continuation would
  still run its close-dialog/clear-composer side effects once it finally settled: closing the
  freshly-reopened SECOND dialog out from under the user, and - on a successful first attempt -
  wiping whatever text/attachments the second attempt had already typed. Fixed the same way Phase 1's
  DurableOpStore closes the identical "a stale attempt must recognize a newer one has taken over"
  shape: a `scheduleDialogGeneration` counter, bumped on every NEW dialog open (menu or dock edit,
  never on a bare dismiss), captured by the continuation at launch and checked before it commits any
  side effect. A bare dismiss with no reopen deliberately does NOT bump the generation, so a late
  success still clears the composer in that milder, non-destructive case (the schedule genuinely
  went through; only the stale draft text is left sitting unclear until the user notices or types
  over it) rather than trying to handle every conceivable dismiss/reopen/success timing perfectly.
  Also added a `try/finally` around the re-enable so it is an explicit guarantee rather than
  incidental on today's callees happening not to throw.

Rebuilt and re-tested again after this fix: `./gradlew compileDebugKotlin testDebugUnitTest` - BUILD
SUCCESSFUL.

## Phase 2 framework-first audit round 1

A smaller, targeted `Workflow()` (4 angles, Opus, 2 verifiers per finding per the tightened cycle
convention) looked for missing/duplicated architecture rather than bugs: hash-id duplication across
the notification/request-code helpers, whether ScheduledSend logic belongs in its own class the way
`IdlePushbackManager` was extracted from `ChatRepository`, naming/comment clarity, and structural
consistency with established conventions. 12 candidates, 4 confirmed - all small, all fixed:

- **Duplicated PR-narration comments** ("a single fixed id was tried first, but a red-team pass
  found...") existed in two places explaining the same per-team-notification-id rationale - a
  timelessness violation (comments must describe the code as it stands, not its change history) that
  also meant an edit to one could silently leave the other stale. Consolidated into one comment on
  `notifyScheduledSendFailed` itself; the companion-object copy now just points to it.
- **The dock countdown ticker's own comment said "roughly every minute" but the code ticked every
  30 seconds** (`delay(30_000)`) - matching neither the plan's own explicit "live-ish... roughly
  every minute" design decision nor its own doc. Changed the code to `delay(60_000)` rather than the
  comment, since the plan's original decision is the authoritative intent.
- **`SCHEDULED_SEND_PASS_TIMEOUT_MS` was a flat literal (240_000L) with its derivation living only in
  a comment** - the exact class of drift the align audit already caught once for this same constant
  (a comment claiming 205s while the literal said 180s). Re-derived from real references where
  possible: `IdlePushbackManager.REVIVAL_OVERHEAD_MS` (bumped to `internal` for this reuse) and
  `ConsoleClient.PINNED_CONNECT_TIMEOUT_MS`/`PINNED_READ_TIMEOUT_MS`, plus an explicit margin term -
  the "four round trips at the default client's own un-named 35s" term stays a labeled literal, since
  naming ITS sub-parts would mean adding new exported constants to `ConsoleClient.kt` for a single
  caller in an unrelated file. Same total (240s), now with two of its three terms genuinely wired to
  the values they claim to track instead of hand-copied.
- **The `destroyed` field's doc comment only mentioned `DeepIdleScheduler`**, even though
  `ScheduledSendAlarmScheduler`'s three methods check the identical guard - updated to name both.

The other two angles (hash-id duplication across `teamNotificationId`/`scheduledSendFailedNotificationId`/
`scheduledSendRetryRc`, and whether ScheduledSend logic should be extracted into its own class like
`IdlePushbackManager`) came back with nothing to change: the hash-id duplication was judged not worth
a shared generic helper (three near-identical one-liners, each already reads clearly, and a shared
helper would only add a layer of indirection between a caller and the range constants it must still
supply correctly), and a `ScheduledSendManager`-style extraction was judged too tightly coupled to
`ChatRepository`'s own private internals (`append`, `deliver`, `rebuildFiles`, `_state`, `filesDir`,
`confirmedDomainId`, `canonicalTarget`) to pull out without a much larger, riskier refactor than fits
this pass - unlike `IdlePushbackManager`, which was designed from the start against abstract
`IdleSilenceStore`/`DeepIdleScheduler` interfaces specifically to stay decoupled. Recorded here as a
considered-and-declined option, not silently skipped.

Rebuilt and re-tested for real after every fix in this round: `./gradlew compileDebugKotlin
testDebugUnitTest --rerun-tasks` - BUILD SUCCESSFUL, all 26 tasks freshly executed.
