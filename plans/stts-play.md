# STTS Play: speak the summary tier through VRCSTT

The notification Play button (stubbed in NotificationReceiver.ACTION_PLAY)
synthesizes a message's `summary` tier through the VRCSTT "STTS" service and
plays the WAV. This is the consumer the required `summary` field was added for.

## API map (from temp/Swagger.txt DOM snapshot + temp/notes.txt)

- Service: VRCSTTAPI, OAS 3.0. Product site vrcstt.com (WordPress storefront,
  desktop VRCSTT.exe, Patreon-gated keys); the API base URL is NOT public on
  the site and is still unknown - it ships inside the desktop app.
- Auth: `vrcstt-api-key: <key>` header on every TTS call. Key lives in the
  provisioning blob (`sttsKey`, already added to
  ~/android-dev/secrets/phone-provisioning.json alongside an empty `sttsUrl`).
- Endpoints:
  - `POST /TextToSpeech/{Provider}/stream` -> raw WAV streamed back.
  - `POST /TextToSpeech/{Provider}/sample` -> short voice sample (ElevenLabs
    has NO sample route).
  - Providers: Amazon, Azure, ElevenLabs, Google, IBM, OpenAI, Uberduck, xAI.
  - `GET /health`.
  - Out of scope for Play: `/AI/OpenAI/Chat`, `/AI/ChatGPTOpenAI/Chat`,
    `/Translation/Azure`, `/Authentication/*`, `/Patreon/Webhook`.
- Request bodies: per-provider `TextToSpeech{Provider}Request` schemas. The
  snapshot has them COLLAPSED - field names unknown. ElevenLabs nests
  `...RequestData` + `...RequestSettings` sub-objects. Notes confirm "each
  service has a custom json".

## Blocked on (ask the API owner)

1. Base URL the phone can reach.
2. Per-provider request fields - live Swagger JSON
   (`<base>/swagger/v1/swagger.json`), a Postman export, or one example body
   per provider of interest. With the live spec, introspect and fill
   `SttsClient.requestBody()` per provider.
3. Whether /sample is free/cheap vs /stream (for the settings voice picker).

## Built already (uncommitted, switchboard holds pushes)

- `SttsClient.kt`: blocking-OkHttp client mirroring PhoneClient idioms.
  Provider enum (sample-less ElevenLabs modeled), health(), stream()/sample()
  writing WAV to a dest file, placeholder `{text, voice}` request body with a
  single per-provider override point.
- `Provisioning` gains `sttsUrl`/`sttsKey` (optString, default empty -
  re-pasting an old blob still works; empty key disables Play).

## Remaining phases

1. Introspection lap (needs base URL): GET /health with no key; fetch live
   swagger.json; one /sample call per candidate provider with the key; parse
   the WAV (RIFF header, sample rate, duration) to verify; lock the request
   shapes into requestBody().
2. Playback path: ACTION_PLAY resolves the message (summary ?: title ?: text),
   SttsClient.stream() to cache (reuse the updates/ cache-dir pattern), play
   via MediaPlayer; foreground-service-safe (the receiver hops to a coroutine
   or short-lived service - receivers cannot block).
3. Settings: provider picker + voice field; Play-a-sample button using
   /sample; surface health state. sttsUrl/sttsKey stay provisioning-blob-fed.
4. Emulator lap: fake server first (local HTTP fixture serving a WAV) so the
   pipeline laps offline, then live once the base URL exists.

## Verification notes

- Claude cannot listen to audio, but verifies WAV programmatically: RIFF/fmt
  header parse, sample rate, channel count, duration, non-silence amplitude
  check (python wave module on the host; no ffprobe installed).
- Live verification protocol: synthesize a known sentence, assert WAV header
  sanity + plausible duration for the text length, then the human ears it.
