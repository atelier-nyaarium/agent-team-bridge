# Awareness subscribers

The owner changes something a session holds and the session keeps acting on old knowledge until told.
A board entry today; a file the owner saved in an editor later. The gateway already told a session
about board edits, as its own `no_ack` push. This generalizes that into one bank with subscribers, and
changes how the notice is delivered: it rides the next message that was going to the session anyway.

Board entry: `bd_37e62e18`. Sibling entries: `bd_216371df` (the agent-to-agent reply axis, folded in
here) and `e86c9cf1` (the IDE extension, which becomes the second subscriber).

## What was wrong

Two defects, both seen live while the owner tested the feature from the phone.

- **It woke the session.** The push fired on its own 3s window, so an owner tidying a title landed a
  turn on a session that had asked for nothing. The demo interrupted a reply mid sentence.
- **The 3s window was not the latency.** The phone ships queued board edits only inside a poll pass
  (`PollDrain.kt`, `repo.boardOps.drainBoard()`), and a visible app holds each poll for up to
  `LONG_POLL_HOLD_MS` (40s). Nothing kicked the loop on an edit, so the edit sat on the phone until an
  unrelated message bumped the held poll. The owner measured about 30s and read it as the gateway
  being slow.

And one structural one: classifier (`boardNotices.ts`), coalescer (the bank in `noAckPush.ts`),
renderer (`renderNoAckBody`) and delivery were all hardwired to `BoardNotice`. A second source would
have copied all four.

## Decisions

### A subscriber owns identity, diff and render

`awarenessBank.ts` is one bank for N subscribers. A subscriber is `{ source, act, render }` and the
bank keeps, per session, per subscriber, per identity, one `{pre, post}` pair. The bank and the
delivery know nothing about what a change is. The board is subscriber one (`boardAwareness.ts`).

The second subscriber is the IDE extension, not a filesystem watcher. inotify cannot tell the owner's
save from the agent's own Edit write, so a watcher would echo the agent's edits back at it. The board
avoids that only because every write carries a writer. An editor knows exactly which saves and renames
the human made.

### Diff at flush, not at write

The bank keeps the FIRST pre and the LAST post per identity, and the subscriber classifies once on
that pair when it flushes. Coalescing then costs nothing: any run of edits and moves is one pair.

- Board: a parent move plus three edits is one `changed`. An edit, a trash and an untrash inside one
  window is NOTHING, because pre equals post. That replaces the earlier "later notice wins" rule,
  which would have said `arrived`.
- Files (later): edit, move, edit, move for casing, edit is one pair whose pre has the old path and
  content and whose post has the final path and content. The renderer says "moved to X" and "these
  lines changed", and nobody wrote a coalescing rule for it.

Identity is the subscriber's. The board's is the entry id, so a move is already the same key. For a
file it is whatever the editor tracks across a rename.

### Two axes on the envelope

Both are rendered into the `instructions` line the plugin builds, the way `no_ack` is today.

- **Reply axis:** reply expected / `no_ack`. This is the same axis `bd_216371df` names asking /
  informing / closing for agent-to-agent sends; one vocabulary for every producer.
- **Act axis:** `no_act` / `act_now`. Named by what the recipient DOES, and the delivery rule falls out
  of it instead of being a second decision.

Everything banks. The flush trigger is the next inbound `channel_push` to that session, in the send
route, and the banked content rides it as a sibling `awareness` field. The act axis decides only
whether there is ALSO a deadline:

- `no_act`: none. Rides the next message whenever it comes. It cannot go stale, since the diff is
  against the state before the owner's edits began. Dropped only with the session.
- `act_now`: `ACT_NOW_HOLD_MS` (60s) from the first act_now observation. A message inside the window
  carries it for free; past it, the bank pushes on its own. The harness hands a push to a working
  session between tool calls, so it interrupts a long turn; idle, it wakes. Three deletes in a row fold
  into one push.

The subscriber sets the axis per notice. Board: changed, arrived, backlog are `no_act`; gone (trashed,
removed, reassigned) is `act_now`, the one case where continuing is wrong. A delete properly notified
IS the urgent case, so there is no separate urgency knob. An earlier draft had one and it was a
transport setting dressed as a policy.

The 3s early send is gone. The 1s tick fires only deadlines. Liveness stays three-valued (live, waking,
gone) with `MAX_HOLD_MS` on the deadline path, for the reasons `noAckPush.ts` already recorded.

### The phone ships an edit at once, and ahead of a send

Every board enqueue kicks the poll loop (`kickPoll` existed), so an edit leaves within a second
instead of waiting out the held poll. `deliver` drains the board queue before the wire send, so the
edit reaches the gateway ahead of the message that should carry its notice. Without that the notice
rides the message AFTER the one the owner expects.

Accepted, not fixed: an edit that hits the deadline path can still take the poll hold plus the minute
to land.

## Wire

Every new field is optional on both sides, plain TypeScript on `ChannelPushPayload`, no zod and no
codegen: the console never sees a `channel_push`. An older plugin ignores the sibling field; an older
gateway never sets it. Meta keys are snake_case strings.

Deploy order: gateway (and daemon) first, then the plugin bump, then the console APK.

## Out of scope here

The file subscriber and its line-diff renderer belong to the IDE entry. The seam is built so that
subscriber is a registration.

`823978dd` Reply Introspection is agent-to-console and unrelated. It was briefly mistaken for this.
