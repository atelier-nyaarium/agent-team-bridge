# Questionaire

Attachments on task board entries. The OWNER attaches supplementing pictures from the console's edit
screen; agents only READ them, through an MCP tool that fetches the bytes to disk. The board list
answer carries the names so an agent knows to look. A paperclip marks an entry that has some.

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
the gallery whenever, and the console's own copy is best-effort and non-authoritative (Question 4 has
it keep one for instant peeks; the Gateway is the holder of record, and `Admission.Reason.GONE` exists
because a device copy can vanish).

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

- **The fetch tool materializes through the `evieFiles` machinery**, one folder per entry, files under
  their real names, so an agent gets ordinary paths to Read rather than a new access idiom. That
  machinery already carries the sweeper, the filename sanitizer, collision-free naming, atomic landing
  and per-file failure marking; nothing there is designed twice.
- **An attachment id is the sha256 of its bytes.** An interrupted upload retries into the same id.
  Dedup is PER ENTRY: the store keys bytes under the entry, so the same picture attached to two entries
  costs two copies. That is the price of a reclaim that can never reach across entries.
- **Ten attachments per entry**, per the scale note above.

# How this plan got here

Six audit laps before any code existed: 3 blockers, then 5, then 13, then a lap that mostly deleted,
then a verification lap, then a narrow confirmation. The rising count was not the feature getting
harder. Each lap added MECHANISM to fix the previous lap's findings, and the next lap found the
mechanism wrong. The rule that ended the spiral, and that governs any further lap: **prefer deleting
a mechanism to adding one.**

What each lap left behind, kept because the reasoning is the reusable part:

- **Lap 1** found the real structural hazards that survive today: the entry id is not a safe path
  segment, the attach needs a durable intent and bytes may never ride the queue, and the drain mutex
  cannot host a transfer.
- **Lap 2** invented a claim-then-fetch byte gate, then retired it for a WRONG reason: it claimed
  `/blob/get` was the weaker door when it is the stronger one (`mayUseLocalPlane` demands a credential
  whenever any session is bound; `refuseImpersonation` is name-keyed and admits an UNBOUND claim).
  Lap 2 also added preserve-when-omitted, a detach op, a remove-refusal with an acknowledgment field,
  and drop-the-cache-copy. All four are now deleted; see the constraints for why each guards nothing
  or breaks something.
- **Lap 3** caught the door inversion, killed the cache drop, shrank the transfer phase, and found the
  pre-existing LAN hole recorded below.
- **Lap 4** ran deletion-biased and removed the transfer phase entirely (the requirement it served is
  already met by shipped code), collapsed the byte-gate section (a fetch is two hops and each hop's
  existing door already carries the right predicate), and deleted lap 2's remaining three mechanisms. It also
  found five places where one lap's text contradicted another's, which is why the layered lap-by-lap
  record was consolidated into the single constraint set below. Every deletion was re-verified against
  the code by hand before it landed here.
- **Lap 5** verified the consolidated plan: one auditor re-checked roughly forty file-level claims at
  HEAD and every one held. Three structural items surfaced and were folded: the byte reader has a
  THIRD door (`serveBlobRange`, the federation export, cache-only), so the durable fallthrough moved
  into the shared read below all three; hop 1 needed the route's new `attachments` read action named
  explicitly, with the projection pinned ROUTE-side; and the op handler's presence check was pinned
  durable-first, or the owner's own remove would wedge weeks later on a swept cache.
- **Lap 6** confirmed all three folds clean and caught the bypass under the third: `BoardUpsert` was
  a second committer of attachment lists (a move upserts entries verbatim), which re-opened the
  wedge and, under Phase 2 as then written, destroyed the only durable copy. Closed the
  deletion-shaped way: upsert ignores the field entirely, `board_set_attachments` is the sole
  committer, and Phase 2's move gains an explicit set step before the origin delete.

## Why there is no "safe transfers" phase

> "I might upload a bin that takes a few min. It needs to be safe for an alt tab."
> "in fact, safe uploads should be implemented anywhere there's a file upload. like message sending."

The requirement is real and it is ALREADY MET for the case named, verified line by line:

- An alt-tab cancels nothing. A send runs on `repoScope`, which is documented "Never cancelled ...
  lives for the process's lifetime", and `onBackground` only sets a flag and resets the pushback
  clock.
- The CPU is already held. Both the FOREGROUND and MINUTE tiers call `exitDeepSleep`, which holds the
  untimed poll wakelock, and the MINUTE tier covers the first TEN minutes of background silence
  (`SILENCE_MINUTE_MAX_MS`), with the clock reset at the moment of backgrounding. "A few min" sits
  inside that window with room to spare.
- Past the window, a wakelock is the wrong instrument anyway: the repo records twice that deep Doze
  cuts NETWORK even for a foreground service, and the real lever, the battery-optimization exemption,
  already ships as a self-service settings row ("Background delivery").
- The failure mode past all of that is a resumable retry, not a loss: `uploadBlob` short-circuits on
  `blobStat().complete` and resumes from the gateway's cursor, and `reconcilePending` re-delivers on
  every foreground and service start. The download half of this exact feature
  (`fetchPendingAttachments`) has shipped for a long time on a CANCELLED-scope design whose own doc
  calls interruption normal: "a fetch cut off by a process death is simply still pending on the next
  pass."

Along the way the phase collected three reversals worth keeping: owning transfers on the service's
scope is a REGRESSION (that scope is cancelled in `onDestroy`); `FOREGROUND_SERVICE_TYPE_DATA_SYNC` is
a 6h/24h platform cap plus a boot-receiver refusal at targetSdk 36, a daily self-kill for a service
meant to be permanently up; and a pushback pin would have frozen the ladder in exactly the tier that
releases the wakelock.

One real residual, a status choice rather than a phase: a plain send that exhausts its retry settles
to a tap-to-retry error, while the board queue below retries forever. That asymmetry is worth knowing,
not worth machinery here.

# Constraints

The single authoritative set. Every item was verified against the code in the lap that produced it or
the lap that attacked it. The Plan section references these and adds nothing of its own.

## The durable store

- Path: `DATA_DIR/board-attachments/<ownerId>/<entryId>/<blobId>`. Assert ALL THREE segments at the
  store boundary, `assertId`-style, before any path is built: `blobId` is `sha256-<64hex>` (the
  existing `assertId` shape), `ownerId` is 64 lowercase hex BUT the durable board file types it as a
  bare string, so assert what comes off disk rather than trusting the derivation, and `entryId` needs
  its own pattern gate because `BoardEntrySchema.id` is `z.string().min(1).max(64)` with NO pattern
  and `board_upsert` accepts client-authored entries. Today's ids are all 32 hex or `bd_` + 32 hex, so
  a tight gate refuses nothing legitimate.
- **The FILENAME is never a path segment.** The stored path is the content hash; the display name is
  metadata beside it, bounded on the wire. No filename validation at the store, because nothing there
  reads it.
- **No sweep is wired = durable.** `BlobStore.sweep` is caller-driven from exactly one site, so a
  store nothing sweeps needs zero new eviction code.
- **Reclaim fires at exactly two sites**: `sweepTrash` (the normal end of every entry), and the
  MEMBERSHIP DIFF of every committed `board_set_attachments`: any blobId in the stored list and not
  in the incoming one is deleted from the entry's durable directory. Not a count comparison; a
  same-count swap reclaims the replaced file too. The commonest trigger is the owner removing one
  picture.
  Explicitly NOT at `restore`'s per-entry drop: that is corruption recovery, and reclaiming there
  turns the store's one tolerant path into its one irrecoverable one. Explicitly NOT at `remove` in
  Phase 1: `remove` is only ever the delete half of a cross-Gateway move, and reclaiming there lets an
  old console's move destroy the pictures; leaving it leaks one directory per move, bounded by a rare
  owner action, and "leaking a directory is fixable later; deleted bytes are not." Phase 2 adds the
  `remove` reclaim in the same change that makes the move carry bytes. NEVER implement reclaim as
  "delete what the live board does not reference": a shell-level parse failure restores an empty
  board, and that sweep would then delete everything.
- **Do NOT drop the blob-cache copy after the durable copy lands.** Deleting it destroys the
  `blobStat` short-circuit that makes a retried attach cheap, and it deletes by CONTENT HASH from a
  store shared with message attachments, taking an unrelated message's only copy. The cache is a
  cache; its own sweep handles it.

## The wire

- `BoardEntrySchema` gains `attachments?: BoardAttachment[]`: field names aligned with `ChannelFile`
  (`filename`, `mime`, `size`, `blobId`, `blobGateway`), `.meta({id: "BoardAttachment"})`, capped at
  10, filename length-bounded. One codegen run covers all three roots; update the three
  `tests/fixtures/protocol/` fixtures that carry `BoardEntry`, since both runtimes iterate the
  manifest. Verified precedent for a nested `.meta`'d array: `RefFileMeta.keys`.
- **Sort the stored list by `blobId` at every write.** `stableStringify` preserves ARRAY order, and
  that one hash is three gates at once: the plane identity, `upsert`'s did-it-change test, and
  `noticesFor`'s changed test. An unordered rebuild produces a spurious full-board ship, a false
  "applied", and a spurious awareness push, all three together.
- Identical bytes under two names: first-write-wins, since the id is the content hash and the name is
  display metadata.
- Deploy order: gateway first, then plugin, then APK. A ROLLED-BACK gateway strips the field on
  restore (plain `z.object`) and writes it away on its next commit; the bytes survive on disk (no
  reclaim path runs), so the exposure is metadata loss during a rollback window. Accepted and stated.
- **`board_set_attachments` is the SOLE committer of the field: `upsert` IGNORES `attachments` on
  every incoming entry**, present or absent, preserving whatever the store holds. This is stronger
  than the earlier "no preserve-when-omitted" argument (no writer can upsert over an
  attachment-bearing entry today; both producers mint fresh ids or target a gateway with no stored
  entry, and `createAtEnd` never overwrites) because lap 6 found the case that argument misses: once
  the field exists on the wire, `enqueueMove` upserts subtree entries VERBATIM to the destination,
  landing an attachments list nothing ingested. That list's members are durable-absent at the
  destination, so the owner's next `set_attachments` on the moved entry hits the durable-first
  presence check with nothing to find, no upload racing, and no refusal permitted: the lane-close
  wedge, arriving through the one door the presence check cannot see. Upsert-ignores makes the
  invariant total: **every blobId in a STORED attachments list is durable under that entry's
  directory**, because the only committer enforces it. Stated consequence: a Phase 1 cross-Gateway
  move drops the attachment records from the moved entry (the bytes leak on the origin, recoverable
  by hand, matching the deliberate `remove` leak); Phase 2 is what makes a move carry them.

## The op

- **ONE op: `board_set_attachments(id, attachments[])`, absolute.** `setBody`'s exact shape: always
  sets, never merges. Attach is the full new list; removing one picture is the full list minus one.
  No detach op, so absent-versus-empty is never load-bearing (and the codegen renders an optional
  list as `List<T>? = null`, verified, so the distinction survives anyway). Last-write-wins between
  two devices editing one entry's attachments concurrently: the winner's list stands, and the
  membership diff reclaims the loser's bytes along with its metadata. Accepted at this scale.
- The `board_` name prefix is load-bearing: `isBoardMutationKind` is a prefix test feeding both the
  opCache and the durable replay layer.
- Committed through `BoardStore.mutate`, which bumps the plane and banks the `changed` notice for the
  holding session for free. The gateway's op handler resolves EVERY member before adopting any, then
  stores what resolved:
  - **Durable-first.** A blobId already under the entry's directory is present, full stop. The
    absolute op names the SURVIVORS on every write, so a cache-only check turns the owner removing one
    picture, weeks later when the cache has swept the others, into a permanently failing action. It
    would pass every warm-cache test.
  - Otherwise copy from the blob cache, digest-checked.
  - Otherwise, if the sender's `supplied` list names it, a plain retryable error: the upload is
    genuinely racing this write.
  - Otherwise DROP it and report which. Those bytes are on no machine, and an op that cannot be
    satisfied is one the console retries forever, eventually closing that Gateway's whole lane.
  - Adopt only after every member is accounted for, so a partial pass cannot leave bytes under an
    entry whose stored list never names them.
  **No new `BoardRefusal` member anywhere in this plan.**

## The console

- The local `src` rides `PendingBoardAction` (hand-written, `@Serializable`, defaulted field is
  additive), NEVER `ConsoleOp` (codegen'd wire; a src there ships a device path to the gateway,
  against `draft-location-residue.test.ts`). The op is the natural-looking home, which is how the
  wrong one gets built.
- At tap: copy the staged pick into a stable board bucket (`admitPicked` stages a bare `File` with no
  src; only a copy mints one, and the gallery thumbnail needs the copy anyway), then enqueue ONE
  `board_set_attachments` action. Bytes never ride the queue: `BoardBlob.queue` persists as one
  SharedPreferences string rewritten on every mutation.
- **A new queued op kind has THREE silent fallthrough registries**, each needing exactly one new case:
  `applyBoardOp` (`else -> entries`; missing it, the optimistic tile VANISHES on the next poll
  snapshot and returns only when the upload finishes), `boardEntryIdsOf` (`else -> emptySet()`;
  missing it, same-entry ordering and `dropQueuedForSession` cannot see the action), and `entryIdOf`
  (`else -> null`; missing it, the struggling marker never shows).
- **The upload runs on `repoScope`, kicked at enqueue, outside the drain mutex.** `drainLane` has
  three outcomes (accept, sealed refusal, charge-an-attempt) and none means "bytes still moving", so
  it gains ONE branch: a `board_set_attachments` whose upload has not finished returns without
  charging an attempt. Without that branch, eight poll passes mark a healthy slow upload as
  struggling, and a struggling head closes the WHOLE Gateway lane: verified in
  `eligibleBoardActions`, a skipped entry's later write does `laneClosed.add`, which drops every
  other entry's writes on that Gateway too. This wedge is the single worst failure in the plan.
- **A local file gone before upload completes is a local abandon, using two calls that already exist
  adjacent in `drainLane`'s refusal branch**: `refusals.add(BoardRefusal(entryId, reason))` (the
  console's `BoardRefusal` is a UI data class with a free-form reason string, NOT the gateway's
  closed union) plus `abandonBoardAction` (already called locally by `dropQueuedForSession` with no
  wire refusal). No new machinery; do not build a local producer of the wire's `refused:` prefix.
- The board buckets feed `sweepOrphanBuckets`'s existing `keepBuckets` parameter, derived from the
  merged board entries, the same seam video frames use. Queue srcs only protect the bucket while the
  action is QUEUED; `keepBuckets` is what honors Question 4's "and keep" after it retires.
- **The upload targets the ENTRY's Gateway, not the route Gateway.** `relay` already takes
  `targetGateway` and most sealed ops already pass it; `blobStat`/`blobPut` just do not yet. One
  threaded parameter. Without it, attaching to an entry homed on Gateway B while routed through A
  writes metadata on B naming bytes only A holds; no move required, just a second Gateway. The
  console's `blob_get` needs NO threading: fetch-on-open keeps its existing `fromGateway` federation
  idiom, which works because the durable fallthrough lives below `serveBlobRange` too (see Serving
  bytes).
- Gallery: reuse `AttachmentViewer` through its three named seams; paperclip beside `StateMark`;
  attach commits on TAP (the state-chip precedent; Save protects title and body only). A tile is one
  of three states (bytes present, downloading, gave up) with a bounded failure count, like messages.
  Fetch-on-open rides the console's existing sealed `blob_get`. Known niggle, accepted: refusals
  render on the board list, not the edit screen.

## Serving bytes: one read, three doors

- **The byte reader has THREE doors, not two, and the durable fallthrough lives in the shared read
  below all of them.** `answerBlobOp` is "The SOLE implementation" behind the HTTP route and the
  console's sealed op plane, but the FEDERATION export is a third surface it does not cover:
  `serveBlobRange` (gateway `index.ts`) reads `blobStore` directly and is what a peer Gateway's
  `blob_fetch` hits. Every cross-Gateway read the plan promises rides that third door: a second
  device opening the gallery for an entry homed off its route Gateway, an agent fetching through its
  own Gateway with `fromGateway` set, and Phase 2's download-from-origin. A board attachment is by
  construction the coldest object in the blob cache, so the holder's cache copy WILL sweep, and a
  fallthrough wired only into `answerBlobOp` leaves the durable bytes on disk but unreachable from
  any other machine. So: one read function, cache then durable board store, called by
  `answerBlobOp`'s local read AND by `serveBlobRange`. At dozens of entries the durable lookup can
  be an index or a scan; either is fine.
- **There is no new gate anywhere.** A fetch is necessarily two hops. Hop 1 resolves names to
  blobIds through a NEW read action on `/task-board` (next section); the route-level
  `refuseImpersonation` covers it, and the new case applies `visibleTo` itself, since that filter
  lives INSIDE the list case rather than at the route level. Hop 2 moves bytes on `/blob/get`, which
  already runs `mayUseLocalPlane` and is already chunked, resumable and digest-verified. Four laps
  of gate design end in zero new predicates; the federation door's own gate is unchanged too (a
  sealed peer relay).
- Residuals, stated where they can be judged: `mayUseLocalPlane` returns true for EVERYONE on a
  gateway where no session is bound, so the byte door is only as strong as the deployment's binding
  posture. A hand-launched session with no token is refused at `/blob/get` once any bound session
  exists; that is the pre-existing posture of every blob transfer (channel attachments included), not
  new here, but it means the manual-start runbook session can list names and not fetch bytes. A
  session that once resolved a blobId keeps byte access to it after the entry is reassigned. And
  every host MCP shares `/tmp/switchboard-blobs`, so on the host, anything one agent fetches is
  readable by all of them; the doors govern who can FETCH, not what survives a fetch.

## The agent's half

- **The list route needs a projection layer that does not exist today, ROUTE-side.** The `list` case
  returns `projection.entries` verbatim after the `visibleTo` filter, so the moment `attachments`
  lands on the schema, every visible session receives `blobId` and `blobGateway` with no code change.
  The names-only projection is therefore the one genuinely new security seam in this plan: the ROUTE
  projects the DISPLAY facts per entry (`filename`, `mime`, `size`) and never `blobId` or
  `blobGateway`. The rule is what is stripped, not what is kept: the ids are the fetch plumbing and a
  blobId is a bearer token, while size and mime are what let an agent decide whether a 400 MB binary
  is worth fetching at all. Plugin-side stripping is the wrong side: during the gateway-first deploy
  window an old plugin would relay full records into the agent's context.
- **The route gains ONE new read action, `attachments`**, taking an entry id and answering that
  entry's attachment records (blobId, blobGateway, filename, size). This is hop 1; no existing
  action can serve it once the list projects names only. It sits behind the route-level
  `refuseImpersonation`, applies `visibleTo` itself in its own case, and follows the list case's
  reads-are-not-recorded rule: it never mints or accepts an operation id. Its whole answer stays in
  the TOOL HANDLER, which returns file paths; blobIds never reach the model's context.
- **The fetch action stays OUT of `MUTATING` in `boardTools.ts`.** The route records every settled
  reply under `(from, operationId)` and replays it verbatim BEFORE consulting the store; a fetch that
  minted an operation id would replay stale blobIds for attachments the owner has since swapped. The
  read exemption is entirely caller-side, one Set literal.
- The fetch tool takes an entry id and an optional list of names (the owner says "look at
  mellisa-render.png"; all-or-nothing contradicts the reason the filename ships). Sweep the staging
  root BEFORE the transfer; `sweepStaging` is upload-only today and the download path has never
  swept. That optional list IS the byte control: an agent asks for the file it wants rather than
  pulling everything an entry holds.
- **There is NO cap on how large a board attachment may be.** An earlier draft of this plan said to
  cap per-attachment bytes at attach time, well under `MAX_STAGING_BYTES / 10`. The owner corrected
  it and was right twice over:

  > "By design, Switchboard allows up to 500mb files. Transferred in chunks. what is this 25 you just
  > invented? / the auto download should probably be restricted to files under 25, and over will be
  > manual tap to download"
  >
  > "500mb files, up to 10 per turn (for ease of LLM enumeration)"

  A board attachment rides the same chunked plane as any other file and gets the same 500 MB ceiling;
  refusing the owner's own picture at 25 MB was inventing a limit the system does not have. The real
  concern was never what may be STORED, it was what a device fetches WITHOUT BEING ASKED. So the
  number moves to `BOARD_AUTO_DOWNLOAD_MAX_BYTES`: at or under it a console fetches on open, above it
  the tile says the size and waits for a tap. The count cap of 10 per entry stays, and its reason is
  now stated too - it bounds what one fetch enumerates.
- Materialize through the `evieFiles` machinery with the entry id as the bucket key: `cleanupTmpDir`
  sweeping, `safeFilename`, `resolveCollisionFreePath`, `landAtomic`, and the per-file `fetchFailed`
  marker distinguishing "bytes failed" from "never had bytes". Nothing bespoke.
- Guidance lives in the TOOL DESCRIPTION: how to fetch, that a `changed` notice may mean a new
  attachment (the notice carries the entry id alone), and that an UNASSIGNED entry produces no notice
  at all, since `noticesFor` builds addressees from holders; a picture added to backlog work is never
  announced to anyone.
- Fetch failures (bytes gone, wrong name, holding Gateway unreachable) are ERRORS, never refusals: a
  route may only relay a member of `BoardRefusal`, and none of these is one.

## Painpoints

Not a code audit. These are the things that actually cost time on this plan, with enough detail to
act on later.

- **`Attachments` has three path concepts and one of them is a trap.** A `src` carries an
  `appassets` URL prefix, `relOf` recovers the relative part, and `resolve` maps that to a File - but
  `resolve` ends in `takeIf { it.isFile }`, so it answers null for a path that does not exist YET.
  That makes it unusable for building a download DESTINATION, which is the obvious thing to reach for.
  Combined with `relOf` silently returning null for a string missing the prefix, a reader that builds
  a path the "obvious" way gets null forever with no error anywhere. This produced a gallery that
  compiled, passed every gate, and was completely inert. `Attachments.boardFile` exists now as the one
  place that owns a board path; the general shape (a resolver that refuses non-existent files, beside
  a parser that nulls on a shape mismatch) is still there for the next feature to fall into.
- **The board queue's lane rules are the most dangerous code in this area and the least legible.** The
  whole worst-case - one stuck action freezing every write to a Gateway - lives in five lines of
  `eligibleBoardActions`, where `chosen[lane] = action; laneClosed.add(lane)` for a head UNDER the
  struggling threshold is what closes the lane. Reading it, the struggling branch looks like the
  dangerous one; it is the safe one. Three separate rounds on this plan misread it, including one
  where the "fix" guaranteed the freeze. A named predicate for "this head holds its lane" would make
  the trap visible.
- **A comment described a branch that had been deleted, and an auditor believed it.** After the
  no-charge branch was removed, `ConsoleClient:boardBytesReady`'s doc still said "the drain charges no
  attempt for a transfer still running". That is the timelessness rule failing in the direction that
  matters: a stale comment about control flow is worse than no comment, because the next reader
  reasons from it. Worth a sweep of comments that describe OTHER files' behaviour, since those are the
  ones nothing invalidates when the other file changes.
- **Kotlin property initialization order silently defeated a flag.** `loadedCleanly` was declared after
  `blob = load()`, so its own initializer ran after `load()` had set it and overwrote the result. No
  warning, no error, and the behaviour looked correct in every reading of the function. Only a unit
  test caught it. Anything a constructor-time function needs to WRITE has to be declared above the
  property whose initializer calls it, and nothing in the language says so.
- **`AttachmentViewer` must be composed at the top level and nothing says so at the definition.** The
  requirement is written as a comment at the one existing CALL site in `MainActivity`. Nested inside a
  scrolling column it renders inline: a squashed strip of its own controls with no image, no error.
  The constraint belongs on the composable.
- **Sandbox seeding order is load-bearing and unstated.** `BoardManager` reads its durable blob once at
  construction, so a fixture that seeds after `Repo.get` writes to disk and is then ignored. The board
  simply showed the previous run's data, which reads as "my fixture did not run" rather than "my
  fixture ran too late".

# Pre-existing holes, separately scoped

Found while auditing, not caused by this feature, each worth its own fix outside this plan:

- **The board door admits invented names from the LAN.** `docker-compose.yml` publishes
  `"20000:20000"` on all interfaces; `/task-board` has no gate above `refuseImpersonation`;
  `localTeamKey` never checks the named session exists, so a bare slug expands to a default session
  key with no record, `toClaim` answers UNBOUND, and `satisfies` admits it. `visibleTo` then passes
  every unassigned entry, and its `entry.sessionId === sessionId` clause means naming a real unbound
  session's key exposes that session's ASSIGNED entries too. Anyone who can reach the port can list
  the owner's backlog today. Owner has been told; awaiting the word to scope it.
- The board door being weaker than the blob door is the same hole seen from the other side: the fix
  for one is the fix for the other.

# Plan

Two phases.

## Phase 1 - The feature

The whole thing end to end: it does not split, since without the console nothing can create an
attachment and without the tool nothing can read one. Build order inside the phase follows the deploy
order: gateway first (store, op, serving, the route's names-only projection and its new `attachments`
read action), then the plugin's fetch tool, then the
console. Every constraint above applies here except the two Phase 2 items below.

### Not yet seen on a screen

The gallery, the three tile states and the viewer were verified on the emulator. The board's NOTICE
row was not: its two wordings, the entry-title lookup beside them and the line cap are compiled and
unit-covered but have never been looked at. Every previous UI change in this phase that skipped the
screen was broken in a way no gate could see, so this one is owed a look before the phase is called
done. Seeding it needs a `BoardRefusal` in the sandbox fixture's board blob, which is one field.

### Bug Classes

**Mechanism:** the console's queued board action, drained per Gateway lane.
**Defect class:** a lane wedged by a queued op whose precondition the queue cannot itself guarantee.

Patched three times in three different places, which is what makes it a design bug rather than three
mistakes:

1. **Lap 6, before any code.** A cross-Gateway move upserts a subtree verbatim, so the destination
   would store attachment records naming bytes it never ingested; the owner's next attachment write
   there could never be satisfied. Patched by making the gateway's `upsert` ignore the field.
2. **Implementation.** The drain grew a branch that did NOT charge an attempt while bytes were still
   moving, to avoid marking a healthy transfer as struggling. That guaranteed the wedge instead: a
   head below the struggling threshold holds `laneClosed`, so an action that can never reach the
   threshold blocks every other entry's writes on that Gateway, permanently and with no marker.
   Patched by deleting the branch.
3. **Red team.** Two more doors onto the same class. The console's own optimistic `applyBoardOp` kept
   the attachments the gateway drops, so the console wrote lists off a view the gateway would refuse
   forever; and `sources` held only newly picked files, so an absolute write re-stating a SURVIVOR
   the Gateway lacked had no path to supply it. Patched by mirroring upsert-ignores on the console and
   by putting every locally-held member in `sources`.

The shared root: **`board_set_attachments` is absolute, so every write re-states members whose bytes
must already be somewhere, and "somewhere" is a different machine than the queue lives on.** Every
patch above is a different way of keeping those two facts in step.

**Resolved: the op no longer has a precondition to violate.** Three shapes were evaluated and all
three rejected, which is what pointed at the fourth:

- *A `bytes_missing` refusal.* Rejected: every other `BoardRefusal` member is a total, deterministic
  statement about BOARD state, and this one would be a statement about a transfer. It also discards
  the owner's whole absolute list, so the ordinary "keep X, add Y" edit loses the good new picture
  along with the dead one.
- *The Gateway pulling missing bytes from `blobGateway`.* Rejected: inert where it is needed, since a
  member minted by this console names the handling Gateway itself and the federated fetch
  short-circuits on that. It also adds an `await` between the entry check and the adopt, reopening
  the orphan-bytes hole that ordering exists to close.
- *Changing the lane rules.* Rejected: every variant only moves WHEN the lane steps past a doomed
  action, never WHETHER it can, because the same-entry ordering rule the fix must preserve is itself
  what closes the lane. The console also cannot tell a dead member from a Gateway that has not
  restarted yet, so any local ceiling would discard real edits during ordinary deploy skew.

What landed instead: **the sender declares what it can supply, and the Gateway stores what it can
resolve.** `board_set_attachments` carries an optional `supplied` list, which is a fact about the
sender's own disk rather than a prediction about the Gateway's. A member that resolves nowhere and is
not declared as still uploading is DROPPED and reported, not failed. Neither side predicts the other,
the op is always satisfiable, and the invariant "every stored member is durable under its entry" holds
by construction rather than as a precondition a caller has to meet. A member the sender says it is
still uploading stays retryable, which is the one genuine race. An older console omits the field and
gets exactly the previous behaviour, so the deploy window is safe.

## Phase 2 - Moving between machines

- The console-mediated move per Question 3 learns to carry bytes: download from the origin when the
  local copy is gone, upload to the destination (the `targetGateway` threading already landed in
  Phase 1), upsert there, then **`board_set_attachments` on the destination entry**, and only then
  delete from the origin. The explicit set step exists because upsert ignores the field (sole
  committer rule), and it is what establishes durable presence at the destination: its handler
  copies the just-uploaded cache bytes into the entry's durable directory before the metadata
  commits. Order is load-bearing; a failure at any point leaves the entry where it was, and the
  origin delete never runs before the destination's durable copy exists.
- `remove()` becomes a reclaim site in the SAME change, closing the deliberate Phase 1 leak. Safe
  now precisely because of the step above: by the time the origin delete fires, the destination
  holds the bytes durably, not merely in its sweepable cache.
