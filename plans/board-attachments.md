# Questionaire

Attachments on task board entries. The OWNER attaches supplementing pictures from the console's edit
screen; agents only READ them, through an MCP tool that fetches the bytes to disk. The board list
answer carries a count so an agent knows to look. A paperclip marks an entry that has some.

## Settled before any question was asked

Research, not decisions.

- **The blob plane is a CACHE, not storage, and says so.** `shared/blob-store.ts` states it outright:
  "A blob's lifetime is a CACHE lifetime, not an ownership one, which is what lets nothing hold a
  reference count." There is no refcount, no owner, no per-blob TTL, and the header records WHY
  refcounting was rejected: "a reference can live in a mailbox entry, a durable job result, a thread
  row on a phone, or a message still in flight, and a counter that has to be right in all four places
  is a counter that will be wrong in one."
- **The sweep evicts coldest-first by LAST ACCESS, past an 8 GB ceiling.** `read()` calls `touch()`,
  so mtime tracks access rather than creation. A board picture attached once and opened once is by
  construction the coldest object in the store. A message attachment is read within minutes of
  arrival and never sits in that position; a board attachment would sit there permanently.
- **Eviction is TERMINAL.** There is no re-fetch path (`blob-store.ts`: "evicting a blob a message
  still names loses it, and the receiver sees a chip that never renders"). The console deletes its own
  copy the moment the bytes land (`ChatRepository.kt` calls `forgetBlob` right after `Attachments.land`,
  because "keeping the blob as well would hold every attachment twice on the device with the least
  room for it"), and prunes transfer residue after 24h. Within a day of upload the route Gateway is
  the sole holder.
- **`blobStore.remove()` has no production caller.** Nothing deletes a gateway blob when its referrer
  goes away. So a new store needs its own reclaim, and equally, no existing path can reclaim one by
  accident.
- **`blob_fetch` is not durability.** It only helps while ANOTHER Gateway still holds the bytes, and
  both copies age out under the same rule.
- **A blobId is a bearer token.** `/blob/get` hands bytes to whoever names one, gated only by
  `mayUseLocalPlane`, which returns true for everyone when no session on the Gateway is bound.
- **A reference must carry a WHERE.** `ChannelFile.blobGateway` exists because a blob lives only on
  the Gateway that received it. The console uploads to its route Gateway and the board is homed on a
  Gateway, so today they coincide, but nothing enforces it.

The consequence that drives Question 1: reusing the blob plane as it stands means the owner's
pictures silently disappear, with no error and no recovery beyond re-picking the file.

## Question 1 - Where do the attachment bytes live?

Q: Reuse the blob cache, pin board blobs against its sweep, or give board attachments their own
durable store?
A: **Their own durable store on the Gateway, owned by the entry.** No eviction; reclaimed when the
30-day trash sweep permanently deletes the entry.

> "that blob was for a moving history right? in conversation if we attach package.json over and over,
> they are blobs attached to different messages. So task board would have to be stored differently.
> I'm thinking the UX becomes reusable, but the storage becomes different."

The owner's framing is the distinction exactly: the blob plane serves a MOVING history, where the
same bytes are re-attached to successive messages and each reference is transient. A board attachment
is a standing property of one long-lived entry. Same UX components, different storage.

Recommendation reason that was taken: pinning would make the cache's single invariant conditional and
re-introduce the ownership question `blob-store.ts` deliberately refuses to answer. A separate store
gives that question one owner - the entry.

**Bytes stay on the Gateway for the entry's whole life.** The MCP fetch is a COPY to the agent's disk,
not a hand-off; fetching does not move or free anything. Agents are disposable, the owner can reopen
the gallery whenever, and the console deliberately keeps no copy of its own.

## Question 2 - What rides the board plane per entry?

Q: A bare `fileCount` on the entry with details fetched on open, or a small file list on the entry?
A: **A file list on the entry, carrying `{id, name, mime, size, gateway}`.** The `/task-board` route
projects the NAMES ONLY for the agent, so the fetch plumbing stays off its context.

> "toss the `2 -` though. I don't want count anymore if you are listing names."

No count anywhere: a list of names carries its own length, and a second field stating it is one more
thing that can disagree with the list beside it.

Two agents were given one option each and told to argue it honestly. Both landed on the list,
including the one assigned to defend the count.

- **A count breaks the offline queue.** Every board write is deliberately ABSOLUTE, because the
  console queues writes and replays the whole queue over each fresh snapshot (`BoardState.kt`:
  "these ops are absolute, so reordering two writes to one entry would apply the older value last").
  `fileCount + 1` is a delta. A lost reply on an applied attach leaves the action queued while the
  snapshot already counts the file, so the merge reads 4 for 3 until the retry lands. Attach-by-id is
  idempotent by construction.
- **A count cannot see a replacement.** Swap one picture for another and the count is unchanged, so
  `stableHash(pre) !== stableHash(post)` never fires: no plane bump, no awareness push. Console
  gallery and holding session both stay stale.
- **A count is not less wire.** The console needs per-file details for the gallery either way, so the
  record gets written regardless; the count then adds a new `ConsoleOp` plus its result schema on top,
  and a second path for non-route Gateways. It also puts the first network dependency into
  `BoardEditScreen`, which today touches no network at all.
- **A count carries no WHERE.** `BoardManager.enqueueMove` upserts a subtree onto another Gateway
  while the bytes stay on the origin. An integer after a move points at nothing.
- Byte budget is not the deciding factor: 50 entries at 3 files each is ~22 KB against
  `MAX_PROJECTION_BYTES = 1_000_000`, about 2%. Cap the array per entry and it stays noise.

### Scale, stated once so nothing is designed against a fantasy

> "don't be scared of amount or size. Nobody is going to have 5000 entries. A few dozen at most.
> Beyond that, they will seek external solutions to organizing thoughts"

A few dozen entries. `MAX_ENTRIES_PER_OWNER = 5000` is a backstop against runaway, not a target, and
designing the projection budget or the per-entry cap around it buys nothing. Concretely: 50 entries at
3 files each is ~2% of `MAX_PROJECTION_BYTES`, so the file list is free. Cap attachments per entry at
10 (matching `ChannelFilesSchema`) to bound the fetching, not because the bytes are a threat.

### The filename ships, and it is the point

Recommended against carrying it, and overruled. The owner's reason:

> "as for name, I think we have to store that value for context, not keying. so the agent can ask,
> 'the one from may? or June?' Or where it is named, I can say look at mellisa-render.png"

The value I dismissed as noise is the disambiguator: a date in a screenshot name is exactly what lets
an agent ask WHICH one, and a deliberately named file is how the owner points at one in conversation.
The privacy precedent I reached for (`draft-location-residue.test.ts`) guards a picked file's PATH,
which names a user and a folder layout; `ChannelFile.filename` already ships a name today, so carrying
one here is consistent rather than novel. Bound its length on the wire.

## Question 3 - What happens when an entry with attachments moves between Gateways?

Q: Refuse the move, mark the attachments as held elsewhere, or copy the bytes?
A: **The console performs the move**, uploading each attachment to the destination Gateway before the
upsert, and downloading from the origin first when its own copy is missing.

> "I will have more Gateways soon as soon as it's stable. The console has the files right? so just
> recreate and send to the next gateway?"

Verified, and the premise mostly holds: `admitPicked` stages a picked file into
`Attachments.root(filesDir)/<bucket>/staged-N`, the app's own attachments area, NOT the blob transfer
buffer that `pruneStaleBlobs` clears at 24h. So the attaching device does hold the bytes. It holds them
only on THAT device though, and `Admission.Reason.GONE` exists precisely because a local copy can
vanish - hence the download-from-origin fallback.

Chosen over a Gateway-to-Gateway durable transfer because it needs NO new machinery: upload and
download both exist, chunked and resumable, in both directions. A federation op for durable files would
be a new authorisation surface and a new failure mode for a rare event.

**Order is load-bearing: upload, then upsert, then delete from the origin.** A failure at any point
leaves the entry where it was rather than pointing at bytes that never arrived.

## Question 4 - When does the console pull attachment bytes down?

Q: Eagerly for the whole board, or on open?
A: **On open, and keep.** The attaching device already has them staged, so the peek is instant there
from the start. A second device or a reinstall downloads on first open, then holds it.

Eager download stays available later as an additive button, so this does not close it off. Board
attachments accumulate on the phone exactly as chat attachments already do: the same cost, not a new
one, and at a few dozen entries not one worth machinery.

## Decided without asking

- **The fetch tool writes to a per-invocation directory** under the system temp dir, one folder per
  entry, files under their real names. Same shape as the refs system's own materialization, so an agent
  gets ordinary paths to Read rather than a new access idiom.
- **An attachment id is the sha256 of its bytes.** An interrupted upload retries into the same id, and
  the same picture attached twice costs one copy. The `boardEntryIdForOperation` trick applied to
  bytes, which makes the attach op absolute for free.
- **Ten attachments per entry**, per the scale note above.

# Plan

Two phases. Each ships alone and is separately useful.

## Phase 1 - Attach, peek, and read

The whole feature end to end. It does not split: without the console there is nothing that can create
an attachment, and without the tool nothing an agent can do with one.

### The owner's half

- **Durable store on the Gateway**, its own directory under `DATA_DIR`, keyed by entry id. NOT the blob
  cache; no eviction. Reclaimed from `sweepTrash` when an entry is permanently deleted, which is the
  hook `promoteOrphans` just proved correct.
- **`BoardEntrySchema` gains `attachments?: BoardAttachment[]`** carrying `{id, name, mime, size,
  gateway}`, `.meta({id: "BoardAttachment"})`, capped at 10. One codegen run. Gateway deploys FIRST,
  then the plugin, then the APK.
- **Upload op**: the console streams bytes over the existing chunked blob transfer, and the gateway
  copies them into the durable store and records the metadata on the entry.
- **Console**: an attach button on the edit screen (reusing `admitPicked` and the SAF picker), the
  gallery reusing `AttachmentViewer`, a paperclip on rows whose `attachments` is non-empty, and
  fetch-on-open that lands bytes the way a message attachment lands.
- Optimistic echo is a set-union by attachment id, so a replayed attach is idempotent.

### The agent's half

- **`/task-board` list projects NAMES ONLY** per entry. No ids, gateways or sizes: that is fetch
  plumbing, and an agent's cost model is its context window.
- **A fetch tool**, registered only when the taskboard capability is announced, like the other six.
  Takes an entry id, copies every attachment to a temp directory, returns the paths. Read-only: agents
  never upload and never delete.
- The "how to get these" guidance lives in the TOOL DESCRIPTION, where it costs one read, rather than
  riding every list answer.

## Phase 2 - Moving between machines

- Console-mediated move per Question 3: upload to destination, upsert there, delete from origin, with a
  download from the origin when the local copy is gone.
- Until this ships, a move of a subtree carrying attachments is refused rather than half-completed.
