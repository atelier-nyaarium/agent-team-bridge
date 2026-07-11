# Designer announce chip (chip-decoration framework seam)

The Item-15 "in-chat announce chip": a design push should read as a visible moment in the chat
timeline, not just a silent dock update. Today a pushed card renders as a generic attachment chip
(same as any file); the dock updates silently below.

## Questionaire

**1. Custom chip via a plugin seam, or core special-casing?** Framework seam. User: "We love
framework first. Much like nyaadot, if that code base is in your context, pretty much everything is
extensible. Feasibility check it." Feasibility check confirmed the seam mirrors `attachmentOpeners`
one-for-one (see Design below).

**2. v1 scope: title + badge chip, or full chip with mini thumbnail?** A - no in-chip thumbnail.
Recommended and chosen because the thumbnail is the one piece that is async-computed, and the
renderer's row fingerprint hides anything computed after first render; the dock peek strip below
the chat already shows the rendered thumbnail. The decoration seam stays shaped so a thumbnail ref
can ride later without rework (B remains available as a follow-up).

**3. New/updated badge?** Dropped entirely. User: "don't worry about new/updated. Not that
critical. Especially if we are scrolling through history. We can tell." The decoration is the card
title + Designer styling only, which removes the one open semantics question (nothing per-push is
recorded anywhere, and nothing needs to be).

## Plan

### Design

**The seam (data-only, no code injection).** A new `PluginRegistry<AttachmentChipDecorator>` on
`PluginHost` (`attachmentChipDecorators`, keyed `<plugin>:<decorator>`). A claimed decorator is
given `(team, MessageFile)` and returns a small decoration value (or null to leave the chip alone):
title and an accent/kind hint. Pure data - no plugin HTML or JS ever enters the WebView, so the
thread renderer's security model (appassets-only interception, no CSP surprises) is untouched.

**Wiring path** (each hop already exists for a sibling feature):
- MainActivity wires per-renderer callbacks onto `ThreadRendererPool` today (`onAttachmentTap` is
  how `attachmentOpeners` is consulted); add a `decorateFile` callback at the same place that walks
  the claimed decorators (first non-null wins, matching `attachmentOpeners`' first-claim-wins).
- `ThreadRenderer.toJson()` serializes each file as `{name, mime, src}`; add an additive
  `decoration` key when the callback returns one. The payload shape is private to the renderer and
  `thread.js` is its sole consumer, so the change is additive-safe.
- `thread.js`'s `buildFiles()` renders every non-image file as a generic `span.chip`; add one
  branch: when `f.decoration` exists, render the decorated chip (title, badge, accent) instead.
  Tap-to-open is unchanged (`openAttachment(f.src)` -> the existing bridge; no new
  `@JavascriptInterface`, so no new R8 keep-rule exposure).

**Designer's decorator.** A pure synchronous, in-memory lookup - with a load-bearing matching
rule: **match by `rel`** (`relOf(f.src)`) against `StoredCard.rel`, never by fileName.
`DesignStore` keeps only the LATEST revision per fileName, so a fileName-keyed lookup would
BORROW the current card's title for an older historical chip of a re-pushed file - a wrong title,
not just a stale one. A rel-keyed match makes every edge case fail-safe for free: an older-rel
historical chip, a deleted card's chip, and a non-card HTML attachment all miss the store and fall
back to the plain chip. `DesignStore` needs a small new disk-free lookup surface for this (e.g.
`cardForRel(team, rel)` over the already-hydrated per-team list) - NOT a copy of
`DesignerCardOpener`'s read-the-prefix-off-disk pattern: `decorateFile` runs inside `toJson()` on
the main thread (driven by `LaunchedEffect(renderer, messages)`), once per file per sync pass, so
it must never touch disk. Titles are already parsed at ingest (`htmlTitle` -> `StoredCard`), so
the store has everything the chip needs. No new/updated badge (questionaire Q3) - nothing
per-push needs recording, and the decoration for a given rel never changes once present.

**Known constraint (why v1 is synchronous-only).** `ThreadRenderer.fingerprint()` hashes only
text/status/file-count/sender; a row re-renders only when its fingerprint changes (and `sync()` is
only re-invoked when the `messages` list changes - a store update alone re-triggers nothing). Any
decoration computed after first render is invisible for the life of that pooled renderer instance.
This is safe for the LIVE path: ingest runs synchronously on the drain thread before the message
can render, so the title is always in the store by serialization time. It is NOT safe for the
one-shot per-team dock BACKFILL (pre-plugin cards seeded lazily, on IO, when the dock first
composes): those chips can first render plain and will not upgrade until the renderer instance is
recreated (app restart / pool eviction). **Accepted v1 limitation** - it affects each team at most
once ever, is purely cosmetic (tap still opens the card), and fixing it requires exactly the
async-refresh plumbing scope B deferred; shape the decoration value so that plumbing can be added
later without breaking the sync contract.

**Renderer pooling caveat - staleness runs in BOTH directions, all accepted for v1.** Pool
renderers survive navigation and only re-render a row when its fingerprint changes, so a chip
keeps whatever decoration state it was first serialized with, for the life of that renderer
instance (until app restart, tab close/reopen, or crash recovery). Beyond the backfill case above
(plain-should-be-decorated), the mirror cases are also real: disabling the plugin mid-session
leaves already-rendered chips DECORATED (the registry claim is swept, but no re-sync fires and the
fingerprint is unchanged); re-enabling repeats the backfill-shaped gap; and a card deleted from
the dock (including via `designer_delete_card`) keeps its already-rendered chip's title, while
freshly-serialized rows correctly fall back to plain. All purely cosmetic - the tap path is
independent of decoration - and all fixable only by the async re-sync plumbing scope B deferred,
so they are documented rather than built around. Exception containment is NOT optional though:
the decorator consultation wraps each decorator in `runCatching` (the `Plugins.kt` bridge
pattern), because this seam runs on every sync of every open thread - a throwing decorator must
cost only its own decoration, never the transcript render.

**Web side is hand-maintained plain JS** (`assets/thread/` - no build step, no typecheck). Keep the
`buildFiles` branch small and defensive (missing/malformed decoration falls back to the plain chip).
Two hard rules for that branch: decoration-derived text (the title) is agent-authored content and
must enter the DOM via `textContent` (or equivalent property assignment), never
`innerHTML`/`insertAdjacentHTML` - mirroring how `f.name` is handled in the same function. And on
the Kotlin side, decoration fields ride `JSONObject.put` like every other `toJson()` field - never
hand-concatenated - so the existing quote/backslash escaping through the `eval`-wrapped payload is
inherited automatically.

### Phasing

## Phase 1 - framework seam

The `AttachmentChipDecorator` interface + `attachmentChipDecorators` registry (`PluginEntry.kt`),
the pool-level `decorateFile` wiring (`MainActivity.kt`/`ThreadRendererPool.kt`), the additive
`decoration` key in `ThreadRenderer.toJson()`, and `thread.js`'s decorated-chip branch + CSS.
Plugin-agnostic; unit-test `toJson`'s decoration inclusion with a fake decorator, hand-test the JS.

## Phase 2 - Designer decorator

The Designer's claim: the card title via the rel-keyed match (see Design - `cardForRel` on
`DesignStore`, disk-free, main-thread-safe), Designer styling via the accent/kind hint. Unit tests
mirror `DesignerPluginActionTest`'s fake-host pattern, including the fail-safe cases (older rel,
deleted card, non-card HTML -> null). R8 gate as always.

### Notes

- No wire/gateway/MCP changes anywhere - this is entirely device-side presentation.
- After ship: retire this plan per the session convention (fold residuals into
  `pain-points.md`/`features-and-fixes.md`, mark Item 15's bullet shipped).

## Painpoints

Collected by the close-out crust sweep, scoped to the surfaces touched since the last full sweep.
Record only, nothing fixed here. The plans-reconciliation scout confirmed `pain-points.md` and
`plugin-pipeline-hardening.md` need no corrections from this plan's changes.

- [medium] `android/.../ChatRepository.kt`-adjacent - **bug-class** -
  `ThreadRenderer : playEnabled` is copied BY VALUE onto a renderer at `ThreadRendererPool.get`
  time (`it.playEnabled = playEnabled`), unlike `resolveFrom`/`selfLabel`/`decorateFile`, which are
  live-reading closures. `MainActivity` re-assigns `rendererPool.playEnabled = repo.sttsReady()`
  every recomposition, but nothing re-copies it onto already-created renderers - so STTS
  provisioning mid-session never lights the Play buttons on any thread already open. Functionally
  dead for the renderer's lifetime, not merely cosmetically stale; pre-existing, surfaced while
  enumerating the fingerprint-staleness class. Fix direction: make it a live closure like its
  siblings (and note `fingerprint()` would also need to reflect it for already-rendered rows).
- [medium] `android/.../plugins/designer/DesignerThumbs.kt : renderOn` - **bug-class** - a render
  that times out never calls `stopLoading()` and registers no `invokeOnCancellation`, so a
  straggling `onPageFinished` from the abandoned load can fire against the NEXT render's freshly
  assigned client and resolve its visual-state gate early - `draw()` then captures a stale/partial
  frame and caches it permanently under the new card's rel (a cache hit never retries). Narrow
  window (needs a 4s-blowing card immediately followed by another render), but silent and sticky.
  Fix direction: a per-render generation check in the client callbacks, plus `stopLoading()` on
  cancel.
- [medium] `android/.../plugins/designer/DesignerThumbs.kt : cache` - **bug-class,
  privacy-relevant** - the 6MB bitmap LruCache is keyed by rel and never evicted on thread forget
  or account wipe; `designer:forget`/`designer:wipe` clear `DesignStore` but not this cache, so a
  forgotten conversation's rendered thumbnails stay decoded in process memory until LRU pressure
  or process death. Never re-surfaces in the UI (lookups only happen for rels still in the store),
  but inconsistent with the lifecycle-handler contract the store itself honors. Fix direction:
  evict by team at the forget/wipe handlers (needs a team-aware key or a per-team index over the
  cache).
- [medium] `android/.../plugins/Plugins.kt : build (inboundMessages bridge)` - **dup-logic** -
  still hand-rolls the loop + `runCatching` + log idiom `PluginRegistry.forEachCaught` now owns;
  migrating also upgrades the log line from the generic "inbound handler threw" to the registry's
  claim-identifying message. The `pluginActions` bridge stays as-is (single-key `get()` dispatch
  has no matching registry primitive; not worth minting one for one call site).
- [low] `android/.../plugins/designer/DesignerThumbs.kt : attach/detach` - **dormant fragility** -
  the single-`var` WebView pool assumes exactly one `DesignerThumbHost` is ever composed, which
  holds today (one `ThreadScreen` call site, plain conditional, no crossfade). A future dual-pane
  layout or animated tab transition would silently break it: the losing host's thumbnails just
  never load (the `===` detach guard prevents corruption). Worth an assertion or log if a second
  attach ever lands.
