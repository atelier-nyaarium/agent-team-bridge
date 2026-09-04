# Task board

The owner's board, its attachments, and edit awareness.

## Where the board lives

`/task-board` reads and writes the Router-held board over the gateway's own WS. The Router stores
clear structure with sealed title, body and attachment filenames. It never opens them.

## Router-held board

`gateway/router/boardClient.ts` is the gateway's only door to it.

- **It is the sole sealer and opener of board text:** Titles seal under `board.title`, bodies under
  `board.body`, filenames under `board.name` keyed by `blobId` so a reorder cannot mislabel a file.
- **Every board kind binds the entry id into the AAD:** filenames bind the `blobId` after it. The
  phone builds the same kind in `BoardSealing`.
- **It is the sole mapper between a local session key and the Router's triple:** Another gateway's
  session comes back as an opaque joined key, never as a local one.
- Writes are CAS on `revision`. A conflict answer carries the board that won, so the mutation
  rebuilds against it without a second read.
- **A Router that cannot answer is a transport fault, not a refusal:** The route answers 503. Only a
  refusal retires the caller's write.
- Text with no key held opens to a placeholder rather than dropping the entry.
- An upsert that leaves attachments alone keeps their sealed names. Naming attachments replaces both.
- `set_session` carries claim and release. Its authority is `mayTake`, not `mayWrite`: a session may
  take an unheld entry and drop one it holds, and only the owner reassigns.
- Claim and release act on the whole subtree, as one batch.
- Observations arrive as `board_observation` inbox rows, opened into the awareness bank by the
  delivery pump.

## Attachments

Attachment bytes belong to entries in `src/shared/board-attachment-store.ts`, separate from the evicting
blob cache. A Router-held entry may name only blobs the Router's reference-held store already holds; a
write naming anything else is refused `attachment_missing`.

- **`set_attachments` replaces the field:** Other writes preserve stored attachments.
- The op declares `supplied`. Durable or cached members are retained, uploading members cause retry,
  and unresolved members are dropped and reported.
- Presence checks are durable-first, and every member resolves before any is adopted.
- **All three byte-serving doors use `readBlobRange`:** `answerBlobOp`, the HTTP route, and
  federation `serveBlobRange`.
- `/task-board` exposes display facts only. Blob ids and gateways travel through the separate
  attachment fetch action; route-side stripping prevents bearer-token leakage.
- Cross-Gateway moves chain destination upsert, attachment writes, then origin delete. Records are
  restamped; unavailable local bytes use `fetchFrom`.
- `remove()` reclaims nothing until the destination is proven to hold the bytes. Per-move directories
  may leak.

**File map:**

- `src/shared/board-attachment-store.ts` - durable per-entry attachment bytes.
- `src/gateway/router/boardClient.ts`, `src/federation-server/board/boardService.ts` - attachment projection and mutation.
- `src/mcp/board/boardTools.ts` - attachment name lookup and byte fetch.
- `android/.../BoardOps.kt`, `AttachmentOps.kt` - console queueing and fetch state.

## Awareness

- **Awareness rides the next message:** The send route drains each session's bank into
  `channel_push`. Standalone pushes are only the `act_now` fallback.
- The bank keeps the first pre-state and last post-state per identity, then diffs at flush.
  Intermediate edits, moves, and undo sequences collapse into one net fact.
- Reply disposition and gateway `no_ack` are separate axes; `no_ack` wins. `act_now` starts its hold
  at the first observation and is not extended. Board `gone` is `act_now`; other board changes are
  `no_act`.
- The route drains only after confirming an active delivery path.
- `no_ack`, `act`, and `awareness` are plain `ChannelPushPayload` fields. Notification metadata must
  be strings with snake_case keys.
- No-reply interception is valid only when the store has no job for the fallback id. The `na-` prefix
  alone is insufficient across federation.
- Both holders of a changed entry receive awareness, classified from pre/post visibility. A self-echo
  is skipped.
- Rank-only reorders announce nothing.
- Awareness bodies are bounded. Liveness distinguishes waking from gone and uses `WAKE_TIMEOUT_MS`.
- The phone drains board edits before sending the next wire message.

**File map:**

- `src/gateway/awarenessBank.ts` - subscriber bank, flush deadline, liveness.
- `src/gateway/boardAwareness.ts` - board recipients and net-change classification.
- `src/gateway/routes.ts` - awareness delivery on channel pushes.
