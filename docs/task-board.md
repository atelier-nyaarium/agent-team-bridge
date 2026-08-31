# Task board

The owner's board, its attachments, and edit awareness.

## Board

Stored by `gateway/boardStore.ts`. Entries use parent pointers and fractional ranks.

- **The store is the sole validator.** `BoardRefusal` replies use the `refused: ` marker, the only
  client-visible signal that retires a queued edit. `refusalError` is its sole producer;
  `board-refusal-residue.test.ts` enforces this.
- **A session end is one mutation.** `sessionEnded` applies its required `boardDisposition` to the
  complete server-side session set, and the reply is authoritative for console reporting.
- The pending queue is a separate writer. Forgetting a session drops its queued writes and linked
  deletes. A lane may pass a persistently failing action, but never reorders another write to the
  same entry ahead of it.
- **`forget` performs its own local-address check.** Its kill path swallows target-resolution errors,
  so the guard prevents a foreign address from forgetting a colliding local session.
- Invalid ranks are refused before durable persistence. Restore stays tolerant, because one poisoned
  entry must not poison the board.
- Board mutations are absolute and replay through `DurableOpStore`. Retrying a lost reply must not
  reapply an older value over newer state.
- Cascade is opt-in per write. The seed state is not rederived; `orphanedParents` comes from pre/post
  state for parents whose child disappeared.
- **A board session is `(gatewayId, sessionId)`.** The stored id is Gateway-local; `Team.name` is
  qualified. `consoleTargets.boardSessionKey` and `BoardManager.sessionKeyOf` are the sole
  directional converters, and unknown or foreign targets resolve to null.
- A queued console edit retires on refusal only. Absolute writes must not be reordered.
- `mayWrite` is the sole authority predicate for board scope and trash rules. Console writes use
  `OWNER_ACTOR`, route writes the session actor.
- A truncated projection is an id-sorted prefix. Merging the entire prior cache resurrects deleted
  entries.
- `BOARD_TRASH_TTL_MS` and `SESSION_RESUME_TTL_MS` are both 30 days and must remain separate
  constants.

**File map:**

- `src/gateway/boardStore.ts` - durable board state and owner plane.
- `src/gateway/boardAuthority.ts` - actors, authority, refusals, refusal marker.
- `src/gateway/boardCascade.ts` - post-write state cascade.
- `src/shared/board-rank.ts` - rank ordering and rank assertions.
- `src/mcp/board/boardTools.ts` - six gated task-board tools.

## Attachments

Attachment bytes belong to entries in `shared/board-attachment-store.ts`, separate from the evicting
blob cache.

- **`board_set_attachments` is the sole field committer.** `upsert` ignores incoming `attachments`.
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
- `src/gateway/routes.ts`, `src/gateway/boardStore.ts` - attachment projection and mutation.
- `src/mcp/board/boardTools.ts` - attachment name lookup and byte fetch.
- `android/.../BoardOps.kt`, `AttachmentOps.kt` - console queueing and fetch state.

## Awareness

- **Awareness rides the next message.** The send route drains each session's bank into
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
- `mutate` stages ids per invocation and releases them after commit. `sessionEnded` and `sweepTrash`
  announce nothing, and rank-only reorders announce nothing.
- Awareness bodies are bounded. Liveness distinguishes waking from gone and uses `WAKE_TIMEOUT_MS`.
- The phone drains board edits before sending the next wire message.

**File map:**

- `src/gateway/awarenessBank.ts` - subscriber bank, flush deadline, liveness.
- `src/gateway/boardAwareness.ts` - board recipients and net-change classification.
- `src/gateway/routes.ts` - awareness delivery on channel pushes.
