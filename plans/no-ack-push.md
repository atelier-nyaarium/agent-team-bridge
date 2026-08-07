# Questionaire

The no-ack channel push: an awareness-only notification to a running agent session that asks for no
reply. First consumer: the owner edits a task board entry, and the session holding it is told.

Agreed in principle during the task board questionaire and deliberately kept out of its scope.

## Settled before any question was asked

Research, not decisions. Each of these killed a design that looked obvious.

- **Nobody needs to remember a watermark.** The owner's framing was "no longer matching what the
  MCP of the session had", but the MCP caches nothing (every board tool call is one-shot) and the
  gateway's `list` deliberately records nothing either. Both would have been new state. They are not
  needed: `BoardEntry.sessionId` already names the holder and `mayWrite` reads it on every scoped
  write, so the entry being edited names who to tell. The feature is "the owner touched something
  you hold", not "your view is stale".
- **A push does NOT always start a turn.** The harness enqueues it as a queued command at priority
  `next` with `isMeta: true` - not an interrupt. Mid-turn it is absorbed at a post-tool-batch
  boundary. A turn thinking or writing prose with no tool calls has no such boundary, so the push
  waits for turn end. "No turn" is achievable; **"no cost" is not** - it still enters the next model
  call's context. Nothing can ENFORCE no-reply; that stays a convention in the instructions text.
- **`send()` cannot be reused with a flag.** Its channel branch inlines wake/mint (`tryWakeTeam`),
  persistent job creation, vibe-check counting (`noteInbound`) and console mirroring (`mirrorPeer` ->
  `fanOutConsolePush`). Four separate reasons. The shape to copy is `vibeCheck`: `resolveLead` +
  `lead.send`, which creates no job entry and is not counted, because it never goes through `send()`.
- **The signal must be minted inside `BoardStore`'s mutate closures.** `PlaneDefinition.onBump`
  receives only a `PlaneVersion`, so a plane bump can only ever say "the board moved". `index.ts`
  already records the identical limit for linked-peers.
- **It must be STAGED and released by `commit()`, never sent from the closure.** `mutate` runs
  against a working copy and discards it on a refusal returned AFTER the mutation (`setParent`
  writes parent and rank then returns `cycle`; `upsert` writes every entry then checks cycles).
  Sending from the closure announces changes that never happened.
- **`no_ack`, never `no-ack`.** The harness meta-key regex is `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and a
  non-matching key is SILENTLY DROPPED. Every existing meta key is already snake_case.
- **The field costs no wire schema.** `ChannelPushPayload` is a plain TypeScript interface, not zod,
  so no codegen, no Kotlin, and no strict-schema 400 window against an older gateway.
- **`emitChannelNotification` dereferences `payload.session_id` unconditionally**, so a no-ack push
  must still carry one - and it must be deliberately unroutable, the way `vibeCheck` uses a `vc-`
  prefix, or it invites the reply it is trying not to ask for.
- **The writes most worth announcing erase the addressee in the same pass.** `sessionEnded`,
  `setSession(.., undefined)` and `release` all delete `sessionId`. The addressee must be read from
  the PRE-state.
- **A commit is not one entry.** `setTrashed`, `setSession`, `claim`, `release` and `sessionEnded`
  each walk a subtree inside ONE mutate, and a subtree can span entries held by different sessions.
  Every design needs a group-by-addressee fan-out.

## Question 1 - A general awareness primitive, or a general envelope with a specific producer?

Q: The owner named "that file changed" as a future consumer. Build the general thing now?
A: **A general envelope, a board-specific producer.** The `no_ack` field and the `channelNotify`
instructions branch are generic and nearly free. Everything above them - subscriptions, dedup,
banking - is built for the board alone. A second real producer decides later whether a shared core
exists.

Recorded from the owner moving on without objection, not from an explicit answer. Reopen if wrong.

Reasoning that decided it: **"that file changed" has no producer.** No filesystem watcher exists
anywhere in `src/`, and `BlobStore` is content-addressed with no path index. It is not a second
consumer; it is a missing subsystem. Surveying every state-holding subsystem, exactly two can name
both a change and its addressee: the board (today) and the Codex catalog ("your agent finished" is
derivable, nobody asks for it). That is not the several-existing-call-sites case the plane registry
had when it was extracted. The codebase has ruled both ways before: `plugin_action` was generalized
as a WIRE ENVELOPE only, while four timeout coordinators were deliberately left un-merged with the
recorded note that they differ too much.

## Question 2 - A push per change, or a condensed object?

Q: One push per change, or accumulate into one condensed object?
A: **Both, at different layers. Mint per change; condense at the SEND edge, keyed by addressee, on
a window of a few seconds sized to the console's drain.** Flush early on the session's own next
`/task-board` call.

Two agents took opposite sides and converged on this split independently.

Why condense at all - **the burst is the editing pass, not the gesture**. A single gesture is one
commit (the worst in shipped code is the edit screen's Save, which fires title and body as two).
But no board write kicks the poll, and the foreground held poll runs 40s, so the owner's whole
triage pass queues locally with zero traffic and `drainLane` fires it back-to-back on the next poll.
A 10-20 tap pass reaches the gateway as 10-20 commits in a couple of seconds. Per-change SENDING
would re-explode a batch the client already assembled.

Sharpening it:

- **No rate limit exists on that socket path.** `resolveLead` hands back a bare `ws.send`.
  `vibeCheck`'s low volume is behavioural (15s tick, one in-flight check, thresholds, expiry), so
  copying its shape inherits none of its restraint.
- **N pushes never merge at any layer.** One `notifications/claude/channel` per frame, full envelope
  each. The session pays N envelopes and must compute the net truth itself: `open -> in_progress ->
  paused -> in_progress` is four pushes carrying one fact.
- **Condensing is nearly free.** A commit already fans out over a subtree spanning several sessions,
  so the group-by-addressee pass exists in both designs. The window is the only new part.

Why a few seconds and not 300ms: `markDirtyCoalesced`'s window would fold roughly nothing, because
the drain is serialized on phone -> evie -> gateway round trips, each already longer than 300ms.

Why the latency is free: delivery is already gated on a post-tool-batch boundary, and on a
prose-only turn on turn end - an unbounded wait. Seconds are invisible against it.

**The bank holds entry IDS, not values.** `mutate` works on a copy, `commit` rolls back on a durable
failure, and same-value writes never commit - so a banked value can describe a state that never
existed. Ids are union-idempotent, survive rollback harmlessly, and self-correct because the agent
re-reads.

### Flush triggers that were killed

- **Idle/busy: fatal.** `presence.working` is three-valued with unknown a real answer, sourced only
  from the daemon's `presence_derive`, floored at `BACKGROUND_CADENCE_MS` (60s) when no console
  declares focus, and cleared wholesale on daemon disconnect. With no host daemon it is unknown
  forever, so an idle-gated bank never flushes. It is also freshest (2s) only while the owner is
  still editing, and stalest exactly when the flush is wanted. And it is redundant: the harness
  already implements "deliver at a turn boundary".
- **"The owner stopped": no event.** `IntentTracker` is per-device, exposes no expiry callback, and
  its finest grain is a screen name on a 135s TTL.
- **"Next time the session talks": starves.** The only session-to-gateway traffic is tool-triggered
  `routerPost`. A session writing code for an hour contacts the gateway zero times. Good as an
  opportunistic EXTRA drain, never as the trigger.

## Question 3 - Which changes are worth announcing, and is losing an entry its own kind of notice?

Q: How many notice kinds, and does a take-away differ from an edit?
A: **Two kinds, and the take-away says which.** `changed` carries ids only; the agent re-reads.
`taken` carries the fact and distinguishes *back in the pile* (re-claimable) from *gone* (stop).
Classified per ENTRY from pre/post state, never by which method ran.

Folded in without objection: `sweepTrash` announces nothing, and session-end is ONE notice rather
than one per entry.

The research below is what decided it.

### The mutation surface, classified

Every mutating `BoardStore` method has exactly ONE caller surface, and they are nearly disjoint:

- **Owner only** (console ops): `upsert`, `setParent`, `setTrashed`, `setSession`, `remove`
- **Session only** (the `/task-board` route): `createAtEnd`, `setParentAtEnd`, `claim`, `release`,
  `clearDone`
- **Gateway only**: `sessionEnded`, `sweepTrash`
- **Both**: `setState`, `setTitle`, `setBody` - only three, and exactly where echo suppression bites

### Findings that decide the shape

- **Echo suppression is mandatory, not an optimization.** EVERY write through the `/task-board`
  route is a self-echo: `mayWrite` guarantees the actor holds the entry, `claim` and create-self make
  the writer the post-state addressee, and `release`/`clearDone` act on entries whose pre-state
  addressee is the writer. Without suppression the board's highest-volume writer is the agent
  announcing its own work to itself. It must be per-ENTRY on (pre-addressee, post-addressee, writer),
  because `clearDone` and `release` walk many entries in one commit.
- **A take-away notice CANNOT be a bare pointer.** This is the decisive structural difference. The
  bank holds ids and relies on the agent re-reading - but after a trash, remove or reassign,
  `taskBoardList` returns NOTHING for that id, and `mayWrite`'s two refusals collapse four distinct
  fates into two strings (`entry_missing` covers trashed and removed; `held` covers reassigned and
  released). The agent cannot find out what happened. An edit notice may stay id-only because the
  re-read resolves it; a take-away must carry the fact.
- **The agent's correct next action differs in kind.** On an edit it re-reads and continues - the
  entry is still writable. On a take-away it must STOP and must not retry, because every subsequent
  write refuses permanently and a refusal is never retryable.
- **There are THREE post-states, not two.** Still mine (readable, writable). Unassigned to the pile
  (still readable - the default `all` scope includes unassigned - and re-claimable, but writes refuse
  `held`). Gone from view (reassigned, trashed, removed). Only the middle one leaves the agent an
  action, so collapsing it into "gone" loses "you may take this back".
- **Classify per ENTRY from pre/post state, never by method name.** Visibility is exactly the route's
  own list filter (`trashedAt === undefined && (sessionId === me || sessionId === undefined)`) and
  writability is exactly `mayWrite`. A per-method taxonomy needs re-auditing every time a method
  gains a caller; these predicates are already the contract the agent experiences.
- **`sessionEnded` is ONE fact about the session, not N about entries.** Fanning it into the
  per-entry bank would emit the system's largest burst to the addressee guaranteed to be going away.
- **`sweepTrash` should announce nothing.** `setTrashed` never clears `sessionId`, so a trashed entry
  keeps naming its holder and the sweep fires 30 days later at a long-dead session. The take-away
  already happened at the trash.
- **One exception to "route writes are always self-echo":** `placeAtEnd`'s rank rebalance rewrites
  every live sibling's rank, and sibling groups are not session-uniform. It is rank-only - a
  representation change no other session can act on - so it should not stage a notice.
- **Do not infer owner authority from an absent actor.** `setTrashed`, `setSession`, `remove`,
  `sessionEnded` and `sweepTrash` take no writer today. Encoding "no actor means owner" rebuilds the
  absence-as-permit shape that `BoardActor` and `sessionAuthority.ts` both exist to kill. `mutate`
  should take the writer as a required value.

## Question 4 - Does a banked notice survive the addressee going offline?

Q: Hold a banked notice for the next live incarnation, or drop it?
A: **DROP** - but on the ADDRESSEE having no live incarnation, checked at the send edge, and
holding across the merely-unconfirmed window.

- **The `vibeCheck` split maps exactly.** `noteOffline` drops the in-flight question and keeps the
  durable fact (the description, which lives on the `SessionRecord`). Here the durable fact is the
  BoardEntry itself, which survives the sleep and which the agent re-reads on receipt. So dropping
  loses the PROMPT to look, never the information.
- **Every hold in this codebase carries an incarnation fence** - `DeviceMailbox`'s epoch,
  `codexRelay`'s `(daemonInstanceId, targetId, generation, lastEventId)` and its retain-until-acked.
  A no-ack push has no ack by construction, so a HOLD has nothing to detect that the incarnation it
  is flushing into is not the one the notices were minted for. Building that fence is building the
  subscription machinery Q1 declined.
- **The harmful incarnation change fixes itself.** A forgotten segment re-adopted by a stranger via
  `adoptById` is preceded by `sessionEnded` erasing the `sessionId`, so the bank's claim is already
  false when it lands.
- **Refinement 1: do not key the drop on `onTeamDisconnect`.** It fires with the socket's registered
  `teamName`, which for a `claude --resume` alias is NOT the record key a board `sessionId` names -
  `vibeCheck` has this bug latent today. Check `resolveLead(addressee)` at flush time instead.
- **Refinement 2: `resolveLead` flattens three states into one `undefined`** (asleep / mid-wake /
  registered-but-unconfirmed). The unconfirmed window is explicitly sized for a slow
  `claude --resume`. Dropping there discards notices for a session that never left. Ask
  `resolveLiveIncarnation` for the three-valued answer and retry the middle case under a short cap.

## Question 5 - Retire the vibe check; what labels a session card instead?

Q: Delete all the vibe-check code and show the last agent reply's title tier, with the board line
under it. What does a card show when there is no titled reply?
A: **Fall through to the last message, whatever it was** - drop `description` from the card's ladder
and keep today's `snippet()` behaviour behind the new title rung. **Keep `description` on the wire
for the linked-friend row alone**, which has no local substitute.

> "delete all the code handling for vibe check. Let's simplify it to be the title tier of last agent
> reply, and under it, the small task list as it is now."

### What the removal actually touches

Clean deletions: `gateway/vibeCheck.ts` entire; its wiring in `gateway/index.ts` (`createVibeCheck`,
`VIBE_TICK_MS`, the tick timer, the `noteOffline` hook, the local `recordTmuxTarget` whose only two
callers are the vibe check's `peekScreen` and `sendRename`); the `vibeCheck` dep in `routes.ts` with
its two `noteInbound` sites and the `vc-` interception in `respond()`; `src/__tests__/vibe-check.ts`.

- **The `/rename` keystroke path dies with it and has no other user.** It is the only place in the
  repo that types a slash command into another session's composer. The console's `rename_session` op
  is unrelated (it renames `sessionLabel` and never touches the pane). Side effect outside this repo:
  the harness-side Claude Code session title stops tracking, so `claude --resume` listings revert to
  auto-generated titles. Nothing here reads that.
- **Nothing depends on the vibe check RUNNING.** Idle detection is derived independently daemon-side
  by `presenceScheduler`. Deleting it also frees interactive-lane peek slots the terminal view
  competes for.
- `agent-screen.ts`'s `isPromptEmpty` goes fully dead (gateway-only, no Kotlin twin, vibe check was
  its sole caller). Its ONLY test coverage lives in the vibe-check test, so that block moves or goes.
- **`description` has exactly one producer** (`SessionStore.setDescription`, reached only from
  `vibeCheck.resolve`). Stored ones are orphaned, not migrated - `restore` reads the field tolerantly
  and `snapshot` rest-spreads, so the next persist tick rewrites the file without them.

### What the replacement cannot answer

- **A linked friend's session row.** Display-only with no click-through, so this device has no thread
  for it and never will. `description` was the only thing describing it. This is why the field stays
  on the wire.
- **Any session this device has no thread rows for**: a fresh install, a second device, a session
  woken but never messaged, or one that only ever did work (terminal, Codex, board writes, no
  `channel_reply`). The description was GATEWAY state riding presence; a title is LOCAL to one
  install.
- **Titleless reply shapes**, which fall through to the snippet: `channel_reply_structured` (the
  handshake answers this way), peer mirrors of a crosstalk SEND leg (no tiers spread at all), and
  status-only rows such as a failed wake.

### Two rules that have to be re-decided, not carried over

- **The board line currently occupies the TIME slot.** `timeShown` is taken only when there is no
  live board work, and the finished-over-total count sits where the relative time would go. Inverting
  the ladder strands that: a stale title with no date beside it is worse than a stale description.
- **`snippet()` is not "last agent reply".** It reads the thread's last row of ANY origin, including
  the owner's own titleless `sent` rows and `peer` mirrors. The new rung needs a derivation filtering
  on `fromMe` / `isPeer`, beside `snippet` rather than replacing it.

### Deploy note

The nine descriptions currently in `session-resume.json` vanish at the gateway's restart on the new
build, before any console has the matching app update - a window where both old and new consoles show
a blank line. Removing the field from `TeamInfoSchema` outright would be a codegen + staggered-deploy
change; keeping it for the friend row avoids that entirely.

## Question 6 - What shape is the notice?

Q: Structured JSON, or prose? Where does it ride?
A: **Prose only, in the body. No structured payload and no extra meta attribute beyond `no_ack`.**

`ChannelPushPayload.body` is a string that becomes the prose inside the `<channel>` tag, and every
structured field rides in `meta`, which the harness renders as tag attributes. `channelNotify.ts`
states the rule outright: "content is the message prose ONLY ... nothing is jammed as a prose
preamble." So there is no free-standing JSON slot, and JSON in the body would spend the prose slot on
something the agent must parse, for a message whose whole job is to be noticed.

Ids in a meta attribute were the runner-up and are a purely additive step later if a machine consumer
ever appears. They buy nothing now: the `changed` case ends in a re-read regardless.

**A `taken` line carries the entry's TITLE**, captured from the pre-state inside the closure at
commit. Not a reversal of ids-not-values: the id is unresolvable once the entry is gone, so without
the title the agent cannot name what it lost. It is a committed fact by construction - what the entry
was when it left.

### The notice states facts and adds nothing

> "You must not tell them they should reclaim it. just say nothing extra."

An earlier draft ended a take-away line with "you can claim it again". That is the notice telling the
agent what to do, and it is wrong twice over: it presumes the agent should want the entry back, and
it turns an awareness signal into an instruction. Say what happened and stop.

- Good: `"Ship the board" went back to the pile.`
- Good: `"Purge the old ranks" was trashed.`
- Wrong: anything appending a suggestion, a next step, or an interpretation.

This is the same rule the board's own capability text already follows - describe what IS.

# Plan

Two phases. Each ships alone and is separately useful; neither half of phase 2 is.

## Phase 1 - Retire the vibe check, relabel the card

Gateway and console together, because the label's producer and its consumer are on opposite sides and
a gap between them is a blank card.

- Delete `vibeCheck.ts`, its `index.ts` wiring, its two `routes.ts` hooks and its test. Move the
  `isPromptEmpty` coverage to an `agent-screen` test, or delete `isPromptEmpty` with it.
- Stop writing `description`: drop `presence.setDescription` and `SessionStore.setDescription`.
  **Keep the field on `TeamInfo` and `CrossDomainPresenceSession`** so the linked-friend row keeps
  its subtitle. No codegen run, no wire break, no deploy ordering.
- Console: add a `lastAgentReplyTitle`-style derivation beside `snippet` (filter `fromMe`, decide
  `isPeer` explicitly), and rebuild `SessionCard`'s ladder as title -> board line -> snippet
  fallback. Re-decide where the relative time sits now that the board rung is not the top one.
- Kotlin gate locally, and `assembleEmulator` - `SandboxFixtures.teams()` sets a description and only
  compiles in the emulator build type, which CI never touches.

## Phase 2 - The no-ack push, end to end

The envelope, the board producer and the delivery. Split any smaller and nothing works.

- **Envelope:** optional `no_ack` on `ChannelPushPayload` (a plain interface - no zod, no codegen, no
  deploy window), branching `channelNotify`'s `instructions` to awareness-only. Test for exactly
  `true`. Mint an unroutable session id under its own prefix, the way `vc-` was.
- **Voice:** the body is prose that states facts and adds nothing - no suggested next step, no
  interpretation. See Question 6.
- **Producer, inside `BoardStore`:** make the writer a required value on `mutate` (`OWNER_ACTOR` at
  the five sites that take none today, `BoardActor` at the three that pass a bare `sessionId`), stage
  `(entryId, preAddressee, postAddressee, writer)` inside each closure, and release from `commit()` -
  never from the closure, which can still refuse after mutating. Classify per entry from pre/post
  against the route's own list filter and `mayWrite`: `changed` (ids only) versus `taken`,
  distinguishing pile from gone. Suppress per entry when the writer is either addressee. `sweepTrash`
  announces nothing; `sessionEnded` is one notice; skip rank-only rebalances from `placeAtEnd`.
- **Delivery:** a per-session in-memory bank of ids, flushed on a few-second window sized to the
  console's drain, plus an early flush on the session's own next `/task-board` call. Resolve the
  addressee at the SEND edge, not from a close hook (`onTeamDisconnect` fires under the socket's
  registered name, which is not the record key a board `sessionId` names - `vibeCheck` has that bug
  latent today). Ask `resolveLiveIncarnation` for a three-valued answer: send when confirmed, retry
  under a short cap while unconfirmed, drop when gone. Invalidate inside `sessionEnded`'s existing
  pass, which already walks exactly the right set.
- Copy `vibeCheck`'s delivery shape before it goes: `resolveLead` + `lead.send`, never `send()`.
  After phase 1 this becomes the only gateway-authored push besides the handshake.
