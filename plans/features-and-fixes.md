# Features and fixes (PLAN - not implemented)

Scoped items across the terminal view, TTS playback, message rendering, and attachments, plus a backlog of larger features and a CLI-era teardown. Verified against the current tree on branch `home-retire-refactor` (versions at 5.0.23). Symbol refs are `path:scope:name`, never line numbers.

`android/.../` below abbreviates `android/app/src/main/java/com/atelier_nyaarium/switchboard/` (package `com.atelier_nyaarium.switchboard`). Asset paths under `android/app/src/main/assets/` are written in full.

## At a glance

| # | Item | Surface | Code change | Deploy target |
|---|------|---------|-------------|---------------|
| 1 | tmux pane is 80-wide | host / TS | `tmuxCore.ts` + `start-host-daemon.sh` + test | reload_plugins (+ host restart) |
| 2 | BSpace disallowed | gateway + host | NONE (stale process) | `./start-gateway.sh` + reload_plugins |
| 3 | autoplay tier collapses to full on plain msgs | Android / TTS | `SttsPlayer.kt` | APK |
| 4 | play/stop out of sync | Android / TTS | `SttsPlayer.kt` + `ChatRepository.kt` + `MainActivity.kt` | APK |
| 5 | TTS volume slider (0-200%, default 100%) | Android / TTS | `SttsPlayer.kt` + `ChatRepository.kt` + `ProvisioningStore.kt` + `MainActivity.kt` | APK |
| 6 | slash macros: `/context`, `/resume`, `/compact [msg]` | Android / terminal | `TerminalView.kt` | APK |
| 7 | single newlines collapse in Markdown | Android / rendering | `assets/thread/thread.js` | APK |

Three deploy targets total: the plugin (item 1), a gateway rebuild (item 2), and the Android APK (items 3-7). No wire-schema change anywhere -> no Kotlin codegen (`scripts/codegen-kotlin.ts`), no synced-leaf restamp (none of the touched symbols appear in `src/shared/schemas.ts`).

---

# Host / TypeScript

## Item 1 - tmux pane size (resize to 58x40)

**Root cause.** The console terminal view captures `claude.0` (session `claude`, pane 0) on both the host (`kind:"gateway"` -> local tmux) and a devcontainer (`kind:"devcontainer"` -> `docker exec <name>_devcontainer-dev-1 tmux`). Nothing sizes that session: `src/mcp/devcontainer/tmuxCore.ts:peekPane` issues a single `capture-pane` with no prior resize, and there are no col/row constants in the file. The host session is created by `start-host-daemon.sh` (`tmux new-session -d -s "$TMUX_SESSION" ...`, `TMUX_SESSION="claude"`) with no `-x/-y`, so it defaults to 80x24; the devcontainer's own `claude` session is created by the devcontainer (switchboard never touches its creation). So the captured pane is 80 wide and overflows the phone.

**Current state (verified).**
- `src/mcp/devcontainer/tmuxCore.ts:peekPane` - one `run(tmuxArgv(target, ["capture-pane", "-t", TMUX_PANE, "-e", "-p"]))`, hashes, returns. No resize.
- `src/mcp/devcontainer/tmuxCore.ts:tmuxArgv` - the argv builder (prepends `docker exec -u vscode <container> tmux` for a devcontainer, bare `tmux` for gateway). Reuse it so one resize call covers host AND every devcontainer.
- `src/mcp/devcontainer/tmuxCore.ts:TMUX_PANE` = `"claude.0"`. There is NO standalone session constant - the session is embedded in the pane string. `resize-window` needs a session target, so a `TMUX_SESSION` const must be added.

**Fix.**
- `src/mcp/devcontainer/tmuxCore.ts`: add `const TMUX_SESSION = "claude"` (keep `TMUX_PANE = "claude.0"`), `const TMUX_COLS = 58`, `const TMUX_ROWS = 40`. In `peekPane`, before the capture, run a BEST-EFFORT resize as a SEPARATE `run()` call:
  ```ts
  await run(tmuxArgv(target, ["resize-window", "-t", TMUX_SESSION, "-x", String(TMUX_COLS), "-y", String(TMUX_ROWS)])).catch(() => {});
  const ansi = await run(tmuxArgv(target, ["capture-pane", "-t", TMUX_PANE, "-e", "-p"]));
  ```
  Best-effort (`.catch`) so an old tmux without `resize-window`, or a transient error, just captures at the current size. Two separate `run()` calls (not `;`-chained) so a resize failure can never fail the capture.
- `start-host-daemon.sh`: add `-x 58 -y 40` to the `tmux new-session` so the host session is born at 58x40 (cosmetic given the peek-resize, but correct from the start).
- `src/__tests__/tmux-core.test.ts` - the test `describe("tmuxCore peekPane")` / `it("captures the visible pane with ANSI and returns a content hash")` asserts `calls[0]` is the capture argv. With the resize prepended, `calls[0]` becomes the resize and `calls[1]` the capture - UPDATE it to assert `calls[0]` is the `resize-window` argv and `calls[1]` the `capture-pane` argv. The slug-rejection test (`it("rejects a target name that is not a slug before reaching docker")`) is unaffected.

**Why resize-window holds.** The `claude` session has no attached tmux CLIENT (claude runs as the pane process; the console only `capture-pane`s, never attaches). A detached session keeps the size set by `resize-window`, so 58x40 sticks. Re-resizing to the same size each peek (~2s) is a no-op in tmux (no redraw), so the cost is one cheap extra spawn per peek.

**Edge cases.** 58 cols is narrow for Claude's TUI - it will reflow/wrap; that's the user's explicit choice (fit the phone). A manual `tmux attach` for debugging would resize to that terminal (window-size latest), but that's a deliberate debug action, not the capture path.

**Verify.** Open the terminal view on the host-agent and on a devcontainer; the captured pane is 58x40 and fits.

## Item 2 - `tmux_send failed: disallowed key BSpace`

**Root cause.** NOT a code bug. The app sends exactly `"BSpace"` / `"M-BSpace"` from `android/.../TerminalView.kt:TerminalView` (the `BackspaceKey` call: `onTap = { fire(null, "BSpace") }`, `onHoldRepeat = { fire(null, "M-BSpace") }`), and the source allowlist `src/shared/host-op.ts:ALLOWED_KEYS` already contains both. The error means a RUNNING process is on pre-allowlist code.

**Which process is stale.** TWO gates throw the identical `disallowed key "..."` string and BOTH import the same `ALLOWED_KEYS`:
- `src/gateway/console/consoleHandler.ts` - the `tmux_send` op fail-fast, runs in the gateway Docker container.
- `src/mcp/devcontainer/tmuxCore.ts:sendKey` - the host executor gate, runs in the host daemon.

The stale process could be EITHER, so fix both: `./start-gateway.sh` rebuilds the gateway (git pull + Docker rebuild bakes in the current `ALLOWED_KEYS`), and `reload_plugins` on the host-daemon (delivered alongside item 1) refreshes the host gate.

**Verify.** After both: tap = one backspace, hold = repeat Alt+Backspace (delete-word).

---

# Android - TTS

All three items are in `android/.../SttsPlayer.kt` and friends. No tests exist for `SttsPlayer` today (`android/.../test/.../` has only `SttsMigrationTest.kt` + `SttsVoiceTest.kt`).

## Item 3 - autoplay Title/Summary collapses to full on plain messages

**Premise correction (since the original plan).** `ttsText` is ALREADY tier-aware - the old "every tier reads the whole message" framing no longer matches the tree. Current `android/.../SttsPlayer.kt:SttsPlayer.Companion:ttsText`:
```kotlin
fun ttsText(m: Message, tier: Tier): String = when (tier) {
    Tier.SUMMARY -> m.summary ?: m.title ?: sanitize(m.text)
    Tier.TITLE   -> m.title   ?: m.summary ?: sanitize(m.text)
    Tier.FULL    -> sanitize(m.text)
}
```
The wiring around it is correct too: the selector persists (`android/.../ChatRepository.kt:ChatRepository:sttsAutoPlay`, default `"off"` via `android/.../ProvisioningStore.kt:ProvisioningStore:autoPlay`), and the autoplay trigger `android/.../ChatRepository.kt:ChatRepository:poll` maps the setting through `android/.../ChatRepository.kt:ChatRepository:autoPlayTier` and calls `playMessage(t, at, autoTier)` with the chosen tier - it does NOT hardcode FULL.

**The actual remaining gap.** A plain message (a `channel_reply`, like normal chat) has no `title`/`summary` (those `Message` fields - `android/.../ChatRepository.kt:Message` - ride in only on a `notify_human` notice). So for a plain message both TITLE and SUMMARY fall through to `sanitize(m.text)`: with autoplay set to Title or Summary, a plain reply still reads the whole body. (Tier enum `android/.../SttsPlayer.kt:SttsPlayer:Tier` = FULL/SUMMARY/TITLE.)

**Fix.** Derive a title/summary from the text when none is supplied. In `android/.../SttsPlayer.kt:SttsPlayer.Companion:ttsText`:
```kotlin
Tier.SUMMARY -> m.summary ?: m.title ?: deriveSummary(m.text)
Tier.TITLE   -> m.title   ?: deriveTitle(m.text)
Tier.FULL    -> sanitize(m.text)              // unchanged
```
Add `android/.../SttsPlayer.kt:SttsPlayer.Companion:deriveTitle` and `:deriveSummary`. Notices with explicit tiers keep theirs (the `?:` short-circuits before the derive).

**The heuristic (OPEN DECISION - see end).**
- `deriveTitle(text)`: first non-blank line (split on `\n`), sanitized; cut at the first sentence end (`.`/`!`/`?`) before ~140 chars, else cap ~140 chars on a word boundary (+ "…"). One-sentence headline.
- `deriveSummary(text)`: first paragraph (up to the first blank line) or first ~3 sentences, sanitized, capped ~400 chars on a word boundary.
- A short message whose derived title equals the whole body just reads fully at every tier (fine).

**Tests.** Add unit tests for `ttsText` (pure): explicit title/summary used as-is; no title -> derived first line; no summary -> derived first paragraph; caps enforced; a one-line message reads the same at all tiers.

**Verify.** Autoplay=Title on a fresh plain reply reads one sentence; Summary reads the first paragraph; Full reads everything; a `notify_human` notice uses its explicit tiers.

## Item 4 - play/stop button out of sync

**Root cause (verified).** `android/.../MainActivity.kt:App` wires the play button to FULL: `rendererPool.onPlayTap = { team, at -> repo.playMessage(team, at, SttsPlayer.Tier.FULL) }` (field `android/.../ThreadRendererPool.kt:ThreadRendererPool:onPlayTap`). The toggle in `android/.../SttsPlayer.kt:SttsPlayer:play` only stops when `currentKey == k`, where `k` is built from `android/.../SttsPlayer.kt:SttsPlayer:key` (`"$team/$at-${tier.suffix}-${provider.path}-${voice}"`, tier included). During an autoplay of a DIFFERENT tier (e.g. Title), `currentKey` holds the title-suffixed key, so the tap's FULL key never matches - instead of stopping it synthesizes and plays FULL on top (the user hears it "play twice"). The glyph is fine: `android/.../SttsPlayer.kt:SttsPlayer:onPlayingChanged` -> `android/.../ThreadRendererPool.kt:ThreadRendererPool:setPlaying` -> `android/.../ThreadRenderer.kt:ThreadRenderer:setPlaying` is keyed by message `at` (any tier). The existing `android/.../SttsPlayer.kt:SttsPlayer:isPlaying` takes a tier, so it can't answer "is this message playing in any tier".

**Fix.** Make the BUTTON toggle by message (leave `SttsPlayer:play` per-tier, since autoplay/notifications must still play a specific tier without toggling):
- `android/.../SttsPlayer.kt:SttsPlayer:isPlayingMessage` - add `fun isPlayingMessage(team: String, at: Long): Boolean = currentKey != null && currentTeam == team && currentAt == at` (backing fields `currentTeam`/`currentAt` already exist, set in `SttsPlayer:playFile`, cleared in `SttsPlayer:clearNowPlaying`).
- `android/.../ChatRepository.kt` - add `fun isMessagePlaying(team, at) = stts.isPlayingMessage(team, at)` and `fun stopPlayback() = stts.stop()` (alongside `ChatRepository:playMessage`).
- `android/.../MainActivity.kt:App` - change the `onPlayTap` lambda:
  ```kotlin
  rendererPool.onPlayTap = { team, at ->
      if (repo.isMessagePlaying(team, at)) repo.stopPlayback()
      else repo.playMessage(team, at, SttsPlayer.Tier.FULL)
  }
  ```
- Manual tap still plays FULL when nothing is playing (deliberate "read me the whole thing"). Leave the `android/.../NotificationReceiver.kt` `ACTION_PLAY_FULL`/`ACTION_PLAY_SUMMARY` hardcodes alone - those are deliberate explicit-tier actions.

**Edge case.** A tap during the synth window (chosen tier synthesizing but not yet playing, so `currentTeam`/`currentAt` unset) won't see it as playing and starts FULL; the last `playFile` wins. Narrow sub-second race; self-heals. Not worth gating on an in-flight flag - note it.

**Verify.** Autoplay a message (any tier) -> its button shows stop -> tap stops it. Tap again -> plays full -> tap stops.

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

# Android - terminal

## Item 6 - slash macros: `/context`, `/resume`, `/compact [message]`

**Current state.** `android/.../TerminalView.kt:PALETTE_SLASH` = `listOf("/model", "/effort", "/usage", "/workflows", "/plugin", "/mcp")`. Each entry is rendered one-shot in the `PALETTE_SLASH.forEach` loop in `android/.../TerminalView.kt:TerminalView`: `AssistChip(onClick = { fire(cmd, null) }, ...)`. `TerminalView:fire` calls `onSend(text, key)`; a text send appends a trailing CR atomically on the host (`src/mcp/devcontainer/tmuxCore.ts:sendText`), so a slash chip **types the command AND submits Enter immediately** - it never touches the composer. There is an editable composer: `android/.../TerminalView.kt:TerminalView:input` (a `mutableStateOf("")`), bound to an `OutlinedTextField`, with a Send `FilledIconButton` that does `fire(input, null); input = ""` (or a bare `Enter` when empty). NO chip currently writes into `input` - an insert-without-send affordance does not exist yet.

**Fix.**
- **`/context`** and **`/resume`** - pure one-shot. Append both to `PALETTE_SLASH`:
  ```kotlin
  private val PALETTE_SLASH = listOf("/model", "/effort", "/usage", "/context", "/resume", "/workflows", "/plugin", "/mcp")
  ```
  The existing `forEach` loop renders them; no other wiring. (`/context` inserted after `/usage` per the original ask.)
- **`/compact [message]`** - the FIRST arg-taking macro. The optional trailing message must be typed by the human before submit, so it CANNOT be a one-shot chip (that would fire `/compact` + Enter instantly). Render it as a separate chip whose `onClick` PRE-FILLS the composer instead of firing:
  ```kotlin
  // after the PALETTE_SLASH.forEach loop, in the same chip Row:
  AssistChip(
      onClick = { input = "/compact " },   // insert, no Enter; user appends optional message, then Send
      label = { Text("/compact", fontFamily = FontFamily.Monospace) },
  )
  ```
  This reuses the existing Send button (sends `input` + CR, clears it) with zero new submit logic. Empty-message case: tap `/compact`, tap Send. Message case: tap `/compact`, type after the space, tap Send. Optionally add a `FocusRequester` to focus the TextField after insert for nicer UX (not required for correctness).

**Note.** If more arg-taking macros are coming, consider generalizing the palette to declarative `(label, oneShot|insert)` entries rather than a bespoke chip per macro - but that's more than this change needs.

**Verify.** `/context`, `/resume` fire immediately like the other chips. Tapping `/compact` puts `/compact ` in the composer; Send with nothing appended compacts bare, Send with a typed message compacts with that message.

---

# Android - rendering

## Item 7 - single newlines collapse in Markdown

**Root cause.** The thread renderer is a WebView loading `android/app/src/main/assets/thread/thread.html`, which vendors **markdown-it 14.1.0** locally (`android/app/src/main/assets/thread/vendor/markdown-it.min.js`, no CDN) and renders in `android/app/src/main/assets/thread/thread.js`. The config object `thread.js:(anonymous IIFE):md` (`window.markdownit({ html: false, linkify: true, highlight: ... })`) has NO `breaks` key, so markdown-it defaults `breaks: false` - a single `\n` is a soft break rendered as whitespace. Hence:
```
**Subject**:
Some item
```
collapses to `**Subject**: Some item`.

**No upstream stripping (verified).** The text reaches the parser intact: `android/.../ThreadRenderer.kt:ThreadRenderer:toJson` puts the raw `m.text` into JSON and `ThreadRenderer:sync` injects it via `webView.evaluateJavascript` -> `window.thread.setMessages(...)`; `thread.js:setMessages`/`appendMessages` pass `m.body` straight to `thread.js:buildRow`, which calls `md.render(m.body || "")` with no pre-processing. The `@JavascriptInterface` bridge carries only attachment/id callbacks (JS->Kotlin), never message text, so it's irrelevant here. Enabling `breaks` is the complete fix.

**Fix.** Add `breaks: true` to the markdown-it options at `android/app/src/main/assets/thread/thread.js:(anonymous IIFE):md`:
```js
const md = window.markdownit({
    html: false,
    breaks: true,   // single \n -> <br> (GitHub-style line breaks)
    linkify: true,
    highlight: function (code, lang) { ... },
});
```
That's the markdown-it equivalent of GitHub line breaks; every single `\n` inside a paragraph becomes `<br>`. (`gfm`/`pedantic` are marked options, not markdown-it; `linkify` is already on. Code fences are handled by the separate `md.renderer.rules.fence` override and are unaffected.)

**Notes.** Pure JS asset change - the minified vendor lib is untouched, no Kotlin rebuild needed for the logic, no proguard/`@JavascriptInterface` impact. It still ships through the normal APK build.

**Verify.** A message with single newlines between lines renders each line separately; a `**Subject**:` line stays above its value instead of joining.

---

# Build + deploy

## Code change list

| File | Change | Items |
|------|--------|-------|
| `src/mcp/devcontainer/tmuxCore.ts` | `peekPane` resize + `TMUX_SESSION`/`TMUX_COLS`/`TMUX_ROWS` consts | 1 |
| `src/__tests__/tmux-core.test.ts` | assert `calls[0]` resize + `calls[1]` capture | 1 |
| `start-host-daemon.sh` | `-x 58 -y 40` on `tmux new-session` | 1 |
| `android/.../SttsPlayer.kt` | `ttsText` derive + `deriveTitle`/`deriveSummary`; `isPlayingMessage`; `volumePct` param + `LoudnessEnhancer` + pure mapping helper | 3, 4, 5 |
| `android/.../ChatRepository.kt` | `isMessagePlaying` + `stopPlayback`; `sttsVolume` passthrough + thread into `playMessage` | 4, 5 |
| `android/.../ProvisioningStore.kt` | `sttsVolume` (Int, default 100) + `KEY_STTS_VOLUME` | 5 |
| `android/.../MainActivity.kt` | `onPlayTap` toggle; volume `Slider` | 4, 5 |
| `android/.../TerminalView.kt` | `/context` + `/resume` in `PALETTE_SLASH`; `/compact` insert-into-composer chip | 6 |
| `android/app/src/main/assets/thread/thread.js` | `breaks: true` in the `markdownit` config | 7 |
| `.claude-plugin/plugin.json` + `package.json` | 5.0.23 -> 5.0.24 | 1 |

`src/mcp/index.ts:new McpServer` reads `packageJson.version`, so the MCP server version follows `package.json` automatically - 2 version files, not 3.

## Gates (before push)

- **TS:** `bun run lint && bun run test` (covers `tmuxCore` + the updated `tmux-core.test.ts`). `lint` = `biome ci . && bunx tsc --noEmit`.
- **Android** (the only pre-merge Kotlin gate - `ci.yml` does NOT compile Kotlin):
  ```bash
  cd android
  JAVA_HOME=/home/nyaarium/android-dev/jdk ANDROID_HOME=/home/nyaarium/android-dev/sdk \
    ./gradlew :app:testDebugUnitTest --console=plain
  ```
  Compiles Kotlin + runs unit tests (incl. the new `ttsText` + volume-mapping tests). For the R8/minify gate also run `./gradlew :app:assembleRelease` (testDebugUnitTest runs un-minified and won't catch a strip). Item 7 is a JS asset, so the gradle build only packages it - no Kotlin compile for that one, but it still ships in the APK.

## Deploy sequence (after the PR merges + the APK builds)

1. `./start-gateway.sh` - rebuild the gateway (item 2 BSpace gateway gate; git pull + Docker rebuild).
2. `reload_plugins` on the host-daemon - deliver item 1's `tmuxCore` resize AND refresh the host-side `sendKey` gate for item 2 (needs the 5.0.24 bump merged first). The peek-resize then forces 58x40 with no host restart.
3. (optional) `./start-host-daemon.sh` - clean 58x40 host session from birth.
4. Update the Android app (in-app updater or sideload) - items 3, 4, 5, 6, 7.

## Open decisions for review

- **Item 3 heuristic:** title = first line/sentence, summary = first paragraph, caps 140/400. Confirm or adjust.
- **Item 5 volume:** (a) continuous slider vs stepped (e.g. 5% increments); (b) the pct->mB mapping - simple linear `(pct-100)*6` vs a log-accurate dB curve; (c) whether 200% is the right ceiling (LoudnessEnhancer can push higher but distortion grows).
- **Item 6 `/compact`:** confirm the insert-into-composer UX (tap pre-fills `/compact `, user edits, standard Send submits) over any alternative, and whether to auto-focus the composer on insert.

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

## Sequencing note for items 11-13

Item 11 (CLI-era teardown) should land BEFORE items 12-13 (create-session button, Copilot support). The teardown removes the old prompt-injection session-driving code; items 12-13 then rebuild session-launch + Copilot the right way under the new host_op/tmux architecture. The user accepts that the teardown deletes code that 12-13 partly reinvent - that's the point (do it right under the new model).

## Item 11 - CLEANUP: tear down the CLI-era (cursor / copilot / codex) infrastructure

**Reality check - the teardown is ~70% already done.** `src/mcp/cli/` does NOT exist (the prompt-injection spawners, `handleInject`, `promptBuilders`, `cliReply` are already gone), and `src/shared/mutex.ts` is gone. CLAUDE.md is STALE and still documents all of it. What remains is the host-side `dispatch_cli` tool, dead model-resolution, dead types, the gateway's vestigial `ConnectionMode "cli"` reject branches, and stale docs. This item is mostly dead-code + doc cleanup, not a big infra removal.

**(A) Delete outright.**
- `src/mcp/devcontainer/devcontainerCli.ts` - the whole `dispatch_cli` tool (`devcontainerCli.ts:registerDevcontainerCli`, `:pollJob`, `DevcontainerCliSchema` with `agent: z.enum(CLI_AGENT_TYPES)`, the cursor-agent/copilot/codex runner spawner). Sole non-test consumer is `src/mcp/index.ts`.
- `src/mcp/resolve-model.ts` - now fully dead except its own test (`resolve-model.ts:DEFAULT_MODELS`, `resolve-model.ts:resolveModel` has zero non-test callers). Dies once `helpers.ts` stops importing `DEFAULT_MODELS`.
- `src/__tests__/resolve-model.test.ts`.

**(B) Remove symbols/branches from shared files.**
- `src/mcp/index.ts` - the `import { registerDevcontainerCli }` and its call in the host branch (`index.ts:startMcp`).
- `src/mcp/devcontainer/helpers.ts` - CLI-only helpers: `helpers.ts:CLI_AGENT_TYPES`, `helpers.ts:EFFORT_LEVELS` (the `["simple","standard","complex"]` one - NOT the unrelated `setEffortLevel.ts:EFFORT_LEVELS`), `helpers.ts:resolveDevcontainerModel`, `helpers.ts:buildAgentCommand`, `helpers.ts:BuildAgentCommandParams`, the `DEFAULT_MODELS` import. KEEP the container-lifecycle internals (`assertNotContainer`, `resolveProject`, `ensureContainerUp`, `execInContainer`, ...) - load-bearing for `devcontainerExec.ts` + the wake path.
- `src/shared/types.ts` - dead `types.ts:InjectPayload` (referenced nowhere), `types.ts:EffortEnv` (only the dead `resolveModel` used it; `MODEL_SIMPLE/STANDARD/COMPLEX` env reads are fully dead), and the stale CLI comment block.
- **`ConnectionMode "cli"` entanglement (decision needed).** `mode` is the ONLY field distinguishing CLI from channel agents at the gateway, and every remaining "cli" branch exists to REJECT a CLI agent. Either (i) collapse to channel-only and drop the enum, or (ii) keep `mode` as a defensive reject. If collapsing, touch: `src/shared/schemas.ts:ConnectionModeSchema` (drop `"cli"`), `src/shared/types.ts:ConnectionMode`, `src/gateway/websocket.ts` (the `mode` derive + `WsData.mode`), `src/gateway/routes.ts:getTeamMode` + the `channelOnly` reject + the "CLI-mode agents are no longer supported" 400, `src/gateway/console/consoleHandler.ts` (the `ws.data.mode === "cli"` reject), `src/gateway/index.ts` (the two `mode: "cli" as const` upgrade defaults). NOTE: `ConnectionModeSchema` is codegen'd to Kotlin, so dropping `"cli"` is a wire-schema change -> `bun scripts/codegen-kotlin.ts` + Android build. Keeping `mode` as a guard is lower-risk; lean that way unless a clean cut is wanted.
- **Container-side twin:** `src/mcp/bridge/registerBridgeTools.ts:detectAgentType` + the `AGENT_CLI_NAMES` map probe agent type; post-teardown a container is always Claude/channel. Simplify `detectAgentType` to return `"claude"` (and drop cursor/copilot/codex) OR leave `AGENT_TYPE` as a future hook. Keep in sync with the gateway `mode` decision (`helpers.ts` sets `mode = isChannel ? "channel" : "cli"`).

**(C) Do NOT delete (CLI-named but channel/federation load-bearing).** `src/shared/pending-job-store.ts` (core channel-conversation + cross-Domain job store; only the stale `poll()` comment needs fixing), `src/mcp/bridge/replyTool.ts` (now channel-only: `channelReply` + `humanTools`), `src/mcp/devcontainer/devcontainerExec.ts` (`dispatch_exec`).

**(D) Stale docs/config to clean.** `CLAUDE.md` (the entire `cli/` subtree doc, the `mutex.ts` line, the "CLI mode (cursor/copilot/codex)" Connection Modes section, the `dispatch_cli` line, `AGENT_TYPE`/`MODEL_*` env docs, the `mutex.test.ts` testing example - all reference gone code); `README.md` (the "Cursor/Copilot/Codex" tagline, the inject-mode bullet, the `dispatch_cli` row, the `AGENT_TYPE=cursor` section); `skills/orchestrate/SKILL.md` + `skills/crosstalk/SKILL.md` (the `dispatch_cli` / `crosstalk_reply` / "CLI agents" lines); `agents/team-relay.md` (the `dispatch_cli` doc + `agent: cursor|copilot|codex` examples). Env files (`.mcp.json`, `docker-compose.yml`, `install.sh`, `Dockerfile`, `start-*.sh`) are ALREADY clean - nothing to change.

**(E) Tests.** Remove `resolve-model.test.ts`. If the `ConnectionMode "cli"` enum is dropped, update the `mode:"cli"` fixtures in `console-handler.test.ts` (the CLI-reject test + error-message asserts), `routes.test.ts`, `websocket.test.ts`.

## Item 12 - FEATURE: "create session" button (tmux create + launch)

A Console button that launches a NEW agent session (tmux new-session + `claude ...`) on a target, instead of only attaching to the one hardcoded `claude` session. Full path mapped; the hard part is session naming.

**The path, hop by hop** (mirrors the existing `peek`/`tmux_send` flow):
- Android button - `android/.../MainActivity.kt:SessionsScreen` (the "Agent Sessions" list screen; add an `onCreateSession` lambda + a `TopAppBar` action or FAB, or in `MainActivity.kt:EmptyBoard`).
- Android repo/client - `android/.../ChatRepository.kt` new `createSession` (twin of `ChatRepository:peekTerminal`/`:tmuxSend`) -> `android/.../ConsoleClient.kt` new `createSession` -> `ConsoleClient:relay(ConsoleOp.CreateSession, ...)` (twin of `ConsoleClient:peek`/`:tmuxSend`).
- Wire schema - `src/shared/schemas.ts:ConsoleOpSchema` new `create_session` member (sibling of `peek`/`tmux_send`). **Codegen change:** `ConsoleOp` is `.meta({id})`'d -> run `bun scripts/codegen-kotlin.ts` to regenerate `android/.../proto/Protocol.kt` (CI drift-checks it).
- Gateway dispatch - `src/gateway/console/consoleHandler.ts:dispatch` new `create_session` case (next to the `peek`/`tmux_send` cases): `resolveTmuxTarget(op.target)` then `relayToHost({kind:"createSession",...})`. Add it to `consoleHandler.ts:isMutatingOp` so a retried opId replays instead of double-launching.
- Gateway relay - `src/gateway/index.ts:relayToHost` (reused; may need to raise `HOST_OP_TIMEOUT_MS = 20_000` OR make the op fire-and-return rather than block on Claude booting).
- Host RPC - `src/shared/host-op.ts:HostOp` new `{ kind: "createSession"; target; ... }` variant (type-only, NOT codegen'd). `src/mcp/devcontainer/hostWakeListener.ts:handleHostOp` reused; add a `createSession` primitive to the `createHostOpRunner({...})` deps. `src/mcp/devcontainer/hostOpRunner.ts:createHostOpRunner` new `run` branch + `TmuxOps`.
- tmux primitive - `src/mcp/devcontainer/tmuxCore.ts` new `createSession` (twin of `tmuxCore:sendText`), building `tmuxArgv(target, ["new-session","-d","-s",<name>, <claude cmd>])`. Launch command template: `start-host-daemon.sh` (host) and `hostWakeListener.ts:handleWake` (devcontainer, the truest template - it already does `tmux new-session -d -s claude "... claude --model ... plugin:switchboard@..."`).

**Hard parts (flagged).**
1. **Session naming/collision (central).** `tmuxCore.ts:TMUX_PANE` is hardcoded `"claude.0"` and BOTH launch templates name the session `claude` - the whole peek/send layer assumes ONE session per target. A button that adds sessions breaks the 1:1 assumption. Easiest v1: scope "create session" to launching a KNOWN, not-yet-running catalog project (effectively a manual wake) - reuses all existing single-`claude` machinery, no multi-session plumbing. True multi-session-per-target requires threading a session name through `TmuxTarget` -> `TMUX_PANE` -> every primitive -> the team registry.
2. **Registration latency.** The button launches a process; the session appears as a team only after the in-session Claude's MCP plugin self-registers (`websocket.ts` register path). `list_teams` won't show it immediately - UI must poll/refresh (the wake path already models "launch then poll the pane for readiness").
3. **Host-op timeout.** Booting Claude may exceed `HOST_OP_TIMEOUT_MS`; return fast and let registration surface async rather than blocking the sealed relay.
4. **Auth/privilege.** Inherits the console seal (owner-signed `kind:console` admission) + the token-gated `host` WS slot - no new auth surface, but launching a session is heavier than keystroke injection, so keep `consoleHandler.ts:resolveTmuxTarget`'s allowlist (known projects + `gateway`) as the gate.

## Item 13 - FEATURE: Copilot support (limited - no channels API)

Drive a Copilot session through the SAME create-session -> host_op -> tmux path as item 12; the only divergence is the launch command in the `tmuxCore:createSession` primitive (a `copilot`/CLI-agent invocation instead of `claude ...`). Depends on items 11 + 12.

**The key design constraint.** Copilot has no channels API, so a Copilot session canNOT self-register as a channel team the way Claude does - the old CLI mode handled this with one-shot prompt injection (now torn down in item 11) and the console `send` path explicitly rejects non-channel agents today. So Copilot can't appear as a chat team. The natural fit under the new architecture: drive Copilot PURELY through the terminal view (peek + tmux_send on its tmux pane) - no channel registration, no chat thread, just the raw pane. The create-session button launches it; the terminal view operates it.

**Open questions to revisit.**
- Does Copilot get a tmux session that the terminal view targets (terminal-only, no team entry), or does it need a lightweight registry presence so it shows in the session list? If the latter, what registers it (the host daemon on launch, since Copilot won't)?
- Session naming again (item 12 hard-part 1): a Copilot session on the host/a container is a second session alongside `claude` -> needs the multi-session-name plumbing, OR its own target convention.
- This deliberately reinvents (correctly) the agent-launch capability item 11 removed - confirm the terminal-only model is the intended scope vs. any chat affordance.
