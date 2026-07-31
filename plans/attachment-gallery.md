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
- **Role invariant (supersedes the reserved-name rule, which J-6 deleted):** every outbound
  `ChannelFile` producer stamps `role` as a LITERAL, never from its arguments, so no operator-supplied
  path can classify itself as machinery. Ref artifacts are dropped from agent-bound file lists by that
  declared role, in either direction; no filename is reserved and no position is meaningful.
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
- **IB - admission handle + repo-owned Error boundary. Ships alone, right after I0.** Added by a
  second assessment after I0's reconcile fix held but the RETRY button still crashed: I0 patched one
  call site of a shared hazard, which is the same defect wearing a different hat.

  The allocation is now pinned exactly: `53894224 = ceil(40420668/3) * 4`, so it is
  `Base64.encode`'s output array at `ConsoleClient.kt:661`, NOT `readBytes`. The file read
  succeeded. That also means `rebuildFiles`' `runCatching` (which catches `Throwable`) has been
  silently DROPPING oversized attachments and reporting them as "no longer on this device".

  The ownership defect, proven in-repo: `retrySend` is safe from `repoScope` (`SupervisorJob +
  Dispatchers.IO + CoroutineExceptionHandler`) and fatal from the retry button
  (`MainActivity.kt:292`, a Compose scope with no handler). Same function, same row; the caller
  decides whether it crashes. A per-caller `try/catch` is therefore not the fix.

  Two halves:
  1. **`OutgoingFile` becomes a smart constructor.** Private constructor, NO `bytes` field; an
     `OutgoingFiles.admit()` factory stats (`File.length()` / `openAssetFileDescriptor`) and returns
     `Granted` or `Refused(GONE | OVER_TRANSPORT | OVER_DEVICE)` BEFORE allocating anything.
     Budgets: the transport ceiling, AND live heap headroom scaled by a safety fraction, against
     `size * SEND_AMPLIFICATION` (the measured 1.78x, constant carries its probe date). Refusal is a
     VALUE, mirroring `sessionAuthority.ts`'s UNBOUND discipline. Enforced by a residue test:
     zero `OutgoingFile(` outside the factory, the Kotlin twin of the existing
     `grep 'put("name", f.name)'` rule.
  2. **The repository owns its scope.** Every `scope.launch { repo.X() }` in `MainActivity.kt`
     (~15 sites) becomes a plain `repo.X()` dispatching internally on the handler-bearing scope, so
     no repository `Error` has a path to Main. This half is PERMANENT - it is what will surface the
     blob store's own future failures (disk full, digest mismatch, torn `.part`) as red rows.

  Same commit, cheap and per-site (acceptable only because these have no shared producer type):
  evie's PUBLIC `DeviceApprovalPublicServer.ts:88` has no `maxRequestBodySize` (intends 8 KB, gets
  Bun's 128 MB; the ingress limit does not cover the pod-network path); four more unchecked
  `ws.send` returns (`BridgeServer.ts:617,771`, `BridgeTransport.ts:209,212` - I0 fixed two of six);
  `refFile.ts:86` reads before its cap; `listener.ts:177` `ChunkStream` has no total bound;
  `MainActivity.kt:865` length-checks nothing on a `*/*` picker.

  Honest limit: an admitted 16 MB file still peaks near ~140 MB through the encode chain. IB turns
  that into a clean refusal on a loaded device; only I3 makes it small. IB folds INTO the plane
  rather than being thrown away - at I3 the one private field flips `File` -> `blobId`, making I3 a
  one-function change instead of five construction sites, and at I4 only two integer constants die.
  The type, factory, residue test and Error boundary survive as the enforcement of this section's
  own rule that nothing can name a whole file, which nothing else in I1-I4 actually enforces.

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

**I0-I4 shipped.** Where the built result differs from the plan above, and why:

- **The sequential-budget reader stayed.** It was to be deleted as a memory guard, and that reason
  is gone, but the same loop is still the only thing bounding how much one message may attach: the
  per-file cap alone lets N files each under it total anything. Kept, with the justification
  rewritten to the one that is now true.
- **A total-size bound moved onto the write path** (`MAX_BLOB_BYTES`, enforced in `answerBlobOp`).
  Deleting `fileBytes`' base64 term would have left `MAX_RESPONSE_FILE_BYTES` measuring only the
  sender's own `size` claim, which nothing verifies, so the ceiling had to follow the bytes.
- **`answerBlobOp` is a new single implementation** of the three ops. The HTTP door and the console
  door had each grown a bound the other lacked: console `blob_get` took an unclamped `length`.
- **`OVER_DEVICE` was deleted, not just its two constants.** The heap-proportional refusal existed
  because the encode chain held ~1.8x the file; with a chunked transport it would only refuse work
  the device can do.
- **A stored reply now keeps its file references**, so `stripFileBytes` did not just die, it
  inverted: a polled reply materializes its attachments instead of naming them and apologizing.
- **The console version gate was NOT built.** The capability union now carries every live device's
  `clientVersion` (the input such a gate needs), but no enforcement reads it, because none of the
  available behaviours is worth its cost: refusing a send because one device is stale breaks the
  union semantics every other capability follows, and warning an agent about a device it cannot
  affect is noise. Degradation is already graceful, since a console that does not understand
  `blobId` renders a metadata-only chip rather than failing. Decide the policy before building one.

**Second round, after three adversarial reviews.** What they found and what changed:

- **A blob's lifetime is now a CACHE lifetime.** Nothing reference-counts a blob, deliberately: a
  reference can live in a mailbox entry, a durable job result, a thread row on a phone, or a message
  still in flight, and a counter that must be right in four places will be wrong in one. Content
  addressing makes the cheap answer correct, since evicting something still named costs a re-fetch
  rather than a loss. `BlobStore.sweep` (byte-capped, coldest-first, gateway + agent) and
  `BlobStore.pruneStale` (age-based, phone) are the only reclaim paths, and every store now has one.
- **The phone stores an attachment once, not twice.** Its blob store is a transfer BUFFER: an
  inbound blob is dropped the moment `land` puts its bytes in the attachments bucket that the
  renderer reads and the orphan sweep already owns. Without this, every attachment existed in both
  trees and only one of them was ever swept.
- **`purgeAll` reaches the blob store.** Its own comment promised a Revoke-and-Delete leaves no
  message bytes behind; the two roots are siblings, so it had been leaving a complete second copy.
- **`land` reports a failed commit instead of a src.** It discarded `renameTo`'s result, so a failed
  rename produced a src for a file that was not there, and a row carrying a src is never retried:
  one recoverable failure became permanent.
- **The inbound re-drain fold keeps landed attachments.** A re-drained entry describes files without
  carrying them, so folding it in raw blanked a src whose bytes were on disk and rendered, after
  which the orphan sweep was entitled to collect them. Now the inbound twin of `mergeSentEchoFiles`.
- **The fetch pass is single-flight and gives up.** It fired once per poll pass with no guard while a
  transfer routinely spans several, and a reference no Gateway could serve was re-requested forever.
- **The untimed exemption moved to the op that carries bytes.** It had stayed on `send()`, which no
  longer does, leaving `blobPut` under a 60s whole-call deadline that a slow link fails every time.
- **`MAX_RELAY_FRAME_BYTES` enforces something.** It related three constants in a test that passed
  with the entire blob plane deleted; the budget is now checked where a frame becomes bytes, so an
  oversized reply fails its own op instead of closing the socket every team shares.
- **Both transfer directions are bounded.** Uploads got the stall guard downloads had; downloads got
  the total ceiling uploads had; `ChannelFilesSchema` is capped by count, since a message's cost is
  now the number of references a receiver will chase rather than its own size.
- **A failed fetch reads differently from a file that carried no bytes**, because one is worth asking
  to have re-sent and the other is gone, and one sentence for both had the agent give up on the
  recoverable case.
- **Two residue rules were evadable.** `OutgoingFile.of` slipped past a `\bOutgoingFile\(` match, and
  `\s*` cannot span a statement, so any line before the repo call defeated the launch-scope rule. The
  second now exempts a file that builds its own `CoroutineExceptionHandler`, which is the thing whose
  absence makes a launch dangerous in the first place.

**Third round, two more adversarial passes.** The sharpest findings were in code written during the
second round, which is the argument for auditing a fix as hard as the thing it fixed:

- **Reads now refresh mtime, and the sweep doc was lying before they did.** It claimed eviction was
  least-recently-USED "by the same mtime the reads refresh". Reads refresh atime, not mtime, and no
  filesystem here is mounted to make atime readable, so the order was really first-written-first-out:
  a large attachment being fetched over a slow link was among the FIRST evicted, precisely because
  the transfer started early.
- **The sweep doc's safety claim was also false.** It said evicting a blob someone still names "costs
  a re-fetch, not a loss". There is nowhere to re-fetch from: the sender's staging copy has its own
  sweep and its container may be gone. Corrected to say eviction IS a loss, which is why the ceiling
  sits far above real traffic and the mtime touch matters.
- **A short final write no longer destroys the transfer.** `writeSync` returns a partial count rather
  than throwing when a disk fills, so the part ended up shorter than the chunk that claimed to finish
  it, and `seal` deleted every transferred byte to punish the lost tail. Both runtimes now report the
  honest prefix so the sender resumes.
- **The single-flight latch could stick forever.** It was claimed before the dispatch, and the
  release lived in the coroutine body, so a null or already-cancelled scope left it latched for the
  life of a process-lifetime singleton: attachments would silently stop arriving until a force-stop.
- **`land` leaked its partial on the throw path** (the rename path already cleaned up). The usual
  trigger is a full disk, and the retry runs once per poll pass with a fresh name, so the failure
  path consumed more of the exact resource whose exhaustion caused it.
- **Staging is swept BEFORE an ingest, not after.** Sweeping after let a file large enough to blow
  the budget alone be staged and immediately evicted as the single over-budget entry, so the next
  line failed on a blob that existed a millisecond earlier.

**Fourth round, an adversarial-peer pass. It found the worst bug of the whole intermission:**

- **A stored reply no longer carries a fetchable reference, and never should have.** The old code
  called `stripFileBytes` before persisting, commented "so a persistent store entry never retains the
  bytes". Moving bytes out of band was read as making that guard obsolete, and it was replaced with
  "the store holds the whole thing" - which turned a deliberate METADATA leak into a CONTENT leak.
  `/pending` enumerates every session id and authorizes nobody, `/poll` takes a `req` it never reads,
  `/blob/get` has no gate, and a channel entry is persistent and never swept. So three unauthenticated
  hops read every attachment any agent ever sent. `blobId` is not metadata: it is a bearer token for
  the content. `stripFileRefs` restores the boundary, and moving the bytes out of band changed WHAT
  has to be withheld, not whether. Pinned by a test that greps the whole polled body for the id.
- **Unfinished transfers count toward the store ceiling.** They were reclaimed by age alone, so the
  one unbounded attacker-controlled write on the disk sat outside the one bound on it: never send a
  final chunk and hold arbitrary space for an hour, none of it registering against the budget. A
  partial now also evicts before a sealed blob of equal age, since nothing can name a partial yet, so
  losing one costs a resume rather than the file.
- **The HTTP blob door validates against the console plane's own schemas.** It parsed with a bare
  cast while the sealed plane ran zod. Harmless only by accident: `write` never seeks to the caller's
  offset, so unvalidated negatives merely threw. Anyone "fixing" that into a real seek would have
  turned an unauthenticated route into a corruption primitive.

### I5 - a blob reference names where its bytes are. DONE.

`blobId` says WHAT; without a companion saying WHERE, a message that routes to another Gateway names
bytes its receiver cannot reach, in both directions, which was a regression against the inline wire.

- **`ChannelFile.blobGateway`** carries the holder. Absent means "wherever you are", which is right
  for every same-Gateway transfer and is what a peer predating the field implies.
- **The GATEWAY stamps it** for a local agent, in `respond` and `send`. That one point knows both
  that the bytes were uploaded here and that the message is being posted here, which is why an agent
  never has to learn its own Gateway id. Only ever fills a blank: a relayed message already carries
  its origin's stamp and the console carries its own, and overwriting either would point every
  receiver at a Gateway that never held the file. The console stamps its own `routeGateway`, because
  it uploads there while sealing the send to the target's Gateway.
- **`blob_fetch`** joins the federated op union. The Gateway being asked for a blob it lacks pulls it
  from the holder over the existing sealed relay and caches it. Deliberately ungated beyond the
  relay's own admission check: a blobId is the digest of the content, so naming one is already proof
  of holding the bytes it names, and there is nothing to enumerate.
- **Clients never learn any of this.** They ask their own Gateway, always, and it either has the
  bytes or gets them. That indirection is the point: the transfer loops are identical whether a blob
  is local or three hops away, and content addressing makes the cache free of invalidation.
- Bounded like every other transfer: a range at a time, against `MAX_BLOB_BYTES`, refusing a peer
  whose cursor stops advancing. A failure returns false rather than throwing, because the caller's
  next move is to report that one file unavailable, not to fail the message.

Rejected: having the producer upload to the target's Gateway. It closes console-to-agent only, since
an agent cannot know which Gateway the owner's console happens to poll.

**Fifth round, red-teaming I5 itself.** Four fixes, all in code from this slice:

- **`notify_human` was the one unstamped path.** `stampBlobHolder` had two call sites and this was not
  one, so a notice's attachment fanned out to every Gateway naming bytes none of them could locate.
  A `channel_reply` attachment from the same agent worked, and a single-Gateway Domain never sees it,
  which is exactly the shape that survives local testing.
- **A cross-Gateway fetch now tries every candidate Domain, not one.** `sealTargetFor` is local-first
  by deliberate design, which is right for a SEND (misrouting a message is a disclosure) and wrong for
  a fetch, where it silently asks a sibling that never held the file. Gateway ids default to the
  machine hostname and duplicates are anticipated (see `GATEWAY_ID` in docker-compose.yml), so a
  friend's `desktop` and this Domain's `desktop` are the same string. Trying several sources is safe
  HERE and nowhere else in that file: a blob is named by the digest of its contents, so a wrong guess
  returns no bytes rather than wrong bytes.
- **A stat can no longer trigger a cross-Gateway pull.** The guard read `kind !== "blob_put"`, so a
  hand-crafted stat carrying `fromGateway` dragged up to 16 MB across the mesh to answer what is
  advertised as the cheap "how much do you have" a resume asks first.
- **Concurrent readers of one absent blob share a single fetch.** A client-facing door now initiates
  outbound mesh traffic, and every request re-enters while the bytes are absent, so N readers meant N
  full relay loops for identical content.

And one correction to this document: the `crosstalk_send` poll branch was changed in the fourth round
to materialize attachments, on the claim that a stored reply keeps its references. The SAME round
made that false by adding `stripFileRefs`. A poll reads the persistent copy, which deliberately holds
no reference, so it names attachments and says a re-send is what recovers them. Claiming the sender
attached nothing would have been both untrue and the one message that stops an agent asking.

Rejected from that round, as unsubstantiated: a cross-Domain share gate on `blob_fetch`. The reviewer
could not construct a sequence where a friend obtains a digest without already holding the content,
which is the whole claim - a digest IS the capability. Gating it needs per-session blob tenancy, and
the store is content-addressed and partitioned by nothing, so that is a redesign, not a gate.

Known gaps, accepted and real:

- **The cutover strips `base64` silently rather than refusing it.** A not-yet-updated console's
  attachment is discarded at the schema boundary while the sender is told the send succeeded. Making
  it loud needs `z.undefined()`, which cannot be represented in JSON Schema and so breaks the Kotlin
  codegen the drift check depends on. MITIGATION, and it is a real one: deploy the PHONE FIRST. New
  phone against an old Gateway fails loudly and retriably (the op kind is not in the old union), and
  that ordering never enters the silent cell at all.
- **Rollback is destructive to in-flight rows.** An old APK has no `blobId` in `fileJson`/`loadFiles`,
  so the first `persistThreads` after a downgrade drops the field from every row, and re-upgrading
  cannot recover the reference. Rows already landed (`src` set) are unaffected.

- `check-sync-hash` verifies internal faithfulness, not cross-repo equality, so a stale-but-self-
  consistent leaf copy passes both CIs. Push order remains discipline; consider a real cross-repo
  diff in one CI while touching this.
- ~~A blob lives on ONE Gateway and messages route to another.~~ Closed by I5, below.
- **The blob HTTP routes now authorize, through a question `sessionAuthority` owns.** They were the
  only POST routes that never read `req`. The question a blob op poses is genuinely new, because a
  transfer names bytes rather than a session, so none of the three name-keyed gates applies:
  `mayUseLocalPlane` answers "is this caller any of my sessions?" and keeps the module's existing
  shape rather than a stricter invented one. If any local session is bound a caller must present one
  of those tokens; if none is, the requirement is UNBOUND and anything satisfies it, exactly as
  `toClaim` on an unbound name already decides. The console is unaffected: it reaches the same three
  ops over its sealed plane, and the HTTP routes have exactly one caller class, this machine's own
  MCP agents.

**What the intermission unlocks for the later sections:** resumable large uploads; range reads
(previews, streaming playback); dedup across resend and echo; content-keyed video thumbs (resolves
section 9's regeneration problem outright); `ref://` snapshots escaping their 2 MB budget.

### J. INTERMISSION - Declared file metadata (REQUIRED before 6-9)

Owner directed this in after the I intermission shipped and the ref artifact rows appeared as visible
junk: "Be ready to totally junk and undo most of the code and decisions in all of those commits. We
do this right foundationally. Perhaps a meta object in base Switchboard that base can make use of,
and plugins can too."

**The defect.** A `ChannelFile` is genuinely a sum type (user attachment, ref manifest, ref snapshot,
designer card) collapsed at the wire edge into one product shape. The tag is dropped, so every
receiver re-derives the role from whatever side channel it can reach. The sender knew it declaratively
at compose time and threw that knowledge away.

**Four independent recovery mechanisms**, free to disagree:

| Site | Mechanism |
|---|---|
| `ReferencesPlugin.kt:36` | reads manifest BYTES at drain time |
| `DesignerPlugin.kt:33-37` + `DesignerCards.kt:74` | `f.src ?: continue`, reads bytes |
| `evieFiles.ts:131-134` | POSITIONAL split on a reserved filename |
| `channelNotify.ts:11-20` | gates that split on message DIRECTION |

`assertNotReservedName` is the tell: a global rule every producer must remember, existing only to keep
one filename unclaimable so a positional guess stays trustworthy.

**Why it kept coming back.** Six commits, every one a timing adjustment: `7cdbca6` (feature),
`8830994` (instrument), `b8a4678` (fix attempt, disproved), `e4df21c` (instrument again), `cd3ebd8`
(seed earlier, into a `beforeCommit` hook), `bc22582` (blob plane). `cd3ebd8` was correct and still
works; the blob plane then moved the BYTES later, so perfectly-timed seeding reads a file that is not
there. The decision depends on a conjunction of five things (bytes exist, landed, under a size cap,
parseable, at the right moment) and each fix pins one conjunct.

**Live regressions from `bc22582`:**

- References records nothing (`manifestFrom` returns null). Artifact rows never hidden; fuzzy refs
  never amber. `RefDisplayIndex` documents no backfill, so those rows are permanently wrong.
- References is TWO stacked bugs: even given a manifest, `hiddenRels` maps over `f.src`, null at
  drain time. Fixing manifest discovery alone leaves it broken.
- Designer's `cardsFrom` skips every file. Agent-pushed cards never enter the dock.
- `DesignerDock.kt:203-217` is worse than dead: `markBackfilled` runs BEFORE the seed loop, so an
  unlanded row is missed permanently, not until next time. Mark-first was right against a torn loop.

**Not broken, leave alone:** `RefLinkHandler.tryOpen` and `DesignerCardOpener` read at TAP time, when
bytes exist by definition. That is the authority path and it gives references their snapshot
semantics. The gateway inspects no filenames at all and must stay role-blind.

#### Questionaire

Process: one advocate agent per option, each required to make its own option work and then attack it.
The synthesis is verified against the code before it becomes a recommendation.

**J-1. What scope does the meta ride at?** -> **Per-file only.** Message-level meta deferred, not
rejected; owner: "As plugins expand, we might find a real use for it." Retrofit is additive (optional
field, `ignoreUnknownKeys`, open generated types), so nothing closes.

Corrected fact, load-bearing: the ref key to quality map DOES ride per-file. Every ref key resolves to
exactly one file, and `artifactBuilder.ts:136-151` groups refs BY `refPath` and emits one file per
group. An earlier claim that it could not was wrong.

**J-2. How is the per-file meta shaped?** -> **Flat base-owned named fields.** A flat optional `role`
that base alone reads to decide visibility, plus hand-named optional fields for the plugin facts. No
open bag. Rejected: a per-plugin untyped bag, and a single open bag with reserved keys.

Recommendation reason (chosen): the CLAUDE.md never-a-generic-map rule transfers, because its stated
rationale is a pair of codegen facts, not anything about planes. The two arguments for a bag both
fail on inspection: the synced-leaf cost is removable (evie has zero consumers), and the shipped
`plugin_action.payload` precedent is a COMMAND channel with open-ended action types, where naming
fields is impossible. A file's facts are closed, because the plugin catalog is compile-time.

Two amendments accepted with it:
- Move `ChannelFileSchema` OUT of the synced leaf first, as its own verifiable step.
- Do NOT build `refQuality` yet. There is no consumer once the index dies. Accepted consequence:
  amber rendering for fuzzy refs stays dead until something is built to read it.

**J-3. How does the Designer dock stop depending on WHEN bytes arrive?** -> **Byte-free ingest with
lazy resolution at render**, taking the frozen-legacy-archive migration from the rejected derive-from-
state option. Rejected: a second "attachment settled" event, and deleting the store entirely.

Recommendation reason (chosen): it RESTORES the single-writer invariant rather than patching it. With
no second event the inbound handler stays the only writer, firing once before the row reaches
`_state`. Verified: a redelivered message returns at `ChatRepository.kt:4604`, before `beforeCommit()`
fires at `:4607`, so the premise `DesignStore.kt:94-95` relied on becomes true again. Deleting the
store outright was rejected because persisting ONLY deletions fails in the wrong direction (a lost
tombstone resurrects every card ever deleted, where today the same corruption merely empties the
dock), and because it forecloses designs outliving their conversation.

Migration is taken from the rejected option because this one's own plan needed a legacy sweep that
READS BYTES and re-runs, which would keep alive exactly the path being deleted. Freezing the old store
once at upgrade is a single migration with no surviving byte-reading path.

**A generation guard does NOT fix the resurrection bug. Do not try it again.** Recorded because it was
proposed and is wrong: with a row-shaped landing event, two cards in one message where the first lands,
is deleted, and then the second lands re-presents BOTH files, so the deleted card returns. A `guardGen`
captured at handler entry is captured AFTER the delete, so it equals the current generation and
`DesignStore.kt:97` lets the write through. The fix is an event that names exactly the one file that
changed, which makes the bug unrepresentable rather than guarded. Under the chosen option there is no
landing event at all, so this is moot - but it stays written down because the guard LOOKS sufficient.

**Pending and failed become representable.** `StoredCard.rel` stops being non-null, which is what lets
a card exist before its bytes. Both states are drawn (dock card `designer-card-states.html`):
downloading and failed look different from each other and neither looks like empty; rows keep their
real name and dimensions in every state, since those came off the wire; the dock bar's peek slot
carries the state rather than falling back to a generic icon; `Reattach`/`Download` dim because they
read the file, while `Reference`/`Delete` stay live because they do not.

UX delegated to Claude by owner. Rulings:
- **Retry ships.** `attachmentFetchFailures` (`ChatRepository.kt:1056`) is private and in-memory, so a
  failed card already silently re-attempts on next launch. A button makes that recovery deliberate
  instead of folklore, and a dead-end "couldn't download" with no action is the same silent-dead-end
  shape this intermission exists to delete.
- Retry MUST clear that blob's entry in `attachmentFetchFailures`, because `fetchPendingAttachments`
  skips at `>= MAX_ATTACHMENT_FETCH_TRIES` (`:4344`). A Retry that does not clear it is a no-op button,
  which would be its own silent dead end.

**J-4. What does a file carrying NO role mean?** -> **Absent means ordinary attachment, always shown.
No live-path fallback.** Plus a one-shot migration for rows already drained. Rejected: a permanent
fallback to the old derivation, and migration alone.

Recommendation reason (chosen): **every degradation collapses toward SHOWING.** A stale sender, a
stripping Gateway, an APK rollback all remove the field, which makes a file more visible, never less.
No input, malformed or hostile, makes an unstamped file disappear. It also deletes the only code that
can silently eat a real attachment (`evieFiles.ts:133` `slice(0, start)` drops the matched file AND
every file after it).

The permanent-fallback option was rejected on safety: it is the only one whose own advocate admits a
genuine user file can be wrongly hidden, and it depends on producer array ordering
(`attachRefs.ts:112`) that no test enforces, while making `role` look authoritative. A future engineer
relaxes the ordering because the field exists, and real files start vanishing. Same "global rule
everyone must remember" shape this intermission exists to delete.

A live fallback provably cannot fix already-drained rows: the mailbox is exactly-once, so a drained row
is never revisited. Hence the one-shot pass. It reads manifests off disk, which is legitimate ONLY
because it runs once, later, when bytes have landed - not at drain. Bounded: skips `fromMe` rows, and
hides a chip rather than deleting a file, so bytes stay resolvable if it misclassifies.

Accepted cost: while any agent is un-upgraded, its ref artifacts show as junk to an upgraded receiver.
Narrow (agent crosstalks agent, replier stale, receiver not), cosmetic never functional, taps still
work, and `MainActivity.kt:1982-1988` already draws a version chip on a session running behind.

**`role` is STRIPPED IN TRANSIT by a stale hop.** Verified: `routes.ts:1434` forwards `parsed.data`,
and zod `.object()` drops unknown keys, across up to four independently-versioned hops. A receiver
therefore CANNOT distinguish "old sender" from "old middle box", which is why absence must never be
interpreted as anything but ordinary.

**Corrections to earlier claims in this plan:**
- `assertNotReservedName` is PERMANENT, not deletable. All three advocates concluded this
  independently. `RefManifest.kt:82` selects the manifest by that exact name at TAP time, and tap time
  stays authoritative so old rows keep opening. Without the guard, a forged manifest plus matching fake
  snapshots makes the console open fabricated source for a ref link. The earlier framing of it as
  coupling the role field would retire was wrong.
- "Old rows keep visible junk forever" was also wrong. `RefDisplayIndex` is SharedPreferences-backed
  and survives an APK update, so deleting the writer does not delete the records. Normally-drained rows
  stay hidden. The junk rows are specifically those drained AFTER the blob plane broke recording.

**Live bug found, independent of this work:** Kotlin has NO producer-side reserved-name guard.
`MANIFEST_FILENAME` appears only for reading (`RefManifest.kt:50,82,125`, `ReferencesPlugin.kt:37,58`);
`ConsoleClient.kt:667` builds outbound files straight from the picker with no check. Latent today only
because the console never calls `respond`. Port the guard to Kotlin regardless.

**Also required in the same commit:** delete or reword the DEBUG tripwire (`ReferencesPlugin.kt:52-63`).
Under this option a stale sender's message is exactly what it warns about, so it would fire routinely
and be correct.

**J-5. What does a receiver do with a role value it does NOT recognize?** -> **Show it**, and demote it.
Rejected: sender-declared policy fields alongside identity, and a structured role string parsed for
coarse policy.

Recommendation reason (chosen): **asymmetry of failure.** On the console the decision is recomputed on
every render pass (`AttachmentDisplay.kt:56-65`), so a wrong SHOW self-heals retroactively across the
whole back history at the next app update. A wrong HIDE cannot: `displayAttachments` drops hidden
entries before the row is drawn, so the file is unreachable rather than dimmed. On the agent side the
notification fires exactly once, so an omitted file is never learned about at all - and that is the
receiver where hiding is most often wrong anyway, since "content the sender meant for you" is the broad
class and machinery is the narrow one.

Policy fields were rejected because they are stripped by the SAME hops that strip `role`, so policy
only carries when every intermediary is new enough: the same message can render differently on two of
the owner's own devices depending on the route. The structured-string option was rejected because it is
the same in-band technique being deleted, enforceable only by a residue test, on a runtime whose CI
does not compile Kotlin before merge.

`Protocol.kt:4-6` already commits to this posture in writing: "Enum-like fields are open Strings on
purpose: the console must tolerate values newer than this build."

**Demote-never-hide amendment (zero wire cost).** An unknown role never takes a thumbnail slot and
never sorts above the user's own attachments; it renders as a plain named row at the end. Add
`file.role == null` to `isPreviewable` (`AttachmentDisplay.kt:46-47`); the existing
`sortedByDescending { it.previewable }` already puts it last. The signal is spent on RANKING, never on
reachability. The agent's `[FILES]` block prints the role beside the entry so an agent can see the
sender classified it deliberately.

#### Two-phase clean break

Owner directive, and it revises the ending rather than any single answer: "keep in mind I am the only
user. I can update everything at once. so don't lock into legacy behavior. It can be a 2 parter phase
migration, and then clean out for clean break."

- **Phase 1.** `role` optional. Every producer stamps, INCLUDING ordinary attachments, which stamp
  `attachment` explicitly. One-shot migration stamps rows already persisted. Absent tolerated, shows.
  Ship every runtime.
- **Phase 2.** `role` becomes REQUIRED. Absent stops being a state anyone interprets and becomes a
  schema violation rejected at the edge. Delete the tolerance path, the positional split, and the
  direction gate.

Why it is worth a second phase: absent was carrying two meanings at once, "an ordinary file the user
attached" and "a sender that could not say". The safety argument worked by collapsing both to SHOW,
which is correct but works by refusing to distinguish two genuinely different situations. Requiring the
field makes the ambiguity nonexistent rather than handled.

Verified: `stripFileRefs` (`routes.ts:250`) spreads the rest of the file after omitting `blobId` and
`blobGateway`, so `role` reaches the persistent store with no additional work.

Mixed-fleet cost from J-4 shrinks to a deploy window rather than weeks, but J-5 is unaffected: it rests
on recoverability, not on fleet composition, and the phone is exactly the component that can sit a
version behind a just-updated gateway.

**This reopens the reserved-name question.** All three J-4 advocates called `assertNotReservedName`
permanent BECAUSE old rows must open forever, and the clean break removes "forever". It does not simply
delete, because the guard exists to stop a crafted attachment being adopted as a real manifest, and if
selection moves to the role field then a hostile peer can stamp that role instead, so the protection
changes shape rather than disappearing. Under advocacy separately, since it carries a security property.

**J-6. After the clean break, what protects manifest adoption from forgery?** -> **Delete the manifest
FILE entirely.** Its content moves onto the snapshot files as per-file ref metadata. Rejected: keeping
`assertNotReservedName` alongside role (its own advocate called it vestigial as forgery protection),
and role-alone selection with the file kept.

Recommendation reason (chosen): with no manifest there is no adoption step - no reserved name, no
first-wins selection, nothing to forge. The guards become unnecessary rather than weaker. The real
protection already exists and survives: `role` is a LITERAL in each producer, never derived from an
operator-supplied path, and ref authority is confined to the one file carrying the stamp (the manifest's
guards all existed to bound its authority over SIBLING files, and that cross-file authority is what gets
deleted).

**The feasibility worry was inverted, and it decided the question.** Segment text never rides the wire:
the snapshot file IS `segments.map(s => s.text).join("\n")` (`artifactBuilder.ts:219-224`), so
`(startLine, lineCount)` pairs partition it byte-exactly. Today the text ships TWICE (manifest JSON +
snapshot file) and the file's copy is never read in snippet mode (`ReferenceViewer.kt:60-69`).
Dissolving the manifest roughly halves snippet-mode wire cost.

Also fixed for free, verified live: producer allows 2 MB of artifacts (`artifactBuilder.ts:75`), console
refuses any manifest over 512 KB (`RefManifest.kt:56,94`) and then silently declines the tap - enough
refs in one reply and the code viewer stops working with no error anywhere.

Evie-strip risk checked and does not hold: relay frames are `looseObject` (`evie-protocol.ts:121-136`),
payloads are sealed, and evie has zero consumers of `ChannelFileSchema`. The only strip points are our
own gateways.

Wire shape (stays within per-file-only; arrays not records, honoring the no-generic-map rule):
`RefSegmentMeta {startLine, lineCount}`, `RefKeyMeta {key, startLine, endLine, span?, quality, reason?,
ambiguous?, matchCount?}`, `RefFileMeta {refPath, segments?: [].max(64), keys: [].max(64)}`;
`ChannelFileSchema` gains `ref: RefFileMetaSchema.optional()`. Segments absent = full mode. HARD CAPS
ARE MANDATORY: without them per-file metadata scales with prose, and an oversized relay frame closes
the socket rather than failing politely. With them, worst case ~50 KB across a 10-file message.

Conditions attached (non-negotiable): the array caps above; golden wire fixtures under
`tests/fixtures/` iterated by BOTH runtimes; the amber-tier consumer builds a ROW-LOCAL map once per
render (the site is hot - the old index existed because a scan is quadratic in a long thread,
`RefDisplayIndex.kt:31-32`); serialize the Kotlin side through the codegen'd `@Serializable` class
rather than hand-building JSON, with a round-trip test; drop `totalLines` (decoded, never read).

Deleted outright: `assertNotReservedName` + both call sites, `MANIFEST_FILENAME` (both runtimes),
`MANIFEST_MARKER`, `manifestFrom` + `decode` (~130 lines), `RefDisplayIndex.kt` (127 lines + prefs
store), the TS naming-replay hack (`artifactBuilder.ts:141-146`), the positional split, the direction
gate, the debug tripwire, and the producer/consumer manifest-size mismatch.

Honest scope statement, owner accepted ("let's do it"): 3-4x the change of the alternatives (~14 files,
two runtimes, the synced leaf re-copied to evie-bot, a codegen pass, four test files rewritten), and the
phone-side migration must RECONSTRUCT per-file metadata from on-disk manifests rather than merely stamp
an enum. Net deletion overall. Budget effect: frees one file slot per ref-carrying message.

**J-7. When does the clean break happen?** -> **Two releases: full code clean break immediately, wire
strictness at the end.** R1 deletes every old code path and keeps `role` `.optional()` with one
`?? "attachment"` normalization at the decode edges. R2, after the owner updates Claude plugin and
phone, flips `role` to required and deletes the normalization and the restore shim. Owner: "let's make
it permanent by the end of the plan after I update my Claude and phone."

Recommendation reason (all three advocates converged): the feared split-brain never exists, because R1
already deletes the old derivation everywhere - the only tolerance is one optional marker and one
default expression on the single new path, not a second implementation. Verified: no gateway restore
parses ChannelFiles through zod at all (`gateway/index.ts:232-240` restores are raw casts), so
strictness cannot fail a restore. The REAL hazard is one hop later and is why strictness must wait:
`codegen-kotlin.ts:287` emits a required field as a non-default Kotlin param, so a strict APK's poll
decode throws `MissingFieldException` on a single role-less served mailbox entry, the cursor never
advances, the entry can never be acked past, and the box never idle-expires because polling refreshes
`lastActivity` - a PERMANENTLY wedged console with healthy-looking gateway logs. R1's restore-stamp plus
ingest normalization plus the soak make "zero role-less entries exist" an inspectable precondition
before R2 ships, instead of a hope.

#### Verified constraints

- `codegen-kotlin.ts:376-377` is a literally EMPTY else. A non-sealed `oneOf`/`anyOf` root emits
  nothing, silently, and the CI drift check passes on the silence. Unions are unusable.
- `codegen-kotlin.ts:252` maps `z.record` to an untyped `JsonObject`.
- `codegen-kotlin.ts:247` emits `List<Named>` for an array of a `.meta({id})` schema. **Array-of-pairs
  is the typed-map workaround, so no fact forces a generic map.** This killed option C, and the same
  false premise ("quality is intrinsically a map") had already produced one wrong recommendation.
- `z.enum` emits an open Kotlin `String`, so an unknown future value cannot throw on an old console.
- **`ChannelFileSchema` is misfiled.** It lives in the synced leaf `evie-protocol.ts:28`, but evie has
  ZERO consumers: it appears in evie-bot only in that file's own copied definition. Moving it out of
  the leaf removes a three-repo ritual that buys nothing.
- `MessageFile` persistence is hand-written (`ChatRepository.kt` `fileJson`/`loadFiles`) and untested;
  a field added to the data class but not both vanishes silently across restart. `MessageFile` is also
  built POSITIONALLY in three places with adjacent nullable-String slots.
- `PluginEntry.kt:137` - plugins are first-party code compiled into the same module, from a
  compile-time catalog. There is no third party to keep a schema open for.
- A plugin-keyed untyped map IS already shipped and endorsed (`schemas.ts:812` -> `Protocol.kt:111`),
  but that is a COMMAND channel with open-ended action types.
- `ChannelFilesSchema` caps at 10 files TOTAL, and ref artifacts spend the same budget as user
  attachments. Eight refs plus three files silently exceeds it today.

#### J execution phases

**J0 - move `ChannelFileSchema` out of the synced leaf. ✅ DONE** (switchboard `3e899fb` PR #201, evie
`31ed318` PR #1427, both merged and pulled). Landed as new zod-only `src/shared/channel-file.ts`
rather than inside `schemas.ts`: schemas.ts imports from federation-protocol.ts, which consumes
ChannelFilesSchema, so defining it in either would cycle. schemas.ts stays the one import surface via
re-export. Leaf restamped `aa058a86...`; Protocol.kt regenerated byte-identical; both repos' gates
green (TS 1836 tests, evie 261 in its devcontainer).

**J-R1 - the big release. One coordinated deploy: full code clean break, lenient wire. ✅ DONE**
(`9a6205a`, PR #202, merged and pulled; 7.14.6 -> 7.15.0). Verified on the emulator: ref artifacts
render hidden, the Designer dock ingests a pushed card again, and the chip carries the declared title.

Three defects the audit rounds caught that every gate had passed:
- The phone migration was a guaranteed **no-op on every device**: the init block ran before
  `localGatewayId` initialized, so `parseTarget`'s non-null check threw inside `isAddressKey`'s
  `runCatching`, every key was skipped, zero rows converted, and the version sealed anyway.
- Ingest normalization **disarmed the legacy classifier**: stamping absent -> `attachment` before
  `stampLegacyRoles` could see the list meant a stale agent's snapshots reached other agents as
  ordinary attachments, and the R2 precondition would have read satisfied while lying.
- `return@key` inside an inline lambda emits a marker **D8 cannot dex**, so the APK failed to build
  while every JVM test stayed green. Only `assembleEmulator` catches that class.

Also repaired: the emulator variant had not compiled since the blob plane (`OutgoingFile` took bytes
before it took a file handle), so the one gate that sees the screen was silently unavailable.

Wire (`schemas.ts` post-J0):
- `role: z.enum(["attachment", "ref-snapshot", "design-card"]).optional()` on ChannelFile. There is no
  `ref-manifest` role - the manifest died in J-6. z.enum emits an open Kotlin String, so future values
  decode and SHOW.
- `RefSegmentMeta {startLine, lineCount}`, `RefKeyMeta {key, startLine, endLine, span?, quality,
  reason?, ambiguous?, matchCount?}`, `RefFileMeta {refPath, segments?: [].max(64), keys: [].max(64)}`,
  all `.meta({id})` so codegen emits real classes. `ref: RefFileMetaSchema.optional()` on ChannelFile.
  Segments absent = full mode. Caps are mandatory (frame overflow closes the socket).
- Designer card fields: `cardTitle`, `cardGroup`, `cardWidth`, `cardHeight`, flat optional.
- Codegen; golden wire fixtures under `tests/fixtures/` iterated by BOTH runtimes.

Producers (role is a LITERAL in each; never derived from arguments):
- `readReplyAttachment` stamps `attachment`; a hand-attached `@dsCard`-marked html sniffs an 8 KB
  prefix at compose time and stamps `design-card` (preserves hand-attached docking; 8 KB matches the
  console's own marker-read bound so both sides classify identical prefixes).
- `attachRefs`/`artifactBuilder` stamp `ref-snapshot` and per-file `ref` metadata; STOP emitting the
  manifest file. Segment text rides only in the snapshot file; `(startLine, lineCount)` partitions it.
- `designerTools` stamps `design-card` + the four card fields parsed from the html it already holds.
- `ConsoleClient.kt` stamps `attachment` on picker files.

Receivers (ONE path; absent -> `attachment` via `?? "attachment"` at the decode edges only):
- `evieFiles`: role filter replaces `dropReferenceArtifacts` (drop `ref-snapshot` for agents; a
  `design-card` still materializes - an agent has no dock). Delete the positional split, its rationale
  block, and the `stripRefs` direction gate. `[FILES]` prints unknown roles beside the entry.
- References (console): hide decorator = pure role read. Delete `RefDisplayIndex` + prefs store, the
  drain-time indexer, `manifestFrom`/`decode` from the live path, `MANIFEST_FILENAME`,
  `MANIFEST_MARKER`, `assertNotReservedName` + call sites, the naming-replay hack, the debug tripwire.
  Tap-time reads `file.ref` + the snapshot file; miss contract unchanged (decline -> link menu).
- Designer (console): byte-free ingest from wire fields; `StoredCard.rel` nullable; bytes resolve
  lazily at render; downloading/failed states per `designer-card-states.html`; Retry clears that
  blob's `attachmentFetchFailures` entry (else it is a no-op button); one-time frozen legacy archive
  replaces the backfill (which is deleted, mark-before-seed bug and all).
- Unknown-role demotion: previewable requires `role == null || role == "attachment"`; unknown roles
  sort last as plain named rows. Ranking only, never reachability.

Gateway:
- `stampLegacyRoles`: the positional rule (before first `MANIFEST_FILENAME` -> `attachment`, the
  manifest entry DROPPED, after -> `ref-snapshot`), applied at BOTH the two restore callbacks
  (`gateway/index.ts:232-240`) and at live ingest for any agent-composed role-less list. Idempotent
  (a list where anything already carries a role passes through), so it is a no-op once the persist
  tick rewrites the snapshots stamped.
- Ingest classification runs at `send`/`respond`/`humanNotify`, so everything persisted from R1
  onward carries a role. It must NOT be a blanket absent -> `attachment`: a not-yet-reloaded MCP is
  the normal state for the minutes between the gateway restart and `reload_plugins`, and stamping its
  manifest `attachment` would relabel machinery as a user file, hand agents the source copies the
  drop exists to withhold, and leave the R2 precondition reading satisfied while lying.
- A CONSOLE-composed list is exempt from the positional rule and takes absent -> `attachment`
  outright: those are the owner's own files, never machinery, and a file the owner happened to name
  like the old manifest must not be relabeled and hidden.
- Revised accepted cost (this supersedes J-4's, which assumed ingest could not classify): an
  un-upgraded agent's artifacts are classified correctly on arrival, so they never render as junk.
  What the drop costs instead is a STALE console during the skew window: its `manifestFrom` finds no
  manifest, so those refs decline to the link menu until the APK lands. Minutes, and the miss
  contract already covers it.

Phone:
- `MessageFile` + `fileJson`/`loadFiles` gain `role` and the ref metadata (append-position params;
  BOTH sides of the hand-written pair; round-trip test through the codegen'd `@Serializable` class).
- One-shot migration on the `AppStateStore` schema-version latch: stamp roles on persisted rows and
  reconstruct per-file ref metadata by running the old `manifestFrom` logic once per row against
  on-disk manifest bytes. That logic then lives ONLY inside the migration module, off every live path.
  Additive only: never remove fields, never delete manifest bytes on disk (small orphans). A row whose
  manifest never landed or predates the plugin migrates as plain attachments; its ref links stop
  opening - accepted spillage.

Verification gates: `bun run bump minor` FIRST (the marketplace decides update availability from
`.claude-plugin/plugin.json`; without it `reload_plugins` finds nothing and the MCP half of the
release silently never ships); `bun run lint && bun run test`; codegen drift; fixtures; `./gradlew
:app:testDebugUnitTest`; emulator pass (artifact rows hidden, designer states render, dock ingests a
pushed card again); no leaf changed this release (`ChannelFileSchema` moved out at J0), so evie needs
no push; await workflows; pull main after merge.

**Deploy, and the order is load-bearing.** Every gate above can pass on a release that is entirely
inert, because each runtime strips what it does not know:
1. Push switchboard, await, pull.
2. **Restart the gateway** (`./down.sh && ./start-gateway.sh && ./start-host-daemon.sh`). An
   un-restarted gateway parses with the OLD zod at every ingest point, so `role` and `ref` are
   stripped from every message that crosses it and stored stripped - the release looks deployed and
   carries nothing.
3. `reload_plugins` per container, so each MCP composes with the new producers.
4. Install the APK last.

**J-R2 - the flip. ✅ DONE**
- `role` becomes required on ChannelFile. Codegen makes it a non-default Kotlin param.
- Delete the `?? "attachment"` normalization lines and `stampLegacyRoles`.
- Ingest edges now reject absent-role loudly (schema validation at routes/sealer/relay).
- PRECONDITION, inspected not hoped: zero role-less file entries in `mailboxes.json` and
  `pending-jobs.json`. Verified at ship time: 5 and 4 file entries respectively, all role-stamped.
  The wedged-console hazard in J-7 is what this precondition exists to prevent.
- Wire-identical behavior otherwise; skew during R2 is validation-only.
- `DeviceMailbox.fromSnapshot` drops a stored entry whose files carry no role, because a Kotlin
  decode failure is batch-fatal (one bad file fails the whole `ConsolePollResult`, the cursor never
  advances, and the box never TTL-sweeps because `drain` refreshed it). The guard checks ONLY the
  field that wedges, deliberately not `ChannelFilesSchema`: an ingest schema governs what a sender
  may submit, and reusing it as a retention schema turns any future tightening into a retroactive
  silent deletion of delivered history.

**Accepted, not fixed, with reasons:**
- **The console's `gap` banner never clears** (`ChatRepository.kt:3760` is its only writer). A drop at
  restore therefore raises a permanent non-dismissible banner, and since `drain` does not remove
  entries at read, the dropped entry may be one the console already rendered. Reachable only if the
  precondition above was wrong, and pre-existing to this phase, so fixing it here would widen the
  blast radius of a flip that is otherwise validation-only.
- **`plugin-references-index` prefs are stranded on an install that had References disabled for the
  whole J-R1 window**, since the delete ran inside `register()`. Cosmetic disk residue with no code
  path left to remove it. The original justification (that the delete was a no-op once it had run
  anywhere) was wrong, but the consequence is not worth a migration.

### 6. Viewer (extend `AttachmentViewer`, single attachment) - ✅ DONE

Post-intermission note: file access goes through the blob view (`path()` only when complete and
verified), so a torn download can no longer reach the decoder; everything below is unchanged in
intent.

**Verified on the emulator at 1080x2400 density 420 (3.5x), by measuring the raw framebuffer rather
than by eye.** The fixture is a 480x320 PNG, so a Dp round trip would have been off by 3.5x and a
floor pinned at fit would have made 100% unreachable. Measured widths: 50% -> 240 px, 100% -> 480 px,
200% -> 960 px, fit -> 1080x720, each centred on 539.5. A hard drag at 200% left the bounding box
byte-identical, which is the pan clamp holding an image that fits its frame.

Two things the on-device pass did NOT cover, stated rather than implied:
- **Pan while the image OVERFLOWS the frame.** `adb input` cannot pinch, and no preset takes the
  fixture past the stage bounds. The arithmetic is unit-tested both ways, and it reads the same
  `fitFactor` and container pixels the four verified presets do, so the conversion seam is covered
  even though this branch was not exercised by hand.
- **A completed SAF folder write.** The picker launches (`documentsui.picker.PickActivity` confirmed
  resumed), and the first-run MediaStore write is verified end to end (6732 bytes landed in
  Downloads). Driving the system picker to completion over adb is not reliable, so the tree write and
  the dead-grant re-pick are verified by construction only.

Two defects the on-device pass caught that no unit test could:
- The text stage rendered UNDER the status bar. It is the only stage anchored to the top edge, so a
  centred image never revealed it. Fixed with `statusBarsPadding()` on the text modifier alone.
- Resolving the save-folder label inline meant a document-provider IPC on every recomposition, which
  during a zoom gesture is every frame. Moved to `produceState` keyed on the stored Uri.

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
  back blank. The resolver now consults drafts as well as threads; the TAP TARGET is still section
  7's, so this half is in place ahead of the surface that will use it.
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
