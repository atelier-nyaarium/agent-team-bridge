# Attachment gallery: unified message + draft

## Questionaire

Settled during design-card iteration (dock group `Attachments`: `message-attachments`,
`draft-attachments`, `attachment-viewer`).

**Goal.** Three surfaces render attachments three different ways today: inbound rows get thumbs and
taps, own rows get thumbs with dead taps, drafts get a bare filename chip with no thumb and a
non-scrolling row that clips past the screen edge. Unify them to kill the diverging code bug-class.

**Message row**
- Images: thumb only, NO filename, wrap horizontally onto following lines.
- Files: narrow one-line rows, stacked vertically, never a fat chip. Name only, ellipsis rather
  than a second line, and each row has to read as a control rather than a line of text. No size on
  the row (owner's call after seeing it rendered); the size still shows in the fullscreen viewer.
- Images always first, then files.
- Nothing expands in place. No inline name reveal. Identical for own rows and theirs.

**Fullscreen viewer** (tap anything)
- Opens fitted: whole image exactly inside the frame, centred.
- Zoom presets `50% / 100% / 200%` are TRUE PIXEL scale (100% = one image pixel per screen pixel),
  plus a reset-to-fit icon. Pinch anywhere. Anchored on frame centre.
- Buttons are plain momentary taps. No lit/active state ("set it and forget it").
- Above 100%, interpolation is disabled (nearest-neighbour) so pixel art does not blur. Owner has
  standing permission to cut this to smooth zoom if it fights the platform; the TRUE-PIXEL SCALE
  MATH is the part that may not be cut. See section 6 for the one case where smooth is correct
  anyway.
- Info rows for a message attachment: `Size` (with dimensions) and `Modified` only.
- Non-image: same sheet, stage becomes a file glyph, dimensions dropped.

**Location field**
- Shown ONLY in the draft viewer. It is a pre-send sanity check.
- Omitted from messages entirely and NEVER put on the wire (a device path carries username and
  folder layout, and these cross a gateway to another machine).
- Enforced structurally: the picked-file type carries `sourceLocation`, the sent `MessageFile` has
  no such field, so the conversion has nowhere to put it.

**Modified date**
- The FILE's own mtime, not the message time. Carried on the wire beside the bytes so a save on
  either side restores the real age ("put it in my docs folder" gets the date right for free).
- Carry mtime ONLY. atime is set to now on write by design. Created/birth time is NOT restorable on
  Linux or Android (`ctime` is inode-changed, not created; birth time has no setter), so carrying a
  created stamp would only invite someone to trust it later and be wrong.
- Wire field is optional, so an older console or agent simply omits it and the row hides.

**Draft**
- Two states, toggled from the count in the bar.
- Collapsed (default): one fixed-height row of tiny thumbs, drag to slide. Non-images get a labelled
  tile so row height never changes. On attach, scroll to the end so the newest is visible - no
  highlight, position alone says it.
- Expanded: the message layout verbatim (images wrap, files stack), plus remove badges.

**Save**
- Asks where. Pre-filled with the last folder picked in this app; Downloads on first run. CHANGE
  opens the system folder picker and becomes the next default. Remembered per app, not per thread.
- Writes bytes, restores carried mtime, leaves a snackbar. Save feedback is transient and never
  becomes an info row (it describes an action, not the file).

**Unification, honest limit**
- Messages render in the WebView (`thread.js`), drafts in Compose. They cannot share a component.
- They WILL share the decision layer: one Kotlin classifier for image-vs-file, ordering, display
  name, hidden-artifact filtering, and size/date formatting, consumed by both the transcript
  serializer and the composer. That layer is where the divergence actually came from.

### Asked

**1. Video attachment placement** -> With images, as a previewable with a play badge. The real split
is previewable-vs-not.

**2. Tapping a non-media file** -> One fullscreen sheet for everything; non-binary content previews
in the stage. `FileInfoDialog` goes away.

**3. Non-binary detection** -> Sniff a bounded prefix: peek up to 64 KB for the decision, render
only ~4 KB. Declared mime is ignored (sender-controlled).

**4. Draft expanded state** -> Ephemeral, always opens collapsed.

**5. Viewer swipe** -> No. Swipe belongs to the collapsed draft strip only. `AttachmentViewer`
keeps its single-attachment signature.

**6. Agent-to-agent attachments** -> In scope; owner: "I frequently need them to share files for
verification." Shipped (section 3, done ledger).

**7. Transport foundation** (added after the OOM incident) -> Owner directed the blob plane in as a
REQUIRED intermission before the remaining UI sections: "kill this class of bug and make large
uploads first-party."

## Plan

### Done ledger (sections 1-5, shipped)

| Slice | Commit | PR |
|---|---|---|
| 1. Store plumbing (`size`/`modifiedAt` through every hop) | `4623456` | #195 |
| 2. Wire `modifiedAt` (synced leaf, both repos) | `52ac1e4` + evie `de76986` | #195 / evie #1420 |
| 3. Agent-to-agent attachments, both directions | `3974fda` | #195 |
| 4+5. Shared classifier + message row | `6ae83bb` | #195 |
| Version bump 7.14.2 (marketplace ritual) | `20beb96` | #196 |
| Crash-report flush on the way down | `e4396f7` | #197 |

Invariants the remaining work leans on (do not re-litigate; violating any of these re-opens a fixed
bug):

- **One serialized file shape.** `fileJson`/`loadFiles`, top-level `internal` in `ChatRepository.kt`.
  `grep 'put("name", f.name)'` must find exactly ONE hit. Absent loads as null via `longOrNull`,
  never `optLong`'s 0. `loadFiles` is total: skips unreadable elements, garbled numbers read as
  absent (the threads loader catches around its whole key loop, so a throw there costs every thread).
- **`AttachmentDisplay.kt` is the only decider.** Previewable is an explicit allowlist, not a mime
  prefix; TIFF/HEIC/SVG deliberately excluded (SVG because the viewer decodes with `BitmapFactory`);
  video excluded until section 9 makes posters. Hidden entries never reach the renderer; `label` is
  always sent and thread.js has NO fallback; a blank decoration title is omitted, not shipped.
- **Only a real button wears control styling** in the file rows; a metadata-only row is muted and
  inert (the dead-tap class).
- **`modifiedAt`:** MCP populates via `mtime.getTime()` (never fractional `mtimeMs`), MCP restores
  via `utimesSync(path, new Date(), new Date(ms))` (bare numbers are SECONDS; ms lands in 2446
  without throwing) with a re-stat clamp check; the phone omits it. Long-bait fixtures pin the
  Kotlin `Long` on the nested field in BOTH runtimes.
- **Reserved-name invariant:** `assertNotReservedName` in `artifactNames.ts` guards BOTH outbound
  `ChannelFile` producers (`readReplyAttachment`, `designer_push_card`). Ref artifacts are dropped
  from agent-bound replies by POSITIONAL split on the reserved filename, reply leg only.
- **Trust posture accepted by owner:** the unconfined attachment reader is acceptable because
  `mirrorPeer` copies both legs into the owner's mailbox. Documented in `bridgeSend.ts`.
- **Deploy ritual:** version bump (`bun run bump patch`) or the marketplace silently skips; evie-bot
  pushes FIRST on any leaf change; Kotlin gate runs locally (`:app:testDebugUnitTest`) because CI
  does not compile Kotlin pre-merge; `gitFetch`+`gitPull` after every push before editing.

Cross-cutting facts that survive into 6-9: no image-loading library exists (no Coil/Glide);
`decodeBounded` discards intrinsic size and `inSampleSize` (section 6 changes it to return them);
SAF exposes no user-visible path; the WebView asset loader mounts exactly one storage root
(`ThreadRenderer.kt` registers `/attachments/` at `Attachments.root(filesDir)`).

### I. INTERMISSION - Content-Addressed Blob Plane (REQUIRED before 6-9)

Owner-directed after the 40 MB video OOM bricked the console. Framework-first assessment plus live
probes; this section records the evidence, the design, and the order. The remaining UI sections
build on top of this, not under it.

**The incident.** A pending video row is rebuilt on every app foreground
(`MainActivity.kt` `LifecycleStartEffect` -> `scope.launch { reconcilePending() }`, Main-dispatched)
-> `rebuildFiles` whole-file `readBytes` -> base64 (4/3 size) -> one ~54 MB contiguous allocation ->
OOM on the 256 MB heap -> uncaught -> crash loop. The catch at that site names
"OutOfMemoryError on a large re-upload" in its own comment: documented, armed, and left.

**Measured reality (probes run against prod, 2026-07-30):**

- 15 MB POST through the k8s apiserver service-proxy into evie's console-bridge: fully parsed
  (post-parse 400 proves transit), 4.9 s at ~3.2 MB/s. The proxy carries big bodies fine; the
  transport never forced small frames.
- 140 MB POST: 413 after 128 KB sent. evie's `Bun.serve` has no explicit `maxRequestBodySize`;
  the 128 MB default is a live, unencoded ceiling.
- The TIGHTEST pipe is the gateway<->evie WebSocket: `maxPayloadLength` unset, Bun default 16 MiB.
  With measured ~1.78x amplification (base64 -> JSON -> seal -> base64), the real end-to-end ceiling
  is ~9 MB of raw file. The pinned `MAX_RESPONSE_FILE_BYTES = 500 MB` is fiction ~55x above it.
- **Latent transport-killer:** an agent reply to the console with >~9 MB of attachments builds a
  `console_relay_reply` frame that evie's WS rejects by CLOSING the gateway socket (1009), dropping
  all federation traffic. Reply-direction; never yet hit.
- Sockets verdict (owner asked): a WS for the console is possible but wrong twice over - Doze kills
  persistent sockets (the whole `IdlePushbackManager` ladder exists for this; the 40 s held poll
  already gives push-grade latency), and the WS hop is where oversized payloads are DEADLIEST. The
  foundational shift is a plane split, not a socket.

**Anti-patterns this closes** (assessor findings, spot-verified): cap theater (500 MB pinned by
tests in two repos, unreachable); bytes in the durable mailbox snapshot `JSON.stringify`d every 3 s
(cap `DEFAULT_MAX_BYTES = 2 GB`); the sender re-downloading its own ~53 MB echo after every upload
(`consoleHandler.ts` sent-echo carries full base64); "bytes were not retained, ask for a re-send"
as a UX string; five separate implementations of "move bytes"; no digest anywhere, so corruption is
silent (`runCatching{}.getOrNull()` swallows it).

**The design.** Messages carry references; bytes move on their own plane. One rule everywhere:
NOTHING in the system can name, accept, or return a whole file.

- `blobId = "sha256-<64hex>"` of the plaintext. One value = dedup key, resume cursor key, retry
  idempotency key, integrity check.
- Three ops, chunked: `blob_stat {blobId}` -> `{have, size?, complete}`;
  `blob_put {blobId, offset, chunk, final}` -> `{have}`; `blob_get {blobId, offset, length}` ->
  `{chunk, eof}`. `have` is the contiguous prefix = the resume cursor. Console rides them as sealed
  ops through the proven proxy path (per-chunk seal keeps evie content-blind); agents get three
  plain HTTP verbs; federation gets three relay ops.
- Constants exported from the SYNCED LEAF so all runtimes agree by construction:
  `BLOB_CHUNK_BYTES = 1 MiB` (~1.9 MiB sealed, ~8x under the WS ceiling) and a
  `MAX_RELAY_FRAME_BYTES` budget asserted in tests.
- One store per runtime, cast in the durable-store mold: `stat/write/read/path/pin/unpin`,
  offset-based (`pwrite`/`RandomAccessFile`), layout `blobs/<aa>/<sha256>` with a `.part` sidecar,
  two-level fanout. A blob is readable ONLY when complete and its streaming digest equals its name.
  Refcounted pins (mailbox entry pins, pending job pins), swept when unpinned - the generalization
  of what `Attachments.sweepOrphanBuckets` already does.
- `Attachments.kt` survives as a VIEW over the store (the WebView keeps fetching rel paths through
  the one mounted root); `OutgoingFile` becomes `(name, mime, blobId, size)` - after which no
  `ByteArray` field exists on the console send path at all.
- Zero new dependencies. evie changes only by setting explicit limits.

**Bug classes made unexpressible:** whole-file OOM (no API takes one); the 1009 federation kill
(one frame producer, one bounded constant); duplicate delivery on retry (re-put of an offset is a
no-op); offline byte loss (the store outlives the message); silent corruption (the name is the
checksum); the 3 s multi-GB snapshot (mailbox holds references); the own-bytes echo round trip
(echo carries a blobId the sender already has).

**Phases, in dependency order:**

- **I0 - encode reality, unbrick the phone. Ships alone, FIRST.** Explicit `maxPayloadLength` on
  evie's `BridgeTransport`, explicit `maxRequestBodySize` on its console-bridge, explicit
  `maxPayload` on the gateway's `evieClient`, honor the discarded `ws.send()` return in evie's
  `BridgeServer` (a dropped frame is currently a silent 55 s timeout plus a retry of the same huge
  body), drop both 500 MB pins to a deliverable number and re-pin. Android: `reconcilePending`'s
  launch must not let an `Error` reach the uncaught handler - an oversized row marks `error`
  (retriable) instead of crash-looping. Converts "bricked app" into "one message fails legibly".
- **I1 - the store, three implementations, no wire change.** `src/shared/blob-store.ts` (gateway +
  MCP) and `android/.../BlobStore.kt`, plus a golden corpus `tests/fixtures/blob/` with a
  `_manifest.json` both runtimes iterate (chunk-boundary and digest-mismatch cases included), per
  the existing fixture discipline.
- **I2 - leaf + ops, additive.** `blobId` joins `ChannelFileSchema` (`base64` stays for migration);
  the two constants; three console ops in `ConsoleOpSchema` (encode-side sealed class is
  codegen-safe); three gateway HTTP verbs; three federation relay ops. Sync-leaf ritual, evie
  deploys FIRST, regenerate `Protocol.kt`, Kotlin gate locally.
- **I3 - producers switch, consumers accept both.** Console streams-and-hashes at pick (`readUri`
  stops `readBytes`), uploads chunks, sends `blobId`; MCP mirrors; `Attachments.decode` /
  `materializeFiles` prefer `blobId`, fall back to `base64` while old senders exist; the sent echo
  carries the reference; the mailbox stops carrying bytes.
- **I4 - delete `base64`.** Drop the field from the leaf, delete every fallback plus the whole
  compensation list (`stripFileBytes`, `fileBytes`, the sequential-budget reader, `entryBytes`'
  base64 accounting, the re-send apology text, the 700 MB `maxRequestBodySize`). Gate on minimum
  console version via the capability union, which already receives `clientVersion` at register.

Known enforcement gap, accepted: `check-sync-hash` verifies internal faithfulness, not cross-repo
equality, so a stale-but-self-consistent leaf copy passes both CIs. Push order remains discipline;
consider a real cross-repo diff in one CI while touching this.

**What the intermission unlocks for the later sections:** resumable large uploads; range reads
(previews, streaming playback); dedup across resend and echo; content-keyed video thumbs (resolves
section 9's regeneration problem outright); `ref://` snapshots escaping their 2 MB budget.

### 6. Viewer (extend `AttachmentViewer`, single attachment)

Post-intermission note: file access goes through the blob view (`path()` only when complete and
verified), so a torn download can no longer reach the decoder; everything below is unchanged in
intent.

- **True-pixel scale needs the INTRINSIC size AND the sample factor**, both of which `decodeBounded`
  (`AttachmentViewer.kt:65`) already computes and then discards. Change it to RETURN them alongside
  the bitmap rather than adding a third file open at the call site - a separate bounds pass would
  duplicate work and still not surface `inSampleSize`, which the filtering rule below keys on.
- **Presets need CONTAINER PIXELS, not Dp.** Comparing a Dp constraint to intrinsic pixels is
  correct only at density 1.0, which no real device is (the Pixel 10 Pro XL is ~3.5), so "100%"
  would silently be ~3.5x off. `BoxWithConstraintsScope` exposes the raw pixel constraints directly,
  so read those rather than round-tripping Dp through `LocalDensity`. The unit test takes px in and
  therefore CANNOT catch this - the seam is the conversion at the call site - so an emulator check
  that 100% is genuinely 1:1 is the real gate.
- **Replace the `1f..6f` clamp; do not simply remove it.** BOTH ends are wrong: the floor forbids
  50% of a large image (which is below fit), and the 6f ceiling under-zooms the 200% preset on a
  large photo, so relaxing only the floor still ships a broken preset. And an unclamped domain is
  not safe either - pinch applies a positive multiplicative ratio, so repeated pinch-in decays scale
  toward zero and the image becomes an unrecoverable dot. The new domain is derived from intrinsic
  vs container px, with a floor below the smallest preset and a ceiling above the largest.
- **Pan needs the same treatment.** `offsetX`/`offsetY` are unbounded today and the presets as
  specified write only `scale`, so tapping 50% while panned can leave an empty frame. Presets reset
  the offset (which is also the only way "anchored on frame centre" is true), and pan clamps so the
  image cannot be dragged fully off-stage.
- **Nearest-neighbour above 100%, with one honest exception.** `decodeBounded` only downsamples past
  4096px, so ordinary screenshots and sprite sheets decode 1:1 and nearest-neighbour shows the true
  source grid - the pixel-art case this feature exists for. When `inSampleSize > 1` the bitmap grid
  is NOT the source grid and nearest-neighbour magnifies the wrong pixels, which is worse than
  smooth; fall back to smooth there while the preset math still reports honest intrinsic scale.
  **Build the `BitmapPainter` explicitly, keyed on both the bitmap and the quality** - the
  convenience `Image(bitmap = ...)` overload is reported to remember its painter on the bitmap
  alone, which would freeze sampling at whatever it was on first composition (smooth, since the
  viewer opens fitted) and make the toggle inert. Constructing the painter is correct either way, so
  it costs nothing to not depend on the answer. Owner's standing permission to drop to smooth
  everywhere still stands.
- **The viewer must route on the classifier, not a mime prefix.** Red-team residual: tapping an SVG
  or TIFF file row still reaches `ZoomableImage` -> `BitmapFactory` -> "Could not decode image",
  because `AttachmentViewer.kt:103` branches on `startsWith("image/")`. Consult `isPreviewable`
  (plus a viewer-specific decodable set where `BitmapFactory` differs from the WebView, e.g. HEIF
  decodes here but not there) so an undecodable format lands on the file-glyph sheet.
- **Text sniff: 64 KB peek. Let `CharsetDecoder` do the work.** It already distinguishes the two
  cases natively - a truncated multi-byte sequence at the buffer end returns UNDERFLOW, genuinely
  invalid bytes return MALFORMED - so the earlier hand-rolled "malformed inside the last 3 bytes is
  just the boundary" rule was both unnecessary and actively wrong: it EXCUSES binary tails and calls
  them text. Decode with `CodingErrorAction.REPORT` and pass `endOfInput = false` only when the peek
  actually hit the 64 KB bound; for a file shorter than the peek the buffer end IS true EOF, so a
  truncated tail there is genuinely malformed and must be treated as binary.
  Kotlin's `String(bytes)` substitutes U+FFFD silently and can never fail, so the obvious
  implementation makes the test vacuous.
- Known and accepted: a UTF-16 file is classified binary by the NUL rule. Strip a leading UTF-8 BOM
  from the preview or it renders as a stray glyph on the first line.
- Render the first 4 KB; the stage must scroll vertically or the preview is clipped mid-screen.
- All I/O off the main thread; today the viewer reads in composition and in `onClick`.
- **Video plays here, it does not cycle thumbnail frames.** The stage is the existing `VideoPlayer`,
  with an `Open with` fallback to an external player. Section 9's frame set is thumbnail-only.
- Info rows: `Size` (+ dimensions for images), `Modified` when present. `prettySize` comes from the
  classifier (its only current consumer; the duplicate in this file was deleted).
- **Drafts cannot reach this viewer at all today.** A draft chip has no tap target, and the only
  rel-to-`MessageFile` resolution scans `state.threads` alone - a draft file lives under
  `state.drafts`, so the lookup returns null and both the `Modified` and `Location` rows would come
  back blank. Section 7 must add the tap target and the resolver must consult drafts.
- **`Save` is two writers, not one.** "Downloads on first run" cannot be a tree URI, because no
  persisted grant exists until the user picks a folder - so the first-run path stays the existing
  MediaStore-to-Downloads write, and only a user-chosen tree uses SAF
  (`takePersistableUriPermission`, then create-document under the tree; not
  `openOutputStream(treeUri)`). A remembered grant can also die between runs (data cleared, folder
  deleted, volume unmounted, user revoked) and then throws `SecurityException` at write time, which
  would surface as a bare "Save failed" with no hint that the folder is gone: re-validate the grant
  before offering it and silently fall back to the picker. No mtime restore. `Open with` retained.
  `FileInfoDialog` deleted.
- The bottom control row gains three presets, a reset icon and the save-location control, and the
  app applies no window insets anywhere - check it clears the gesture-nav pill.

### 7. Draft composer (Compose)

Collapsed by default: fixed-height strip, horizontal drag, labelled tiles for non-images, scroll to
end on attach. Expanded mirrors the message layout plus remove badges. Ephemeral state.

Thumbnails need a decode path the app does not have (no Coil/Glide). Do NOT stand up a second
private bitmap cache: `DesignerThumbs` is already a mutex-serialized, byte-bounded `LruCache` that
returns exactly what the Compose strip wants (a `Bitmap`). Generalize that object; its WebView
capture path stays Designer's. Post-intermission, key the cache by `blobId` rather than rel, which
makes draft/outgoing/echo hits the same entry for free.

Also add the missing tap target on a draft chip - see section 6, the draft viewer is currently
unreachable.

Accepted limitation: the scheduled-send dock replaces the composer wholesale, so the strip is hidden
while a send is banked. Consistent with today's behaviour for text and files.

### 8. `sourceLocation` - display name, not a path (draft-only)

Needs a picked-file type distinct from `MessageFile`, so the "cannot reach the wire" guarantee is
structural rather than a promise.

**The threading is the hard part, and the obvious route is wrong.** The provider display name is
only visible where the `content://` Uri is, at pick time. Getting it into the draft's file list
means riding the pick-to-draft path - and `OutgoingFile` is the exact type `ConsoleClient.send`
consumes, so `sourceLocation` must never land on it. Post-intermission `OutgoingFile` is
`(name, mime, blobId, size)` - byteless, but still wire-adjacent, so the rule is unchanged: the
picked-file type lives UPSTREAM of it, and the display name travels in a side channel
`storeOutgoing`'s successor never sees.

Honest counterweight, worth deciding rather than assuming: the "cannot reach the wire" property
already holds three layers deep, so the new type is a fourth gate behind three that work, at a cost
of roughly a dozen call sites. It buys structure, not a fix for a live leak. If the implementation
sprawls, dropping to a documented invariant plus a residue test is a legitimate downgrade.

SAF exposes no user-visible path, so the Location row shows the provider's own DISPLAY NAME (roughly
"Downloads"), read at pick time. Weaker than a path and also safer: it cannot leak a username or
folder layout even by accident. If the provider supplies no usable name, the row is omitted rather
than guessed at.

### 9. Video previewables - the animated THUMB only

Scope, stated because it is easy to conflate: this frame set is the THUMBNAIL shown in the message
row and the draft strip. It is NOT the fullscreen view. Tapping a video plays it (section 6), and
the frames are never used there.

Video sits in the previewable group, but the WebView has no video renderer and no poster exists in
the pipeline, so thumbnail frames must be generated.

**Sampling rule.** Every number is a named constant, because the spacing in particular is a taste
call that will want tuning (1s produces a livelier thumb on short clips; 5s is the starting value):

```kotlin
const val VIDEO_THUMB_MAX_POINTS = 12      // ceiling on sample points
const val VIDEO_THUMB_MIN_SPACING_MS = 5_000L   // tune me: 1_000 for denser sampling
const val VIDEO_THUMB_MIN_POINTS = 3       // below this, one static frame instead
```

```
n = min(floor(duration / MIN_SPACING), MAX_POINTS)
if n < MIN_POINTS -> ONE static frame at the midpoint (clip too short to space samples)
else              -> sample n points evenly, DROP first and last, keep the middle n-2
```

Note the constant's name overpromises: at `MIN_POINTS = 3` the rule keeps `n-2 = 1` frame, so the
first n that produces any actual motion is 4. Either rename it or raise it - do not leave a comment
saying "below this, one static frame" next to a value that also yields one frame.

At the default 5s spacing (drop to 1s and a 12s clip yields the full ten instead):

| duration | points | spacing | frames kept |
|---|---|---|---|
| 12s | - | - | 1 static |
| 15s | 3 | 5.0s | 1 |
| 30s | 6 | 5.0s | 4 |
| 60s | 12 | 5.0s | 10 |
| 10m | 12 | 50s | 10 |

**Two independent ways to make every frame identical.** Both present as "the thumb is static"
rather than as a bug, and neither is catchable by an arithmetic-only corpus:

1. **Units.** `METADATA_KEY_DURATION` returns MILLISECONDS (as a string); `getFrameAtTime` takes
   MICROSECONDS. The rule computes entirely in ms, and the single ms-to-µs conversion lives in its
   own named function at the retriever call, unit-tested on its own.
2. **Seek option.** The default snaps to the nearest KEYFRAME, so on a sparse-GOP source - screen
   recordings especially, which is most of what gets attached here - all ten sample points resolve
   to the same sync frame. Pass `OPTION_CLOSEST` explicitly.

**Bound the frames.** Use `getScaledFrameAtTime` (API 27, well under this app's minSdk 33) with an
explicit target size and a named JPEG quality constant. Unbounded extraction would decode a ~33 MB
bitmap per seek on a 4K video, write ten full-resolution JPEGs permanently into the bucket, and then
make the transcript re-decode those to paint a ~100 px tile.

**Storage and playback.** The platform has no animated-image ENCODER, so do NOT attempt an animated
WebP or GIF on device. Extract frames as individual JPEGs and let each surface cycle them - JS in
the transcript, a Compose animation in the draft strip. One frame set feeds both renderers, with no
new dependency.

**Regeneration across buckets - RESOLVED by the intermission.** Frame sets are keyed by the source
video's `blobId`, so draft, outgoing, and settled-echo copies share one set by construction, and the
old ".thumbs inside the bucket" questions (delete-path orphans, the emptiness check, the traversal
guard for a dotted segment) collapse into the blob store's own pin/sweep lifecycle. The frames still
have to be reachable by the WebView, so they are served through the same single mounted root as
attachments, via the `Attachments` view.

**Degenerate inputs.** An audio-only container carrying a `video/*` mime would run the full N-seek
pass to produce N nulls before falling back to the glyph; `METADATA_KEY_DURATION` can also return
null or a non-numeric string, for which `floor(duration / MIN_SPACING)` has no defined behaviour.
Probe duration first and bail to the glyph on either.

**Readiness needs a push channel, and it takes BOTH halves.** Frames generate lazily on a background
dispatcher, so a row is usually on screen before its set exists - and nothing currently tells it.
`MainActivity.kt` re-syncs on `LaunchedEffect(renderer, messages)`, keyed on the message list alone,
and `ThreadRenderer.sync` re-renders an existing row only when its `fingerprint` changes. Frames
landing on disk change neither. Fix: a small observable readiness signal (per-blobId,
version-counted) added as a `LaunchedEffect` key AND folded into `fingerprint`. Either half alone is
silently inert. There is NO precedent to copy: `RefDisplayIndex` appears in no `LaunchedEffect` key
anywhere; the ref path has the fingerprint fold only and depends on being recorded before first
render (`cd3ebd8`), a trick slow extraction cannot use.

Related: `fingerprint` hashes the file COUNT and decoration, never a per-file field value, so a row
whose file metadata changes in place keeps stale content. Fold the per-file fields in with the
readiness work.

**Teardown.** The readiness signal guarantees at least one row REPLACE per video row, and any
per-row frame-cycling timer in `thread.js` will be leaked by that replace, retaining a detached row.
The replace path has exactly one teardown hook (the mermaid observer's); the cycling timer needs to
register there too.

**Cost and timing.** Ten seeks is expensive and must never touch the main thread: generate lazily on
a background dispatcher, cache on disk, show the first frame (or a play glyph) until the set is
ready. A video whose frames cannot be extracted falls back to the glyph tile rather than failing.

### Verification

Unit tests:

- Blob store, all three implementations against the SHARED golden corpus (`tests/fixtures/blob/`
  with `_manifest.json`, both runtimes iterate): chunk-boundary write, out-of-order offset refusal,
  digest mismatch cannot become readable, resume from `have`, re-put idempotency, pin/sweep.
- The text sniffer: NUL, invalid UTF-8, valid text exactly at the bound, and a 3-byte character
  STRADDLING the bound (UNDERFLOW vs MALFORMED split).
- The scale math, in pixels (intrinsic vs container, below-fit). Explicitly not a density test.
- The video sampling rule (the table above IS the corpus) plus the ms-to-µs conversion on its own.
- Frame-budget assertion: a max-size sealed chunk frame stays under `MAX_RELAY_FRAME_BYTES`, which
  stays under the now-explicit WS payload limit. Pinned in tests on BOTH repos so neither limit can
  drift independently.

Emulator pass per surface: the 1:1 check at 100% zoom, a frame-set completion landing on an
already-rendered row, an attachment surviving a process death, the draft viewer opening at all, and
a >16 MiB attachment surviving the full console round trip (the old ceiling, now just a number).

Gates: `bun run lint && bun run test`,
`bun scripts/check-sync-hash.ts src/shared/evie-protocol.ts`, `bun scripts/codegen-kotlin.ts`,
`:app:testDebugUnitTest`, plus evie-bot's own gate in its devcontainer.
