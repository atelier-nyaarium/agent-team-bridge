# Features and fixes (PLAN - not implemented)

Scoped items across the terminal view, TTS playback, message rendering, and attachments, plus a backlog of larger features. Verified against the current tree on branch `home-retire-refactor` (versions at 5.0.23). Symbol refs are `path:scope:name`, never line numbers. (The CLI teardown + create-session + Copilot items moved into the host-split plan, `bug-class-decisions.md` Phase 6.)

`android/.../` below abbreviates `android/app/src/main/java/com/atelier_nyaarium/switchboard/` (package `com.atelier_nyaarium.switchboard`). Asset paths under `android/app/src/main/assets/` are written in full.

## At a glance

| # | Item | Surface | Code change | Deploy target |
|---|------|---------|-------------|---------------|
| 5 | TTS volume slider (0-200%, default 100%) | Android / TTS | `SttsPlayer.kt` + `ChatRepository.kt` + `ProvisioningStore.kt` + `MainActivity.kt` | APK |

One deploy target: the Android APK (item 5). No wire-schema change anywhere -> no Kotlin codegen (`scripts/codegen-kotlin.ts`), no synced-leaf restamp (none of the touched symbols appear in `src/shared/schemas.ts`).

---

# Android - TTS

All three items are in `android/.../SttsPlayer.kt` and friends. No tests exist for `SttsPlayer` today (`android/.../test/.../` has only `SttsMigrationTest.kt` + `SttsVoiceTest.kt`).

## Item 5 - TTS volume slider (0-200%, default 100%)

**Current state.** The player is `android.media.MediaPlayer`, created in `android/.../SttsPlayer.kt:SttsPlayer:playFile` (via `SttsPlayer:synthesizeAndPlay`). It sets `AudioAttributes` but NO volume anywhere - playback runs at the stream's natural level (effectively 100%). There is no volume setting in `ProvisioningStore`, no slider in the UI, and no volume param on the play path.

**The 200% constraint.** `MediaPlayer.setVolume(left, right)` is clamped to 0.0..1.0, so it covers 0-100% only. The 100-200% half needs a gain stage. Given the existing `MediaPlayer`, the clean path is `android.media.audiofx.LoudnessEnhancer` attached to `player.audioSessionId` (a dynamics/gain effect that boosts loudness without the hard clipping a raw sample multiply causes). Split the slider at unity:
- **0-100%:** `setVolume(pct/100f, pct/100f)` (accurate attenuation, free).
- **100-200%:** `setVolume(1f, 1f)` + `LoudnessEnhancer.setTargetGain(mB)` for the portion above unity. `setTargetGain` takes integer millibels; a linear `(pct - 100) * 6` mapping gives 0 mB at 100% and 600 mB (~+6 dB ≈ 2x) at 200%. Perceptually rough, not exact (true dB = 20·log10(ratio)) - good enough for a user volume knob; comment it as approximate.

(Swapping to ExoPlayer/Media3 for a >1.0 volume pipeline is the heavier alternative - a dependency add + a rewrite of `playFile`. Overkill for one slider.)

**Fix (minimal, read volume per-play to match the existing per-call voice/provider resolution).**
- `android/.../ProvisioningStore.kt`: add `KEY_STTS_VOLUME = "stts_volume"` (lowercase-underscore, matching `KEY_AUTO_PLAY` / `KEY_TERMINAL_REFRESH_MS`) and a property mirroring `ProvisioningStore:terminalRefreshMs`:
  ```kotlin
  var sttsVolume: Int
      get() = prefs.getInt(KEY_STTS_VOLUME, 100).coerceIn(0, 200)
      set(value) { prefs.edit().putInt(KEY_STTS_VOLUME, value.coerceIn(0, 200)).apply() }
  ```
- `android/.../ChatRepository.kt`: add a passthrough `var sttsVolume: Int` over `store.sttsVolume` (mirrors `ChatRepository:sttsAutoPlay`), and pass `store.sttsVolume` into `stts.play(...)` in `ChatRepository:playMessage` (and into the sample-preview path so the preview honors it).
- `android/.../SttsPlayer.kt`: add a `volumePct: Int` param to `SttsPlayer:play` (and the sample path), thread it to `playFile`, and in the `MediaPlayer.apply { ... }`:
  ```kotlin
  setVolume(minOf(volumePct, 100) / 100f, minOf(volumePct, 100) / 100f)
  // after prepare(), only when volumePct > 100:
  loudness = LoudnessEnhancer(audioSessionId).apply { setTargetGain((volumePct - 100) * 6); enabled = true }
  ```
  Extract the pct->(linear, mB) mapping as a pure companion helper so it's unit-testable (the only JVM-testable bit; `MediaPlayer`/`LoudnessEnhancer` can't run under unit tests).
- `android/.../MainActivity.kt`: add a Material3 `Slider` in the TTS settings composable (the one holding `autoPlayOptions`, `repo.sttsAutoGen`, `repo.sttsAutoPlay`, the voice picker), after the autoplay `Column`:
  ```kotlin
  var volume by remember { mutableStateOf(repo.sttsVolume) }
  Text("Playback volume: $volume%")
  Slider(value = volume.toFloat(), onValueChange = { volume = it.toInt() },
         onValueChangeFinished = { repo.sttsVolume = volume }, valueRange = 0f..200f)
  ```
  Commit on `onValueChangeFinished`, NOT `onValueChange`, or every drag tick writes EncryptedSharedPreferences.

**Coverage.** The autoplay path (`ChatRepository:poll` -> `playMessage`), the play button (`MainActivity:App` -> `onPlayTap` -> `playMessage`), and the notification actions (`NotificationReceiver.kt` -> `playMessage`) all route through `playMessage`, so they pick up volume for free.

**Gotchas.**
- **LoudnessEnhancer lifecycle:** add `@Volatile private var loudness: LoudnessEnhancer?`; `runCatching { loudness?.release() }` everywhere the player is released - top of `playFile` (before building a new player), `SttsPlayer:stop`, and the `setOnCompletionListener`/`setOnErrorListener` release blocks. Leaking it holds a native effect handle.
- **audioSessionId** is valid after `MediaPlayer` construction; attach the enhancer after `prepare()`. Effects default disabled, so `enabled = true` is required.
- Keep loudness writes inside the existing `@Synchronized` monitors on `playFile`/`stop` so playback and a concurrent `stop()` don't race the handle.
- `LoudnessEnhancer` is framework (not reflected/serialized) - no new proguard keep.

**Verify.** Slider at 50% is quieter, 100% normal, 200% noticeably louder; the setting persists across app restart; sample preview reflects the slider.

---

# Build + deploy

## Code change list

| File | Change | Items |
|------|--------|-------|
| `android/.../SttsPlayer.kt` | `volumePct` param + `LoudnessEnhancer` + pure mapping helper | 5 |
| `android/.../ChatRepository.kt` | `sttsVolume` passthrough + thread into `playMessage` | 5 |
| `android/.../ProvisioningStore.kt` | `sttsVolume` (Int, default 100) + `KEY_STTS_VOLUME` | 5 |
| `android/.../MainActivity.kt` | volume `Slider` | 5 |

`src/mcp/index.ts:new McpServer` reads `packageJson.version`, so the MCP server version follows `package.json` automatically - 2 version files, not 3.

## Gates (before push)

- **Android** (the only pre-merge Kotlin gate - `ci.yml` does NOT compile Kotlin):
  ```bash
  cd android
  JAVA_HOME=/home/nyaarium/android-dev/jdk ANDROID_HOME=/home/nyaarium/android-dev/sdk \
    ./gradlew :app:testDebugUnitTest --console=plain
  ```
  Compiles Kotlin + runs unit tests (incl. the new volume-mapping tests). For the R8/minify gate also run `./gradlew :app:assembleRelease` (testDebugUnitTest runs un-minified and won't catch a strip).

## Deploy sequence (after the PR merges + the APK builds)

1. Update the Android app (in-app updater or sideload) - item 5.

## Open decisions for review

- **Item 5 volume:** (a) continuous slider vs stepped (e.g. 5% increments); (b) the pct->mB mapping - simple linear `(pct-100)*6` vs a log-accurate dB curve; (c) whether 200% is the right ceiling (LoudnessEnhancer can push higher but distortion grows).

---

# Backlog (jotted, NOT yet scoped)

Captured for later. No investigation depth beyond a quick grounding pass; revisit before planning.

## Item 8 - at-rest encryption on device (PIN-gated)

**Idea.** Everything on the device is encrypted at rest behind the user's PIN. Lose the PIN -> lose the setup (no recovery). The user's Evie mailbox + storage are encrypted too. The only thing an admin can do is EVICT and DELETE the account - never read it. Question to settle: is that posture practical?

**Quick grounding (not a design).**
- On-device: the app already uses EncryptedSharedPreferences for secrets, and the owner root key is generated silently on the phone and never leaves it (see `FederationManager.ownerIdentity()` in the Android tree; CLAUDE.md "Federation trust"). So device-side at-rest encryption is partly in place; a PIN gate over the keystore would extend it. "Lose PIN = lose setup" is consistent with the existing no-silent-re-root recovery stance.
- Evie-side mailbox/storage: today the `DeviceMailbox` entries and the console relay are E2E SEALED in transit (`gateway/console/`, `consoleSealer`), but evie's at-REST storage of mailbox contents is a separate question - needs a look at what evie persists (the `evie-federation` k8s Secret holds trust state, not message bodies; where do mailbox bodies live and are they encrypted at rest?).
- Admin = the operator/owner. "Evict + delete only, never read" lines up with the multi-tenant `TenantAdmin` model (operator can `remove_tenant`) - confirm the admin has no decryption path to a guest's mailbox.

**Open questions to revisit.** PIN recovery vs. hard loss (acceptable UX?); whether evie persists any plaintext message bodies at rest; key-derivation (PIN -> KEK) + rate-limiting/brute-force; what "delete account" guarantees server-side.

## Item 9 - cleanup response prose -> structured `instructions` field

**Idea.** Stop jamming behavioral rules onto every inbound message body as a prefixed block:
```
┃ Reply with the `channel_reply` tool: pass the session_id ... in the `respondAsMarkdownString` field ...
┃ session_id: `...`
```
Instead, since the wire can carry structured objects, attach an `"instructions": "..."` field on the JSON delivered to the agent. The agent reads it as behavioral context and replies as a structured object - no `┃ Reply with the...` preheader on the body.

**Quick grounding - structured I/O already exists (so this is feasible).**
- **Outbound (agent -> console):** `channel_reply` already takes `respondAsStructuredData` (a JSON string) at `src/shared/schemas.ts:ChannelReplySchema`, handled in `src/mcp/bridge/replyTool.ts:registerReplyTool` -> `payload.replyAsJson` (mutually exclusive with `respondAsMarkdownString` -> `payload.response`). So "reply as structured object" is already supported.
- **Inbound (console -> agent):** the message is pushed via `src/mcp/channel/channelNotify.ts:emitChannelNotification` as a `notifications/claude/channel` notification. Structured fields ALREADY ride in `params.meta` (`session_id`, `from`, `request_type`, `effort`, `is_follow_up`) and surface to the agent as the `<channel ...>` tag attributes. The prose-jamming is the `replyInstruction` + `replyReminder` strings prepended to `params.content` in that same function (and the `Status:`/`Question:`/`Reason:` labels in `emitResponseNotification`).
- **Precedent for an instructions field:** `src/mcp/index.ts` already sets a server-level `instructions: CHANNEL_INSTRUCTIONS` for channel mode - the one-time "how to behave in this channel" text. The cleanup could lean on that (state the reply protocol ONCE at session init) and/or add a per-message `meta.instructions` for context-specific guidance, dropping the per-message `┃` block from `content`.

**Sketch (to scope later).** Move the reply-protocol prose out of `emitChannelNotification`'s `content` into either the existing server-level `CHANNEL_INSTRUCTIONS` (stated once) or a `meta.instructions` field; keep `content` as just the message body (+ files block). Decide whether replies become structured-by-default or stay markdown-prose with structured as the opt-in. Verify the harness surfaces `meta.instructions` to the agent the way it surfaces the other `meta` attributes.

**Open questions to revisit.** Does the harness reliably expose a new `meta.*` key to the agent? Once-at-init instructions vs. per-message (does guidance vary per message)? Backward-compat for any consumer that parses the current `content` preheader.

## Item 10 - attachment button: raise the per-file cap to 500 MB + manual round-trip test

### Part A - CODE: raise the max upload cap per file to 500 MB (Discord-Nitro-on-a-server parity)

**Surprise to flag.** The "locked 500 MB hard backstop" in the `src/shared/evie-protocol.ts:ChannelFileSchema` doc comment is ASPIRATIONAL - no 500 MB constant is actually enforced in this repo. Every real cap today is 10 MB (and the schema puts NO `max` on `ChannelFile.size` or `base64`). The 500 MB inbound consumer backstop referenced in CLAUDE.md likely lives on the evie side (evie-bot repo) - verify there too.

**Caps to raise (all currently `10_000_000`).**
- `src/mcp/bridge/replyTool.ts:MAX_ATTACHMENT_BYTES` - agent-side outbound, enforced PER-FILE in `readReplyAttachment` (covers `channel_reply` + `notify_human`). Advisory. -> 500 MB.
- `src/gateway/routes.ts:MAX_RESPONSE_FILE_BYTES` - gateway trust-boundary backstop, enforced as a PER-PAYLOAD TOTAL via `routes.ts:fileBytes` in both `send` and `respond` (413 on exceed). Note it sums all files, so it is NOT per-file. -> see decision below.
- `android/.../ChatRepository.kt:ChatRepository.companion:MAX_OUTGOING_BYTES` - Android console outbound upload cap. -> 500 MB.

**The 100 MB mailbox ceiling (must move too, or a 500 MB file can't be held).** `src/shared/device-mailbox.ts:DEFAULT_MAX_BYTES` = `100_000_000`. The mailbox is the OOM backstop that holds undelivered entries; a single 500 MB attachment exceeds it and would be evicted/never held. Raise it (e.g. >= the per-file cap, with headroom for >1 queued file) or the 500 MB file dies in the mailbox even though the upload cap allows it.

**Decisions before implementing.**
- **Per-file vs per-payload.** The ask is "per FILE = 500 MB". `replyTool`/Android are per-file; the gateway cap is a per-payload SUM. Three images + a PDF + a JSON in one reply could blow a 500 MB total even with each file under 500 MB. Either raise the gateway total well above 500 MB (e.g. N x per-file, or a separate larger total) or accept 500 MB as a per-payload ceiling. Pick one.
- **base64 inflation.** Bytes ride base64 (~4/3), so 500 MB decoded is ~670 MB on the wire (the existing comment already anticipates this). Confirm the gateway/evie request-body limits and any HTTP/WS frame caps tolerate ~670 MB, and that `fileBytes` (which estimates decoded size from base64 length) stays correct.
- **Unit convention.** Existing constants are decimal (`10_000_000` = 10 MB), so 500 MB = `500_000_000` to match (not 524288000). Confirm Discord's 500 MB Nitro figure is the intended target.
- **Memory/throughput.** 500 MB attachments mean large in-memory base64 strings through the agent -> `/respond` -> gateway mailbox -> push path. Sanity-check this doesn't OOM the gateway container or stall the poll. (Streaming/chunking is out of scope for the cap bump but note it as the real fix if multi-hundred-MB becomes common.)

### Part B - MANUAL TEST: round-trip both directions (after Part A ships)

**Inbound (human -> agent).** User sends a photo from the console. Agent receives it via the `[FILES]` block (materialized to `/tmp/evie-files/<msgId>/` by `src/mcp/channel/evieFiles.ts:materializeFiles`), `Read`s it, and DESCRIBES the image to confirm bytes arrived intact.

**Outbound (agent -> human).** Agent sends back, in one or more `channel_reply` calls, `attachments` (absolute paths, base64'd by `src/mcp/bridge/replyTool.ts:readReplyAttachment`):
- 3 images of DIFFERENT types (e.g. PNG / JPEG / WebP or GIF) - produce them by modifying the received image and/or fetching one from the internet.
- a PDF file.
- a JSON file.

**What to verify.** All 5 render/download correctly on the console (images inline, pdf/json as download chips); MIME types come through (`replyTool.ts:MIME_BY_EXT`); the new 500 MB cap holds (test a large file near the limit and one over it -> clean 413, not a crash); the mailbox holds a large file without eviction; multiple attachments in a stream arrive in order. Confirms the full path: `readReplyAttachment` -> `/respond` -> gateway mailbox -> console.

---

## Item 14 - app-side plugins support (bake-in a few, toggle on/off)

**Idea.** Add a plugins layer to the Android app: extra app-side capabilities the user can turn on/off from settings. For now, BAKE IN a few good ones (ship them in the APK) behind per-plugin toggles, rather than a full third-party install story. The toggle-able set is the MVP; a dynamic install/marketplace path is later.

**HARD REQUIREMENT for the follow-up.** When this item is actually picked up, it must FIRST `git clone` the user's `nyaarium/nyaadot` project into `/tmp/` and base the plugin model **100% on the schema modularity defined there**. Do not design a bespoke plugin schema for switchboard - adopt nyaadot's schema verbatim as the source of truth for how a plugin is described, declared, and toggled. The clone-and-read step is a precondition to any scoping or design work on this item.

```bash
git clone https://github.com/nyaarium/nyaadot /tmp/nyaadot
# then read its schema/modularity model and base the plugin design entirely on it
```

**Quick grounding (NOT a design - revisit after the nyaadot clone).**
- The app already has a settings surface (`MainActivity.kt:App`, the TTS settings composable with `autoPlayOptions`, voice picker, etc.) and a persistence layer (`ProvisioningStore.kt` over EncryptedSharedPreferences with the lowercase-underscore `KEY_*` convention) - a per-plugin enabled flag fits the existing `var x: Boolean` property pattern there.
- The thread renderer is already an extensible WebView (`assets/thread/thread.js` + `thread.html`, vendoring markdown-it) with a `@JavascriptInterface` bridge - a likely host for any render-side plugin behavior.
- Decide once nyaadot's schema is in hand whether a "plugin" here is a render/transform hook, a settings-driven behavior toggle, or a sandboxed module - nyaadot's modularity schema dictates this, not a fresh switchboard invention.

**Open questions to revisit (after reading nyaadot).** What exactly nyaadot's schema models a plugin as (manifest shape, capability surface, enable/disable semantics); which baked-in plugins to ship first; where toggle state persists (likely `ProvisioningStore`) and whether it needs to sync server-side or stay device-local; sandboxing/trust if any plugin can touch message content or the bridge; whether the eventual dynamic-install path reuses the same schema.

---

## Moved out: Items 11-13 -> the host-split plan

The CLI-era teardown, the create-session button, and Copilot support are now subsumed into
`bug-class-decisions.md` Phase 6 (split the host: demote the host-agent, headless multi-session
daemon). They were removed here to avoid a split source of truth.
