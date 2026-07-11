# Inbound Message Pipeline (phase -1 foundation)

Framework-first refactor: give the console a single exactly-once "a new message arrived" seam that
core features and plugins subscribe to, so per-message features stop reinventing (and mis-deriving)
the mailbox ordering. Unblocks the Designer additive store, which then collapses to a trivial
subscriber. Confirmed by a framework-first assessment after the additive store failed five red-team
rounds. See `plans/plugins.md` "Phase -1" for the condensed rationale.

## Problem (what went wrong, so the design doesn't repeat it)

The mailbox poll drain already owns exactly-once, in-order, epoch-correct delivery of new messages
(`SyncCursor.advance` returns `adv.fresh`; `MailboxSync.commit` is the LAST write of a poll cycle,
so a crash re-delivers rather than skips). But the ONLY consumer of `adv.fresh` is one hand-rolled
`for` loop in `ChatRepository.startPolling` (~`ChatRepository.kt:2631`), and the only "react to a new
message" hook is a SINGLE-SLOT `var onInbound` (~`:727`), already taken by notifications
(`SwitchboardService.kt:90`). A second consumer cannot get a seat.

Denied the write path, the Designer went to the read path: `DesignerDock.produceState` re-scanned
`state.threads[team]` (post-fold, arrival-ordered, in-place-spliced, mixed-epoch) and reinvented a
SECOND cursor (`wmEpoch/wmSeq/gen`) whose epoch rule (`>`) contradicts the one true cursor's
(equality + reset; the mailbox epoch is a RANDOM per-instance nonce, `mintEpoch` in
`src/shared/device-mailbox.ts`). Two cursors over one stream cannot agree - the source of all five
rounds.

## Invariant the design must satisfy

Each genuinely-new inbound message is delivered to each subscriber EXACTLY ONCE, in mailbox order,
and a subscriber never has to know about epochs, seqs, timestamps, or re-scans. Delete-safety and
crash-safety come from the cursor, not the subscriber.

## The load-bearing constraint (do not violate)

Delivery is a SYNCHRONOUS in-line call on the poll IO thread, inside the drain, BEFORE
`mailboxSync.commit(adv.next)`. NOT a `MutableSharedFlow<Message>`. The cursor advances only after
processing, so a synchronous pre-commit call inherits exactly-once + crash-safety for free; a hot
observable severs that coupling (a cold/unmounted subscriber misses the emit and needs a durable
cursor again - the exact bug). `DesignerOpenBus` (replay-0 SharedFlow) is the correct shape for
transient UI intent and the WRONG shape for the data plane.

Because the call is synchronous on the sole drain thread (audit blockers 2 + 8), the subscriber
CONTRACT is: fast, bounded, non-blocking, idempotent. A subscriber does the MINIMUM synchronous work
(for the Designer: a bounded 2 KB prefix read to check the `@dsCard` marker - the file was just
written by `Attachments.decode` in the same drain iteration, so this is a tight, near-always-readable
read, not an arbitrary IO). Heavy or fallible work is the subscriber's own problem, not the drain's.

## Design

### The pipeline (core)

A neutral core sink in `ChatRepository` (core must NOT import plugins):

```kotlin
fun interface InboundSubscriber { fun onMessage(team: String, msg: Message) }
```

- `ChatRepository` holds `private val inboundSubscribers = CopyOnWriteArrayList<InboundSubscriber>()`
  and `fun addInboundSubscriber(s) / removeInboundSubscriber(s)`.
- Dispatch at the EXISTING `appendInbound(...) == true` gate (the canonical "genuinely new,
  first-seen" signal that already gates `bumpUnread`/`burst`), before `mailboxSync.commit`:
  ```kotlin
  if (appendInbound(team, msg)) {
      bumpUnread(team)
      burst.getOrPut(team) { mutableListOf() }.add(msg)
      inboundSubscribers.forEach { runCatching { it.onMessage(team, msg) } } // NEW; never throws upward
  }
  ```
- A subscriber throwing MUST NOT break the drain (catch + log), same as the existing peer-mirror's
  "purely additive, failure never surfaces" contract.

### The plugin extension point (data plane)

`PluginHost.inboundMessages: PluginRegistry<InboundMessageHandler>` - the framework's first
data-plane point (the four existing are UI/lifecycle). The handler is given a STRIPPED, read-only
view (audit 6 + 7): NO `epoch`/`seq` (so the invariant "subscribers never see an ordinal" is
type-enforced, not just documented), and a narrow capability (`filesDir`) instead of full `Context`
(so a handler cannot reach `Repo.get(context)` and reentrantly call a ChatRepository mutator from
inside the drain):

```kotlin
/** What a data-plane subscriber sees: no mailbox coordinates, no repo handle. */
class InboundMessage(
    val team: String,
    val fromMe: Boolean,
    val isPeer: Boolean,
    val at: Long,
    val files: List<MessageFile>,
    val text: String,
)
fun interface InboundMessageHandler { fun onMessage(filesDir: File, msg: InboundMessage) }
```

The app bridges the registry into the repo once (like `SwitchboardService` wires `onInbound` today):
one core `InboundSubscriber` that maps each `Message` to an `InboundMessage` and fans to every
claimed handler. `registry.values()` is read live per dispatch, so enabling/disabling the Designer
starts/stops delivery correctly (the retract sweep removes its claim).

### Notifications and TTS are NOT touched (audit 5)

The `onInbound` per-team BURST callback stays exactly as-is - it coalesces one notification per poll
cycle AND drives the async STTS preload (`scope.launch`, post-commit). It is one intertwined closure
with sync+async branches; folding it into per-message dispatch would regress notification coalescing
and contradict the async branch. So the new pipeline is a SECOND, separate seam that lives BESIDE
`onInbound`: `onInbound` is the per-team-burst UI/notification/TTS seam, `inboundSubscribers` is the
per-message data seam. They are genuinely different concerns; two seams is honest, not debt. The
"unify onInbound" idea is dropped.

### Designer collapses (the payoff)

- `DesignStore` becomes a PROCESS-GLOBAL SINGLETON (audit 4): one instance in the same process as
  both the service (poll-thread writes) and the activity (dock reads), so its per-team
  `MutableStateFlow<List<StoredCard>>` is shared, not split-brain. It hydrates each team's flow from
  the persisted `switchboard-designer` prefs on first access. `upsert/delete/forget/forgetAll`
  update BOTH the persisted prefs AND the in-memory flow under one lock. The dock `collectAsState`s
  the flow.
- DELETE (no watermark - the pipeline delivers each message once, so there is no re-scan to re-add a
  deleted card): `wmEpoch/wmSeq/gen`, `ingest(scan, expectedGen)` + CAS, `mergeDesigns`, `scanForCards`,
  `ScannedCard`, `IngestScan`, `newerThan`, `CardRead.Retry`'s watermark-hold. KEEP `CardRead.Ok/Skip`,
  `parseDsCardMarker`, `looksHtml`, `relOf`, `htmlTitle`.
- The Designer registers an `inboundMessages` handler (~15 lines): guard `msg.fromMe || msg.isPeer`;
  for each html-looking file, read a bounded 2 KB prefix (retry the read 2-3x synchronously - the
  file was just written, so a miss is near-unreachable; audit 8) -> `parseDsCardMarker` ->
  `DesignStore.upsert(team, card)`.
- `DesignerDock` no longer ingests; it renders from `DesignStore.cards(team).collectAsState()`.

### One-time backfill (audit 1 + 3)

Because a headless service can drain messages before this feature/subscriber ever existed (and the
cursor never re-delivers), a card received earlier would be missing. A ONE-TIME, flag-guarded
backfill runs once at first boot: scan the loaded `state.threads` for dsCards and `upsert` each
(fileName -> the last-occurring rel; array order is fine for a one-shot, and any error self-corrects
on the next re-push). It is safe to be dumb because: (a) it runs ONCE ever (a persisted flag), so
there is no recurring re-scan to fight delete; (b) the additive store is GREENFIELD (no prior
additive delete-state to conflict with - the live app still runs the phase-3 versioned Designer);
(c) it runs at service boot before the dock is interactive, so no concurrent forget. After the flag
sets, only the live pipeline mutates the store. Backfill upsert and live upsert are both idempotent,
so their ordering does not matter.

## Bugs impossible by design after this

- Cursor re-derivation drops (no second cursor; subscribers never derive an ordinal).
- Epoch-flip silent drop (epoch handling lives ONLY in `SyncCursor`; subscribers never see an epoch).
- Deleted-content resurrection (each message delivered once, never replayed).
- Stale-scan-vs-forget race (synchronous single-card delivery + a plain lock; no generation counter).
- Duplicate on at-least-once re-drain (handled once, centrally, at the gate).

### Registration ordering (audit 1 + 5 - the fix)

The plugin data-plane bridge MUST be registered before `startPolling`, from a boot point that runs
whether or not an Activity ever opens. So: boot the plugin framework and wire the bridge in
`SwitchboardService.onCreate`, BEFORE `repo.startPolling(scope)` (the service is the durable owner of
the poll loop; `MainActivity`'s existing `Plugins.get` stays, idempotent). Order in `onCreate`:
`Plugins.get(this)` (boot -> registers the Designer's `inboundMessages` handler) -> wire the core
`InboundSubscriber` bridge onto `repo` -> one-time backfill -> `repo.startPolling(scope)`. No message
is delivered before the subscriber exists.

## Resolved decisions (from the audit)

- Deliver everything that passes the `appendInbound`-true gate; the handler filters `fromMe`/`isPeer`
  itself (`sent` already `continue`s before the gate). A future handler may want peer rows.
- Subscribers run on the poll IO thread; a `StateFlow` write from a background thread is safe and the
  dock recomposes. A subscriber that touches the UI hops threads itself (the Designer does not).
- Do NOT migrate notifications/TTS (they stay on `onInbound`); do NOT migrate peer-mirror. The
  pipeline is a NEW seam beside them.

## Lap-2 resolutions (audit of the fixes; 1 blocker + 9 major, all resolved)

- [BLOCKER, store Context] The Context-stripped handler still needs a Context to reach its
  SharedPreferences store. RESOLUTION: `PluginHost` carries the app `applicationContext` (the
  framework already has it - `Plugins.build(app)`); the Designer inits its store ONCE at
  `register()` via `DesignStore.init(host.applicationContext)`, and the per-message handler then
  calls the context-free singleton `DesignStore.get()`. The DATA handler signature stays Context-free
  (blocks per-message reentrancy); only trusted one-time setup sees the app context.
- [store singleton] `DesignStore` is a process-global init-once singleton (`init(appContext)` /
  `get()`), holding per-team `MutableStateFlow`s. `cards(team)` get-or-create runs under the SAME
  lock as `upsert/delete/forget/forgetAll` (no double-create race between the poll thread and UI).
  Migrate the existing raw `DesignStore(context)` call sites: `DesignerDock`'s
  `remember { DesignStore(context) }`, and `DesignerPlugin`'s forget/wipe handlers.
- [plugin lifecycle - the important reframe] The Designer is OPT-IN, OFF by default. So ingest is
  PLUGIN-GATED: the `inboundMessages` handler is present only while the plugin is enabled (the bridge
  reads `registry.values()` live, so enable/disable start/stop delivery via the retract sweep, no
  extra code). Messages that arrive WHILE THE PLUGIN IS DISABLED are NOT collected (the honest cost
  of a toggleable feature); re-enable resumes for NEW messages and does NOT reconcile (so deletes are
  preserved and no re-scan is reintroduced). The store persists across disable/enable.
- [backfill - lazy, per-team, from the dock] Drop the service-boot backfill. Instead the DOCK
  backfills its OWN team ONCE on first open after enable (a per-team flag): it has Context + that
  team's messages, applies the same `fromMe||isPeer` guard, upserts each dsCard (bounded prefix read,
  off the main thread). Greenfield-safe (first open = no deletes yet); one-time per team (no recurring
  re-scan, so delete stays sticky); idempotent with the live pipeline. No global boot scan, no
  Context gap, no concurrent-forget race.
- [bridge idempotency] The core `InboundSubscriber` bridge is created + added to the repo ONCE per
  process (in the `Plugins`/process-singleton init), NOT in `SwitchboardService.onCreate` (which can
  re-run on service recreation after a re-provision -> double-register -> double-ingest). Added once,
  it reads the live registry, so it needs no teardown on service destroy.
- [per-message file cap] Bound the handler's work: scan at most the first few html-looking files per
  message (a message with hundreds of html attachments is pathological; the wire cap is aggregate MB
  only). Keeps the synchronous drain call bounded regardless of a hostile message shape.
- [read failure] A permanent read miss (oversize/gone) skips cleanly (not a card); a transient miss
  is near-unreachable (co-located with the just-completed write) and accepted as documented residual.

## Lap-3 red-team (implementation audit; fixes applied + deferred)

A 10-dimension alignment pass came back fully aligned, zero gaps. A 12-dimension adversarial pass
surfaced the following.

Fixed (introduced by this change):
- [HIGH] Backfill resurrected a deleted card. `markBackfilled` ran only after the full seed loop, and
  the backfill is a cancellable `LaunchedEffect`, so an interrupted seed left the flag unset and a card
  the user deleted meanwhile was re-seeded on the next open. Fix: mark the flag FIRST, then seed inside
  `NonCancellable`. Mark-first makes resurrection impossible even across process death (a torn seed can
  only MISS pre-plugin cards, never re-add a deleted one); NonCancellable finishes a seed a tab switch
  began.
- [MEDIUM] Stale clobber. `upsertInto` overwrote by filename unconditionally, so a slow backfill of an
  older revision could clobber a faster live-ingest of a newer one. Fix: at-monotonic upsert (an
  incoming card older than the stored one is ignored). The whole ordering-race class is now impossible.
- [MEDIUM] Chip-tap race. The viewer-open was not guarded by the compare-and-clear, so two fast taps
  could open the first-tapped card instead of the last. Fix: return early when a newer tap superseded
  this read.
- [LOW] Team-switch stale frame. `collectAsState` on the per-team flow was not `key(team)`-scoped. Fix:
  wrap it in `key(team)`.
- [LOW] Silent handler exceptions. Fix: catch and log at both dispatch sites (the Plugins bridge and
  the drain).

A fix-verification re-audit (6 dimensions) confirmed the above 5 correct and surfaced one more:
- [MEDIUM] A Delete or Forget racing the one-shot first-open backfill could be re-added by the
  in-flight seed loop (the loop has no suspend point, so it runs to completion once entered). Fix: a
  volatile `removalGen` in `DesignStore`, bumped by delete/forget/forgetAll; the backfill captures it
  before seeding and passes it as a `guardGen` to each `upsert`, which drops the seed once the
  generation moved. A removal that races the loop now wins by design. This is NOT the old watermark: it
  is volatile, not per-message, not persisted, never used for ordering - only "did a removal happen
  since I started seeding." The live pipeline passes no guard (a genuine new push always applies).

Accepted residual (documented, not fixed):
- [LOW] The at-monotonic `upsert` orders by `Message.at` (the mailbox `Date.now()` stamp). A backward
  host-clock step between two pushes of the same filename could stamp the newer one with a smaller
  `at` and strand the stale revision until the next push. This is the app's EXISTING ordering model
  (the thread itself is `sortedBy { it.at }`), not something this change introduces; a real fix is a
  monotonic clamp in the mailbox, tracked with the mailbox work below.

Deferred (a PRE-EXISTING mailbox-layer property, NOT introduced here, out of scope - the plan does not
touch mailbox/forget semantics):
- forget/wipe racing an UNCOMMITTED poll batch (the app killed between a message's render and
  `mailboxSync.commit`) re-polls the stale cursor on restart; `appendInbound` misses (the thread is
  gone) and re-appends, resurrecting the THREAD and any Designer card riding it. This is a whole-app
  property of `repo.forget` vs the drain commit, identical before this work (the old reactive scan
  resurrected the same way). A real fix advances the cursor on forget or serializes forget against the
  drain - a mailbox-layer change, tracked separately.
- No per-batch drain cap: one large drain fans out to the handler per message. The per-message and
  per-file read caps are the stated bound; a non-card message returns without any read, so the marginal
  cost rides alongside the drain's existing per-message work.

## Lap-3 framework-first review (6 dimensions)

Two dimensions came back solid (the forget/wipe lifecycle registries are legitimately distinct, not
duplication; the `InboundSubscriber` -> `Plugins` bridge is owned by the right layer). The rest:

Applied:
- The `DesignStore` docstring claimed to be "the plugin framework's per-plugin device storage" and
  claimed "no generation counter" (both now false - it is the Designer's OWN store, and `removalGen`
  exists). Reworded to be honest, and to MARK the backfill + removal-guard as a general
  inbound-consumer pattern that is a candidate to lift into the framework once a SECOND
  inbound-consuming plugin needs its own removable per-team store.

Declined (with reason):
- Rewriting `DesignStore`'s per-team `MutableStateFlow` map + lock into one aggregate
  `MutableStateFlow<Map<..>>` (the Repo idiom). The cited "double-create race" does not exist - the
  `getOrPut` runs under the lock, which prevents it - so this is a style-consistency change, not a bug
  fix, and folding it in would split the `removalGen` guard's atomicity (map + gen must move together,
  which the single lock gives for free) across two independent atomics. Not worth destabilizing code
  hardened through five audit rounds for idiom.

Backlog (do NOT build speculatively - one consumer today):
- A generic `PluginStore` (own-prefs-file + lazy per-key `StateFlow` under one lock + forget/forgetAll)
  and a generic one-shot-backfill-with-removal-guard helper: extract from `DesignStore` the day a
  second inbound-consuming plugin needs its own removable per-team store, not before. Leave each
  plugin's merge policy (Designer's at-monotonic-by-filename) out of the generic core.
- `InboundMessage` currently drops a peer row's real `from`/`to`. Designer filters `isPeer` so it never
  notices; a future consumer that audits agent-to-agent traffic would add nullable `from`/`to` to
  `InboundMessage`, populated from the already-computed `msg.from`/`msg.to` in the bridge (additive).
- Cosmetic: `DesignStore`/`DesignStoreTest` break the package's `Designer*` naming; rename to
  `DesignerStore` when convenient.

## Phasing

- Phase -1a: the core `InboundSubscriber` sink + per-message dispatch at the `appendInbound`-true
  gate; the `inboundMessages` plugin extension point + `applicationContext` on `PluginHost`; the
  process-singleton bridge wiring (added once). (Notifications/TTS/`onInbound` untouched.)
- Phase -1b: `DesignStore` -> init-once singleton with per-team `StateFlow`s under one lock; the
  Designer `inboundMessages` handler (context-free, file-capped, guarded); the lazy per-team
  dock backfill; the reactive dock read. DELETE the watermark machine
  (`scanForCards`/`ingest`/`mergeDesigns`/`wm*`/`gen`/CAS/`CardRead.Retry`-hold).
- Then resume the original Designer plan (management actions already built ride the collapsed store).

## Audit findings (plan-refinement lap 1; 19 real, 5 blockers, ranked)

Adversarial design audit BEFORE any code. Surviving concerns, most significant first:

1. [BLOCKER] Registration timing is a REAL gap, not a race: `SwitchboardService.onCreate` starts the
   poll loop with ZERO plugin awareness; `PluginManager.boot()` (which would register the subscriber)
   runs ONLY from `MainActivity` Compose (`Plugins.get`). A headless service (START_STICKY / BootReceiver)
   drains + commits messages before any Activity opens -> permanently missed, never re-delivered.
2. [BLOCKER] A hung/slow plugin subscriber wedges ALL delivery: the poll loop is the single drain path
   for every team + notifications + TTS; a synchronous `onMessage` guarded only by `runCatching`
   (catches a throw, not a hang/slow-IO) can stall commit and every other team in the same batch. The
   batch is UNBOUNDED (mixed-team, up to the mailbox's 10k cap), so even a merely-slow subscriber hurts.
3. [BLOCKER] Backfill is MANDATORY (not optional) because of #1, and a re-scan backfill re-opens the
   exact ordering/epoch/delete-safety problem the refactor exists to kill, and races a concurrent forget.
4. [BLOCKER] Split-brain store: `DesignStore` is constructed fresh per call site (no singleton). An
   in-memory `StateFlow` per instance means the service's writes and the dock's reads never share state
   (service writes prefs, the dock's own instance never sees it). Forget/wipe has the same split.
5. [BLOCKER] Notifications/TTS can't cleanly migrate onto per-message dispatch: `onInbound` is a
   per-team, per-poll-cycle BURST callback (one coalesced notification per cycle), and one of its call
   sites is ASYNC + post-commit (the STTS-preload `scope.launch`). Per-message sync dispatch can't
   reproduce burst coalescing and contradicts the async branch. They are ONE intertwined closure.
6. [major] The handler gets `Context` -> a plugin can reach `Repo.get(context)` and call ChatRepository
   mutating methods reentrantly from inside the sole drain coroutine.
7. [major] Reusing the internal `Message` (public `epoch`/`seq` fields) as the payload does NOT
   type-enforce the "subscribers never see an ordinal" invariant.
8. [major] A transient read miss in the handler (the case `CardRead.Retry` exists for today) is now a
   permanent silent loss - the pipeline never re-delivers. (Window is much smaller than today, since
   the read is co-located with the just-completed `Attachments.decode` write, but non-zero.)
9. [minor] The plan never says the per-team `StateFlow` must hydrate from prefs on construction (the
   property restart-correctness depends on).

## Painpoints (crust sweep; landmines for future work, NOT fixed here)

A 5-agent scout, seeded with this session's leads, located the following. Most are PRE-EXISTING and
out of scope; the two marked IN-SCOPE are imprecisions in this session's own code and are addressed
at wrap-up.

Mailbox ordering / identity (pre-existing, whole-app):
- `src/shared/device-mailbox.ts : mintEpoch / DeviceMailbox.epoch` - epoch is a random per-instance
  nonce, valid for EQUALITY only; any future code that orders/compares epochs by magnitude breaks. The
  invariant is documented, not type-enforced.
- `src/shared/device-mailbox.ts : DeviceMailbox.append` - `at = Date.now()` with no monotonic clamp
  (unlike `seq`). A backward host clock or multi-Gateway skew inverts any `at`-ordering downstream.
- `android/.../ChatRepository.kt : loadPersistedThreads` - cold-start sorts `by at` and reassigns dense
  ids; the live append path never sorts, so a skewed row renders in one position live and another after
  a restart.
- `src/shared/device-mailbox.ts : DeviceMailbox.drain (epochOk fallback)` - an omitted (optional) epoch
  collapses the gate to a magnitude check; a stale sub-highWater cursor could ack away a new instance's
  entries. Shipped Android always sends a concrete epoch, so latent.
- `src/shared/sync-cursor.ts : SyncCursor.advance (epoch-flip)` - an epoch flip returns `gap:false`, so
  a long-offline evicted device gets no gap banner for the single worst-case loss (silent).

Forget / wipe vs the poll drain (pre-existing TOCTOU class):
- `android/.../ChatRepository.kt : clearAll` (from `deleteDomain`) - HIGH, and not tracked anywhere:
  `pollJob?.cancel()` without a join, then a full-state wipe. A drain tail already past `poll()` on
  another thread can write chat back into `KEY_THREADS` AFTER the wipe, so chat content can survive a
  "Revoke and Delete Domain" factory wipe (in-memory now, and from prefs on next start). Privacy-
  relevant; a real fix needs `cancelAndJoin()` (or a wipe-generation guard) before clearing.
- `android/.../ChatRepository.kt : forget vs startPolling drain (before mailboxSync.commit)` - the
  already-deferred forget-vs-uncommitted-batch thread resurrection.
- `android/.../SttsPlayer.kt : purge vs preloadBoth` - a preload for a just-committed message can
  recreate `stts/<team>/` after `purge` deletes it, leaving cached audio for a forgotten thread.

Plugin framework (pre-existing / latent):
- `android/.../plugins/SourceContext.kt : CORE_SOURCE` - a plugin whose `content_id` is literally
  "core" would tag its claims as core and, on disable, retract-sweep genuine core claims. No guard.
- `android/.../plugins/PluginCatalog.kt : PluginCatalog (class doc)` - claims catalog order is boot
  order, but `PluginManager.boot` is a fixpoint (order-independent). Stale comment.
- `android/.../plugins/PluginRegistry.kt : keys` and `SourceContext.kt : inContext` - dead code (no
  callers, not even tests).
- `android/.../MainActivity.kt : App (onForget)` - the forget-handler-sweep + `repo.forget` two-liner
  is hand-copied at two callsites; a shared helper would stop it drifting.

In-scope (this session's code):
- FIXED `android/.../plugins/designer/DesignStore.kt : removalGen` - was a single PROCESS-GLOBAL
  counter, so a delete/forget in ANY conversation aborted an unrelated conversation's in-flight
  first-open backfill. Now per-team: `wipeGen` (global, `forgetAll` only) + `teamGen[team]` (that
  team's delete/forget), summed. A cross-team removal no longer aborts a backfill (pinned by a test).
- FIXED `android/.../plugins/PluginEntry.kt : InboundMessageHandler (doc)` - the doc claimed handing
  `filesDir` not `Context` PREVENTS reentrant repo calls; a plugin can capture `host.applicationContext`
  anyway. Reworded: it DISCOURAGES reentrancy (a first-party convention), it is not a hard boundary.
- `android/.../plugins/PluginManager.kt : setEnabled` x `DesignerPlugin threadForgetHandlers` - LOW:
  forgetting a thread while the Designer is DISABLED never calls its forget handler (the claim was
  retract-swept), orphaning that team's index; a later reused deterministic address could show stale
  cards. Symmetric with the accepted "disabled plugin does not ingest" cost; a full fix needs the
  framework to run data-lifecycle handlers for disabled plugins too.
