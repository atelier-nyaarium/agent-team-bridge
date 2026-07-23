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
  single serialized fire-processor (a latch/serialization the cold chain completes and the warm
  kick awaits), so a warm kick can never race a cold start's not-yet-connected state. Wakelock: a
  new derived constant with its own derivation comment (the `IdlePushbackManager.kt` discipline),
  NOT `SEND_BOUND_MS + PINNED_READ_TIMEOUT_MS` - those two overlap by design (the client read
  ceiling is pinned to outlast the gateway bound), and the real cold path adds terms that formula
  misses: `REVIVAL_OVERHEAD_MS` (15s) + `connect()`'s sequential round trips (each up to 15s
  connect + 35s read) + the send's own 15s + 35s. Order-of-2-minutes total, capped: an attachment
  UPLOAD is uncapped by design (600s per-write inactivity), so a huge upload on a slow link can
  outlive the lock - acceptable, because an interrupted attempt is recoverable (below), and
  holding multi-minute wakelocks is worse.
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
