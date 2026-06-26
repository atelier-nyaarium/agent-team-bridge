# WebSocket STT (speech to text)

Status: collecting knowledge. Do not implement yet. Active focus per the owner
("focus on STT for now and we lap back" to TTS playback). The TTS playback issue
stays parked in `tts-playback-stream-bug.md` (TTS has no WebSocket; it is a
server-side REST `/stream` bug).

## Goal

Add speech-to-text over the VRCSTT WebSocket: capture mic audio, stream it up,
receive live transcription. Likely use is voice dictation into the message
composer (speak, see partial text, drop the final text into the field), but the
exact in-app UX is not confirmed yet (see open questions).

## Connection and auth

- Endpoint: `wss://vrcsttapi.azurewebsites.net/SpeechToText/Azure/v1`.
- On open, send a TEXT frame: `vrcstt-patreon-token <token>`.
- The server replies with a 4-digit text status code. `1000` = Authorized and
  ready. Full set:

  | Code | Meaning | | Code | Meaning |
  |------|---------|-|------|---------|
  | 1000 | Authorized (ready) | | 1009 | TTSDenied |
  | 1001 | Unauthorized | | 1010 | STTSDenied |
  | 1002 | InvalidToken | | 1011 | InvalidService |
  | 1003 | MembershipNotFound | | 1012 | ServerError |
  | 1004 | MembershipExpired | | 1013 | PaymentDeclined |
  | 1005 | TooManyLoginRequests | | 1014 | UnknownPatreonStatus |
  | 1006 | NotEnoughTokensRemaining | | 1015 | UnknownReason |
  | 1007 | TextTranslationDenied | | 1016 | BadRequest |
  | 1008 | STTDenied | | | |

## Message flow (ordered, per message)

The WS is ordered and the whole pipeline relies on ordered input. Each utterance
is three steps in strict order:

1. **MessageRequest** (text frame, JSON):

   ```json
   {
     "MessageId": "2026-06-12T23:09:20.6121073-04:00",
     "LogId": "58388b2d",
     "ServiceId": 1,
     "SpokenLanguage": "en-US",
     "TranslateTo": ["en"],
     "SentenceTimeoutMs": 500,
     "TimeoutMs": 1500,
     "ProfanitySetting": "Raw"
   }
   ```

   - `MessageId`: current datetime, ISO 8601 with offset.
   - `LogId`: random string, max 8 chars.
   - `ServiceId`: 1 (meaning TBD; presumably the STT service selector).
   - `SpokenLanguage`: the spoken locale, e.g. `en-US`.
   - `TranslateTo`: array, must include `SpokenLanguage`.
   - `SentenceTimeoutMs` 500, `TimeoutMs` 1500: keep as given.
   - `ProfanitySetting`: Raw / Masked / Removed. Use Raw.
   - Init is silent: no ack that the request was accepted.

2. **Audio data** (binary frames): raw PCM, 16 kHz, mono, 16-bit (2 bytes/sample),
   streamed up. Bites are at most 30 seconds. Incomplete audio still works.

3. **Complete** (text frame, literally `"Complete"`): required. A failed Complete
   leaves the message in an errored state. Sending Complete is what finalizes.

Error tolerance: if a MessageRequest errors, the server consumes and discards
whatever audio/data is sent after it until the next MessageRequest arrives. So
recovery is: send a fresh MessageRequest and resume.

## Results (received while audio is processed)

As the audio is processed, the server pushes JSON text frames with growing
interim transcriptions, then finalizations:

```json
{"MessageId":"0001-01-01T00:00:00","Message":{"en":"this is a test"},
 "StartTicks":3500000.0,"MessageLanguage":"en",
 "CreateDateTime":"2026-06-12T22:49:08.78-04:00",
 "IsFinalInterimResultForStartTicks":false,
 "IsFinalInterimResultForMessageId":false}
```

- `Message`: a map of language -> text (e.g. `{"en":"this is a test"}`), matching
  `TranslateTo`. Each frame's text is the current transcription as it grows
  ("this is" -> "this is a" -> ... -> "This is a test of the speech to text.").
- `IsFinalInterimResultForMessageId: true`: the final frame. Its `Message` is the
  complete, finished result. This is the only signal the client needs.
- `StartTicks` and `IsFinalInterimResultForStartTicks` are effectively
  deprecated (per Crab, largely unused now). The client does NOT need to stitch
  results together by `StartTicks` or track per-segment finalization.

Consumer model (simplified): show the latest frame's `Message` text as the live
partial, and take the frame with `IsFinalInterimResultForMessageId: true` as the
final transcription. No segment stitching, no `StartTicks` bookkeeping.

## Android implementation sketch (when greenlit)

- WS client: OkHttp `WebSocket` (the app already uses OkHttp). New `SttWsClient`.
- Mic capture: `AudioRecord`, source MIC, 16000 Hz, mono, `ENCODING_PCM_16BIT`,
  which matches the wire format exactly (no resampling). Needs the
  `RECORD_AUDIO` runtime permission.
- Flow: connect -> send token -> await 1000 -> send MessageRequest -> stream
  `AudioRecord` PCM buffers as binary frames -> on stop send `"Complete"` ->
  collect result JSONs -> surface text.
- 30s cap: stop-and-restart a new MessageRequest per 30s, or cap an utterance at
  30s. Confirm whether STT enforces the 30s the same as the TTS side.
- Result handling: parse each frame, show its `Message` text as the live partial,
  and finalize on `IsFinalInterimResultForMessageId: true`. Ignore `StartTicks`.
- MessageId/LogId: generate per utterance (ISO datetime; 8-char random).
- UX target (unconfirmed): a mic button in the thread composer; live partial
  transcription; on final, place the text in the input for the user to send.

## Open questions (for Crab / owner)

1. The `vrcstt-patreon-token` value: the same `sttsKey` already in the
   provisioning blob, or a separate token?
2. In-app scope/UX: is STT for dictating chat messages in the composer, or
   something else? This decides the UI work.
3. Does STT enforce the 30s max per MessageRequest like the TTS side, and is the
   input strictly 16 kHz / mono / 16-bit?
4. `ServiceId` values (is 1 always STT? do other ids select translation/TTS?).

## Testing plan

- Emulator: feed a known PCM WAV (16k/mono/16-bit) as the mic source (or use the
  emulator mic), connect, auth (observe 1000), send MessageRequest, stream the
  audio, send Complete, and confirm the interim result frames arrive and the
  final text matches.
- Verify the errored-state recovery: bad MessageRequest, then a fresh one resumes.
- Follow /debug discipline: capture the actual frames (codes, JSON, sizes) and a
  correct final transcription before claiming it works.
