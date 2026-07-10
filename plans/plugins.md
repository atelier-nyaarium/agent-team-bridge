# App-side plugins

A plugins layer for the Android app: baked-in, per-plugin toggleable capabilities. Extracted out of
`features-and-fixes.md` (was Item 14); this file is now the sole source of truth for the feature.
Hard requirement discharged: plugin model based on nyaadot's source-package schema, read from the local
working copy at `~/projects/nyaadot` (docs `Framework Packages.md` + `Framework Mods.md` are its API truth).
Reference plugin: the Designer parity build (`plans/designer.md`, greenlit 2026-06-26). It plays the role
nyaadot's `factory/` exemplar game plays for that framework: the first real consumer that proves the layer.

## Grounding carried over from Item 14

- The app already has a settings surface (`MainActivity.kt:App`, the TTS settings composable) and a
  persistence layer (`AppStateStore.kt` over EncryptedSharedPreferences, lowercase-underscore `KEY_*`
  convention) - a per-plugin enabled flag fits the existing `var x: Boolean` property pattern there.
- The thread renderer is already an extensible WebView (`assets/thread/thread.js` + `thread.html`, vendoring
  markdown-it) with a `@JavascriptInterface` bridge - the likely host for render-side plugin behavior.
- Open questions from Item 14 still live: which baked-in plugins ship first; whether toggle state stays
  device-local or syncs server-side; sandboxing/trust if a plugin touches message content or the bridge;
  whether the eventual dynamic-install path reuses the same schema.

## nyaadot model (the reference)

(Originally a "100% verbatim" hard requirement; the user relaxed it mid-questionaire: "I know I said
100% reference Nyaadot, but that IS a game engine rather than phone app. So now I want you to push
back and say which pieces you want to think and which you toss." The keep/toss pass below is that
pushback; the summary in this section stays as the inventory it judged.)

- **Package** = folder with `manifest.json5`. Manifest schema: `author` (optional), `content_id` (required),
  `version`, `display_name`, `description`, `content_namespace` (optional), `requires: [{content_id}]`,
  `entry_point` (optional). Composite id `<author>.<content_id>`.
- **Lifecycle**: INSTALLED -> ENABLED -> LOADED, with MANUAL/AUTO marks and cascade-disable of auto-only
  deps. Host packages auto-load; non-host packages sit INSTALLED until the user enables them.
- **Ownership** (owned vs vendored) is purely path-based, gates editability only, orthogonal to host.
- **Contributions are registrations, not manifest entries**: the manifest declares identity + deps +
  entry_point only. Content and behavior land via registration calls into framework registries, auto-tagged
  by `SourceContext`, torn down by a single retract sweep (`SourceLifecycleBus.emit_retract`) so a disabled
  package cannot leak registrations. ShadowIndex gives last-wins + resurface-on-release override semantics.
- **Deps**: toposort (`SourceResolver`), id-only (no semver matching), namespace-collision refusal. No
  formal optional deps; soft integration is a use-site concern.

## nyaadot keep / toss (the pushback pass)

What survives contact with "this is a phone chat app, not a game engine". Three buckets.

### Keep (the actual crown jewels)

- **Manifest identity schema**: `author` / `content_id` / `version` / `display_name` / `description` /
  `requires`. It is the interop contract that makes the folder-per-plugin repo mimicry real, and it
  costs nothing. Composite id `<author>.<content_id>` kept too (future-proofs third-party for free).
- **SourceContext auto-tagging + provenance + the single retract sweep.** THE piece. Every
  registration a plugin makes is tagged with its id without the plugin saying so, and toggle-off is
  one bus sweep that cannot leak a registration. This is what makes "disable" trustworthy, and it is
  runtime-agnostic - nothing game-specific about it.
- **Lifecycle NAMES** (INSTALLED / ENABLED / LOADED), collapsed to one enabled flag for v1. Baked-in =
  INSTALLED-by-shipping. Keeping the vocabulary means the later dynamic-install path extends states
  instead of renaming them.
- **Dual-support disable semantics**: disable retracts presentation, never data. The card index and
  design files survive a toggle-off and come back on re-enable. (Kept as the ONE fixed behavior - see
  DeactivationPolicy in the toss list.)
- **Registry-key namespacing convention** `<plugin>:<key>` (e.g. attachment kind `designer:card`) as a
  collision guard - the useful residue of `content_namespace` without the content pipeline.

### Transform (keep the concept, replace the mechanism)

- **`entry_point` script -> a Kotlin interface.** A phone app must not load code at runtime (no DEX
  loading; Play + security posture). The concept - ONE entry hook per plugin that runs inside
  `SourceContext.push(id)` - survives as a compiled `PluginEntry.register(ctx)` class per plugin. The
  manifest field stays reserved-unused so a later runtime for it does not need a schema change.
- **Filesystem discovery scan -> a compile-time registry.** APK assets are not a scan root, and every
  baked plugin's Kotlin must be compiled in anyway. Discovery = a static list of (manifest folder,
  entry class), with a unit test asserting the list and the `assets/plugins/*/manifest.json5` folders
  agree - the scan's "manifest marks the package" invariant enforced at build time instead of runtime.
  Real scanning returns if/when dynamic install arrives.
- **SourceResolver toposort + MANUAL/AUTO marks + cascade disable -> a boot-order list + an assert.**
  With baked-in plugins, load order is the compile-time list and `requires` is validated as an assert
  (refuse to enable X while its dep is off, with a plain message). Building apt's mark system for one
  plugin is machinery without a consumer; the manifest field keeps the door open.

### Toss (game-engine problems we do not have)

- **SourceHandshake** (multiplayer content-set verification): no shared simulation to keep consistent.
  The nearest real concern - agent-side design-sync vs app renderer version skew - is ordinary wire
  schema versioning, which switchboard already does with zod + codegen.
- **SourceSave** (mod manifest in save files): no save files.
- **DeactivationPolicy** (REPLACE / FALLBACK / DELETE / INERT per asset): that vocabulary exists
  because a disabled mod leaves entities stranded in a world. A chat app's disable story is uniform
  (dual-support, above); one behavior, no policy enum.
- **ShadowIndex** (last-wins override + resurface-on-release): mods intentionally overriding core
  content is the point of a modding ecosystem and poison in a first-party phone app - a key collision
  here is a BUG and should refuse loudly, not silently shadow. Revisit only if third-party ever ships.
- **PatchRegistry** (Harmony-style prefix/intercept/replace over invokables): monkey-patching power
  tool for mod ecosystems; enormous trust surface, zero v1 consumers. If a plugin needs to alter core
  behavior, that is a NAMED extension point to design, not a patch chain.
- **Ownership classification** (owned vs vendored): exists to gate CMS editability. No in-app plugin
  authoring exists; everything baked is effectively vendored. A non-concept here.
- **Packed `.pck` vs loose distribution**: the APK is the pack.
- **Content pipeline** (`content_namespace`, ContentScanner-style content ids, data dirs): the
  Designer's "content" is runtime per-conversation data (cards pushed over the channel), not authored
  content shipped in the package. No cross-plugin content graph to namespace. (The id CONVENTION
  survives as registry-key namespacing, above.)
- **CMS / Sources authoring surface + scan-path extension (Workshop)**: authoring workbench and mod
  marketplace concerns; nothing to author on-device, dynamic install is explicitly later.

## Designer as the reference plugin

From `plans/designer.md`'s parity-build sketch, the Designer plugin's contributions:

- **App**: a sandboxed-iframe design-card type in the thread renderer (`assets/thread/`), static
  HTML+CSS+SVG only (scripts disabled); full-screen viewer via the `AttachmentViewer` pattern; a
  per-conversation card index (the `_ds_manifest.json` equivalent).
- **Agent (MCP)**: the `switchboard-design-sync` tool (DesignSync parity: finalize_plan / write_files /
  register_assets against the conversation instead of claude.ai).
- **Transport**: rides the existing `ChannelFile` attachment path; no new network surface.

## Questionaire

**Standing framing (user, up front):** v1 ships everything in ONE APK - each plugin baked in, optionally
toggleable on. "Very gross simplification to mimic a plugin's repo. Designer as the shining 1st party."
So each plugin lives as a folder shaped like what its standalone repo WOULD contain (manifest.json5 at
root), and a later extraction to a real installable is a folder move, not a redesign.

**1. Runtime footprint - what does one plugin span?**

- C) App-only now, but shape the manifest + registries so a cross-runtime split (app / MCP / gateway
  contributions under one id) lands later without a schema break. The `switchboard-design-sync` MCP tool
  ships as ordinary core MCP code for now. ("Let's start with C so we have less to fight. and it's easy
  to split later.")

**2. First-wave plugin set - Designer alone, or Designer plus one retrofit?**

- A) Designer only. Mermaid stays core, NOT retrofitted as a plugin: "The tool description already
  declared mermaid support. would be weird to turn off." (The channel_reply tool description promises
  markdown + mermaid rendering, so making it toggleable would break that contract.)

**UX ruling (user, volunteered with Q2):** the Designer surfaces as a FIXED BAR at the bottom; tapping
it opens the latest designer files. This supersedes `plans/designer.md` open decision 1 (inline thread
cards vs tab/gallery): the gallery-behind-a-bar is the primary surface, not inline cards.

**3. Scope of the bar + gallery - per-conversation or global?**

- A) Per-conversation. The dock sits at the bottom of a chat thread (shown when that conversation has
  design cards); tap opens THAT conversation's gallery, backed by its own per-conversation card index.
  Matches the transport (cards arrive on a conversation's channel) and the mental model (a design pass
  lives in a session). The dock is EXPANDABLE: expanding lists each canvas/view the design pass offers;
  tapping one opens that single view. A global "all design work" gallery is a cheap later add on top.

**Design-pass deliverable (user):** mock this in Claude Designer (dogfood - "so we have references of
what designer Output even look like"). THREE views:
1. A chat thread showing a message ("Here's the thingy") with the Designer dock docked below it.
2. The dock EXPANDED into the list of canvases/views.
3. A single view opened full-screen.

### Design pass (Claude Designer)

Project `switchboard-designer-dock` (`734b6780-2276-4859-ab51-ed47c01af379`),
`https://claude.ai/design/p/734b6780-2276-4859-ab51-ed47c01af379`, group "Designer dock". Three cards
shipped 2026-07-10.

- **Palette is authoritative, not invented**: pulled from the app's real chat renderer
  (`assets/thread/thread.css` `html.dark`) - GitHub-Primer dark (`--bg #0d1117`, `--fg #f0f6fc`,
  `--border #3d444d`, monospace `from` labels, full-width rows with a left-edge tint for user
  authorship, top-right Speak button on agent rows). The chat surface in the mockups matches the
  shipping `ThreadScreen` (`MainActivity.kt:1569`): TopAppBar = back + monospace label + presence chip
  + terminal/overflow actions; composer = OutlinedTextField + attach-over-send right column.
- **Designer gets its OWN accent** (`#bc8cff` Primer purple) so the dock reads as a distinct plugin
  surface, not core chat chrome.
- **The dock sits between the message list and the composer** (a fixed bar), collapsed by default,
  with a grab handle, a thumbnail peek strip, and a count ("3 canvases").
- **Expanded = a bottom sheet** (~75% height) over a dimmed chat, listing each canvas as a row
  (thumbnail + name + updated time + `WxH` dim chip). Selected row highlighted.
- **Full-screen view = the AttachmentViewer pattern**: viewer top bar (close + canvas name + "2 of 3"
  + export), the design centered on a dotted canvas backdrop, prev/next nav affordances, a pager
  (dots) + caption. The design under review is faked as a real recipe-editor form so the frame reads
  as a live preview.
- Note back into `plans/designer.md`: this supersedes its open decision 1 (inline cards vs gallery) -
  the dock+gallery is the surface. Its static-only-iframe security model (decision in designer.md,
  scripts disabled) still holds; the full-screen view is a sandboxed static render.

**4. The in-message announce chip ("3 canvases ready")?**

- Nice-to-have only: "Not sure if you can pull off the button in chat convo. if easy, go for it. If
  not, just prose See the thingy." Build it only if it falls out cheaply from the thread renderer's
  existing custom-element path; the prose-plus-dock fallback is fully acceptable.

**5. nyaadot verbatim requirement relaxed (user):** "It's an excellent reference, with it's modular
ability. But there may be parts you DONT want." -> the keep/toss pass near the top of this file is
the standing ruling on which pieces survive; awaiting the user's reaction to the specific calls.

## Phase 3 questionaire - presentation, referencing, management

Opened after live-testing phase 1+2 in production (real `channel_reply` attachments, not mockups):
confirmed working, THEN the user raised "how are they keyed... now we need to talk about and
refine how it's presented, how I reference and get back to you, and manage them."

**Keying, as shipped (confirmed, not a question):** a card's identity is its attachment FILENAME.
Same filename on a later message updates in place; a new filename accumulates forever - no cap,
no eviction (the index derives from the thread's full, unpruned message history). Re-attaching the
3 approved mockups plus the smoke-test card left 4 permanent entries in the test thread.

**6. Should a canvas be addressable by name, not just by tapping?**

- A) Keep filename-as-identity, title-as-display (current model, UNCHANGED). Reference by prose
  description; the agent picks the filename. ("For reference A.")

**Volunteered alongside the answer (user):**

- **Attachment-chip shortcut-open.** When a card-marked `.html` attachment's chip appears inline
  in a message (the ordinary chip every attachment gets), tapping it should shortcut straight to
  the Designer full-screen viewer for that card, instead of today's generic `AttachmentViewer`
  fallback (HTML matches neither `image/`  nor `video/`, so it currently falls to
  `FileInfoDialog` - a bare metadata dialog, not the rendered card).
- **Management surface: a context menu on each canvas-list row, AND an action bar in the
  full-screen viewer** (same action set, two entry points). Actions, user's exact list:
  - **Reference in chat** - macro-insert the card's **Title**, bolded, into the chat draft/composer.
  - **Reattach to chat** - re-send the card as a fresh attachment message ("in case you forget or I
    like an old version better").
  - **Download** - save to the device's Downloads (reuse the existing `saveToDownloads` MediaStore
    helper already in `AttachmentViewer.kt`, don't reinvent it).
  - **Delete** - removes the card from the Designer dock/list.

**7. Open ambiguity flagged back to the user (not yet answered): what do Delete and Reattach
mean against a DERIVED index?**

The card index is deliberately a VIEW over chat history, not a second stored copy (Phase 2's
build log) - and there is only ONE stored slot per filename (the latest content), no version
stack. Two consequences worth confirming before building:

- **Delete** can't remove a chat message (that would mutate the transcript / break at-least-once
  dedup). The sound shape: a lightweight per-conversation "dismissed filenames" overlay
  (small metadata, not a duplicate of the design content) that the dock's derivation filters
  against - so Delete hides the card from the dock without touching the conversation history.
  A later re-push of that same filename should probably UN-dismiss it (a deliberate new version
  arriving is not "undelete the old one").
  - Recommendation: build it this way unless the user wants delete to also purge the underlying
    attachment bytes/message (a bigger, more destructive feature).
- **Reattach**, given single-slot-per-filename storage, can only resend the CURRENT content - it
  cannot resurrect a truly OLDER version once a same-filename update has overwritten it. The
  phrase "or I like an old version better" implies the user may be picturing version history that
  does not exist yet in this design. Needs a direct answer: is single-current-version (Reattach =
  resend what's there now) sufficient, or does this phase also need a version history stack per
  canvas (each push keeps prior versions, Reattach/rollback picks among them)? The latter is a
  materially bigger feature (storage, a version list UI, a "pick a version" affordance).

**8. User floated: "maybe designer needs it's own place on the store. And this plugin allows it
to understand that place in the store. but now we cross into the switchboard MCP also needing
that level of understanding too. what do you think?"**

Assessment given (recommendation: yes to a store, but the DEVICE's store, not the gateway's;
the MCP needs NO new understanding for this phase):

- Every phase-3 ask (version history, real delete, reattach-old-version, chip shortcut) is
  satisfiable by a device-local, per-conversation, VERSIONED design store owned by the plugin,
  POPULATED by the existing attachment transport. `designerCards()` evolves from a render-time
  view into the store's ingest scanner; each same-filename push APPENDS a version instead of
  being lost to overwrite. Delete becomes a real store op (can even purge bytes); Reattach picks
  any version. An evolution of the shipped code, not a rewrite.
- A GATEWAY-side design store would cut against the architecture's grain: the gateway is
  deliberately content-blind everywhere (sealed frames, unparsed attachments), and every other
  presentation-state surface (threads, labels, drafts, unread) is device-local by design. Making
  the gateway understand one attachment type would be its first content-aware feature - the
  ownership test says designs are conversation artifacts consumed on the device.
- The MCP/agent contract stays exactly "attach @dsCard files" (fresh filename per canvas,
  same filename to update). Agent-side DesignSync-parity verbs (list/get/write against a real
  store) remain the designer.md parity build, designed IF a real cross-session/cross-device need
  arrives - and the device store's schema (stable card ids + version rows) is deliberately the
  thing a gateway store would later sync, so the split stays additive (the same "easy to split
  later" shape as Q1's answer C).
- Framework dividend: this adds the plugin framework's second real extension point - per-plugin
  device storage (e.g. a host-granted plugin-owned dir/keys), with dual-support disable semantics
  already defined (disable keeps data).
- Honest trade-off stated: device-local means the version history lives on ONE phone. Lose the
  device and the history is gone (chat transcript + the agent's own file copies survive). A
  future multi-console setup would not share the store until the gateway-sync lift happens.

**Mockups approved (user):** "Looking good so far. now use that as your reference to plan the UX
against." The three cards are the UX reference; payload snapshotted to
`temp/switchboard-designer-dock/` + `temp/switchboard-designer-dock.zip` (gitignored local artifact,
per user request - the durable copy of what Designer output looks like).

## Plan (rough - UX planned against the approved mockups; pending refinement cycles)

### UX (reference: `temp/switchboard-designer-dock/`)

- **Announce, in the message.** A design push lands as a normal agent message; the body says where to
  look in prose ("See the thingy" style). IF the thread renderer's existing custom-render path makes
  it cheap, an inline chip ("N canvases ready") whose tap expands the dock - optional per Q4, prose
  fallback fully acceptable.
- **Dock, collapsed.** A fixed bar between the message list and the composer, present ONLY when the
  open conversation's card index is non-empty. Contents: plugin glyph (accent `#bc8cff`), "Designer",
  "N canvases - updated <time>", a thumbnail peek strip, an expand chevron. Tap anywhere = expand. A
  new canvas landing while collapsed refreshes count/time/thumbnails in place.
- **Dock, expanded.** A modal bottom sheet (~75% height) over the dimmed chat; grab handle; header
  (glyph, "Designer", "N canvases in this conversation", collapse chevron); scrollable rows of
  thumbnail + name + updated time + WxH chip. Tap a row = full-screen. Back, scrim tap, or handle
  drag = collapse.
- **Canvas, full-screen.** Viewer top bar (close, canvas name, "k of N", export/share); the canvas
  centered on a dotted backdrop; swipe or edge arrows for prev/next; pager dots; pinch/tap to zoom.
  Static sandboxed render, the `AttachmentViewer` interaction pattern.

### Mechanics (rough)

- **Payload** = the same `@dsCard` self-contained HTML files claude.ai/design takes (the `temp/`
  snapshot is the reference corpus). HTML/CSS/SVG only; scripts refused (static-only v1 per
  `plans/designer.md`'s security model - sandboxed iframe, no `allow-scripts`).
- **Transport**: `ChannelFile` attachments on the conversation (existing path, no new network
  surface). A design push = the files + card registration metadata (name, viewport, group, subtitle)
  mirroring DesignSync's `register_assets`.
- **Card index**: a per-conversation persisted index (the `_ds_manifest.json` equivalent) with
  register / update-in-place / remove semantics. The dock renders FROM the index, never by scanning
  raw attachments.
- **MCP side**: the `switchboard-design-sync` tool ships as core MCP code (Q1 = C), DesignSync-parity
  verbs, target = the conversation.

### Plugin framework (v1, sized to Designer-only per Q2)

- **Manifest**: nyaadot's identity schema (`author`, `content_id`, `version`, `display_name`,
  `description`, `requires`; `entry_point` reserved-unused - the entry hook is a compiled Kotlin
  `PluginEntry` class per the keep/toss pass); folder-per-plugin baked into the APK, shaped like the
  plugin's would-be standalone repo.
- **Registries** (only what the Designer needs, extracted-upward later as consumers arrive): a dock
  slot, an attachment-kind handler (design payload -> card index), a full-screen route. Every
  registration is source-tagged; toggle-off is ONE retract sweep - the dock disappears, stored files
  and index remain for re-enable (nyaadot's dual-support semantics: disable affects presentation,
  not data).
- **Settings**: a Plugins section listing each baked-in plugin with its toggle
  (`AppStateStore`-persisted, device-local for v1).
- **Lifecycle**: keep nyaadot's INSTALLED -> ENABLED -> LOADED names, collapsed for v1 to a single
  enabled flag driving load/retract, so the later dynamic-install path reuses the same states.

### Open for refinement cycles

- Thumbnail strategy: live scaled-down iframe vs cached bitmap snapshot.
- Announce-chip feasibility check in `thread.js` (Q4's "if easy").
- Index schema + lifecycle: per-conversation cap, `forget()` sweep integration, on-device file home
  (`Attachments.kt` internal storage vs a plugin-owned dir) and TTL.
- Whether toggle state ever syncs server-side (device-local for v1).

## Build log

**Phase 1 (foundation) - built, red-teamed, committed (ad0d728).** The `plugins/` package:
manifest (`manifest.json`, which nyaadot's own discovery also accepts, so repo-mimicry holds),
`SourceContext`, `PluginRegistry` (refuse-on-collision), `PluginLifecycleBus`, `PluginRuntime`,
`PluginEntry`/`PluginHost`, compile-time `PluginCatalog` + agreement test, `PluginManager`,
`Plugins` process singleton, Settings > Plugins, `AppStateStore.plugin_enabled.` keys. A
5-dimension adversarial diff review (Sonnet fleet) confirmed and led to fixing: the broken-flag
lockout (persist only after a successful load; the OFF direction always reachable, in the manager
AND the Switch's enabled gate), enable/disable dep-gate asymmetry on composite ids, boot made a
fixpoint loop so catalog order never decides correctness, the enabled-but-not-running divergence
rendered in settings, and tests pinning each. Framework boots with the app, not on first
Settings open.

**Phase 2 (Designer plugin) - built.** `plugins/designer/` (`DesignerCards` pure core,
`DesignerDock` UI, `DesignerPlugin` entry) + `assets/plugins/designer/manifest.json` + the
catalog entry (which made the agreement test live). Deviations from the rough plan, each chosen
during the build:

- **Transport needs NO new tool or wire shape**: a design push is ordinary `channel_reply`
  `attachments` - a self-contained `.html` whose FIRST line is the `@dsCard` comment marker. The
  marker IS the registration (exactly claude.ai/design's self-check model); optional marker attrs
  `width`/`height` carry the viewport, `<title>` names the card. The `channel_reply` attachments
  describe documents the convention (schemas.ts; plugin 7.4.0). The DesignSync-parity verb tool
  remains later work per plans/designer.md.
- **The card index is DERIVED, not persisted**: a pure view over the thread's messages
  (`designerCards()`), memoized per message-list change. Update-in-place = same filename, later
  timestamp (so agents must name cards distinctly: `editor-form.html`, not `index.html` - the
  attachment pipeline flattens paths to basenames). A second persisted index would drift against
  `forget()` sweeps, schema wipes, and attachment eviction; deriving makes those Just Work.
- **One extension point, not three**: `PluginHost.threadDockSlots` (composable slots between the
  message list and the composer). The sheet and the full-screen viewer live inside the dock
  slot's own state, so no route registry or attachment-kind registry exists until a second
  consumer needs one (extract-upward).
- **Render security** per plans/designer.md: the full-screen canvas is a WebView with JS off,
  network blocked, file/content access off, navigation swallowed; content loads as inline data
  (`loadDataWithBaseURL(null, ...)`), so a hostile card is inert markup. Pinch-zoom on.
- **Thumbnails deferred**: the sheet rows AND the collapsed bar's peek strip show a generic canvas
  glyph rather than a rendered thumbnail; snapshot thumbnails are listed polish. The announce chip
  (Q4 nice-to-have) is not in this slice - prose + the dock is the shipped fallback.

**Phase 2 red-team round (Sonnet fleet, 4 dimensions over the diff) - 7 confirmed, all fixed:**

- **[high, security] Peer-mirror cards cross threads.** `designerCards()` folded EVERY message's
  attachments, so a `kind:"peer"` row (an agent-to-agent exchange mirrored into a thread, `from`/`to`
  = other parties) sharing a filename with a real card silently overwrote it. Fix: skip `isPeer`
  rows entirely - the dock shows only this conversation's own channel (the same distinction the
  renderer draws with its `from -> to` label). Pinned by two new tests.
- **[high, correctness x2] Open sheet/viewer leaked across tab switches.** The dock is one composable
  instance reused as the `team` arg changes; `expanded`/`openIndex` were unkeyed `remember`, so an
  open canvas from thread A showed over thread B. Fix: `remember(team)`.
- **[high, correctness] Full-screen WebView froze one canvas behind when paging.** `produceState`
  keeps the prior value across a key change, so the render loaded the OLD html under the NEW card's
  tag. Fix: the produced value carries the src it was read for; the render gates on a match, so the
  WebView remounts fresh per card (with `onRelease { destroy() }`, also closing the two refuted
  leak findings for free).
- **[medium, plan] Missing export/share.** Added the viewer's share action (FileProvider over the
  already-exposed `attachments/` path -> Android share sheet), matching the mockup's top-bar glyph.
- **[medium, plan] Oversize cards vanished silently.** Raised the read cap 512 KB -> 4 MB and log a
  skip, so a too-big card is diagnosable instead of a mystery.
- **[low, plan] Collapsed-bar thumbnail strip** folded into the standing thumbnail deferral (noted
  above), not a new gap.

## Phase 3 build - versioned store + management + chip-open

Built after the phase-3 questionaire (versioned device store owned by the plugin, fed by the
existing transport; MCP + gateway unchanged). Shipped:

- **Versioned model** (`DesignerCards.kt`): `DesignerCard.versions` (chronological, newest last),
  derived from messages - each same-filename push is its own on-disk attachment bucket, so history
  is a VIEW over the message log, not a copied store. Dedup by src; peer rows still excluded.
- **The only new persisted state** (`DesignStore.kt`): per-conversation DELETE tombstones in the
  plugin's OWN SharedPreferences (`switchboard-designer`), untangled from AppStateStore's
  provisioning/wipe partitions. A tombstone records the newest-version timestamp at delete; a card
  hides while `latest.at <= tombstone`, and a strictly-newer re-push resurfaces it. This is the
  plugin framework's SECOND extension use - per-plugin device storage - with disable-keeps-data
  already the rule.
- **Two new extension points** (`PluginEntry.kt`): `ThreadDockScope` (carries `insertDraftText`,
  the composer seam ThreadScreen provides) and `AttachmentOpener` (a plugin claims a tapped
  attachment). Both are typed, host-exposed, source-tagged, swept on disable - the framework grew
  exactly as designed (one point per real consumer).
- **Four-action surface** (`DesignerDock.kt`): a row context menu AND a viewer action bar sharing
  one `CardAction` enum so they can't drift. Reference (macro-insert bold `**Title**` into the
  draft), Reattach (re-send the viewed version's bytes via a FileProvider URI through the
  composer's own `repo.send` - "I like an old version better" = view it, reattach it), Download
  (reuse the extracted `saveFileToDownloads`), Delete (tombstone via the store). Plus a version
  stepper in the viewer (older/newer) and the share action.
- **Chip shortcut-open** (`DesignerOpenBus.kt` + `DesignerPlugin.kt`): tapping a card-marked
  `.html` attachment chip in the chat body routes through the `AttachmentOpener` registry to the
  live dock's viewer instead of the generic file dialog. `MainActivity.onAttachmentTap` consults
  the openers and only falls back to `AttachmentViewer` when none claims.

**Gates:** 293 Android unit tests (DesignerCardsTest covers version accumulation, tombstone
hide/resurface, the `<=` boundary, cross-card dismissal isolation, prefix-truncation marker), plus
the R8 `assembleRelease` minify gate (new WebView/FileProvider/serialization paths). All green.

**Phase 3 red-team round (Sonnet fleet, 4 dimensions) - 6 confirmed, all fixed:**

- **[high x3, chip-open] The chip-open mechanism was fragile by design.** A process-global
  `MutableStateFlow` retained the last request forever (re-entering a conversation auto-opened a
  canvas with no tap), the request was tagged with the ambient on-screen team rather than the
  tapped thread's (a notification-driven team switch mid-post misrouted it), and the opener read
  the WHOLE attachment synchronously on the UI thread (a big `.html` ANRs on one tap). Reworked
  the whole path: `DesignerOpenBus` is now a replay-0 event stream (no retained value, no stale
  replay); the team is threaded per-renderer through `onAttachmentTap(team, rel)` so it is always
  the tapped thread's; and the opener reads only a bounded 2 KB prefix (the marker leads the file),
  main-thread-safe. A dock-local `pendingOpenRel` resolves once `cards` contains the rel, so a tap
  that beats the async re-derive still opens.
- **[medium, ui] Version stepper jumped to latest** when a new version streamed in (keyed on
  version COUNT). Re-keyed on filename only + coerce, so the user's position is preserved as
  history grows.
- **Reattach send** moved off the dock's composition scope onto a process-lifetime scope, so
  closing the thread mid-send cannot cancel it (matching the composer's own App-scoped send).
- Six findings refuted (the `<=` same-ms boundary is correct; `DesignStore.forget()` orphans are
  benign; stale `openIndex` is range-guarded; etc.).
