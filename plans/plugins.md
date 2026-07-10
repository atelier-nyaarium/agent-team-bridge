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
