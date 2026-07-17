# Plugin pipeline hardening (bug-fix backlog, no vision needed)

Fixes for residuals the 2026-07-11 crust sweep found while shipping the plugin inbound-message
pipeline + Designer additive store (git ffa32c4). Each fix direction is already clear from the sweep's
evidence; this is a fix-tracking plan, not a design one - no questionaire, straight to an
implementation cycle whenever picked up. Full context: git ffa32c4, CLAUDE.md "Android plugin
framework".

Graduated out of `plans/pain-points.md` (removed there to avoid a split source of truth) - anything
NOT in this plan stays a pain-points record.

## Phase A - `forget` vs uncommitted-drain race (privacy-relevant)

**Narrowed 2026-07-16: the `clearAll` half of this phase is already fixed** (out of band, not by this
plan) - `ChatRepository.clearAll` now does `pollJob?.cancelAndJoin()` before wiping state, with a
comment explaining the join is load-bearing (the poll loop's non-suspend tail, ending in
`DebugLog.flushToIngest()`'s blocking POST, is not always brief). Verified directly against the
current file; the race this phase originally flagged there no longer exists. The `forget` half below
remains open.

`ChatRepository.forget` mutates top-level state (a thread forget) with no join/coordination against
the poll drain's in-flight, not-yet-committed batch: a drain iteration already past `client().poll()`
on `Dispatchers.IO` can finish its synchronous append + persist tail AFTER `forget` ran, re-`append`ing
the just-forgotten thread (and any Designer card riding it) via a redelivered entry.

`plans/plugin-actions.md` (deleted, shipped) added a third branch inside this same drain loop: a
`kind == "plugin_action"` entry (e.g. the Designer's delete-card) dispatches synchronously before the
cursor commits, same as the body-append branch above. It is subject to the identical hazard - a drain
iteration already past `client().poll()` can still dispatch a plugin action against state a concurrent
`forget` intended to have already torn down. The fix direction below should cover this branch too.

Fix direction: `forget` needs either `cancelAndJoin()` (matching `clearAll`'s now-shipped fix, if
briefly pausing the poll loop on every forget is acceptable) or a lighter per-team generation guard so
a stale in-flight append is dropped instead of applied. Decide the exact mechanism during
implementation (a shared "drain generation" the mutator bumps and the drain tail checks before its
final write covers both `forget` and the `plugin_action` branch with one primitive).

## Phase B - mailbox `at` is not monotonic

`src/shared/device-mailbox.ts : append` stamps `at = Date.now()` with no floor against the previous
entry (unlike `seq`, which is a guaranteed `++`). A backward host clock or multi-Gateway clock skew
lets a later entry carry an earlier `at`, which every `at`-orderer then inverts:
- `ChatRepository.loadPersistedThreads` sorts `by at` on cold start while the live append path never
  sorts, so a thread's message order can differ before and after a restart.
- `DesignStore.upsertInto`'s at-monotonic guard (added this session to stop a slow-backfill clobber)
  silently DROPS a genuinely-newer card whose `at` lost to clock skew - the gallery sticks on the stale
  revision with no error.

Fix direction: clamp `at` to be monotonically non-decreasing per `DeviceMailbox` instance in `append`
(`at = Math.max(Date.now(), this.lastAt + 1); this.lastAt = at`), so every downstream `at`-orderer
inherits the guarantee for free. Cross-platform: touches the synced mailbox core, so re-check the
Android `SyncCursor.kt` twin and its cross-platform vectors after the change.

## Phase C - plugin framework crust (small, independent fixes)

- **`SourceContext.CORE_SOURCE`** ("core") has no reservation guard: a plugin whose `content_id` is
  literally `"core"` (passes the slug regex) would tag its claims as core, and disabling it would
  retract-sweep genuine core claims project-wide. Add a manifest-parse rejection for the reserved id.
- **Dead code**: `PluginRegistry.keys` and `SourceContext.inContext` have no callers anywhere (not even
  tests). Delete both, or wire up the consumer that was meant to use them.
- **Stale doc**: `PluginCatalog`'s class doc claims catalog order is boot order; `PluginManager.boot`
  is actually an order-independent fixpoint (pinned by `aDependentListedBeforeItsDepStillBoots`). Fix
  the comment to state the fixpoint, not an ordering requirement.
- **Disabled-plugin-forget gap**: forgetting a thread while a plugin is disabled never runs that
  plugin's `threadForgetHandlers` claim (it was retract-swept), orphaning its per-team state. A
  reused deterministic address (e.g. a peer's stable `ownerKeyId`-keyed thread) could later resurrect
  stale plugin data on re-enable. Needs the framework to run data-lifecycle handlers (forget/wipe) even
  for a currently-disabled plugin, which is a small change to `PluginManager`/`PluginHost` - decide
  during implementation whether that means keeping a disabled plugin's lifecycle claims un-swept while
  sweeping its UI/data-ingest claims, or a separate always-on lifecycle registry.
- **Dup-logic**: `MainActivity.App`'s two `onForget` callsites hand-copy the
  `threadForgetHandlers.forEach { ... }` + `repo.forget(team)` sequence. Extract one shared helper.

## Notes

- Phase A and B are both mailbox-core changes (`ChatRepository.kt` / `device-mailbox.ts`), not
  Designer-specific, even though the crust sweep found them while auditing Designer's new dependency on
  drain ordering. Fix them at that layer so every consumer (not just Designer) benefits.
- Phase C is purely additive/local to the plugin framework; safe to pick off independently and in any
  order.
- No user-facing UX decisions in this plan - straight to `audited-implementation` cycles per phase
  when picked up.
