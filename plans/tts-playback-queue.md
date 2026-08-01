# TTS Playback Queue

## Source idea (owner, verbatim)

> For a spam of TTS messages, I want them to queue back to back instead of cancelling the previous.
> So we will need some sort of playback queuing. Maybe a sound for the first message in the spam.
>
> We also need a UX to control it as well. the tiny play button does not help at all. Perhaps a
> floating bubble when messages play?
> - Any play or auto-play will bring up the bubble. Bubble is a speech bubble icon with a number
>   indicating queue size. Tapping play on another message will queue more. Auto play will queue more.
> - Swiping to dismiss the bubble will stop the current playback and play the next one. Obviously
>   decrement number. Bubble cones back for next playback in queue.
> - Tapping on bubble will show a floating modal of **queued entries** list. First row is a
>   **pause/play + seek bar + time/time** UX, for the current playback. Second row down is the queue
>   including current one. Trash icon right of them to unqueue. Trashing the first one obviously stops
>   playback of the current, and starts playback of the next one. There is no toggling playback
>   between entries. only plays the top one until it's done and popped off the top of the list.
>
> **Queued Entries** UX is a fat tile each:
> ```
> Session Name         duration
> Title tier
> ```
>
> Also we should have a spoken separator sentinel that is the session name that depends on the number
> of contributors . Multiple teams in the same chat?
> - Primary Session: "CoolApp Refactor"
> - Participant Session: "CoolLib Analysis on CoolApp Refactor"
>
> Example Auto-play transcript of 2 messages on session named "CoolApp Refactor":
> ```
> (sound effect once for auto-play)
> (silence 0.5s)
> CoolApp Refactor
> (silence 0.5s)
> Diagnosed the issue and already sent the issue to the session CoolLib Analysis. they should have a
> response any second now.
> (divider silence 1s)
> CoolLib Analysis on CoolApp Refactor
> (silence 0.5s)
> I've found the issue, and here's what it is.
> ```

## Existing code, as found

- `SttsPlayer.kt` - one `MediaPlayer`, one `currentKey`. `play()` calls `stop()` first, so a second
  play cancels the first. Three tiers: `TITLE` / `SUMMARY` / `FULL`. Audio cached per
  (team, at, tier, provider, voice); `preloadBoth` warms SUMMARY + FULL.
- `ChatRepository.kt:1284` `playMessage` is the single play entry point; `ttsTextFramed` already
  frames a peer-mirror row as `"<from> to <to>: <text>"`.
- Autoplay lives in the poll drain (`ChatRepository.kt` ~3695). Per burst it takes
  `msgs.lastOrNull { !it.fromMe }` - **only the last agent message per team is ever spoken; earlier
  ones in the same burst are dropped, not cancelled.** Across teams in one burst, each launches a
  play that cancels the previous.
- Gated on `followed = team in openTabs`, `sttsReady()`, and `autoPlayTier(sttsAutoPlay)`
  (off/title/summary/full). `isDuplicatePeerAutoPlay` already suppresses speaking a peer-mirror row
  twice when it appears in both participants' threads.

## Questionaire

**1. What enters the queue on auto-play?** -> **Every new agent message, in order.**

A 5-message burst queues 5 entries. Fixes the existing silent-drop (only `msgs.lastOrNull` was ever
spoken) as a side effect. Ordering is strict: "All, in order."

Recommendation reason (chosen): the transcript example only shows two different sessions, so it does
not settle the same-session case; keeping the drop would preserve a bug, and same-session grouping
only pays off if such bursts turn out common. This is also the only option where the bubble's count
means what a user expects.

**2. Where does the queue live?** -> **`ChatState`, driven by the repository.**

`ttsQueue: List<TtsEntry>` beside `drafts` / `scheduledSends`. `SttsPlayer` stays a one-shot engine
that plays a file and reports completion.

Recommendation reason (chosen): it is the seam that already exists. `SttsPlayer` takes a text string
and a cache key and knows nothing of sessions or tiers; `playMessage` / `ttsTextFramed` already do the
domain framing; and the completion signal already exists as `onPlayingChanged(team, at, false)`.

Consequence to build: the player has one `stop()` today, but the queue needs four outcomes. Finished,
swipe-skip and trash-current all ADVANCE; pause does NOT. So the player gains a real state transition.

**3. Where do the controls live when the app is not in front?** -> **B and C, with C degrading to B.**

Both surfaces, for both audiences: a `MediaSession` media notification (lockscreen / shade / headphone
/ watch) AND a true `SYSTEM_ALERT_WINDOW` overlay bubble that floats over other apps. When the overlay
permission is not granted, the feature falls back to B alone rather than degrading the bubble to
in-app-only.

Folded in with it: the missing audio-focus request, since it is the same code path.

Recommendation reason (B was recommended, C accepted on top): auto-play already speaks while
backgrounded with no control surface at all, and only a media notification closes that. C stacks on
top rather than competing, and B is its prerequisite either way.

**4. When does the spoken sentinel speak?** -> **Before EVERY entry, including same-session repeats.**

> "it also makes it clear that the message is a new transcript even if it's the same one"

So the sentinel is an entry BOUNDARY marker, not only attribution. Repetition is the feature.

Engine consequence: an entry is still a SEGMENT LIST (optional chime, sentinel, gap, body), not one
file. This answer removes the runtime-order argument for segments, but two reasons stand: a session's
sentinel is identical across all its messages, so it is synthesized once and cached per
(label, provider, voice) instead of re-synthesized inside every message; and the 0.5s / 1s silences
stay real timed gaps rather than punctuation eight different providers each interpret differently.
The chime is a bundled asset, so multi-segment playback is required regardless.

**5. What does a tile show before its audio exists?** -> **Nothing to estimate. Withhold the message
notification until TTS is generated, and show a loading spinner in the TTS view.**

> "I figure if the TTS isn't yet generated, we just withhold the message notification and if in the
> new TTS view, show a loading spinner."

No duration estimate and no dash: a spinner occupies the duration slot until the real value is
readable off the cached file. Notification timing is tied to synthesis, so a queued entry is normally
already synthesized by the time it is visible, making the spinner a brief transient.

Already partly shipped: with `sttsAutoGen` on, the drain awaits `preloadMessage` BEFORE calling
`onInbound` (which fires the notification), and a failed or slow synth falls through and notifies
anyway. This answer makes that the rule rather than one setting's side effect.

**6. Does withholding gate the queue UI too?** -> **No. Queue UI is immediate; only the Android
notification waits.**

> "now that we have a GUI, we should let them show immediately on the TTS UI. It shows a loading
> entry, but you will not receive an Android notification until the message finishes generating audio.
> And it will attempt to play in order of queue. The bubble will show a loading spinner if the current
> queued item is generating."

Three separate timings, deliberately decoupled:
- **Queue entry**: appears the instant it is enqueued, as a loading entry.
- **Android notification**: fires when THAT message's audio finishes generating. Bounded already by
  the STTS client's own timeouts, and a failed synth falls through and notifies.
- **Playback**: strict queue order, even if a later entry finishes synthesizing first. Head-of-line
  blocking is intentional.

Bubble has two states: queue count, or a spinner while the HEAD entry is still generating.

Consequences worth recording:
- **My earlier "current + 1 prefetched" policy is superseded.** Every queued entry's notification is
  gated on its own audio, so every queued entry gets synthesized regardless of whether it is ever
  heard. Eager whole-queue synthesis is implied, not optional.
- That cost only lands when auto-play is on (nothing enqueues otherwise), which is when the audio is
  wanted anyway. The residual is entries synthesized then trashed before playing.

**7. What happens when the HEAD entry never generates?** -> **Shift it to the END of the queue and
resume. Once everything finishes, the bubble icon shows an alert icon so the error is known.**

Rotate-to-back rather than pop. The rest of the queue doubles as the retry delay, and the
"top plays and pops" invariant holds because a failed entry is genuinely re-queued rather than parked
in the list unplayed.

**8. How many attempts before an entry is given up?** -> **Exactly one rotation.**

Fails at head, goes to tail, fails once more, dropped and remembered for the alert. Worst case two
attempts per entry, so the queue always drains and the alert state is always reachable.

Recommendation reason (chosen): one rotation is the smallest bound that absorbs a transient blip, and
an expired key or dead endpoint will not fix itself inside one queue cycle, so more rotations delay the
alert without changing the outcome. Degenerate case is safe: a lone failing entry rotates into a queue
of one, retries immediately, stops after the second attempt. No tight loop.

**9. Is the sentinel derived from the message or from the thread?** -> **From the message.**

- Non-peer entry: its own session's label. `"CoolApp Refactor"`.
- Peer entry: `"<from> on <to>"`. `"CoolLib Analysis on CoolApp Refactor"`.

Thread-independent, so `isDuplicatePeerAutoPlay`'s arbitrary "first thread to claim the pair wins"
(it keys on `"${from}|${to}"` and iteration order over the burst map decides) stops mattering. Also
resolves the case the owner's two examples did not cover, a peer row whose own thread is the SENDER:
thread-relative would render `"CoolApp Refactor on CoolApp Refactor"`, message-relative gives
`"CoolApp Refactor on CoolLib Analysis"`.

Recommendation reason (chosen): removes the nondeterminism rather than working around it, and lands on
the owner's example string with no special casing.

**Implies a deletion:** the sentinel absorbs `ttsTextFramed`'s inline `"<from> to <to>: "` prefix, so
that prefix is removed. Otherwise a peer entry states its attribution twice.

**10. What timeline does the seek bar measure?** -> **The whole transcript entry. Reaching the end IS
the advance signal. Completed entries pop off the queue, for now.**

> "seek bar is per transcript. So when it reaches the end, it ends and plays the next one. For now,
> pop dones off the queue."

"Per transcript" means ONE BAR PER ENTRY, as opposed to one bar spanning the whole queue. It does NOT
mean the bar covers the chime and sentinel - see the no-concatenation ruling below, which settles the
bar as body-only. Consequences:

- End-of-bar is the single advance trigger, which unifies with Q7: natural end pops, skip pops,
  trash-current pops, pause does not.
- "For now, pop dones" means no history / replay list in v1. A completed entry is gone from the queue.
- Tile `duration` measures whatever the bar measures, so it is BODY duration. A ten-entry queue
  therefore under-reports wall clock by the sentinels and gaps. Accepted.

**11. When does the chime play?** -> **If the queue was empty AND auto-play queued. Once per automatic
run.**

> "a chime once for the whole automatical auto queue. Unprompted audio yes. but once. Not really a
> cool down. but exactly like you said: Chime if queue is empty and auto-play queued."

A manual tap never chimes. No cooldown and no threshold constant.

**Engine model, settled (owner):** three SEPARATE playbacks per entry, no concatenation anywhere.

> "the scrub doesn't cross any boundaries. There are no set boundaries. Just 1 seek bar."
> "ohh no don't concatenate. Different providers different format."
> "Yeah, chime and sentinel. It's an auto-play boundary marker. no need to seek that."

```
[chime]      standalone, once per auto-play run, no UI, not seekable
[0.5s gap]
[sentinel]   standalone TTS, cached per (label, provider, voice), no UI, not seekable
[0.5s gap]
[body]       THE seekable transcript: the bar covers exactly this, and its end advances the queue
[1s gap]     divider before the next entry
```

Chime and sentinel are boundary MARKERS, not content, so neither gets a timeline. The bar therefore
drives a single `MediaPlayer` over one file and `seekTo` is plain. No composite position mapping exists
anywhere, and nothing has to reconcile provider container mismatches. The silences are timed gaps
between playbacks rather than authored audio.

### Design rulings (card `tts-queue.html`, pushed to the Designer dock)

Card approved. My five labelled assumptions stood unchallenged except the error state:

- **Error is an ADDITIONAL badge on the normal bubble, not a red bubble replacing the count.** Losing
  queue depth exactly when something failed is the wrong trade.
- Standing as drawn: equaliser mark on the playing tile, highlight on that tile, "Now playing" heading,
  tile order = play order with the current entry first.

**12. What does the in-thread play button mean now?** -> **B, plus a visible non-clickable state.**

> "B. but to make sure it's clear it's not playing, make the play button change to like a
> non-clickable button of it's state. Loading, playing, queued."

Not queued -> pressable, appends at FULL. Already queued -> NOT pressable, and it renders its state
(Loading / Playing / Queued) instead of looking like a button. Retraction lives only in the modal's
trash. Rejected my option C: no in-place tier upgrade, no retract-by-tapping.

Known cost accepted: with auto-play on Title, a message wanted in full shows `Queued` and cannot be
asked for until it leaves the queue. A delay, not a dead end. No machinery for it until it irritates.

**13. What does the alert bubble do when the queue is empty?** -> **A, and the failed entries are
LISTED and actionable.**

> "it needs to be listed so we can jump to the session or clear the entries"

Bubble outlives the drained queue carrying the badge. Tapping opens the modal, which LISTS the failed
entries rather than just naming a count, and each one offers:
- **Jump to the session**, at that message. Reuses the existing open-and-reveal machinery
  (`openNonce` / reveal-and-scroll).
- **Clear the entries.** Dismisses them and the alert with them.

Assumption to confirm: tap-to-jump applies to ORDINARY queue tiles too, not only failed ones. A tile you
cannot act on is a worse version of one you can.

### Row control styling (owner ruling)

> "if you uplift the style, be sure to give the copy button consistent treatment."

`.play-btn` and `.copy-btn` currently SHARE one rule in `thread.css` (min-width 30px, height 24px,
1px border, radius 6px, transparent background, opacity .75), differing only in font-size. They are a
matched pair by construction.

Ruling: keep that shared rule as the base for "pressable control", so idle-play and copy stay
identical. The three non-pressable states are additive classes on play only. That preserves the
existing invariant and makes the divergence meaningful, since a filled chip then reads as state rather
than as a button.

**Correction to `tts-play-states.html`:** it drew idle-play with a purple border and glyph, diverging
from copy's grey, at 40x34 with an 8px radius. Real base is grey, 30x24, 6px radius. The card is
schematic; the shipped control follows the existing CSS.

`SttsPlayer.purge(team)` already stops playback when the current key belongs to a purged team, so
`forget` has a precedent to extend to queue entries.

**14. Does the queue have a cap?** -> **No cap.**

> "C. if it clears out anyways, no need to cap."

The queue drains as it plays and can be trashed or cleared, so unbounded length is accepted rather than
designed against. This is the one store in the app with no bound; noted deliberately, not overlooked.

Residual the reasoning does not cover (raised once, owner's call taken): draining bounds queue LENGTH,
not provider SPEND. A 200-message flood still costs 200 synthesis calls, because every entry's
notification is gated on its own audio. Revisit only if a runaway session actually bites.

**15. Does the queue survive process death?** -> **No. Ephemeral.**

Dies with the process; a cold start means no bubble and silence. Deliberately UNLIKE its `ChatState`
neighbours `drafts` and `scheduledSends`, which both persist.

Recommendation reason (chosen): the queue is derived state. Every entry is a message still in its thread
whose notification already fired, so losing it costs an ordering rebuildable with one tap. Persist-and-
resume was the one to avoid outright: `SwitchboardService` is a foreground service the system restarts
on its own schedule, so it would start talking in a pocket at a moment nobody chose.

### Deferred details -> all resolved

- **Tier indication on a tile: not needed.** No distinguishing mark.
- **Tap-to-jump: yes**, on ordinary tiles, to the session.
- **No clear-all.** "swipe is quick. and there's never an instance of more than 3 talkers." Per-entry
  trash plus swipe-to-skip covers it; the alert still clears on acknowledgement.

**16. What should "withhold until audio exists" mean, given there is no per-message notification?**
-> **Split the content from the alert.**

Raised because audit finding L2-6 showed Q5/Q6 assumed an object that does not exist: there is one
notification per TEAM, rebuilt from the current trailing unread rows.

- Notification CONTENT updates immediately, but SILENTLY, through the path
  `reconcileTeamNotifications` already uses (`setOnlyAlertOnce(true)`).
- The RINGING post fires once per run, when the first entry of that run actually has audio.

Recommendation reason (chosen): keeps the intent - a ping means there is something to listen to - while
dropping the two costs, N rings per burst and delayed awareness of the messages themselves. Also the
smallest change available, since both the ringing and the silent-refresh paths already exist; this picks
between them rather than building a mechanism.

Follow-on folded in: the notification's existing Play action (`SwitchboardService.kt:435-436`, "speak the
burst-last message") becomes "queue this run" now that a queue exists.

### Chime asset and NO CONCATENATION (owner)

> "ohh no don't concatenate. Different providers different format. Just have it play on its own. No UI
> to support it. then the auto-play transcripts begin."

The chime is a STANDALONE one-off played before a run begins. It is not part of any entry's audio, is
not covered by the seek bar, and has no UI representing it. Reason: providers disagree on container
(`stts-providers.json` today: IBM `wav-stream`, OPENAI `wav-stream`, XAI `mp3`), so there is nothing
reliable to concatenate into.

**Chime source is user-selectable:** either an Android notification sound, or the bundled default.

Supplied asset `2575.wav`: 234 KB, 16-bit stereo 44.1 kHz, 1.329 s, peak 89% (healthy level).
Measured dual-mono (max L/R difference 11), so a downmix is lossless in practice, and it carried 0.349 s
of trailing near-silence. Staged at `<scratchpad>/chime.wav` as **1ch 16-bit 44.1 kHz, 0.981 s, 84 KB**.

Trimming the tail is a correctness fix, not only a size one: the spec authors 0.5 s of silence after the
chime, and 0.349 s of built-in tail would have made the real gap 0.85 s.

No converter is installed on the host (no ffmpeg / oggenc / sox), and none is needed - Android plays PCM
WAV natively, and the system-notification-sound option means arbitrary formats have to work anyway. OGG
would reach ~15 KB if the 84 KB ever matters.

### Findings that shape the UX questions

- No `SYSTEM_ALERT_WINDOW` permission, so no system-overlay bubble exists today.
- No `MediaSession` and no audio-focus request: TTS talks over other audio and does not duck or pause
  for a call.
- Playback is gated on `followed = team in openTabs`, which is persisted state, NOT visibility. So
  auto-play already speaks while the app is backgrounded, with no control surface at all.
- `SwitchboardService` is already a foreground service (type `remoteMessaging`).

## Plan

Rough shape, derived from the questionaire. Sliced so each phase is verifiable on its own and the engine
is proven before any new surface is built.

**Creative licence (owner):** the UX carries deliberate latitude - make the call rather than asking, and
confirm it on the emulator or a debug build afterwards. This applies to presentation, not to anything the
questionaire already settled.

### Model

`TtsEntry` in `ChatState.ttsQueue: List<TtsEntry>` - ephemeral, never persisted, unbounded.

Per entry: team address, message `at`, tier, source (auto-play vs manual, for the chime rule), state
(queued / generating / ready / playing / failed), attempt count (0 or 1, per Q8), duration once readable,
and the display fields the tile needs (session label, title text).

Also **frozen at enqueue: provider and voice** (audit finding 5). The cache key is
(team, at, tier, provider, voice), so an entry that is queued-but-unsynthesized would otherwise pick up
whatever provider is current when its turn arrives, giving one run two different voices.

### Phase 1 - Queue and engine, no new UI

Scope corrected by audit finding 4: this phase plays the BODY only. Chime and sentinel move wholly to
Phase 2, because Phase 1 cannot play audio whose text and asset Phase 2 is what defines.

**Phase 1a - player surface, before anything depends on it. ✅** Lap 2 found the queue cannot be built
on the player as it stands (L2-1, L2-2, L2-3). These are prerequisites, not refinements. See
"Phase 1a as built" and the sections after it for what actually shipped; the generation deadline in the
third bullet is deliberately NOT delivered and stays open:

- **Multi-subscriber callbacks.** `onPlayingChanged` and `onPlaybackError` are single `@Volatile` slots
  (`SttsPlayer.kt:41`, `:46`) that `MainActivity` claims and NULLS on dispose
  (`MainActivity.kt:370-373`, `:3481-3482`). Convert both to a subscriber registry owned by the
  repository, mirroring the existing `inboundSubscribers` pattern, and demote MainActivity's glyph wiring
  and the settings sample screen to subscribers. Without this a backgrounded queue receives no advance
  signal at all and stalls after entry one.
- **Typed, identity-carrying outcomes.** `clearNowPlaying()` emits the same `playing=false` for
  completion, playback error, `stop()` and replacement (`SttsPlayer.kt:207-214`), and `onPlaybackError`
  carries no (team, at, tier). Emit a typed outcome per key instead: `completed` / `playback-error` /
  `synth-error` / `preempted`. Q7's rotation, Q8's attempt count and Q13's failed list all read that
  identity; a decode failure must not pop as though it were heard.
- **An abandon path for a generating head.** Synthesis and playback share one daemon thread
  (`SttsPlayer.kt:29`), `stop()` releases only the MediaPlayer, and the STTS transport is deliberately
  non-cancellable with an 80s ceiling (`SttsClient.kt:52-62`). Add either a cancellable `Call` or a
  generation lane separate from the playback lane, make an abandoned key emit `preempted` so
  `inFlight` (`SttsPlayer.kt:157`) cannot swallow it into no-outcome-at-all, and pick a per-entry
  generation deadline for UX rather than inheriting the transport's 80s.
- Also warm TITLE, not just SUMMARY and FULL: with auto-play on Title every entry is otherwise a live
  cache-miss synth on that single thread, which is precisely the burst this phase claims to verify.

**NOT delivered by the first implementation pass, deliberately recorded rather than dropped:** the
per-entry generation deadline. The lane split means a stalled synth no longer blocks playback, but it
still occupies the synth lane for the transport's full 80s (`SttsClient.kt`), so the NEXT entry's
synthesis waits behind it. Bounding that needs either a cancellable `Call` (an `SttsClient` contract
change, which its header calls deliberate: "Blocking OkHttp, by design ... callers own the dispatcher
boundary") or a multi-threaded synth lane. Neither is in this pass.

- Autoplay drain: replace `msgs.lastOrNull { !it.fromMe }` with EVERY agent message, in order.
- **Re-key `isDuplicatePeerAutoPlay` on (from, to, body-content-hash)** - CORRECTED by L3-1; do NOT use
  `at`. The current `"${from}|${to}"` key was correct when only one message per burst could be spoken;
  under queue-everything it collapses distinct peer messages between the same two sessions, contradicting
  "All, in order". But the two mirror copies do NOT share `at`: `device-mailbox.ts:147` re-stamps it after
  the spread and `routes.ts:1282-1283` lands two independent entries. Body and files ARE shared by both
  `mirrorPeer` calls, so a content hash is the only usable identity without a wire change. Residue: two
  IDENTICAL messages between the same pair in one burst collide and one is dropped. Durable alternative is
  a new shared exchange-id field on the wire - never `dedupeKey`, whose `seenKeys` path would delete one
  participant's thread row outright.
- **Attribute a peer entry to the RECEIVING session (`to`)** (L3-3). The dedupe's winning thread is
  drain-order arbitrary, and the entry's team is what Phase 5's tap-to-jump and this phase's teardown both
  dereference, so it must be chosen rather than inherited.
- Repository owns the queue and advances it; `SttsPlayer` stays a one-shot engine.
- Replace the single `stop()` with distinct outcomes: completed, skipped, trashed, paused. Only pause
  does NOT advance.
- **One mutex-guarded advance**, per audit finding 3. Player completion and a user swipe can both advance
  concurrently, and an advance is read-the-head-then-mutate across calls rather than a single atomic
  `_state.update`. `scheduledSendFireMutex` is the precedent to copy.
- Body playback only: one `MediaPlayer`, and it is what feeds the bar, so `seekTo` stays plain.
- Failure: rotate to tail once, drop on the second failure, remember it for the alert.
- **Teardown, corrected by L2-4** (lap 1 got this wrong). `SttsPlayer.purge(team)` is called from
  `forget` ALONE (`ChatRepository.kt:4291`, its only call site); `closeTab` (`:3996-4011`) touches
  neither player nor cache. And `purge` welds stop to cache deletion (`SttsPlayer.kt:193-196`), right for
  forget, wrong for a close the user may reopen. Split into three: stop-current, drop-queue-entries,
  delete-cache. `forget` uses all three, `close_session` uses the first two. Sequence drop BEFORE stop
  under the advance mutex, or the stop's `playing=false` advances into an entry whose audio that same
  call is deleting.
- A remembered FAILURE is no longer a queued entry (L2-5), so teardown scoped to "queued entries" leaves
  it pointing at a thread `forget` has removed, and Q13's jump-to-session has no target. Drop a team's
  remembered failures alongside its queued entries.
- Auto-play enqueue stays gated on `followed = team in openTabs` and `sttsReady()`, exactly as today. No
  queue and no bubble exist when TTS is unprovisioned.
- Verifiable without UI: a burst of N messages speaks N times, in order.

### Phase 2 - Spoken form

This phase now owns BOTH boundary markers end to end - their text, their assets, and their playback -
since Phase 1 deliberately ships body-only.

- Sentinel text: non-peer uses the session label; peer uses `"<from> on <to>"`.
- DELETE `ttsTextFramed`'s inline `"<from> to <to>: "` prefix, which the sentinel replaces.
- Sentinel audio synthesized once and cached per (label, provider, voice), reused across that session's
  messages.
- Play chime and sentinel as SEPARATE playbacks with timed gaps around the body. No concatenation, so
  provider container mismatches never matter. Neither marker gets a timeline or a seek bar.
- Chime once per automatic run: queue was empty AND auto-play queued. Manual taps never chime.
- **Ship the chime asset.** `res/raw/` is the idiomatic home for a `MediaPlayer`-playable bundled sound.
  Staged file is mono 16-bit 44.1 kHz, 0.981 s, 84 KB.
- **Chime source setting**, which the phases previously omitted entirely: choose the bundled default OR
  an Android notification sound. The system option means the player must accept an arbitrary content URI
  and whatever format sits behind it, so the bundled asset's own format stops being special.

### Phase 2 as built

In progress. Landed and green:

- **`sentinelText`** (in `ChatRepository.kt`, pure, tested): the session label, or `"<from> on <to>"`
  for a peer row, with `"someone"` standing in for an unresolvable author so the marker never
  announces a blank. Depends only on the SPEAKER, never on the message - that is what lets one
  synthesis be cached and reused for every message in a session, and a test pins it.
- **The chime asset** at `res/raw/stts_chime.wav` (mono 16-bit 44.1 kHz, 86548 bytes).
- **`PlaybackQueue.isIdle`**: nothing playing and nothing waiting. Asked BEFORE an autoplay enqueue,
  this is the "once per run" rule - mid-run the queue is never idle, and a stood-down run is not idle
  either, so the marker cannot re-announce a run already in progress.

**Audit on Phase 2: five verified MAJORs, and two re-opened a closed class.** Fixed so far:

- **The sentinel did not yield.** I wrote "the chime must not yield" and then built `playMarker`
  non-yielding for BOTH markers, so a sentinel talked over a manual play. That is bug class A5 -
  "who takes the sound" - reaching around the rule through a path added after the rule. Only the chime
  is exempt now, and the reason is specific: it is instantaneous, so standing it down DROPS the
  boundary rather than delaying it. A sentinel is speech like any other and yields.
- **A marker terminal with no head stalled the queue.** Tear a team down while its chime or sentinel is
  speaking and every other team's backlog went silent: the drop's own resume bailed because the marker
  still held the sound, and the marker's terminal then found no head and started nothing. That is A3
  re-opened through a path A3's fix could not see. The marker branch now resumes when its run is gone.

**The marker sequence now matches terminals to the marker that was started.** This is the root cause
under three rounds of marker-ownership patches, and it is the recorded bug class again: the identity
EXISTED and was thrown away. A marker terminal carries its own `at` (and a `gen` the listener drops),
and the branch matched only on the head - so a terminal from a torn-down run was indistinguishable
from this run's own and drove it a step forward with its message unspoken. Deterministic, not racy:
`dropQueuedFor` holds the advance lock from the marker stop through the resume, so the stale terminal
always arrives after the next run is staged. `playMarker`/`playChime` now return WHICH request will
report, and the branch ignores anything else. Capturing the gap owner (below) only ever guarded the
350ms window, never entry into the branch.

**Teardown abandons a marker by identity, not by stopping whatever is audible.** The untargeted stop
missed a marker still SYNTHESIZING - which owns no sound at all, so a forgotten session went on to
announce itself anyway - and could silence a playback belonging to a team nobody asked to touch. The
field is `markerInFlight` and it is deliberately CLAIMED rather than sounding, because the window that
mattered is the one where the marker is audible to nothing.

**Also fixed, found by the re-audit:** the marker gap callback RE-READ the current head when the gap
expired instead of capturing it. A run torn down during a gap, with a new one staged behind it, left a
stale callback that drove the NEW entry's sequence and dropped its body unspoken. The owner is now
captured when the gap starts. Related and fixed with it: no teardown could reach a marker already
handed to the engine, because a marker lives under its own reserved team - so a session you had just
forgotten carried on announcing itself by name.

**Also fixed, found by the re-audit:** the `attributed` flag changed the spoken text but NOT the cache
key, so whichever variant synthesized first was served to both paths - and a cache hit never looks at
the text it was asked for. The direction was deterministic rather than racy: the preload runs
unattributed and finishes before the notification exists, so a manual tap on a peer row played the
unattributed audio and the restored attribution was silently defeated. The body cache is now keyed on
the spoken words, the same way a marker already was; `markerAt` had the right shape and its own doc
saying why, and the body key simply had not followed it. Dead `key()` removed with it.

**Fixed earlier in Phase 2 (this heading was stale and is corrected):**

- **Attribution restored for a message played by hand.** `ttsTextFramed` takes an `attributed` flag:
  an autoplay run has a sentinel and needs none, a manual tap has no marker and carries the prefix. A
  boundary marker delimits a RUN, and one message is not a run - so the answer was not "play markers
  for manual taps".
- **The chime copy is atomic** (temp then rename). A copy interrupted by a kill used to leave a
  half-written file that passed the exists-and-non-empty check forever after.
- **A picked sound takes a persistable read grant**, and **"Silent" is now a choice** rather than an
  absence: it is stored distinctly from the unset preference, so it no longer falls back to bundled.

- **Markers are bound to the entry they were staged for** (`markersFor`). Leftovers for an entry the
  queue has moved past are discarded rather than spoken: a marker names a session, and announcing the
  wrong one is worse than announcing none.
- **Timed gaps exist** (`MARKER_GAP_MS`, on the play lane). Run back to back, a marker and its message
  blur into one utterance instead of reading as a boundary.

Phase 2 code is complete. Not yet re-audited after this batch, and the gap timing is unheard.

Still to build, with the decisions already made:

- **The marker sequence.** An entry plays as chime (only when the run begins) then sentinel then body,
  as SEPARATE playbacks with gaps. No concatenation - providers differ in container, so one stream
  would have to re-encode. Neither marker is seekable and neither appears on the timeline.
- **Where the sequencer lives.** NOT in `PlaybackQueue`: an entry is one thing to a queue, and making
  it a segment list would put "what does an entry consist of" into the unit that owns "what plays
  next". The repository already owns sequencing-by-terminal, so the markers chain there. Each marker
  is an ordinary request with its own identity, which means it inherits one terminal, the yield rule,
  and delivery ordering for free rather than needing a parallel path.
- **The chime must not yield.** It is the shortest possible sound and it marks a boundary; standing it
  down would silently drop the boundary rather than delay it. The body still yields.
- **Deleting `ttsTextFramed`'s `"<from> to <to>: "` prefix** happens in the SAME commit that starts
  playing the sentinel, never before. Landing it early would leave peer rows with no attribution at
  all in between.
- **The chime source setting**: bundled default, or a system notification sound. The system option is
  the reason the player must accept an arbitrary content URI and whatever format sits behind it, so
  the bundled asset's own format stops being special.

### Phase 3 - In-thread control

- `thread.css`: keep the shared `.play-btn` / `.copy-btn` rule as the pressable base so idle-play and
  copy stay identical. Add state classes on play only: queued, loading, playing - filled, captioned,
  not pressable.
- Bridge: `setPlaying(at)` becomes per-row state rather than one "which row is playing" pointer.
- Tap behaviour: append at FULL when not queued; inert (state only) when already queued.

**Take the BRIDGE route, not the row payload** (agreed with the file-gallery team, whose `ThreadRenderer`
work made this matter). `ThreadRenderer`'s `fingerprint` decides row re-render, so anything riding the row
PAYLOAD that can change while the row is on screen must be folded into it, or the row keeps stale content
forever. State pushed over the JS bridge (`window.thread.*` mutating in place) is outside the fingerprint
by design and needs no fold. Four-state play control over the bridge is on the safe side.

If Phase 3 ever DOES want the payload route, note the trap they hit and paid for: **both halves must be
wired - a readiness key on the sync effect AND the fold in the fingerprint - because either alone is
silently inert.** Their video frames landing after a row rendered is what made it visible, since frames
change nothing a sync otherwise looks at. They offered to fold play state in properly rather than let us
discover the staleness the hard way, so ask rather than improvising it.

### Bug Classes (Phase 2)

**Mechanism: which run a marker belongs to.**
Defect class: a marker outlives the run that staged it, and nothing on the terminal says which run that
was - so a stale marker drives whatever is current.

- Round 1: `pendingMarkers` was process-global. Patched by binding it to an entry (`markersFor`).
- Round 2: the gap callback re-read the current head when it expired. Patched by capturing the owner
  when the gap starts.
- Round 3: teardown could not silence a marker at all. Patched by checking the marker's team.
- Round 4: the branch matched only on the head, so a terminal from a torn-down run was
  indistinguishable from this run's own. Patched by having the player return WHICH request will
  report, and matching on it. Teardown abandons by that identity too, which also reached a marker that
  was still synthesizing and owned no sound.

Rounds 1-3 were all guards, and each was a correct patch to a real hole that was not the one doing the
damage. The identity was on the terminal the whole time - `at`, plus a `gen` the listener discarded -
which is the recorded class from Phase 1a exactly: identity that exists and is thrown away, then
re-derived from something coarser. The fix that ended it was carrying the value, not adding a fourth
check. Worth remembering the tell: three consecutive fixes that each narrow a window rather than
answer "who is this?".

### Phase 3 as built

- **Three states on the play button** (`thread.css`, `thread.js`): queued, loading, playing as filled
  captioned chips that are not pressable. Filled rather than recoloured because idle is the outlined
  state; captioned because three states cannot be told apart by colour; only `loading` animates,
  because it is the one with no end in sight and a thread of pulsing chips reads as noise. Respects
  `prefers-reduced-motion`.
- **Per-row state over the BRIDGE** (`setPlayStates`), not the row payload, so it stays outside the
  re-render fingerprint. Each row is painted as it is BUILT as well as on push: state changes when
  playback does, not when a row re-renders, so a rebuilt row would otherwise sit idle awaiting a push
  that may never come.
- **The repository answers, consumers do not accumulate** (`playStatesFor`). This closes the deferred
  framework finding "make consumers query current truth instead of reconstructing it from the event
  stream". The glyph listener's own reconstruction was wrong twice - once blanking a row still
  playing, once stranding one that had ended - and it is now two lines that hold no state to drift.
- **A tap APPENDS at FULL** rather than playing alongside the queue, and an already-queued row is
  inert by construction (`pointer-events: none`). A tap on an audible message still stops it.
- **A tap does not chime, but does get a sentinel.** A chime marks a run that began on its own; a
  person who pressed a button knows they started it. Which session is speaking is not something the
  tap tells them, so the sentinel stays - and that keeps the `attributed` prefix off the queue path,
  where a marker already names the speaker. The notification Play action bypasses the queue, so it
  keeps the prefix and gets no marker.

### Phase 4 - Background control surface

**Use the PLATFORM media APIs, not a new dependency.** The app has no media dependency today
(`app/build.gradle.kts` has no media3 or androidx.media), and it does not need one: `minSdk 33` puts
`android.media.session.MediaSession` and `Notification.MediaStyle` both well inside the platform.
Adding `media3-session` would pull a dependency tree into a project whose rules are exact pins, a
lockfile, and a residue check - a real cost for a transport this small. Reach for media3 only if
something concrete needs it, not by habit.

- `MediaSession` plus a media-style notification: play / pause / skip, lockscreen, shade, headphone,
  watch.
- **The foreground-service change is bigger than "add a type"** (audit finding 2). With `minSdk 33` /
  `targetSdk 36`, API 34+ per-type enforcement applies, and today the app declares only
  `FOREGROUND_SERVICE_REMOTE_MESSAGING` (`AndroidManifest.xml:6`) with
  `foregroundServiceType="remoteMessaging"` (`:48`) and calls
  `startForeground(..., FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)` (`SwitchboardService.kt:312`). All of
  these move together:
  - add `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />`
  - declare `foregroundServiceType="remoteMessaging|mediaPlayback"`
  - pass the combined constant at the SINGLE existing `startForeground` call
  - **do NOT toggle.** L3-2 and L3-8 independently refuted the toggle: API 34 has no runtime prerequisite
    for `mediaPlayback`, so there is nothing to dodge; the concern was a Play-review one and this app is
    sideloaded; and toggling would re-call `startForeground` twice per run on `STATUS_NOTIFICATION_ID`,
    resurrecting a status notification the user dismissed (violating `SwitchboardService.kt:404-406`) and
    reverting its text to "Connecting..." with zero unread, since no (health, unread) snapshot is cached.
- **Publish a `PlaybackState`** (L3-4). At `targetSdk 36` the system IGNORES notification actions for
  media and derives controls from `PlaybackState`, so the transport is `ACTION_PLAY` / `ACTION_PAUSE` /
  `ACTION_SKIP_TO_NEXT` (skip = the swipe-advance), never `addAction`. Publish
  `METADATA_KEY_DURATION` + `ACTION_SEEK_TO` ONLY while a body `MediaPlayer` is live; publish
  `STATE_BUFFERING` with duration unset during chime, sentinel and the gaps. No duration means no progress
  bar, which is exactly right for a boundary marker - and it is how a MediaSession can represent
  body-only seeking honestly.
- **Pick the MediaStyle route and add a channel** (L3-5). Neither exists today: either platform
  `Notification.MediaStyle` on a raw `Notification.Builder` (no new dependency, breaks the
  NotificationCompat-everywhere convention) or a pinned `androidx.media` / `media3-session` through the
  repo's exact-pin + `check-module-residue` ritual. Plus a FOURTH channel at `IMPORTANCE_LOW`;
  `CHANNEL_MESSAGES` is `IMPORTANCE_HIGH` with sound and vibration, wrong for a transport.
- Request audio focus, which the app has never done, so TTS stops talking over music and ducks for calls.
- **Notification: split content from alert (Q16).** There is no per-message notification to withhold -
  one per TEAM, rebuilt from the current trailing unread rows. So update the content IMMEDIATELY and
  SILENTLY via the path `reconcileTeamNotifications` already uses (`setOnlyAlertOnce(true)`,
  `SwitchboardService.kt:501`), and fire the RINGING post once per run, when that run's first entry has
  audio. `notifyBurst` deliberately omits `setOnlyAlertOnce` on an `IMPORTANCE_HIGH` channel with sound
  and vibration, so per-message ringing would have meant N rings while the queue spoke those same N
  messages.
- The notification's existing Play action ("speak the burst-last message", `:435-436`) becomes
  "queue this run".
- Q16 dissolves two further lap-2 findings rather than leaving them open: L2-7 (no gate for audio that
  never arrives) stops mattering because content is never withheld, so nothing can be stranded; and the
  unrecoverable half of L2-8 goes with it, since a lost release can no longer strand a notification that
  was never held back. What REMAINS of L2-8 is real: the deep-idle tier's budget constants derive from
  ONE synthesis wait, not N, and eager whole-queue synthesis has to fit inside them.
- Focus, corrected by L3-6. The plan lumped a call and a navigation prompt together; they raise DIFFERENT
  callbacks, and with `CONTENT_TYPE_SPEECH` already set the system does NOT auto-duck, so
  `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` has to be handled explicitly rather than assumed. Settle: gain type
  `AUDIOFOCUS_GAIN_TRANSIENT` (a burst speaks and ends, so the user's music should resume) rather than
  `AUDIOFOCUS_GAIN`, which stops it permanently; `LOSS_TRANSIENT` pauses and resumes; `LOSS_TRANSIENT_CAN_DUCK`
  ducks or pauses by explicit choice; permanent `LOSS` pauses and leaves the queue intact. None of these
  advance, which is the pause outcome Phase 1 already separates from the three that do.
- Two existing wrinkles this phase should settle rather than inherit:
  - `preloadBoth` warms SUMMARY and FULL but NOT TITLE, so with the auto-play tier set to Title,
    pre-generate does not warm what actually plays.
  - `sttsAutoGen` may now be redundant. Once every queued entry is synthesized anyway to release its
    notification, a separate "pre-generate" toggle covers a case that no longer exists. Candidate for
    retirement, which is a settings change and therefore the owner's call.

### Phase 5 - Bubble and modal

- Overlay bubble via `SYSTEM_ALERT_WINDOW` when granted; degrade to Phase 4's notification alone when
  not. Count badge, spinner while the HEAD is generating, error as an ADDITIONAL badge that keeps the
  count. Swipe to dismiss = stop current, advance, bubble returns for the next.
- **Budget the overlay foundation** (L3-7), which this phase currently implies for free. There is no View
  layer and no lifecycle host a `ComposeView` can attach to inside a Service: `WindowManager.addView`
  throws at attach unless the root carries `ViewTreeLifecycleOwner`, `ViewTreeSavedStateRegistryOwner` and
  `ViewTreeViewModelStoreOwner`, and a Service is none of them. Either hand-roll a `LifecycleRegistry` +
  `SavedStateRegistryController` + `ViewModelStore` on the overlay root, or build the bubble without
  Compose. Also name the site that requests the permission - the phase's own premise is that the app is
  not in front, so it cannot be an Activity-only flow.
- Modal: transport row (play/pause, one bar over the current entry's BODY, `time/time`), then the list
  including the current entry. Fat tiles: session label + duration (spinner until known) on line one,
  title tier on line two, trash on the right.
- Trash the top entry = stop it and start the next, identical to swipe.
- Tap a tile = jump to that session at that message, reusing the existing open-and-reveal machinery.
- **No clear-all.** Per-entry trash plus swipe-to-skip covers it: "swipe is quick. and there's never an
  instance of more than 3 talkers."
- Alert bubble outlives a drained queue; tapping LISTS the failed entries, each offering jump-to-session
  or dismissal. The alert clears on acknowledgement, treated as "seen" rather than "resolved".

### Audit findings (lap 1)

**Provenance caveat: this is a SINGLE-perspective audit.** The `audit-fan-out` step calls for parallel
auditors; it was attempted twice and all six agents died on `API Error: 529 Overloaded` both times, with
`agents_done: 0`, `subagent_tokens: 0`, `tool_uses: 0` and zero `"type":"result"` lines in the run journal.
The empty result was infrastructure failure, NOT a clean bill of health. Re-run the fan-out on a later lap
when subagent capacity returns; the findings below are one perspective, not several.

Ranked, each verified against the code rather than reasoned from the plan alone.

**1. BLOCKER - `isDuplicatePeerAutoPlay` will silently drop messages under queue-everything.**
`ChatRepository.kt:359-362` keys the dedupe on `"${it.from}|${it.to}"` and returns
`!seenPairs.add(pair)`. That was correct when only `msgs.lastOrNull { !it.fromMe }` was ever spoken, so
one pair per burst was all that could occur. Now that EVERY message is queued, three peer messages
between the same two sessions in one burst collapse to one, which directly contradicts Q1's "All, in
order". ~~Fix: key on message IDENTITY (from, to, at)~~ - **THIS REMEDY IS REFUTED, see L3-1.** The
diagnosis above stands; the fix does not. The two mirror copies do not share `at`. Use
(from, to, body-content-hash).

**2. BLOCKER - the `mediaPlayback` service type needs a permission and a `startForeground` change the
plan omits.** The manifest declares only `FOREGROUND_SERVICE_REMOTE_MESSAGING`
(`AndroidManifest.xml:6`) and `foregroundServiceType="remoteMessaging"` (`:48`), and
`SwitchboardService.kt:312` calls `startForeground(..., FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)`. With
`minSdk 33` / `targetSdk 36`, API 34+ per-type foreground-service enforcement applies. Phase 4 says only
"add the `mediaPlayback` foreground-service type beside `remoteMessaging`". It also needs
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`, the combined `remoteMessaging|mediaPlayback` declaration, an updated
`startForeground` type argument, and a decision on whether the media type is declared permanently or
toggled at playback start and stop. **The toggle half is REFUTED, see L3-2 and L3-8: declare it
permanently.** The premises below stand; the recommendation does not. A permanently-declared
`mediaPlayback` with no active session is the
risky shape under API 34 enforcement.

**3. MAJOR - the queue advance needs a mutex, and there is direct precedent for one.** `_state.update`
appears 72 times in `ChatRepository.kt`, so per-block atomicity is the house discipline, but an advance is
read-the-head-then-mutate ACROSS calls. Player completion and a user swipe can both advance concurrently
and double-pop. `scheduledSendFireMutex` (`ChatRepository.kt:1032`) already exists for exactly this class
of bug, guarding `fireDueScheduledSends` "so a warm kick can never double-convert the same due record".
Fix: one mutex-guarded advance, single writer.

**4. MAJOR - Phase 1 depends on Phase 2's deliverables.** Phase 1 says "Play an entry as three SEPARATE
playbacks ... chime (auto-play runs only), sentinel, body", but Phase 2 is what ships the chime asset and
defines the sentinel text. Phase 1 cannot play what Phase 2 has not defined, so its "verifiable without
UI" claim is false as written. Fix: Phase 1 plays BODY only and proves "N messages speak N times, in
order"; chime and sentinel move wholly into Phase 2.

**5. MINOR - a provider or voice change mid-queue yields mixed voices in one run.** The audio cache key is
(team, at, tier, provider, voice) and the sentinel cache is per (label, provider, voice), so an entry that
is queued but not yet synthesized picks up whatever provider is current when its turn arrives. Fix: freeze
provider and voice onto the `TtsEntry` at enqueue time.

### Audit findings (lap 2) - the fan-out landed, and it is bad news for Phase 1

Two of four dimensions completed (`failure-modes`, `hidden-coupling`), 245k subagent tokens, 35 tool
calls, 10 findings. The other two (`verify-lap1-findings`, `android-platform`) died on 529 Overloaded and
are **still unaudited** - a one-shot retry is scheduled. Note the raw output reported them as
`died:false, findings:[]`, which reads as clean: `agent()` RESOLVES null on a terminal error rather than
rejecting, so the script's `.catch()` never fired. Cross-checked against the failures list instead.

Two independent agents converged on the same root defect, which is why it leads.

**L2-1. BLOCKER - the completion signal Q2 rests on cannot serve a queue.** Verified directly:
`SttsPlayer.kt:41` is `@Volatile var onPlayingChanged: (...)? = null`, a SINGLE slot whose own doc says
"Set by the owner", and `MainActivity.kt:370` claims it inside a `DisposableEffect` that nulls it at
`:373` on dispose. So:
- a backgrounded queue gets NO advance signal and stalls after entry one, which is the exact case the
  plan exists to fix;
- the repository wiring an advance would steal the thread glyph wiring, or be stolen by it, depending on
  composition order.
Fix: turn both player callbacks into a multi-subscriber registry (mirroring `inboundSubscribers`) owned
by the repository, with MainActivity's glyph wiring becoming one subscriber rather than the owner. This
is Phase 1 groundwork, before anything depends on it.

**L2-2. BLOCKER - `playing=false` cannot express Phase 1's four outcomes.** `clearNowPlaying()`
(`SttsPlayer.kt:207-214`) fires the same `onPlayingChanged(team, at, false)` for completion, playback
error, `stop()`, and replacement - the doc at `:38-40` says so outright. Concrete loss: a cached file that
fails to DECODE pops the entry as though it were heard, so the user gets silence, Q7/Q8's rotate-to-tail
never fires, and the entry never reaches Q13's failed list. Separately `onPlaybackError`
(`SttsPlayer.kt:173`) carries only a `reason: String`, no (team, at, tier), and is wired ONLY in the
settings sample screen (`MainActivity.kt:3481-3482`). Fix: the player must emit a typed,
identity-carrying outcome per key (completed / playback-error / synth-error / preempted). Q7, Q8 and Q13
all read that identity; without it there is nothing to count attempts on or to list in the alert.

**L2-3. BLOCKER - skip and trash cannot preempt a generating head.** Synthesis and playback share ONE
daemon thread (`SttsPlayer.kt:29`), `stop()` releases only the MediaPlayer (`:180-187`), and the STTS
transport is deliberately non-cancellable with an 80s per-call ceiling (`SttsClient.kt:52-62`). So
swiping away a stalled head buys no audible advance for up to 80s per entry, and Q8's "the alert state is
always reachable" becomes reachable only after roughly 2*N*80s. It compounds with the known
`preloadBoth`-never-warms-TITLE gap: with auto-play on Title every entry is a live cache-miss synth on
that one thread, so Phase 1's own burst test is the worst-serialising configuration. Also
`SttsPlayer.kt:157` `if (!inFlight.add(k)) return` means a rotated retry arriving while the first attempt
is still in flight returns with no playback AND no callback - no outcome at all, so the queue stalls
silently. Fix: an explicit abandon path (a cancellable `Call`, or a generation lane separate from the
playback lane), a rule that an abandoned key emits `preempted` so `inFlight` cannot swallow it, and a
per-entry generation deadline chosen for UX rather than inheriting the transport's 80s.

**L2-4. MAJOR - my own lap-1 teardown fix was wrong.** Lap 1 said to extend `SttsPlayer.purge(team)`.
That precedent exists ONLY for `forget` (`ChatRepository.kt:4291`, its sole call site); `closeTab`
(`:3996-4011`) touches neither player nor cache, so close needs a new path rather than an extended one.
And `purge` welds stop to cache deletion (`SttsPlayer.kt:193-196`), which is right for forget and wrong
for a close the user may reopen. Worse ordering hazard: `purge` calls `stop()`, `stop()` emits
`playing=false`, and under this plan that means ADVANCE - so a forget mid-playback advances into the next
entry, possibly the same team's, whose audio that very call just deleted. Fix: split into stop-current,
drop-queue-entries, delete-cache; say which of forget/close uses which; sequence drop-then-stop under the
advance mutex.

**L2-5. MAJOR - a remembered failure can outlive the thread it points at.** Teardown is scoped to
"that team's queued entries", but a remembered failure is by construction no longer queued (Q7 drops it
into the alert list). `forget` then removes the thread, team row and label, so Q13's "jump to the session"
has no target and the tile has no label to render. Phase 5 also describes the modal as the queue list OR
the failed list, never both, which is exactly what a refill produces.

**L2-6. BLOCKER (needs the owner) - per-message notification withholding is incoherent with the shipped
notification model.** The app posts ONE level-based notification per TEAM, rendered from the whole
trailing unread set, so the first released notification already displays every later, still-unsynthesized
message in the burst, and `reconcileTeamNotifications` re-renders it. Releasing per message therefore
cannot mean what Q5/Q6 assumed. It also turns one alert per team per burst into N: `notifyBurst`
deliberately does not set `setOnlyAlertOnce` and `CHANNEL_MESSAGES` carries sound and vibration, so N
posts to the same id each ring, while the TTS queue is speaking those same N messages. **This conflicts
with a settled owner decision (Q5/Q6), so it is raised rather than redesigned in-loop.**

Verified directly while framing Q16:
- ONE notification per team, id from `teamNotificationId(team)`, built by `teamNotificationBuilder`
  (`SwitchboardService.kt:414`) from `unreadRows(thread, state.readAnchors[team])` - the team's CURRENT
  trailing unread rows, InboxStyle over the last 5. Its doc (`:410-413`) says the preview lines "always
  reflect the team's real trailing unread rows, never a stale burst list". So "a message's notification"
  does not exist as a thing to withhold.
- `notifyBurst` (`:448`) RINGS: `CHANNEL_MESSAGES` is `IMPORTANCE_HIGH` with `setSound` and
  `enableVibration(true)` (`:327-336`), and it deliberately omits `setOnlyAlertOnce`.
- `reconcileTeamNotifications` already refreshes that SAME notification SILENTLY via
  `setOnlyAlertOnce(true)` (`:501`).
- The notification already carries Play actions that "speak the burst-last message" (`:435-436`), whose
  meaning changes once a queue exists.

So ring and content-refresh are ALREADY separate paths in this code. Any fix picks between existing paths
rather than inventing a mechanism.

**L2-7. MAJOR - the withhold rule has no never-arrives gate.** Enqueue is gated on
`sttsReady() && followed && (sttsAutoGen || autoTier != null)`; everything else takes the else-branch and
notifies immediately today. Nothing enqueues when auto-play is off, the team is not in `openTabs`, or TTS
is unprovisioned - so "withhold until audio exists" must not apply to those, or their notifications never
fire at all.

**L2-8. MAJOR - eager whole-queue synthesis versus the deep-idle budget.** The idle-tier budget constants
derive from ONE synthesis wait, not N. And because the reconciler refuses by design to post for a team
with no notification currently showing, a release lost to wakelock expiry or doze is unrecoverable rather
than merely late.

### Audit findings (lap 3) - the retry landed, and it refuted me twice

Both previously-dead dimensions completed (2/2, 0 errors, 245k tokens). They found 8 findings, and two
of them REFUTE lap-1 conclusions that were already folded into the phases. This is precisely the risk of
a single-perspective audit, and it materialised.

**L3-1. BLOCKER - lap-1 finding 1's FIX was broken, and it was already in the plan.** The diagnosis was
right (the `"from|to"` key collapses distinct messages under queue-everything); the remedy was not.
Verified directly: `device-mailbox.ts:147` is
`const entry: MailboxEntry = { ...input, seq: this.nextSeq++, at: Date.now() };` - the `at` stamp follows
the spread, so `append()` ALWAYS overwrites any incoming value. And `routes.ts:1282-1283` makes TWO
independent `mirrorPeer(...)` calls for one exchange (`fromAddr` then `toAddr`), each landing its own
entry through its own `append()`, hence its own `Date.now()`. `dedupeKey` also defaults to a fresh
`crypto.randomUUID()` per call (`:411`). So the two copies share NO identity field. Locally they usually
land in the same millisecond, but nothing enforces it, and on a relay-landing Gateway they are two
separate `consolePush` -> `landMailboxEntry` operations re-stamped at land time, where differing `at` is
near-certain. Keying on (from, to, at) would therefore have caused an INTERMITTENT regression: one
agent-to-agent exchange queued and spoken twice, the exact thing `isDuplicatePeerAutoPlay` exists to
prevent.

Corrected fix: key on **(from, to, body-content-hash)**, the only data the two copies genuinely share -
both `mirrorPeer` calls receive the same `{ body, files }`. Known residue: two IDENTICAL messages between
the same pair in one burst would collide and one would be dropped. The durable alternative is a shared
exchange id added at the wire level, which must be a NEW field - reusing `dedupeKey` across both calls
would make `append`'s `seenKeys` path (`device-mailbox.ts:138-146`) suppress the second copy outright and
delete one participant's thread row.

**L3-2. MAJOR - lap-1 finding 2's TOGGLE recommendation was unsound.** Found independently by BOTH
agents. Its premises were all correct; the recommendation was not. Two reasons. First, the rationale
argued against a permanent DECLARATION, but toggling varies only the runtime `startForeground` argument -
the manifest bullet mandates `remoteMessaging|mediaPlayback` under either option, so the toggle does not
change the shape the rationale objected to. That concern is a Play-review one, and this app is sideloaded
(`AndroidManifest.xml:18-19` reasons explicitly about "a sideloaded non-Play app at minSdk 33", and `:21`
declares `REQUEST_INSTALL_PACKAGES` for the in-app updater). Second, concrete harm: `startForeground` has
exactly ONE call site, `startInForeground()` (`SwitchboardService.kt:310-312`, called only from `:216`),
which hardcodes `buildStatusNotification("Connecting...", 0)`. Toggling would re-call it twice per run,
resurrecting a status notification the user deliberately dismissed - violating the stated invariant at
`:404-406`, "once the user clears the status entry, state changes must not resurrect it" - and reverting
the live status line to "Connecting..." with zero unread, since no (health, unread) snapshot is cached
anywhere. **Corrected: declare `mediaPlayback` permanently and pass the combined constant at the single
existing call. Drop the toggle.**

**L3-3. MINOR - Q9's "the arbitrary winner stops mattering" was overstated.** True for the sentinel TEXT
only. Whichever thread wins still becomes the entry's TEAM, and two Plan items dereference it: Phase 5's
tap-to-jump and Phase 1's teardown. So a peer entry's tile jumps to an arbitrarily-chosen participant
thread, and forgetting that arbitrary thread silently drops an entry the user associates with the other.
Fix: attribute a peer entry explicitly to the RECEIVING session (`to`), matching Q9's own framing, and
scope teardown to match - or drop a peer entry only when BOTH participant threads are gone.

**L3-4. BLOCKER - Phase 4's "play / pause / skip" cannot work as written.** At `targetSdk 36` the system
IGNORES notification actions for media and derives controls from `PlaybackState`. The plan has no
`PlaybackState` model at all. This is also the honest answer to the seek question I raised at Q10: a
MediaSession CAN represent body-only seeking, but only as a per-segment STATE MACHINE, not one static
advertisement. Fix: transport becomes `ACTION_PLAY` / `ACTION_PAUSE` / `ACTION_SKIP_TO_NEXT` (skip being
the swipe-advance), and publish `METADATA_KEY_DURATION` + `ACTION_SEEK_TO` ONLY while a body
`MediaPlayer` is live, publishing `STATE_BUFFERING` with duration unset during chime, sentinel and the
gaps - no duration means no progress bar, which is exactly right for a boundary marker.

**L3-5. MAJOR - there is no MediaStyle on the classpath and no channel a media notification can live
on.** Phase 4 treats both as free. Either use platform `Notification.MediaStyle` on a raw
`Notification.Builder` (no new dependency, fine at minSdk 33, but breaks the NotificationCompat-everywhere
convention) or pin `androidx.media` / `media3-session` through the repo's exact-pin +
`check-module-residue` ritual. Also needs a FOURTH channel at `IMPORTANCE_LOW`: `CHANNEL_MESSAGES` is
`IMPORTANCE_HIGH` with sound and vibration, which is wrong for a transport.

**L3-6. MAJOR - the audio-focus bullet is inverted for this app's own AudioAttributes.** With
`CONTENT_TYPE_SPEECH` already set the system does NOT auto-duck, and
`AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` is the one callback the plan omits - it lumps a navigation prompt in
with a phone call, which raise different callbacks. Also unsettled: the gain type.
`AUDIOFOCUS_GAIN` permanently stops the user's music; `AUDIOFOCUS_GAIN_TRANSIENT` lets it resume when the
queue drains, which is the shape for a burst that speaks and ends.

**L3-7. MAJOR - Phase 5 assumes an overlay foundation the codebase does not have.** No View layer, no
lifecycle host a `ComposeView` can attach to inside a Service, and no named site for the permission
request - while the phase's whole premise is that the app is NOT in front. A `ComposeView` added via
`WindowManager.addView` throws at attach unless its root carries `ViewTreeLifecycleOwner`,
`ViewTreeSavedStateRegistryOwner` and `ViewTreeViewModelStoreOwner`, and a Service is none of them. Budget
for hand-rolling those on the overlay root, or for not using Compose in the overlay.

**L3-8. MINOR - the toggle rests on a platform claim that is not true.** API 34 enforcement has no runtime
prerequisite for `mediaPlayback`, so there was no hostility to dodge. Independent corroboration of L3-2.

### For the framework-first step: one bug class, hit three times in one session

Not three unrelated mistakes. One class: **identity re-derived by parsing a formatted string, instead of
carried as a value.** Each instance was caught by a different mechanism, and each time the fix I reached
for first was to patch the parser rather than to stop parsing.

1. **Plan, lap 1.** Proposed keying the peer dedupe on `(from, to, at)`, assuming the two mirror copies
   shared `at`. They do not: `device-mailbox.ts:147` re-stamps `at` after the spread, and
   `routes.ts:1282-1283` lands two independent entries. Refuted by the lap-3 audit.
2. **Code, Phase 1a.** `tierOfKey` recovered the tier by splitting a cache key on its first dash. Team
   addresses legally contain dashes (`evie-bot.0713b7` is a live one), so the tier came back null for
   real teams. Caught by the align audit. Fixed by THREADING the tier through as a parameter, which is
   the class-level fix rather than a better parser.
3. **Tooling, same session.** `grep 'stts.purge'` matched `stts.purgeAll`, producing a false "three call
   sites" claim that was reported to the owner before being checked.

**The codebase already contains the correct pattern**, which is what makes this worth a framework pass
rather than three patches: `shared/session-id.ts` is explicitly built so "a store key and a lookup key
are the SAME value by construction", with one grammar owner and no shadow parsers. `tierOfKey` was
re-parsing a composite two files away from that discipline.

What the framework step should look for: any place that recovers a component from a rendered/composite
string (cache keys, addresses, ids, file names) where the producer had the typed value and could have
carried it. The fix is always the same shape - carry it, do not re-derive it - and it kills the class
rather than the instance.

### Second framework target: the request registry is untestable by construction

Phase 1a took 8 defects across two audit rounds before a redesign, and every one was caught by REVIEW
rather than by a test. The reason is structural: the request state machine (claim, finish, the single
terminal event, the preempt-predecessor rule) is pure logic, but it lives inside `SttsPlayer` alongside
`MediaPlayer` and `LoudnessEnhancer`, which a JVM unit test cannot construct. So the one part of this
feature with real invariants is the one part no test can reach, and `testDebugUnitTest` stayed green
through all 8.

Extracting the registry - claim / finish / release / the live map, with playback as an injected effect -
would make the whole event contract assertable: every path emits exactly one terminal, no request leaks,
preemption reports the predecessor, a rejected duplicate mutates nothing. That is behaviour testing, not
state testing, and it is the difference between catching the ninth defect and shipping it.

### Phase 1a as built

`PlaybackRequests.kt` (new, no Android import) owns the request lifecycle; `SttsPlayer` keeps only the
playback effects. `PlaybackRequestsTest.kt` covers the contract; the count below is what shipped, and
the sections that follow record what each later round added.

- **One carried identity.** `PlaybackId(team, at, tier, gen)` is minted at `claim` and threaded through
  both lane hand-offs into every event. `gen` separates a re-claim of an entry from the claim it
  replaced, so a late hand-off drives nothing. Replaces three disagreeing identities: a cache key
  (which smuggled provider and voice into identity), an event tuple, and four loose `current*` fields.
  The sounding pointer lives in the registry too, so the bulk drop is one atomic decision rather than
  two monitors agreeing by luck.
- **One terminal per entry.** `finish` returns the event or null; a second caller gets null. Every
  ending routes through it, so an outcome cannot be reported twice or not at all.
- **Ordered delivery.** The registry owns the listeners. Every event is appended to an outbox inside
  the same critical section that changed the state, so delivery order IS transition order and no
  consumer has to reconstruct it. A `Started` is refused once the request has ended, so it cannot
  trail its own terminal and strand a consumer on a phantom playing entry.
- **Listeners run off the monitor.** A pump hands the drained outbox to a sink: the `stts-events` lane
  in production, inline by default so a JVM test can assert the delivered transcript.
- **A preload is not a request.** It holds no claim at all, so it cannot be reported, stopped, or
  mistaken for playback. A purge reaches it through the epoch instead, which also covers the gaps
  between its writes where a claim could not exist.
- **MediaPlayer built into a local** and released by hand on failure; a field assigned via `apply` is
  never assigned when the block throws, which is exactly when it must be released.

Cost of getting here, worth recording: 11 defects across 3 audit rounds, none catchable by a test until
the extraction. That is the evidence for the second framework target above, not a hypothetical.

### Red team on Phase 1a

8 audit angles, 22 findings raised, 5 refuted by both skeptics, 17 survivors collapsing to 5 root
causes. Two splits, both broken toward the finding, reasons below.

**RC-A. `apply()` releases the field, not the request's player.** Four angles found it independently.
The `soundingEnded` decision is taken under the registry monitor and acted on after a separate
acquisition of the `SttsPlayer` monitor, which `playFile` holds across `prepare()`. A teardown racing
a start releases the NEW player and leaves its request live, sounding, and terminal-less forever -
`MediaPlayer.release()` nulls its own listeners, so nothing can ever mint that terminal. This is the
one invariant the extraction exists to guarantee. The trailing `Ended` also lands after the newer
`Started`, contradicting `emit`'s own mint-order claim. Fix direction: `PlaybackDrop` carries WHICH id
was sounding, teardown is identity-guarded against the player's owner, and events publish before the
effect rather than after it.

**RC-B. Preload shares the play path's claim.** Mine, from round 6, and the largest cluster: seven
findings. Claiming was right (a purge must reach that producer), the key was wrong - a preload and a
play request are different roles that now collide on one `(team, at, tier)` entry. Consequences, all
real: `isPlayingMessage` reports true for a message only being pre-synthesized, so the in-thread Play
button is dead for the whole synthesis window and instead stops whatever else is audible; a Play that
does land cancels the preload and plays nothing; and a superseded preload's completion unconditionally
`dest.delete()`s a file a newer live claim owns. Fix direction: give the entry a role, count only PLAY
roles in the toggle predicates, and let purge sweep both. Note this is the same shape as the recorded
bug class - two different things sharing one identity - which is why it belongs in framework-first, not
just in a patch.

**RC-C. The glyph listener drops the tier.** Three angles. `sounding` is keyed `team -> at`, so a
sibling tier's `Ended` clears the glyph of the tier that is still playing, which is precisely what its
own comment claims to prevent. Reachable whenever autoplay speaks TITLE while the notification starts
FULL.

**RC-D. `isLiveForMessage` has zero coverage.** The one predicate the whole toggle hangs on, and the
only public method of the registry with no test. RC-B rode in under it.

**RC-E (minor, split). The cache-hit check sits inside the single-threaded synth lane**, so a cached
play queues behind a stalled fetch for up to the transport's 80s. Skeptic A refuted it as pre-existing
serialization; skeptic B held that the plan's recorded carve-out covers "the next entry's SYNTHESIS
waits", which does not cover an entry needing no synthesis at all. Broken toward the finding: the
serialization is old but the class doc asserting it cannot happen is new in this diff, and hoisting the
`dest.exists()` check ahead of the lane hop is a few lines.

**Tie-break on the preload delete (RC-B).** Skeptic A refuted it by showing the in-thread Play tap
never reaches `stopEntry`, because `isPlayingMessage` is true during preload and the tap diverts to
`stopPlayback()`. That is not a refutation - it is RC-B's own defect standing in front of this one.
Fixing RC-B opens the path. Skeptic B independently found a second route through
`reconcileTeamNotifications`, whose Play actions carry `last.at`. Severity does drop: the sounding
`MediaPlayer` holds an open fd, so unlinking cannot interrupt audio being heard; the harm is a wasted
re-synthesis, not a glitch.

### Bug Classes

Two mechanisms have now been patched more than once for the same defect class. Recorded here rather
than fixed properly, because a third patch in the same place is the signal that the design is wrong,
not the patch. `framework-fan-out` owns the redesign.

**Mechanism: the terminal decision and the player-release effect.**
Defect class: the decision is taken under one lock and the effect runs under another, so the effect
lands on whatever state exists when it wins its lock rather than the state the decision was about.

- Rounds 1-6, pre-extraction: 11 defects. Patched in turn by adding an outcome, making the outcome
  non-contradictory, ordering the emit, making the bulk drop atomic, extracting `PlaybackRequests`,
  and finally moving the sounding pointer into it.
- Round 7 (red team): `apply()` released whatever `player` held, on a boolean taken earlier under the
  registry's lock. A teardown racing `playFile` killed the newcomer's player and stranded its request
  with no terminal. Patched by having the drop NAME the id that lost the sound and guarding the
  release on `playerOwner`, plus publishing events before running the effect.

- Round 8 (red team, lap 2): three more from the same seam. The release ran inline on whatever thread
  reported the terminal, and MediaPlayer's callbacks land on the MAIN Looper, so main blocked on a
  monitor held across `prepare()`. Both MediaPlayer callbacks and the playback-failure path ended the
  ENTRY rather than the request, so a late callback killed the generation that replaced it. And
  because minting and publishing are still not one step, a terminal could be delivered after the
  Started that replaced it. Patched by moving the release onto the play lane, scoping those terminals
  to the request with `finishRequest`, and putting `gen` on the events so a consumer can tell a stale
  terminal from its own.

- Round 9 (red team, lap 3): a `Started` can be published after its own `Ended`, stranding a row on
  "playing" with no terminal left to clear it. The comment claiming the monitor made mint and publish
  one step was worse than wrong: no terminal path takes that monitor at all, so holding it orders
  nothing. Patched at the CONSUMER - the glyph listener now refuses a Started whose generation has
  already ended - and the comment now says the ordering cannot be fixed from the producer side.

Every round so far has moved the seam rather than removed it. The seam is that two locks exist at
all: `PlaybackRequests` has its monitor and `SttsPlayer` has its own, and `playFile` holds the second
across `prepare()`. Mint-and-publish is the same seam seen from the other side, and both `gen` on the
event and the consumer's ended-guard are ways to SURVIVE it, not fixes. Every mint already happens
under the registry's monitor; publishing there too would make enqueue order equal mint order by
construction and delete this entire class. That is the redesign.

**Mechanism: the claim key.**
Defect class: two roles collapsed onto one identity, so a predicate answering for one answers for the
other.

- Round 6: preload was invisible to `purge`, so a forget mid-preload recreated the directory it had
  just deleted. Patched by having preload claim the play entry.
- Round 7 (red team): that claim made a message being warmed read as playing. Seven findings from one
  cause: a dead Play button for the whole synthesis, a tap that stopped a different message, a Play
  that cancelled the warm-up and started nothing, and a superseded preload deleting a file a live
  claim owned. Patched by adding a role to the entry and scoping the toggle predicates to PLAY.
- Same round, same class: `isPlayingMessage` asked "any tier of this message" while `stop()` acted on
  "whatever is sounding". Patched by adding `finishMessage` so the action matches the question.
- Round 8 (red team, lap 2): making the question claim-wide was itself wrong, because a row gives the
  user no way to SEE a claim. With autoplay on, one tap on a fresh message cancelled the autoplay and
  played nothing. The button is back to toggling on audible; the claim-scoped toggle is blocked on the
  Loading / Playing / Queued button state, which is where the owner already put it.
- Round 10 (red team, after the preload removal): the same claim-versus-sounding mismatch was still in
  `playSample`, the sibling call site I did not change when I fixed `play()`. A second tap on the
  settings voice preview cancelled a synthesis the user was still waiting on and played nothing. The
  naive fix would have double-paid the provider, because the team-wide supersede sweep would have
  ended the very entry the re-claim was about to make; `finishTeamExcept` makes it one operation
  instead of a check then a sweep. `stopEntry`, the last claim-scoped toggle, is deleted.
- CLOSED by framework-first: the preload left the registry, so the role and its six filters are gone.
  Three rounds tried to make one identity serve two things; the fix was for the second thing to stop
  being a request. Registering it was always the wrong instinct - what it needed was reachability, not
  identity, and those are not the same requirement.

**Mechanism: purge versus an in-flight producer.**
Defect class: a purge is an instant and a producer spans one, so "is this claimed" cannot answer "is
this still wanted".

- Round 6: preload was invisible to the sweep. Patched by claiming.
- Round 7: the claim collided with the play entry. Patched by adding the role.
- Round 8: the sweep still could not reach a producer that held no claim at the moment it ran - either
  mid-fetch on the play path, which recreated the deleted directory via `mkdirs`, or in the gap
  between two preload tiers. Patched with a purge epoch stamped from the same counter as `gen`, so a
  producer can ask `isStale` at any later point instead of asking whether it is still claimed.

- Round 9: the epoch was stamped by `finishTeam`, which the voice sample also uses to supersede
  itself, so testing a voice made its own in-flight synthesis read as purged and delete the audio it
  had just paid for. And because the stamp was compared against the id's own `gen`, a producer that
  re-claims per work item moved its horizon past the very purge it needed to see, leaving the
  between-tiers gap exactly as open as before I claimed to have closed it. Patched by splitting
  `purgeTeam` from `finishTeam` and capturing the horizon once with `purgeStamp`.

Four rounds, four different answers to "who is allowed to write into a team's cache directory". The
question is really one of ownership of that directory, and nothing here owns it: the player, the
preload, and `forget` all reach into the same path with no arbiter. Every fix so far has been a way
for a writer to guess whether its file is still wanted.

STILL OPEN. This is the one class of the three that structural work has not closed, and it is
deliberately left for a later lap rather than attempted late: the shape (a generation-stamped
directory, so a purge RENAMES and a stale writer's path stops existing) is filesystem-semantics work
that nothing automated covers, and a hasty version of it would be another seam relocation. The epoch
is now the registry's ONLY remaining opinion about files, so the chunk is cleanly separable.

**The pattern across all three mechanisms.** Rounds 7, 8 and 9 each introduced their own successor:
the role fix made the button claim-wide (round 8 regression), the button fix left `play` still
cancelling a synthesizing entry (round 9 regression, MAJOR), and the purge epoch broke the voice
sample (round 9 regression). A fix landing in a mechanism that has no owner does not converge - it
relocates. That is the argument for `framework-fan-out` doing structural work here rather than a
tenth round of patches.

### Framework-first

29 proposals across 8 design angles, 13 refuted by both skeptics, 16 survived - 15 of them split, so
nearly every one had a dissent worth reading. Landed one chunk; the rest are ranked below rather than
dropped.

**Landed: the registry owns delivery.** `PlaybackRequests` now holds the listeners and an outbox, and
every mint appends inside the same critical section that changed the state. A pump hands the whole
outbox to a sink; production passes the `stts-events` lane, and the default runs inline, which is what
makes delivery assertable from a JVM test. `SttsPlayer` no longer has `emit`, a listener list, or any
way to publish an event at all. Delivery order is now the registry's transition order by construction,
so the consumer-side ended-guard is deleted and `gen` on the event goes back to being plain identity
rather than an ordering crutch. Six new tests cover the transcript, including preemption being
delivered before the start that caused it - a sequence no test could reach an hour ago. 43 tests.

Two smaller things rode along: `installPlayer` is now the only part of `playFile` that takes the
monitor, so building and preparing a MediaPlayer no longer holds a lock across disk work; and the dead
`isPlaying(team, at, tier)` is gone, which was a same-stem sibling of `isPlayingMessage` answering the
opposite question with zero callers.

**Rejected: play-lane confinement.** Deleting `SttsPlayer`'s monitor and confining the player fields to
the play lane reads like the fix for bug class 1, and it is not. A single-thread executor IS a
mutual-exclusion domain, so it renames the second lock rather than removing it; the proof is that the
round-7 `playerOwner` guard would still be load-bearing afterward, and a change that closed the class
would let that guard be deleted. Dropping `@Volatile` also makes the Phase 4/5 hazard it claimed to fix
strictly more reachable, since a future `positionMs()` accessor touches the field, not the guarded
methods.

**Landed: the preload left the registry.** It was never a playback request - no sound, no terminal any
consumer observes, and the only thing it actually needed was purge reachability, which the epoch
already provides and provides better (a claim cannot exist in the gap between two of its writes; the
epoch covers it). `PlaybackRole` is deleted along with the six predicates that had to filter on it and
the suppression rule every bulk path had to remember. Six role tests collapsed into one that pins what
protects a warm-up now. This closes bug class 2: there is no second identity left to conflate, and no
rule for a Phase 1b predicate to forget.

**Landed: a residue gate.** `PlaybackResidueTest.kt`, in the repo's existing
`OutgoingFileResidueTest.kt` mould: nothing outside the registry may mint a `PlaybackId` or construct a
playback `Event`, and the registry may import no platform type. The first two keep the ownership the
other two chunks established from eroding at a NEW call site, which is how all nine rounds recurred -
every patch was correct where it landed. The third guards the property the 39 unit tests depend on,
and the pressure on it is ordinary: the first instinct on losing a log line was to reach for the
Android logger. Verified to fail when violated rather than assumed to.

**Ranked next, not done.** Closes the one recorded class still open:

1. **Give the cache directory an owner.** The strongest shape proposed is a generation-stamped
   directory, so a purge RENAMES and a stale writer's path simply no longer exists. That deletes
   `purgedAt`, `wipedAt`, `isStale` and `purgeStamp` from the registry outright, and with them the
   question "which method stamps the epoch" that produced round 9's voice-sample regression. This also
   fits the repo's documented sole-owner-plus-residue-test idiom. Note the registry now holds the
   epoch as its ONLY remaining opinion about files, so this chunk finishes the separation the preload
   removal started.
2. **An `AudioDevice` port owning opaque handles.** Makes `teardownPlayer` - "release whatever the
   field holds" - unexpressible, and with it the `playerOwner` guard.
3. **A `Lanes` port**, so hand-offs are deterministic in a test and lane identity is a type rather than
   a comment.

### Gates

Kotlin is not covered by `ci.yml`, so `./gradlew :app:testDebugUnitTest` locally is the gate, plus
`assembleEmulator` and a real look on the AVD for anything visual. Cards live in the Designer dock
(`tts-queue.html`, `tts-play-states.html`).

**Audio is the owner's to verify, at the end.** They will test the whole feature once the plan runs top
to bottom, so "I cannot hear it" is not a blocker on any phase and must not gate progress. What still
gets verified without ears, and should be: that the expected file is produced and cached under the
expected key, and that the ORDER of playback events is right - which is the actual risk in the chime
and sentinel work, and is observable through the event stream. Anything VISUAL gets a real emulator
screenshot rather than a description.

**Audit fan-outs are capped at 12 agents PER LEVEL** (owner's instruction; the cycle script's "8+ up to
20" is the looser bound). The shape that fits: 8 explore agents, then rank every finding and send the
top 6 to adversarial verify at 2 opus skeptics each, which is 12 in the verify level. Anything below
that line ships UNVERIFIED and must be labelled so - verify kills roughly half of what explore raises,
so an unverified finding is not the same claim as a survivor.

### Phase 1b as built ✅

Landed and green. Six MODERATE items remain, listed under "Still open" below; none of them break
autoplay, and each is recorded rather than dropped.

- **`PlaybackQueue.kt`** (new, pure, no Android import; `PlaybackQueueTest` covers it). Ordered entries
  with one head. Advancing is ONE operation keyed on the outcome: `STOPPED` alone holds position, and
  an outcome naming anything other than the current head is ignored, so a terminal from an
  already-replaced request cannot walk the queue past a message nobody heard. A failure rotates to the
  tail once, then drops and is remembered for the alert. `dropTeam` takes queued, playing AND
  remembered entries, and returns whether it took the head so the caller can stop the player knowing
  the queue no longer points at it.
- **`isDuplicatePeerAutoPlay` re-keyed on content** (`from`, `to`, body hash + length, file names and
  sizes) rather than on the pair alone. The pair key was correct only while a pass could speak one
  message; queueing every message made it collapse distinct exchanges. Deliberately NOT keyed on `at`,
  which the two mirror copies do not share.

### Alignment audit on Phase 1b

53 findings, 50 surviving, deduping to seven root causes. Five of them leave autoplay permanently
broken, not degraded. Recorded before fixing because the set is large and the wiring was rushed.

**A1. Nothing guarantees a terminal for an entry the queue starts.** `speak` calls `playMessage`, which
returns early when the message cannot be resolved or its text is blank. That path mints no claim, so
no `Ended` is ever emitted, so the head is never retired and every later message piles into `pending`
forever. Autoplay goes silent for the life of the process with no log line. This is the queue's own
version of the invariant Phase 1a exists to protect - exactly one terminal per started entry - and the
repository breaks it from the outside.

**A2. Peer entries carry the wrong `at`.** Attributing to the receiving session was implemented by
swapping the team while keeping `msg.at`, which belongs to the copy in the OTHER thread. The two mirror
copies do not share a timestamp (the mailbox re-stamps on append), and the cross-Gateway single-mirror
cases name a remote address with no local row at all. So the pair resolves to nothing, which triggers
A1 deterministically.

**A3. `dropQueuedFor` clears the head and never starts the next entry.** Closing a tab or forgetting a
team halts every OTHER team's queued messages too.

**A4. A user stop parks the queue for good.** `STOPPED` holds position by design, and `resume()` has no
caller. One tap on the in-thread stop button ends autoplay for the process.

**A5. The queue talks over a manual play.** A tap preempts the sounding head, the queue reads PREEMPTED
as "advance", and it immediately starts its next entry over the top of what the user just asked for.
PREEMPTED conflates "the queue replaced this" with "something outside the queue took the sound".

**A6. The followed/`sttsReady` gate is evaluated on the drained thread, not on the team the entry is
attributed to.** So autoplay can speak for a session that is not followed, and the peer dedupe claims
its content key BEFORE the gate runs, letting an ineligible thread suppress an eligible one.

**A7. Teardown's stop is untargeted.** It calls `stopWith(PREEMPTED)`, which ends whatever is sounding -
possibly another team's audio. `SttsPlayer.abandon`, which is identity-scoped and was built for exactly
this, has no callers.

Lower-ranked and not yet fixed: cross-team order within one burst is synthesis-completion order rather
than arrival order; `clearAll` leaves the queue populated; and the preload warms the burst's first
message while the notification's Play action still targets its last.

**Fixed so far.** A1: `SttsPlayer.play` now returns whether it CLAIMED the request, which is the same
question as whether a terminal is owed, and the repository mints the terminal itself when the engine
declines. A2: the peer re-attribution is REVERTED - an entry is addressed by the thread it actually
lives in. Attributing to the receiving session needs that thread's own copy of the row looked up, not
the other copy's timestamp pasted onto a different team; until that lookup exists, the re-attribution
only produced entries nothing could resolve. A3: `dropQueuedFor` starts the next entry, so tearing one
team down no longer halts every other. A7: `dropTeam` NAMES the entry it took so teardown abandons that
request by identity rather than silencing whatever is audible.

A4: `STOPPED` now retires its entry and the run carries on. The stop control says "not this one", not
"not any more"; holding the head there ended autoplay for the life of the process, because nothing
resumed it. A real pause needs a control that says so, and arrives with the Phase 4 transport - so
`resume()` and `QueueStep.paused` are deleted rather than left as API with no caller.

A5: PREEMPTED now retires the head and starts NOTHING. Something outside the queue has taken the sound,
and speaking over it is the bug. The run picks up again when that playback reports its own terminal:
an outcome for a non-head entry moves nothing by itself, so the caller sees an idle queue with a
backlog and restarts it.

A6: closed in two halves. The gate half fell out of the A2 revert - an entry is now attributed to the
same thread the gate tests, so they cannot disagree. The dedupe half needed a reorder: the peer content
key is claimed only by a thread that is actually eligible to speak, otherwise a muted session silently
suppressed the followed one showing the same exchange.

**Re-audit caught A5 still live, plus two defects the fixes themselves introduced.** Worth recording
because the pattern is the same one Phase 1a's bug classes describe.

- **A5 was not fixed.** `PREEMPTED` returned "start nothing", and the very next line restarted the run
  anyway, because it asked whether the QUEUE was headless - which it always is the instant it stands
  down. The stand-down is now an explicit flag rather than something inferred from an empty head, and
  the resume asks the PLAYER whether anything is audible. My test passed throughout, because it
  asserted at the queue level on exactly the value the caller overrode.
- **The A1 fix minted a SECOND terminal.** `play` returned false on the toggle branch, which had
  already emitted this entry's terminal, so the repository invented another. `play` now returns true
  there: the question it answers is "will this entry's outcome be reported", and it just was.
- **Teardown could be undone by a burst job.** A drain coroutine landing after a close or forget put an
  entry back into a queue the teardown believed it had emptied. Enqueue now re-checks the team under
  the advance lock rather than trusting the check made back at the drain.

### Bug Classes

**Mechanism: who is allowed to take the sound.**
Defect class: a request handed to the engine takes the sound whenever it finally becomes ready,
regardless of what happened in between. The queue is not consulted, so no amount of queue-side care
fixes it.

- Round 1: the queue advanced on PREEMPTED and started its next entry over the top. Patched by making
  PREEMPTED not advance.
- Round 2: the stand-down was undone one line later by a resume that asked whether the QUEUE was
  headless. Patched with an explicit `standDown` flag plus asking the player instead.
- Round 3: the OTHER start path, `step.next`, never asked at all. A head that fails before it ever
  sounds - a cache-miss error, or a cached file that will not decode - hands back a next entry that
  starts over the top of a manual play. Patched with the same guard.

Three rounds, three patches, and the audit's own refutation names why none of them close it: the same
overwrite happens with NO queue decision at all when an in-flight head's synthesis simply succeeds.
`PlaybackRequests.sound` displaces unconditionally, so every request already in flight is a pending
interruption of whatever the user does next. The window is ordinary rather than rare - with
pre-generate off, every autoplay head is a live cache-miss synth bounded only by the transport's 80s.

CLOSED by framework-first. A request now declares whether it YIELDS, and `sound()` decides: a yielding
request that finds the sound already taken stands down and reports its own terminal instead of
displacing. Autoplay yields; anything the user asked for never does. The asymmetry is the rule, and it
holds for every request in flight rather than for the call sites that remembered to check - which is
the point, because a request handed over before the person acted arrives long after any caller is left
to ask.

- Round 4: the caller-side guard from round 3 was not merely redundant afterwards, it was harmful.
  `advance` installs `step.next` as the head BEFORE the caller decides, so refusing to speak it
  stranded an entry the engine never received and no terminal could ever retire - the wedge from A1,
  reintroduced by the patch for A5. Deleted. Handing the entry over is now always right, because the
  request yields at the player and reports its own terminal either way.

The lesson worth keeping: once the invariant moved into `sound()`, every guard protecting it from
outside became a liability rather than insurance. A redundant check is not free when it can refuse.

**Still open:** cross-team ordering within one burst; `clearAll` leaving the queue populated; the
notification's Play action targeting the burst's last message while the preload warms its first; two
rows sharing one `at` collapsing into a single entry; unspeakable rows (status-only, files-only) being
enqueued and burning both attempts; and `close_session` having no stop-current leg, so a manually
played message from a closed tab keeps sounding. The peer attribution stays on the drained thread - the
spec's `to` needs that thread's own copy of the row looked up, and the "Still to wire" list above is
stale on this point.

Still to wire, all in `ChatRepository`:

- Autoplay drain over EVERY agent message in order, replacing `msgs.lastOrNull { !it.fromMe }`.
- Attribute a peer entry to the RECEIVING session (`to`), since the dedupe's winning thread is
  drain-order arbitrary and the entry's team is what teardown and tap-to-jump dereference.
- Repository owns the queue and advances it from playback terminals, under one mutex
  (`scheduledSendFireMutex` is the precedent). `SttsPlayer` stays a one-shot engine.
- Teardown split three ways: stop-current / drop-queue-entries / delete-cache. `forget` uses all
  three, `close_session` uses the first two. Drop BEFORE stop, or the stop's own terminal advances
  into an entry whose audio the same call is deleting.

## Painpoints

Not a code audit. What actually hurt while working here.

**No audio was ever heard.** Every change across ten rounds was verified by compile, unit test and
`assembleEmulator` only. Nothing automated covers the play lane, and I never put the AVD in front of a
message and listened. The toggle semantics changed three times in this work and all three are unheard.
That is the single largest gap between "green" and "known good" in this plan, and it is worth an
emulator pass before Phase 1b builds a queue on top.

**`SttsPlayer` cannot be constructed by a JVM test, and that is where every defect lived.** All ten
rounds found their defects in the effect layer; the pure registry has 39 tests and produced almost
none. The asymmetry meant an expensive multi-agent audit was the ONLY detection mechanism available
for the half of the system that breaks, and each audit cost roughly twenty minutes and several million
tokens to find things a unit test would have caught in milliseconds. `AudioDevice` and `Lanes` ports
are ranked in framework-first for exactly this reason.

**Comments here are load-bearing, and nothing gates their accuracy.** In this file a comment is the
ledger of a paid-for bug, so a reader trusts it. Two comments were actively WRONG in ways that caused
real harm: one claimed a monitor made mint-and-publish atomic when no terminal path took that monitor,
and one claimed a staleness check covered a gap it could not see. A wrong comment here is worse than
no comment, because the next round reads it and reasons from it - an audit agent did exactly that and
produced a confident, wrong refutation.

**Kotlin's `apply` is a trap that bit twice.** `x = Foo().apply { configure() }` leaves `x` unassigned
when the block throws, so the catch releases a null and leaks the object. It cost a leak in the
MediaPlayer path, was documented as a bug class, and then recurred verbatim three lines away for
`LoudnessEnhancer`. A private method also named `apply` sat next to it, which does not help anyone
reading quickly.

**`ChatRepository.kt` is too large to read.** It exceeded the context budget to open at all, so every
question about it had to be answered by grep. A file that cannot be read is a file whose invariants
are discovered by accident.

**A green test suite meant nothing, three separate times.** Every defect the queue work produced passed
the full suite. Worse, three tests passed while the exact behaviour they were named for was broken: a
teardown test whose `pending` was already empty, an ordering test asserting `step.next` at the queue
level while the caller overrode it, and a stand-down test that could not see the caller ignoring the
flag. The habit that actually worked was breaking the line under test and confirming the test goes red
before believing it. That should be routine here, not a reaction to being burned.

**Every fix in this area spawned its own successor.** Four rounds on "who takes the sound", and each
patch was correct where it landed and wrong one layer out. The pattern only broke when the decision
moved INTO `sound()`. The tell, in hindsight, was that each fix was a question asked by a caller about
state it did not own - and by the time an autoplay request is ready, no caller is left to ask.

**A redundant guard is not free.** The `step.next` guard was added as insurance and became the wedge:
`advance` installs the head before returning it, so declining to speak stranded an entry forever. Once
an invariant lives inside a unit, an outside check that can REFUSE is a liability, not a belt to the
braces.

**A stale doc count survived nine rounds.** The plan's own as-built preamble claimed 19 tests while the
suite held 37, and it took an audit agent to notice. Counts in prose go stale the moment they are
written; the plan now says where to look instead of restating the number.
