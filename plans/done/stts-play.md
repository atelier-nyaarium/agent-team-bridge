# STTS Play: speak messages through VRCSTT

The notification Play stub becomes a real playback feature: "Play Full" and
"Play Summary" actions on message notifications, and a per-message "Play"
button in the thread view. Audio synthesizes through the VRCSTT STTS service
(`SttsClient.kt`, drafted) and caches per message; Forget on a session purges
its cache. This consumes the `summary` tier added for exactly this.

## API facts (from temp/ artifacts; see SttsClient.kt header)

- `POST /TextToSpeech/{Provider}/stream` -> raw WAV; `/sample` for a short
  voice sample (ElevenLabs has no sample route). `GET /health`. Auth header
  `vrcstt-api-key`. Providers: Amazon, Azure, ElevenLabs, Google, IBM, OpenAI,
  Uberduck, xAI. Per-provider custom JSON bodies; field names NOT in the dump.
- Credentials ride the provisioning blob: `sttsKey` (set) + `sttsUrl` (empty,
  HARD GATE: the base URL is not in any artifact and not public on vrcstt.com;
  it ships inside the desktop exe - must come from the API owner, ideally with
  the live `swagger/v1/swagger.json` or one example body per provider).

## Phase 1: introspection laps - DONE 2026-06-12

Base URL: https://vrcsttapi.azurewebsites.net (set in the provisioning blob).
Swagger UI is disabled in prod; shapes were introspected via empty-body
validation errors, then one live synthesis per provider (temp/stts-lab/).
Confirmed: Amazon {text,engine,modelId,language} / Azure {text,region,modelId,
language} / Google {text,modelId,language} / IBM {text,modelId} / OpenAI
{text,engine,modelId,language} / xAI {text,language,voiceId} / Uberduck
{speech,voicemodel_uuid} (needs a real voice uuid) / ElevenLabs
{VoiceId,RequestData{text,model_id,voice_settings{stability,similarity_boost}}}
(accepted, zero-byte stream: the service has no ElevenLabs key; SKIP it).
Audio: MP3 for Amazon/Azure/Google/xAI, length-unbounded streaming WAV for
IBM/OpenAI, all mislabeled content-type audio/wav - sniff the container, never
trust the header or its WAV length field. Verified durations 1.6-2.8s for the
test sentence, non-silent RMS on the WAVs. Shapes locked into
SttsClient.requestBody().

## Phase 1 original spec (kept for reference)

- No-key `GET /health`; fetch live `swagger.json` and extract every
  `TextToSpeech{Provider}Request` schema (fallback: ask for a Postman export
  or example bodies).
- Lap per provider: call `/sample` (ElevenLabs: short `/stream`) with the key,
  save to `temp/stts-lab/<provider>.wav`, machine-verify each file: RIFF/fmt
  header, sample rate, channels, bit depth, duration seconds
  (data bytes / byte rate), duration plausibility vs text length, non-silence
  RMS. python `wave` on the host (no ffprobe). Human ear-checks one or two.
- Lock real request shapes into `SttsClient.requestBody()` per provider;
  document each provider's voice identifier format next to it. Commit.

## Phase 2: playback engine + per-message cache (app)

- `SttsPlayer` (new): owns synthesis + cache + MediaPlayer.
  - Cache key: `(team, message.at, tier, provider, voice)` - `Message.at` is
    the stable per-message identity (`Message.id` is reassigned on load, NOT
    stable). Path: `filesDir/stts/<team>/<at>-<tier>.wav`.
  - Single-flight: an in-flight set on the cache key. Impatient multi-taps
    while synthesizing are no-ops; a cache hit plays immediately with no
    re-fetch. Starting a new playback stops the previous one.
  - Text preparation: tier full = message text run through a light TTS
    sanitizer (drop fenced code/mermaid blocks, collapse the FILES block and
    links to their labels, collapse whitespace); tier summary =
    `summary ?: tiny-title ?: sanitized text`.
- Forget purges: `ChatRepository.forget(team)` (ChatRepository.kt:480) also
  deletes `filesDir/stts/<team>/` recursively. Repo already holds filesDir.
- No size cap needed beyond Forget (WAVs are bounded by message counts), but
  delete a message's stale tier file if a re-synthesis is forced later.

## Phase 3: notification actions

- Rename the stubbed action "Play" -> "Play Summary"; add "Play Full" BEFORE
  it (addAction order controls display order; 2 actions, under Android's 3
  cap). Both carry team + the burst-last message's `at` in the intent extras.
- `NotificationReceiver` routes both to `SttsPlayer` with tier full/summary.
  Receivers cannot block: `goAsync()` + launch on the Repo-owned scope, finish
  on completion. Multi-tap idempotency is Phase 2's single-flight.
- Buttons only when configured: skip addAction when the provisioning has no
  sttsUrl/sttsKey, so unconfigured installs see no dead buttons.

## Phase 4: in-thread Play button

- Agent (inbound) message rows get a top-right "Play" button in the WebView
  renderer, same behavior as Play Full for that specific message.
- ThreadRenderer gains an `onPlayTap(at)` callback beside the existing
  onRetry/onAttachmentTap bridge pattern; the row template adds the button for
  non-self rows only. Hidden entirely when STTS is unconfigured (and in the
  demo thread unless a fixture is active).
- Visual: small icon button, top-right of the bubble, no layout shift on long
  bodies; playing state swaps to a stop glyph (tap again = stop).

## Phase 5: settings + emulator lap

- Settings: provider picker (enum), voice text field, "Play a sample" button
  (uses /sample; ElevenLabs falls back to stream), health indicator gating.
  Persisted in ProvisioningStore prefs (NOT the blob - blob carries only
  credentials).
- Emulator lap runs OFFLINE first: a local fixture (python http.server serving
  a generated WAV at the stream/sample paths) with sttsUrl pointed at
  http://10.0.2.2:<port>. NOTE: cleartext HTTP needs a debug-only
  networkSecurityConfig allowing 10.0.2.2, or the fixture is unreachable on
  modern Android. Verify: multi-tap fires one synthesis; cache hit replays
  without a request; Forget deletes the team's cache dir; both notification
  actions and the in-thread button play.
- Live lap once sttsUrl exists: repeat against the real service, then the
  human ear-check.

### Notes for implementers

- Lean passes; switchboard pushes are currently held - local commits only.
- `SttsClient` stays the ONLY owner of wire shapes; `SttsPlayer` the only
  owner of cache layout. UI layers never touch OkHttp or files directly.
- Emulator harness: `source ~/android-dev/env.sh`, AVD phone35,
  `wm size 720x1600` + `density 280`, reset after.
- Built already: SttsClient.kt (placeholder bodies), Provisioning
  sttsUrl/sttsKey, key staged in ~/android-dev/secrets/phone-provisioning.json.
