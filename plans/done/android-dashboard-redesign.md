# Android Dashboard Redesign

Redo the phone UI from "texting app" energy to "engineering dashboard" energy.

User direction:
- Kill "inbox" vocabulary. Use "threads" / "agent sessions" style words (Claude devises the final set).
- No chat bubbles. Full-width rows, left-aligned only. User messages get a tinted background; agent messages untinted.
- Rich rendering: markdown (#headings, links, emphasis, tables), fenced code blocks with a few languages, simple mermaid diagrams, simple image and file gallery.
- A demo transcript exercising all of the above ships with the app. The implementing agents do laps of testing against the demo on the emulator and fix what's off; the plan does not need to nail pixel details up front.

## Questionaire

**1. Rendering engine for message bodies?**

Answer: **A) One WebView renders the whole thread.** Bundle markdown-it + highlight.js + mermaid.js as app assets; transcript becomes HTML/CSS; Compose keeps only the chrome (top bar, tabs, input box).

Reason (recommendation chosen): mermaid forces a WebView somewhere; one engine renders everything consistently; the dashboard look is what CSS is good at; demo-lap fixes become stylesheet edits. Phone transcripts are small enough that losing LazyColumn does not hurt.

Follow-up resolved: user asked whether native markdown + per-mermaid WebViews would be cheaper. No: the cost unit is WebView instances (one Chromium renderer each), not mermaid renders. One shared WebView renders N mermaids as SVG nodes cheaply. User's "disappear messages ~2x viewport off screen" idea maps to CSS `content-visibility: auto` + `contain-intrinsic-size` (built-in browser virtualization), plus IntersectionObserver-gated lazy mermaid init with SVG kept after first render.

**Vocabulary (devised by Claude, accepted):** top screen is **Sessions** (header "Agent Sessions", rows are agent sessions); a conversation is a **Thread**; back button says "Sessions". Code identifiers follow (`inboxTeams` -> `sessions`, `InboxScreen` -> `SessionsScreen`). "Peer" remains internal arbiter vocabulary only.

**2. Color theme?**

Answer: **B) Follow system light/dark.** Two CSS palettes + matching highlight.js/mermaid themes, Compose light/dark colorSchemes, kept visually consistent. Demo-testing laps audit both themes.

**3. Where does the demo transcript live?**

Answer: **B) Debug-build-only synthetic session pinned in the Sessions list.** Invisible in release builds. User: "Only needed for dev testing. I will see it in action while production using the app." It still renders through the real Thread view pipeline, just with a canned transcript instead of mailbox data.

**4. Image/file gallery: render layer only, or wire real attachments too?**

Answer: **B) Wire real attachments end to end.** User: "Real attachments. Then Claude can send actual screenshots." Scope includes the mailbox protocol, arbiter phone handler, and the agent-side reply path, not just the gallery renderer.

**5. Attachment direction?**

Answer: **B) Both directions.** User: "I may send screenshots or even log files or whatever at it." Inbound: agent reply attachments -> base64 over the relay -> mailbox -> gallery. Outbound: phone picker -> base64 through the `send` op -> agent-side materialization (mirroring the Discord inbound path).

**6. Does the Sessions screen get the dashboard treatment too?**

Answer: **B) Full dashboard.** User: "Make it pretty!" Status cards, per-session activity summaries, arbiter health. User context: "I know I'm asking for seemingly a lot, but thats the whole point of a phase based plan doc. We walk through the foundational steps 1 at a time."

## Plan

Phases ordered so each lands independently testable. Demo-lap phases (P4, P8) explicitly budget agent iteration: render, screenshot on the emulator, fix, repeat, in both themes.

User direction on fuzziness: the formatting/viewing work (P4 especially) is expected to be the fuzzy part. Implementing agents get freeform license there: the plan specifies the rendering matrix and acceptance loop, not the pixels, spacing, or fixture wording.

### Wire map (current state, verified against source)

The attachment plumbing is further along than the phases assumed. What exists today:

- `ChannelFile {filename, mime, size, descriptiveKey, base64?}` (`shared/types.ts:15`) with `ChannelFilesSchema` validation (`shared/schemas.ts:115`).
- `PhoneSendOp.files`, `PhoneRespondOp.files`, `MailboxEntry.files` already typed (`shared/phone-protocol.ts`) and accepted by `PhoneOpSchema` (`shared/schemas.ts:142,150`).
- `ChannelPushPayload.files` exists; `PhonePeer.send` already copies `channel_push` files into the mailbox entry (`arbiter/phone/phonePeer.ts:62`).
- `channelNotify.ts:28` materializes inbound files via `materializeFiles()` to `/tmp/evie-files/<id>/` and prepends a `[FILES]` block, but only when `payload.discord_message_id` is set.
- The 500 MB-class base64 `dm_forward` path already rides the same arbiter<->evie WS, so relay frame size is not a new constraint for phone attachments.

What is missing (the actual gap list):

- Outbound (phone -> agent): `phoneHandler.ts` `case "send"` does not pass `op.files` to `routes.send`; `SendRequestSchema` (`routes.ts:37`) has no `files`; the `channelPayload` built in `routes.ts:246` has no `files`; `channelNotify` keys materialization on `discord_message_id` which phone messages lack.
- Inbound (agent -> phone): `ChannelReplySchema` (`shared/schemas.ts:48`) has no attachments; `replyTool.ts` sends none; `RespondBodySchema` (`routes.ts:49`) rejects unknown `files`; `ResponsePayload`/`ResponsePushPayload` (`types.ts:64,76`) have no `files`; `routes.respond` builds the push without files; `PhonePeer.send` `response_push` branch (`phonePeer.ts:68`) does not map files.
- Phone `respond` op files: typed in the protocol but `phoneHandler.ts:311` does not forward them; the Android app currently only uses `send` for outgoing thread messages, so this stays protocol-supported but unwired until the app needs it.
- `DeviceMailbox` caps are count-based only (`DEFAULT_MAX_ENTRIES = 200`); multi-MB base64 entries need byte-aware accounting.

## P1 - Renderer foundation (WebView assets)

- `android/app/src/main/assets/thread/`: `thread.html`, `thread.css`, `thread.js`, vendored minified `markdown-it` (~100 KB), `highlight.js` custom build (core + kotlin/ts/js/bash/json/diff, ~120 KB), `mermaid` (~2.8 MB min, UMD build so no module loader is needed offline). APK grows ~3 MB; acceptable.
- New dependency: `androidx.webkit` for `WebViewAssetLoader` - add to `gradle/libs.versions.toml` + `app/build.gradle.kts` (serve assets from `https://appassets.androidplatform.net/assets/...` so ES modules and fetch behave; `file://` URLs break mermaid).
- Renderer contract (JS side): `window.thread.setMessages(json)` and `window.thread.appendMessages(json)` called via `evaluateJavascript`; message shape `{id, role: "user"|"agent", from, at, body, files?: [{name, mime, src?}], status?}`.
- Layout: full-width rows, left-aligned only; `.row.user` tinted background, `.row.agent` plain; sender + timestamp header line per row; row separators not bubbles.
- Light/dark: Kotlin sets a `dark` class on `<html>` from Compose's `isSystemInDarkTheme()` (audit: `setAlgorithmicDarkeningAllowed` is API 33+, `forceDark` deprecated; a class toggle is deterministic across minSdk 26..35 and keeps WebView and Compose on the same source of truth). highlight.js + mermaid theme selected off the same class.
- Virtualization: `content-visibility: auto` + `contain-intrinsic-size` on rows; IntersectionObserver-gated mermaid init (render once, keep SVG).
- Mermaid failures degrade to the raw fenced block plus a small error note, never a blank row.
- Security (agent markdown is semi-trusted; it can relay hostile web content): `javaScriptEnabled` on for the bundled renderer only. `shouldInterceptRequest` blocks every non-appassets resource load - this is the callback that covers subresources like `<img src=http://...>`; `shouldOverrideUrlLoading` only sees navigations, so it handles link taps (escape to system browser via Intent) and is not the blocking layer. markdown-it runs with `html: false` (no raw HTML passthrough) and a link-protocol allowlist (http/https only); mermaid runs with `securityLevel: "strict"`. No `addJavascriptInterface` bridge in P1/P2 (message data flows one way via `evaluateJavascript`); if a later phase adds one, it must expose no filesystem or token surface. No `allowFileAccess`.

## P2 - Thread view swap

- Replace `MessageBubble`/LazyColumn body with the WebView in a Compose `AndroidView`; keep Compose chrome: top bar, tabs, input row, error line.
- WebView ownership (audit-corrected): a view referenced only inside `AndroidView` dies when `ThreadScreen` leaves composition (back to Sessions kills it). Hold a per-thread `WebView` pool OUTSIDE composition (Activity-scoped `Map<String, WebView>` keyed by team); the `AndroidView` factory pulls from the pool, so tab switches and Sessions round-trips keep each thread's scroll position and rendered DOM. Pool is bounded by the open-tabs set: closing a tab destroys its WebView.
- IME: set `android:windowSoftInputMode="adjustResize"` on MainActivity (currently unset, defaults to unspecified) so the keyboard shrinks the WebView instead of covering the input row; sanity-check on API 26 and 35.
- Scroll-to-bottom on append unless the user has scrolled up (JS tracks proximity to bottom).
- `Message` model (`ChatRepository.kt:15`) gains `id: Long = 0` plus persist/load support; messages loaded from old JSON get ids reassigned from their list index on load, so the default never collides. Semantics: `id` is a local-only stable row key for the WebView DOM (per-thread counter), NOT the mailbox seq; poll dedupe stays `lastSeq`-based and epoch-aware exactly as today. `files` comes later (P6).

## P3 - Vocabulary sweep

- Inbox -> Sessions everywhere: screen names, button labels, composable/identifier names (`InboxScreen` -> `SessionsScreen`, `inboxTeams` -> `sessions`, `onInbox` -> `onSessions`).
- Thread stays the conversation word. "Peer" remains arbiter-internal vocabulary.
- Ordered before the demo laps (audit) so P4 screenshots exercise the final vocabulary instead of churning on renamed chrome. Surface is bounded: "inbox" appears only in `MainActivity.kt` + `ChatRepository.kt`; zero TypeScript or cross-repo references.

## P4 - Demo session + render laps (debug builds only) [agents freeform]

- Canned transcript fixture exercising the full matrix: #headings, [links](), bold/italic/strikethrough, lists, blockquotes, | tables |, fenced code (kotlin, ts, bash, json, diff), two simple mermaid diagrams (flowchart, sequence), image gallery row, file chip row, a long plain-text message, a pathological message (huge code block) for virtualization sanity.
- Gallery/file rows in the fixture use data-URI images and fake file entries - no attachment plumbing required at this phase.
- Synthetic session pinned in the Sessions list under `BuildConfig.DEBUG` with a visible "demo" badge so it cannot be mistaken for a live peer; invisible in release.
- Persistence isolation (audit): the demo transcript never flows through `append()`/`persistThreads` - it renders from an in-memory fixture only, so it cannot pollute the encrypted thread store or resurface stale in later sessions.
- Agents do laps: load demo on emulator, screenshot light + dark, fix CSS/JS/fixture, repeat until the matrix renders correctly. Acceptance is the demo looking right on screenshots, not pixel specs in this plan. Freeform license: visual judgment calls (spacing, type scale, tint strength, table styling, gallery layout) belong to the implementing agent.

## P5 - Sessions dashboard

- Full redesign of the list screen: per-session cards with status chip (live/offline), mode, unread badge, last-activity time + one-line snippet (derived from the local thread tail).
- Header strip: bridge health (poll success/failure streak + register state already tracked in `ChatRepository`), device name, gap warning relocated here.
- Data inventory (all already on the phone, no new protocol): `Team {name, status, mode, queue_depth}` from `list_teams`; `unread`, `threads` tails, `labels`, `gap`, `error`, `status` from `ChatState`; last-activity = max `Message.at` per thread. One gap (audit): `pollFails` is private to `ChatRepository` - expose it as `pollFailStreak: Int` on `ChatState` for the health strip. If the design wants more (e.g. arbiter uptime), that is new protocol surface and gets deferred, not snuck in.
- Pretty per user mandate ("Make it pretty!"); final look iterated on the emulator with the same freeform license as P4.

## P6 - Inbound attachments (agent -> phone)

- `ChannelReplySchema` gains `attachments?: string[]` (absolute paths, same vocabulary as `respond_to_human`); `replyTool.ts` reads each path, base64-encodes, ships `files: ChannelFile[]` in the `/respond` payload (size-capped client-side with a clear error listing the offending file). Reference implementation for the read/encode pattern: `humanTools.ts` / `routes.ts:humanRespond`.
- Arbiter: `RespondBodySchema` + `ResponsePayload` + `ResponsePushPayload` gain `files` (validated by `ChannelFilesSchema`); `routes.respond` copies files into the push; per-message cap 10 MB raw enforced arbiter-side as backstop. The `resolveHandshake` path ignores files (handshakes never carry them).
- Memory (audit): the `PendingJobStore` result for persistent channel conversations is never swept, so `routes.respond` must NOT retain base64 in the stored result - store files metadata-only (strip `base64`), let bytes ride only the live push/mailbox. A sender that missed the push re-requests the file rather than polling it out of the store.
- `PhonePeer.send` `response_push` branch maps `p.files` into the mailbox entry (channel_push branch already does, `phonePeer.ts:62`).
- `DeviceMailbox`: byte-aware cap alongside the count cap (e.g. 30 MB per mailbox, sized via serialized entry length); evictions count toward `dropped` exactly like the count cap, preserving drain/cursor semantics.
- Phone: poll decodes `files` to app-private storage (`filesDir/attachments/<epoch>-<seq>/`), thread rows render image thumbnails (tap = full-screen viewer) and file chips (tap = open/share via FileProvider, scoped to the attachments dir only); persisted thread JSON stores local paths, not base64. Filenames pass a basename-only sanitizer equivalent to `safeFilename()` (`evieFiles.ts:45`) before any `File(parent, name)` so an agent-authored `../../` name cannot escape the directory.
- Renderer mapping (audit): Kotlin receives `ChannelFile[]`, decodes to disk, and hands the JS renderer `{name, mime, src}` where `src` is an appassets-proxied local path - the WebView never sees base64 or raw `ChannelFile` shapes.
- Size-cap enforcement points (audit): the agent-side `replyTool` cap is advisory (agent machine); the arbiter backstop is the trust boundary - sum `base64.length` cheaply right after shape-parse in `routes.respond`/`routes.send` and in the relay pump before any store/mailbox write, rejecting with a per-file error. Zod shape validation alone never bounds memory.

## P7 - Outbound attachments (phone -> agent)

- Input bar attach button: SAF picker (any file type), preview chip row above the input, client-side size cap.
- `PhoneClient.send` ships `files: ChannelFile[]`; `phoneHandler` `case "send"` forwards `op.files`; `SendRequestSchema` + `routes.send` channel branch carry `files` into the `channelPayload` (the `message_id` already generated there becomes the materialization key).
- `channelNotify.ts`: materialize when `files` present using `discord_message_id ?? message_id` as the bucket key, so phone files land under `/tmp/evie-files/<message_id>/` in the target container and agents `Read` them from the `[FILES]` block exactly like Discord inbound files. No new materializer needed (`materializeFiles` just needs the fallback key at its call site).
- Phone-origin files always carry `base64` (the phone has no fetch-later store), so every entry materializes; adjust `renderFilesBlock` wording so the `evie_fetch_message_files` hint is only emitted for evie-origin metadata-only entries.
- Idempotency: files ride the existing `(conversationId, opId)` dedupe; a retried send must not re-push the channel message. The op cache coalesces retries onto the in-flight promise (so the backgrounded `SEND_BOUND_MS` continuation also runs once); pin this with a test (retry during continuation produces exactly one mailbox entry).

## P8 - Full audit lap + deploy

- End-to-end lap: demo matrix both themes; real thread round trip with an image both directions (agent screenshots -> phone gallery; phone photo -> agent `[FILES]` Read); sessions dashboard states (live/offline/unread/gap).
- Large-file relay check: one deliberately big attachment (~8 MB) end to end. The relay is verified opaque to file payloads (`evieClient.ts` pipes `phone_relay` frames without inspecting them; the dm_forward path already carries far larger base64), but the k8s API service-proxy hop is unverifiable from this repo, so prove it live.
- Deploy gates per phase (audit): P1-P5 are APK-only (CI build + install, no host deploy). P6 + P7 change the MCP plugin schema and the arbiter together: one plugin version bump for the batch (`.claude-plugin/plugin.json` + `package.json`; the MCP server reads `packageJson.version`), push, `reload_plugins` on containers, arbiter restart. Do not bump per phase.
- Commit per phase along the way, APK release via CI, arbiter restart per the deploy ritual in CLAUDE.md. Never push without asking.

### Audit triage (laps 1-2)

Lap 1 (Android/WebView, arbiter/protocol, phasing/cross-repo) and lap 2 (consistency, Android claims, security) auditors vetted the plan. Accepted findings are folded into the phases above. Rejected findings, so future laps do not re-raise them:

- "Move attachment plumbing before the demo phase": rejected - the demo gallery runs on fixture data URIs, no plumbing needed.
- "Backgrounded send continuation duplicates mailbox entries on retry": rejected as a defect - the op cache coalesces a retried opId onto the same in-flight promise, so the continuation runs once. Kept as a test to pin (P7).
- "Three-place version bump": this repo's MCP server reads `packageJson.version` (`mcp/index.ts:76`), so plugin.json + package.json cover all three.
- "Attachment wiring is missing" (raised as blockers in both laps): not a plan gap - the missing wiring IS the P6/P7 work; the Wire map section documents it deliberately.
- Confirmed non-issues: old APK ignores unknown `files` fields in poll responses (org.json `opt*` accessors); evie relay is opaque to attachments; "inbox" vocabulary is Android-local; P5's data inventory is otherwise fully reachable from `ChatState`/`PhoneClient`.

### Notes for implementers

- The demo fixture is the contract: when rendering looks wrong against it, fix the renderer, then extend the fixture if a real-world case was missing.
- Emulator loop: `source ~/android-dev/env.sh`, AVD `phone35`, `./gradlew :app:assembleDebug`, adb install, screencap; uiautomator dump when screenshots exceed the 2000px view limit.
- Keep `ChannelFileSchema` shape-stable: evie-bot's `ForwardDmFile` mirrors it (cross-repo lockstep note in `shared/schemas.ts:113`). Phone attachments reuse the shape as-is (`descriptiveKey` can be the filename for phone-origin files).
- Run `bun run lint` + `bun run test` per phase; Android side compiles + installs on the emulator per phase.
