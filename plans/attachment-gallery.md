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

Prior analysis: `AttachmentViewer` already exists and branches image / video / other. Its pinch zoom
is clamped `1f..6f` where `1f` IS fitted (fit-relative, never below fit), and its save button
hardcodes Downloads. So this work EXTENDS that screen rather than adding one.

**1. Where does a video attachment belong?** -> **A) With images.** Thumb in the wrapping grid with
a play badge, no filename; tap opens the existing player. Recommended because the real split is
previewable-vs-not: a video frame is a preview, a filename is not. Filing it with files would show
`VID_20260727.mp4` beside a wall of thumbs, which is the inconsistency being removed; a third group
would add a third code path to a change whose purpose is collapsing three into one.

**2. What does tapping a non-media file open?** -> **A) One fullscreen sheet for everything**, plus:
if the content is non-binary, PREVIEW it in the stage. Same info panel as images and video. One
sheet, one set of info rows, one save path; the existing `FileInfoDialog` AlertDialog goes away.
(Text preview was offered as a later follow-up and the user pulled it into scope.)

**3. How do we decide non-binary, and how much do we read?** -> **A) Sniff a bounded prefix**, with
two SEPARATE bounds: peek up to 64 KB for the binary/text decision (UTF-8 decodes, no NUL byte), but
render only a couple of KB as the preview - "download to see the rest". Declared mime is ignored: it
is sender-controlled, and agents routinely attach logs as `application/octet-stream`. The peek being
larger than the preview is deliberate - a file can be clean ASCII for 2 KB and binary after.
Constraint behind it: `MAX_RESPONSE_FILE_BYTES` is 500 MB, so an unbounded read is a real hazard.

**4. Does the draft's expanded state stick?** -> **A) Ephemeral, always opens collapsed.** Expanding
is an inspection gesture, not a preference, and it is answered once you have looked; composer real
estate is scarce enough that a thread expanded weeks ago should not still be eating it. Also adds no
persisted field, in a change whose point is less state that can drift.

**5. Does the viewer swipe between a message's images?** -> **No. Question was misframed.** "Swipe"
belongs to the COLLAPSED DRAFT strip only, where it is the overview of everything attached. A
message already shows every attachment (images wrapped, files listed vertically), so there is nothing
to page through; an expanded draft likewise. `AttachmentViewer` keeps its single-attachment
signature. Zoom is a separate concern that lives in the fullscreen view of ONE file.

**6. Agent-to-agent attachments** -> **In scope, this phase.** Owner: "I frequently need them to
share files for verification." This is what makes the `modifiedAt` wire field load-bearing rather
than speculative, and it is also the only path by which the phone can ever DISPLAY a carried mtime.
Details and the verified size of the change are in section 3.

## Plan

Revised after two audit laps (lap 1: 6 angles, ~12 distinct; lap 2: 5 angles, ~7 distinct). Items
marked VERIFIED were re-checked by hand, not taken on the auditor's word.

### 0. What the audits changed

**Lap 1**

- **No Android API sets mtime on a SAF/MediaStore destination.** VERIFIED via `javap` on
  `android.jar`: `android.system.Os` exposes no `utimes`/`utimensat`/`futimens`, and
  `DocumentsContract` has no timestamp setter. `File.setLastModified` needs a real path, which SAF
  never yields. So the phone save path CANNOT restore mtime. Owner's call: agent-to-agent only.
- **The attachment shape is a SYNCED LEAF.** VERIFIED: `ChannelFileSchema` lives in
  `src/shared/evie-protocol.ts` (`schemas.ts:91` merely re-exports it), carries a `SYNC-HASH`, is
  copied verbatim into evie-bot, and `ci.yml:34` gates it. This is a TWO-REPO change; the earlier
  scope note claiming otherwise was wrong and has been deleted.
- **`MessageFile` is shared by drafts AND sent messages**, so "the sent type has nowhere to put
  `sourceLocation`" was false as written. A separate picked-file type is required for that guarantee
  to be real rather than decorative.
- **Hand-rolled JSON serializers** enumerate exactly `{name, mime, src}`, so any new field is
  silently dropped on restart - `modifiedAt` would render once and vanish, looking like a viewer bug.
- Smaller but real: no image-loading library in the app; `decodeBounded` downsamples so intrinsic
  size is lost; video has no renderer in the WebView at all; SAF exposes no user-visible path.

**Lap 2**

- **`stat().mtimeMs` is FRACTIONAL and `z.number().int()` rejects it.** VERIFIED by running node
  plus this repo's own zod: a real stat gave `1785179969544.809`, which the schema refuses. Shipping
  that pairing would 400 every attachment-bearing message, through a SYNCED leaf, into evie-bot. Use
  `mtime.getTime()` (integral by construction), not a `Math.trunc` of the fractional field.
- **The serializer count was wrong: FOUR, not three.** VERIFIED by grep -
  `ThreadRenderer.kt:81` (`messagesToJson`), `ChatRepository.kt:4421` (`threadsJson`), `:4576`
  (`scheduledSendsJson`), `:4651` (`persistDrafts`). Section 1 had listed three; `scheduledSendsJson`
  was the one missed, and it is exactly the path where a dropped field survives a reboot unnoticed.
- **The agent-to-agent transport gap is REAL but far narrower than reported.** The auditor said no
  transport exists. VERIFIED otherwise: the gateway carries files end to end already, and only the
  `crosstalk_send` TOOL fails to expose them - while the REPLY direction genuinely does drop bytes on
  the floor. Section 3.
- **Video frame extraction has a 1000x unit trap** (ms vs µs) that the declared test corpus cannot
  catch. Section 9.
- **Nothing tells an already-rendered transcript row that video frames finished generating.**
  VERIFIED: `MainActivity.kt:4159` keys its re-sync on `messages` alone, and `ThreadRenderer.sync`
  re-renders a row only on a `fingerprint` change. Section 9.
- **The zoom math has a Dp-vs-px seam** that is correct only at density 1.0 and is invisible to the
  unit test as specified. Section 6.
- **The text sniffer false-negatives on a multi-byte UTF-8 sequence straddling the peek bound.**
  Section 6.

**Lap 3** (weighted at the then-unaudited section 3; it found more in the older sections)

- **`utimesSync` numbers are SECONDS, and `modifiedAt` is MILLISECONDS.** VERIFIED by running it on
  bun (the runtime that actually hosts the MCP): `utimesSync(p, 1785179969544, ...)` yields an mtime
  of **2446-05-10**, and it does NOT throw, so the plan's "guarded so a failure logs" would have
  caught nothing. `new Date(ms)` gives the correct 2026-07-27. Same 1000x class as the video bug,
  found in the section that was supposed to have learned the lesson.
- **`JSONObject.optLong` returns `0L` for an absent key, never null.** Section 1 prescribed exactly
  that for two new NULLABLE fields, so every pre-upgrade attachment and every phone-originated one
  would load as `0L` and render "1 Jan 1970" / "0 B" instead of hiding the row. Confirmed there is
  no nullable-Long load precedent in `ChatRepository` to copy - all existing `optLong` calls are on
  genuinely non-null fields.
- **I invented a precedent that does not exist.** The plan said the readiness fix is "exactly the
  two-part shape the ref decoration already uses". VERIFIED FALSE: `RefDisplayIndex` appears in no
  `LaunchedEffect` key anywhere; the ref path has the fingerprint fold ONLY, and relies on ordering
  (the `cd3ebd8` subscriber-before-append fix) rather than on a signal. An implementer copying that
  precedent would ship the one-part version the plan itself calls silently inert.
- **`getFrameAtTime`'s default option snaps to the nearest KEYFRAME.** On a sparse-GOP source - a
  screen recording, a long-GOP encode - every sample point resolves to the same sync frame and all
  ten JPEGs are identical. Presents as "the thumb is static", the same invisible failure as the unit
  bug, and equally uncatchable by an arithmetic-only corpus.
- **Frames were unbounded in size.** Nothing capped thumb dimensions or bytes, so a 4K video would
  decode a ~33 MB bitmap per seek and write ten full-resolution JPEGs permanently into the bucket,
  which the transcript then re-decodes to paint a ~100 px tile.
- **The agent side cannot produce a `video/*` mime at all.** `MIME_BY_EXT` (`replyTool.ts:13-26`) is
  12 entries with no video types and several missing image types; everything else becomes
  `application/octet-stream`. Since classification is a pure mime prefix test on both renderers, an
  agent-attached `.mp4` can never reach the previewable group and section 9 could never fire for it.
- **The zoom clamp's CEILING is as broken as its floor**, which the plan did not say, so the
  natural minimal edit under-zooms the presets on exactly the large photos this is for.
- **The UTF-8 boundary rule was both wrong and unnecessary.** `CharsetDecoder` already distinguishes
  a truncated sequence (UNDERFLOW) from an invalid one (MALFORMED) natively; the hand-rolled
  "malformed in the last 3 bytes is fine" heuristic instead EXCUSES genuinely binary tails and
  classifies them as text.

REJECTED after checking: an auditor reported that the schema edit was already half-applied to the
working tree and that `check-sync-hash` was therefore failing. Neither is true - `git status` is
clean but for the plan files, `modifiedAt` appears nowhere in the tree, and the gate reports
"1 file(s) faithful". Recorded so a later lap does not act on it.

### 1. Store plumbing (FIRST - everything else depends on it) ✅

`MessageFile` gains `size: Long?` and `modifiedAt: Long?`, carried through EVERY hop:
`Attachments.decode` (stop discarding `ChannelFile.size`), `Attachments.storeOutgoing`,
`messagesToJson`, `threadsJson`/`loadFiles`, `scheduledSendsJson`, and `persistDrafts`/
`loadPersistedDrafts`.

`loadFiles` skips an element it cannot read rather than throwing, and treats a present-but-
non-numeric value as absent. Both matter because `loadPersistedThreads` catches around its ENTIRE
key loop, unlike the drafts and scheduled-send loaders which guard per row, so one bad entry there
would cost every thread on the device and then be overwritten by the next persist. Narrowing that
loader to per-row guarding is a real pre-existing gap but is not this change's to make.

`decode` uses the DECODED BYTE LENGTH rather than the declared `ChannelFile.size` whenever bytes
are present, because a sender's declared size is unverified input and the bytes on disk are what the
row actually describes. The declared value is used only on the metadata-only branch, where there are
no bytes to measure.

Two hops on the original list turned out not to belong here. `rebuildFiles` converts to
`OutgoingFile`, whose bytes already carry the size and which never carries an mtime (the phone does
not populate one), so it needs nothing. `OpenAttachment` is built from a bridge-supplied rel path
with no `MessageFile` in hand, and the rel-to-file lookup it would need does not exist for drafts at
all - that is section 6's work, and adding unread fields ahead of it buys nothing.

**Absent must load as null, not zero.** `optLong` returns `0L` for a missing key, so the obvious
`optLong("modifiedAt")` turns "this file has no carried date" into "1 Jan 1970" and "no size" into
"0 B" - on every pre-upgrade attachment and every phone-originated one, permanently, from the first
restart. Read via an explicit presence check (`if (has(k) && !isNull(k)) getLong(k) else null`) and
put a shared helper on it, since it is needed in three loaders. Section 6's "`Modified` when
present" is only meaningful if absence survives the round trip.

Rather than updating the four hand-rolled writers in step, they now share ONE `fileJson` paired with
the existing single `loadFiles`, so there is nothing left to keep in step. The transcript payload
joins them and adds decoration on top. That is byte-identical output, not a tolerated shape change:
org.json's `put(key, null)` REMOVES the key rather than writing a JSON null, so it already behaved
as `putOpt` does. Independently, every `f.src` use in `thread.js` is a truthiness check, so even a
real shape change would have been safe. `grep 'put("name", f.name)'` should find exactly one hit, inside `fileJson` itself.

Both are top-level `internal` functions rather than `ChatRepository` members, mirroring
`messagesToJson` and `renderedSender`. That is what makes the round trip testable: a private member
cannot be reached from a JVM test, since `ChatRepository` needs a `ContentResolver`.

Justified by `size` ALONE - the file row shows it and nothing carries it today. `modifiedAt` rides
along at no extra cost.

### 2. Wire: `modifiedAt` (synced leaf ritual) ✅

- Add to `ChannelFileSchema` in `src/shared/evie-protocol.ts` as `z.number().int().optional()`
  (epoch ms).
- **Populate with `statResult.mtime.getTime()`, never `mtimeMs`** - see section 0, lap 2. Add it in
  `readReplyAttachment` (`replyTool.ts:31`), which already stats the file, so every attachment-
  bearing tool inherits it from one place.
- `bun scripts/sync-leaf.ts src/shared/evie-protocol.ts` (format, restamp, copy - never a manual
  `cp`), then push evie-bot and run ITS gate inside its devcontainer.
- Regenerate `proto/Protocol.kt`; fixtures with and without the field, registered in
  `_manifest.json` so BOTH runtimes cover it.
- **Populated by the MCP only.** The phone OMITS it: no dependable picker column, and it could not
  restore on save anyway.
- **Restored by the MCP only**, in `materializeFiles` (`evieFiles.ts:61`), after the atomic rename.
  **Use the Date form, never bare numbers:** `utimesSync(path, new Date(), new Date(modifiedAt))`.
  VERIFIED on bun - a numeric argument is interpreted as epoch SECONDS, so passing ms stamps the
  file 2446-05-10 and throws nothing. The Date form also resolves the other half: `utimesSync` has
  no mtime-only overload, and passing `new Date()` for atime is what the questionaire's "atime is
  set to now on write" rule actually requires. Wrap it so a failure logs and the file still reports
  as transferred - the restore is a nicety, the bytes are the point, so this must sit AFTER
  `meta.path` is set, not inside the write's own catch.
- The Android save path does not attempt it.
- The phone still DISPLAYS it when an agent sent one.
- **Fixtures:** `ChannelFile` is not a dispatchable root in either runtime's manifest loop, so a
  fixture cannot be registered under that name - it has to ride a frame that embeds it. And a
  present/absent fixture pair does not prove an epoch-ms value survives as a Kotlin `Long`; this
  repo already invented an explicit large-value "Long bait" assertion for exactly that, which must
  be extended to the nested field rather than assumed.
- **`readReplyAttachment` is the choke point for path-attachment tools, but not the only
  `ChannelFile` producer** - two other sites build the shape by hand and will simply never carry
  `modifiedAt`. That is acceptable (the field is optional by design) but should be a known absence,
  not a surprise during review.

### 3. Agent-to-agent attachments (`crosstalk_send`) ✅

Pulled into this phase by the owner. This is what the `modifiedAt` field is FOR, so it lands here
rather than after.

**What already works** (VERIFIED by reading the path end to end):

- `/send` already accepts `files: ChannelFilesSchema.optional()` (`routes.ts:169`).
- A send carrying files mints a `message_id` and puts both on the `channel_push`
  (`routes.ts:1229-1233`); a fileless send mints none.
- The receiving MCP materializes to `/tmp/evie-files/<message_id>/` and appends the `[FILES]` block
  (`channelNotify.ts:16-19`).
- `mirrorPeer` spreads `files` into the peer mailbox entry (`routes.ts:415-421`), so the owner's
  console ALREADY receives agent-to-agent attachments on the mirrored thread. They land in the very
  gallery this plan builds - the two halves of this work meet here with no extra glue.

**Outbound half - small.**

- `BridgeSendSchema` gains `attachments: z.array(z.string()).optional()` (absolute paths). Write a
  PURPOSE-BUILT describe - do not copy `channel_reply`'s, which is entirely about console rendering
  (inline images, download chips, `@dsCard` design canvases) and describes nothing an agent
  recipient experiences. What the recipient actually gets is a `[FILES]` block of on-disk paths.
- **Fix the poll-vs-send discriminator first.** It is `session_id && !body` (`bridgeSend.ts:113`) and
  returns BEFORE any attachment handling, so `crosstalk_send({session_id, attachments})` would
  silently become a poll and discard the files with no error. Make it
  `session_id && !body && !attachments`, and keep `body` mandatory for a send (state it, since the
  existing `if (!to || !body) throw` already implies an attachment-only send is illegal).
- Map through the EXISTING `readReplyAttachment`: it already enforces absolute paths,
  `MAX_ATTACHMENT_BYTES`, mime-by-extension, and base64. No second reader, no second cap.
- **Extend `MIME_BY_EXT` in the same change.** It is 12 entries with NO video types at all, so an
  agent-attached `.mp4` arrives as `application/octet-stream`, and since both renderers classify on
  a bare mime prefix, it can never reach the previewable group - section 9's whole frame set would
  be dead code on the agent path. Add `video/*` (mp4, webm, quicktime, matroska) and the missing
  image types (bmp, heic/heif, avif, tiff, apng). Section 4 should state plainly that this table is
  the classifier's ONLY input on the agent path.
- Pass `files` in the `/send` body. `MAX_RESPONSE_FILE_BYTES` bounds the payload SIZE gateway-side,
  and nothing more: `routerPost` retries a fetch-level failure four times with the same body and
  `/send` has no idempotency for an agent caller, so a socket error after the push already fanned
  out delivers the files twice. Pre-existing and documented in `routes.ts` at `mirrorPeer`; noted
  here so the size bound is not mistaken for a duplication bound.
- Deliberately NO `appendRefArtifacts`: ref snapshots exist so a console can render a code viewer.
  The recipient here is an agent, which would just receive files it never asked for.

**Trust posture - an explicit decision, not an inherited one.** `readReplyAttachment` enforces only
`isAbsolute` plus the size cap: no root confinement, no secret refusal. The codebase justifies that
in-code by the destination being the owner's OWN console (`refFile.ts:62-67` says so for the sibling
reader). Section 3 repoints that same unrestricted reader at a foreign agent, possibly in a linked
friend Domain, since the relay carries `op.files` cross-Gateway and cross-Domain. Two mitigations
are real and already in place: `mirrorPeer` puts a copy in the owner's mailbox, and the outbound leg
mirrors too, so the owner SEES everything that leaves. Recommendation: accept, on that basis, and
say so in a code comment rather than letting it rest on "same as channel_reply" - which is true of
the reader and false of the recipient. Flagged for the owner; a path allowlist is the alternative.

**Inbound half - the actual gap, and the half the owner needs.** You ask a team to verify something;
they screenshot it back.

- `/respond` accepts files (`routes.ts:203`) and puts them on the push (`:1500`), and
  `ResponsePushPayload` declares the field (`types.ts:65`)...
- ...but `emitResponseNotification` (`channelNotify.ts:50-64`) ignores it completely: no
  materialization, no `[FILES]` block. Bytes cross the wire and are dropped on the floor. A reply's
  attachments are, today, unreachable by the requesting agent.
- Fix, mirroring the send path exactly rather than inventing a second convention: mint a
  `message_id` on the response push when and only when files are present, add `message_id?` to
  `ResponsePushPayload`, and run the same `materializeFiles` + `renderFilesBlock` pair.
- **The offline case stays lossy, and that has to be said rather than discovered.** The store copy
  is metadata-only by design (`routes.ts:1404` strips bytes), so if the asking agent's socket is
  down when the reply lands, the bytes are gone with no re-fetch path. Worse, the recovery route -
  polling by `session_id` - runs through `formatResult`, which never reads `result.files` in any
  branch, so the asker is not even told files existed. Minimum fix in scope: have `formatResult`
  list the filenames with an explicit "bytes were not retained, ask them to re-attach" line. Full
  durability (re-push on the asker's next register) is deliberately NOT in scope; name it as the
  known limit.

**Keeping ref snapshots off an agent's disk.** `channel_reply` appends `ref://` artifacts to every
reply whose body carries a ref, gated only on whether the OWNER's console can render a code viewer,
never on who is receiving this particular reply. Materializing a reply's files therefore starts
delivering source snapshots to an agent asker, which is the same thing the outbound bullet above
refuses. Two rules keep it out:

- The split is POSITIONAL. `appendRefArtifacts` emits the author's attachments first, then its
  artifacts with the manifest first, so the reserved filename marks where generated files begin.
  Reading the manifest to learn which files are snapshots would mean trusting a remote sender's own
  JSON, and a genuine attachment that happened to BE a captured manifest would then delete itself
  and every file it named. Position also survives the store, where the bytes are stripped and there
  is nothing left to parse.
- The reserved name is refused by `assertNotReservedName`, which is what makes the position
  trustworthy rather than assumed. There are TWO in-process producers of an outbound `ChannelFile`
  with a caller-chosen filename, not one: `readReplyAttachment` (crosstalk_send, channel_reply,
  notify_human) and `designer_push_card`, which builds its file inline. The second was missed on the
  first pass and made the invariant false, so the guard lives in `artifactNames.ts` beside the
  constant it protects rather than in either caller.

Applied to the REPLY leg only. A send never appends artifacts, so a manifest arriving there is a
file someone genuinely attached, and splitting on it would silently eat that file plus every one
after. Residual, accepted and logged rather than guarded: the console does not go through
`readReplyAttachment`, so an owner who hand-attaches a real manifest to a REPLY still loses it and
anything after it. Narrow, and the drop now writes a log line instead of vanishing.

**Note on `crosstalk_discover`/skill text.** The tool description and `skills/crosstalk/SKILL.md`
both enumerate what a send can carry; both need the new parameter or agents will not know it exists.

**Entry-point hardening the red team forced.** `readReplyAttachment` also rejects a non-regular file
(a FIFO stats as size 0 and then blocks `readFile` forever, wedging the tool call with no error),
and a new `readReplyAttachments` reads a list sequentially against ONE budget, since reading
concurrently holds every file plus its base64 in memory and N files each under the per-file cap can
exhaust the heap before anything can reject them.

### 4. Shared classifier (the anti-divergence layer) ✅

One Kotlin decision layer both renderers consume: drop plugin-hidden artifacts FIRST, classify
PREVIEWABLE (image, video) vs FILE, order previewables then files, and own the shared formatting
(display name, pretty size, dimensions, date + "... ago"). Must handle a metadata-only attachment
(`src == null`), which today falls back to a named chip. Unit-tested directly.

**PREVIEWABLE is an explicit allowlist, not a mime prefix test.** Both renderers currently branch on
`mime.startsWith("image/")`, which means widening the sender's mime table can silently promote a
format the WebView cannot decode into the thumbnail path, where it renders as a broken image. TIFF
and HEIC hit exactly that and are deliberately absent from `MIME_BY_EXT` until this allowlist exists
(`BitmapFactory` decodes HEIF, so the viewer would have been fine; the transcript is what breaks).
Adding them back is a one-line change here once the classifier gates on what the renderer supports.

### 5. Message row (`thread.js`) ✅

Previewables wrap as fixed squares, no names. Files stack below as thin one-line rows carrying a
glyph and the name only. A Designer-decorated row keeps its title and accent styling. Same for own
rows and theirs.

Only a row that actually opens something wears the control styling. A metadata-only attachment has
no bytes to show, so it renders muted and inert; dressing it identically was the dead-tap this
layout exists to remove, and it got reintroduced once already.

`prettySize` therefore has no consumer on this surface. It stays in the classifier for section 6's
info rows rather than moving, since the composer will want the same formatting.

### 6. Viewer (extend `AttachmentViewer`, single attachment)

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
- Info rows: `Size` (+ dimensions for images), `Modified` when present.
- **Drafts cannot reach this viewer at all today**, which the plan had assumed away. A draft chip has
  no tap target, and the only rel-to-`MessageFile` resolution scans `state.threads` alone - a draft
  file lives under `state.drafts` with an `attachments/draft-<uuid>/...` src, so the lookup returns
  null and both the `Modified` and `Location` rows would come back blank. Section 7 must add the tap
  target and the resolver must consult drafts.
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
returns exactly what the Compose strip wants (a `Bitmap`), and a plan whose whole thesis is "one
decision layer, kill the diverging code bug-class" should generalize that object rather than
re-derive it. Its capture path is WebView-specific and stays Designer's; the cache and its bounds
are what gets lifted. (Section 9's "DesignerThumbs does not transfer" is about the WEBVIEW surface
only, which does need a fetchable URL.)

Also add the missing tap target on a draft chip - see section 6, the draft viewer is currently
unreachable.

Accepted limitation: the scheduled-send dock replaces the composer wholesale, so the strip is hidden
while a send is banked. Consistent with today's behaviour for text and files.

### 8. `sourceLocation` - display name, not a path (draft-only)

Needs a picked-file type distinct from `MessageFile`, so the "cannot reach the wire" guarantee is
structural rather than a promise (today both share `MessageFile`, which is why the original claim was
false).

**The threading is the hard part, and the obvious route is wrong.** The provider display name is
only visible where the `content://` Uri is, at pick time. Getting it into the draft's file list
means riding the input to `Attachments.storeOutgoing` - and that input type is `OutgoingFile`, the
exact type `ConsoleClient.send` consumes. Putting `sourceLocation` there would place it on the
wire-adjacent type and defeat the guarantee this section exists to buy. So the picked-file type must
be introduced UPSTREAM of `OutgoingFile`, and the pick-to-draft path carries it in a side channel
that `storeOutgoing` never sees.

Honest counterweight, worth deciding rather than assuming: the "cannot reach the wire" property
already holds three layers deep at `OutgoingFile`, so the new type is a fourth gate behind three
that work, at a cost of roughly a dozen call sites. It buys structure, not a fix for a live leak.
If the implementation turns out to sprawl, dropping to a documented invariant plus a residue test is
a legitimate downgrade.

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

**Regeneration across buckets.** "One frame set feeds both renderers" holds only WITHIN one rel, and
a video picked in the composer occupies three distinct buckets over its life (draft, outgoing, and
the settled echo), so a naive implementation extracts up to three times per video sent. Either key
the frame set by content rather than rel, or carry the thumbs across the same hops that already move
the file - decide which, and say so, because a silent 3x on the most expensive operation in this
plan is exactly the kind of cost that never gets noticed.

**Degenerate inputs.** An audio-only container carrying a `video/*` mime would run the full N-seek
pass to produce N nulls before falling back to the glyph; `METADATA_KEY_DURATION` can also return
null or a non-numeric string, for which `floor(duration / MIN_SPACING)` has no defined behaviour.
Probe duration first and bail to the glyph on either.

**Where they live, and why it is forced.** Under the SAME attachments root as the source, as
`attachments/<bucket>/.thumbs/<name>.<i>.jpg` - app-private internal storage, never a shared or
device-wide location. This is not a free choice: the transcript is a WebView whose asset loader is
mounted on exactly one storage path (`ThreadRenderer.kt:186-192` registers
`InternalStoragePathHandler` for `/attachments/` rooted at `Attachments.root(filesDir)`), so a frame
stored anywhere else - `cacheDir` included - simply cannot be fetched by the transcript.

The app's only existing thumbnail machinery, `DesignerThumbs`, is an in-memory `LruCache` with no
disk at all, so there is no disk precedent to be consistent WITH; and its approach does not transfer,
because a WebView needs a fetchable URL rather than a bitmap. `cacheDir` would otherwise be the
idiomatic home for regenerable data (the app already uses `cacheDir/updates` for staged APKs,
`AppUpdater.kt:57`), but it is unreachable from the WebView without registering a second path handler
and widening what the renderer can read. Keeping thumbs inside the bucket also makes their lifetime
free: `Attachments.purgeAll` (`Attachments.kt:31`) deletes the root recursively, and dropping a
bucket drops its thumbs with it.

The `.thumbs/` subdirectory needs care in both directions. The per-file delete path
(`scheduleAttachmentDelete` / `mergeSentEchoFiles` deleteSrcs) must remove a file's thumbs rather
than orphaning them, and `Attachments.resolve`'s traversal guard must still behave for a dotted
segment. More subtly: the only thing in this app that enumerates a bucket directory is
`Attachments.deleteFiles`' empty-bucket cleanup, so a lingering `.thumbs` child makes a bucket look
non-empty forever and defeats it. That inverts the dot's stated purpose - nothing enumerates a
bucket to DISCOVER attachments, so the dot buys nothing and costs the cleanup. Either drop the
subdirectory in favour of a name suffix inside the bucket, or teach the emptiness check to ignore
it. Decide explicitly.

**Readiness needs a push channel, and it takes BOTH halves.** Frames generate lazily on a background
dispatcher, so a row is usually on screen before its set exists - and nothing currently tells it.
`MainActivity.kt:4159` re-syncs on `LaunchedEffect(renderer, messages)`, keyed on the message list
alone, and `ThreadRenderer.sync` re-renders an existing row only when its `fingerprint` changes.
Frames landing on disk change neither, so a completed set would surface only when some unrelated
message happens to arrive. Fix: a small observable readiness signal (per-rel, version-counted) added
as a `LaunchedEffect` key AND folded into `fingerprint`. Either half alone is silently inert.

**There is no precedent to copy here** - an earlier draft of this plan claimed the ref decoration
already does this, and that was wrong. `RefDisplayIndex` appears in no `LaunchedEffect` key
anywhere; the ref path has the fingerprint fold only and depends on being recorded BEFORE the row
renders (the ordering fix in `cd3ebd8`). Video frames cannot use that trick, because extraction is
genuinely slow and cannot be pulled ahead of first render. So the observable half is new work.

Related: `fingerprint` currently hashes the file COUNT and the decoration, never a per-file field
value. Section 1 adds two per-file fields to the render payload, so fold those in too, or a row
whose metadata is upgraded in place keeps a stale size in the transcript.

**Teardown.** The readiness signal guarantees at least one row REPLACE per video row, and any
per-row frame-cycling timer in `thread.js` will be leaked by that replace, retaining a detached row.
The replace path has exactly one teardown hook (the mermaid observer's); the cycling timer needs to
register there too.

**Cost and timing.** Ten seeks is expensive and must never touch the main thread: generate lazily on
a background dispatcher, cache on disk, show the first frame (or a play glyph) until the set is
ready. A video whose frames cannot be extracted falls back to the glyph tile rather than failing.

### Verification

Unit tests:

- The classifier (ordering, hidden-artifact drop, `src == null`).
- The text sniffer: NUL, invalid UTF-8, valid text exactly at the bound, and a 3-byte character
  STRADDLING the bound (the case the naive implementation gets wrong).
- The scale math, in pixels (intrinsic vs container, below-fit). Explicitly not a density test.
- The video sampling rule - the table above IS the corpus - plus the ms-to-µs conversion as its own
  case.
- **mtime restore**: write a file with a known epoch-ms stamp, materialize it, assert
  `statSync().mtime.getTime()` equals the sent value exactly. This is the test that would have
  caught the year-2446 bug, and it belongs on the TS side where the restore lives.
- Crosstalk attachments: A sends a file to B and B replies with a DIFFERENT file; assert both
  materialize and both `[FILES]` blocks render. Plus: a fileless response push mints no `message_id`,
  an attachment-bearing send with a `session_id` is NOT treated as a poll, and the asker-offline case
  reports filenames rather than silence.

**What the round trip can and cannot gate.** Extracting `fileJson`/`loadFiles` to top-level
`internal` functions made the serialization round trip an ordinary JVM test, and the two entry hops
(`Attachments.decode`, `Attachments.storeOutgoing`) are plain-JVM reachable too, so all of that is
covered and mutation-checked. What no unit test can catch is a FUTURE writer that simply does not
call `fileJson`: reverting `messagesToJson` to a hand-rolled object leaves the whole suite green.
That one stays a grep (`put("name", f.name)` should find exactly one hit) plus the emulator check
that size and date survive a process death. The byte-bearing `decode` branch is also emulator-only,
since `android.util.Base64` is a throwing stub off-device.

Emulator pass per surface: the 1:1 check at 100% zoom, a frame-set completion landing on an
already-rendered row, an attachment's size and date surviving a process death, and the draft viewer
opening at all (it is unreachable today).

### Open decisions for the owner

Neither blocks implementation; both are cheaper to settle now than to unwind later.

1. **Trust posture on `crosstalk_send` attachments** (section 3). An agent can attach any absolute
   path it can read, and the recipient may be a foreign agent in a linked Domain. Recommendation is
   to accept, on the strength of the owner-mailbox mirror, and document it. The alternative is a
   path allowlist or a refusal list for the obvious credential paths.
2. **Scope.** This started as "make the attachment gallery consistent" and now also contains the
   agent-to-agent transport, a mime-table expansion, a response-push fix, a two-writer save path,
   and generalizing `DesignerThumbs`. Every piece is load-bearing for something asked for, but it is
   a lot for one branch. Sections 1-3 (store, wire, transport) form a coherent first slice that ends
   with agent attachments working and the console rendering them as it does today.

Gates: `bun run lint && bun run test`,
`bun scripts/check-sync-hash.ts src/shared/evie-protocol.ts`, `bun scripts/codegen-kotlin.ts`,
`:app:testDebugUnitTest`, plus evie-bot's own gate in its devcontainer.
