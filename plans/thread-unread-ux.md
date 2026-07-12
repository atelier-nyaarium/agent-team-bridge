# Thread open position + scroll-driven unread clearing

Status: READY TO IMPLEMENT. Refined through three audit laps (6+6+4 agents, all findings
code-verified). Lap 1 killed the epoch-ordering and IntersectionObserver models. Lap 2 killed lap
1's suppression predicate (visibility is the discriminator) and the pin-window receipt swallow.
Lap 3 tightened the new mechanisms (resume-backlog tagging, level-based notification
reconciliation, region-row-only reporting, payload boundary field). Q1-Q4 answered by the owner
("defaults fine"); D5-D7 are decided defaults flagged for veto. Phases A-D land as ONE unit. A
final pre-implementation confirmation pass found two real A-D gaps (now fixed: the reveal-trigger
effect is additive, not a replacement of the existing sync effect; the firstUnreadId payload needs
a wire-shape change) and confirmed Phase E - already flagged unaudited - has real gaps of its own
(recorded in Phase E's own "Known issues" list, to close in its dedicated refinement laps).
Phase E (cross-device read-index sync) is a SEPARATE follow-on landing appended at the owner's
request - scoped but NOT yet audited; it gets its own refinement laps before building.

## Questionaire

Owner's spec (2026-07-12, verbatim intent):

1. "When tapping on a chat, it opens to a message like 10 messages back. I have to scroll down
   every time. Make it snap to the first new message."
2. "Tapping on the message specific notification takes you to the chat and clears Unread counts.
   But navigating to chat without sometimes doesn't clear Unread counts. Make it decrement unread
   count when reaching the bottom of that message."
3. The worked example: "if 3 messages arrives, it should put me on 1st new message on tap.
   Scrolling to bottom of that message will set unread to 2. Scrolling down more, 1. Reach bottom,
   notification bar of new message and the unread count clears."
4. "I think you can use the journal index to keep track of what's read?" - confirmed viable with a
   correction: messages persist their mailbox journal coordinates (`epoch`, `seq`), but epochs are
   RANDOM equality-only tokens (device-mailbox.ts:60-67; seq restarts per instance; an idle mailbox
   is evicted after 1h and re-minted - routine overnight). So the anchor is an IDENTITY key
   resolved to its row by equality; everything else is positional. Side effect: unread counts now
   survive process death.

Decided questions (owner: "defaults fine", 2026-07-12):

- **Q1: one scroll-driven model for every open path. YES.** Open lands on the first unread, the
  count drains as you scroll, the bar notification clears at the bottom. Wholesale clear on open
  goes away everywhere.
- **Q2: "New messages" divider row. YES.** A STANDALONE sibling element inserted before the first
  unread row (never markup inside the row - the fingerprint re-push rebuilds rows via
  `replaceWith`, which would drop it). Idempotent: the divider carries a fixed id; a reveal removes
  any existing divider before inserting. The suppressed-hold path also inserts it.
- **Q3: notification swipe-away keeps marking fully read.** Requires markRead to also advance the
  persisted anchor, else the dismissed count resurrects on the next process restart.
- **Q4: sending while unread > 0 keeps the jump-to-bottom** (your own reply implies caught-up), and
  per the bottom-reached trigger it clears the remainder as read. Documented so verification does
  not file it as a regression.

New sub-decisions (recommended defaults - veto if wrong):

- **D5: a `sent` mirror from ANOTHER device does NOT clear this device's unread.** thread.js's
  `sentByUser` jump fires for any brand-new user row, but a desktop reply appends a fromMe row on
  the phone too (reconcileSent's else-branch). Scope the jump-and-clear to locally-originated rows
  (ship an `ownSend` flag on the row payload). Unread is per-device.
- **D6: keep `setAutoCancel(true)` on the burst notification.** Tapping a notification consumes
  that bar entry immediately (standard Android); it does NOT touch unread state or the anchor
  (verified: tap does not fire the deleteIntent). The reconciler governs every other path, and a
  tap-consumed notification is never re-posted mid-drain (presence-checked, below).
- **D7 (lap 3): on migration day, boot MAY dismiss a leftover bar notification** for a thread the
  one-shot seed marked fully read - the entry is desynced by definition (its team shows a 0
  badge). This replaces the unkeepable "boot cannot dismiss still-pending entries" promise; the
  level-based reconciler makes first-emission and steady-state one rule.

## Investigation findings (root causes, exact sites)

All console-side (Android app). No gateway or wire changes needed.

### Issue 1: opening a chat lands "10 messages back"

- The thread transcript is a WebView (`ThreadRenderer.kt` driving `assets/thread/thread.js`).
- `ThreadRenderer.sync()` (ThreadRenderer.kt:223) deliberately sends only the delta when a pooled
  renderer re-opens: "re-opening a thread keeps its scroll position and rendered DOM". New messages
  that arrived while the tab was backgrounded ride `appendMessages`, whose stick-to-bottom decision
  (`stick = nearBottom()`, thread.js:313) is evaluated on stale detached metrics, so it does not
  follow. Re-opening lands wherever you left off.
- Fresh opens call `setMessages` -> `scrollToBottom()` (thread.js:348). `content-visibility: auto`
  makes `scrollHeight` an estimate; async row growth (images, mermaid, highlight) can push the
  landing short. The existing `repin` fires only on viewport resize (thread.js:303-307), never on
  content growth.

### Issue 2: unread counts do not always clear

- `bumpUnread(team)` fires for every appended inbound message unconditionally
  (ChatRepository.kt:2739), including while that chat is open. Nothing clears it in that case.
- Unread is only cleared wholesale by `openThread()` (ChatRepository.kt:2868-2879) and by the
  notification swipe-away (`markRead`, NotificationReceiver.kt:25).
- The in-thread TAB SWITCH bypasses `openThread` entirely (`onGateway = { openTeam = it }`,
  MainActivity.kt:577). Switching to a tab with unread never clears it.
- The bar notification has THREE cancel paths today: the `LaunchedEffect(openTeam)` cancel
  (MainActivity.kt:361-363), SessionsScreen's onOpen direct call (MainActivity.kt:636), and
  `setAutoCancel(true)` on tap (SwitchboardService.kt:243). The first two are retired in Phase C;
  the third is kept per D6.

### Supporting facts

- `Message.id` is a per-thread monotonic Long assigned at append (max+1, ChatRepository.kt:3064);
  ids never renumber in-process (folds preserve them) but ARE renumbered on restart. A row id is a
  process-lifetime handle; the durable anchor is the (epoch, seq) identity.
- **Order durability**: `loadPersistedThreads` re-sorts by `at` (ChatRepository.kt:3245), which
  reorders the placeholder-fold inversion case and is wrong under cross-gateway clock skew. Phase
  A removes the re-sort UNCONDITIONALLY - the multi-raw-key merge it served is unreachable since
  the address-grammar migration (isAddressKey drops non-canonical keys and canonicalKey == rawKey,
  ChatRepository.kt:3197-3198). Persisted order is the live arrival order; only the dense id
  re-assignment remains. This makes "positioned after the anchor row" stable across restart.
- Rows with seq == 0 exist (local pending echoes until their `sent` mirror folds coordinates in,
  the "waking" placeholder, legacy rows) and never count toward unread. Two folds legitimately
  REWRITE a row's `at` in place (the sent-echo reconcile and the waking fold) - which is why
  receipts report region rows only (below), whose `at` never mutates.
- Unread is NOT persisted today. The new model rebuilds it from the persisted anchors at startup.
- Bridge methods run on the WebView's JavaBridge thread and hop via `webView.post`
  (ThreadRenderer.kt:153-173). Pool-level callbacks are team-bound at `pool.get()` time
  (ThreadRendererPool.kt:49).
- `repo.isVisible` (@Volatile, onForeground/onBackground) is the visibility signal - BUT
  `onForeground()` sets it true and THEN kicks the poll, so the away-backlog drains tagged visible
  unless corrected (the `resumeBacklogPending` rule, Phase B).
- The status notification's total-unread line reads `state.unread` reactively
  (SwitchboardService.kt:109-120); the existing collector projects a SUM, so per-team duties need
  the map in the projection (Phase A wiring).

## Plan

Phases A-D are a SINGLE landing unit (one PR): A's payload fields ship on sync payloads that B
defines, and A-without-C would let openThread's surviving wholesale clear desync the anchor from
the count. The phase labels are build order, not independent landings.

### Phase A: read anchor + scroll-driven read receipts

**Anchor model (identity, positional - never ordinal):**

- Persist per team: `readUpTo {epoch, seq, at}` (the `at` is diagnostics only; the id-reuse guard
  uses the report's own data-at against the live row - see Kotlin wiring). New
  `saveReadAnchors`/`loadReadAnchors` JSON map in AppStateStore beside drafts/labels, keyed by
  canonical address, `isAddressKey`-filtered on load. The pref literal (`"read_anchors"`) joins
  BOTH `SCHEMA_WIPE_KEYS` and `PROVISIONING_KEYS`; both pinning tests (`SchemaMigrationWipeTest`,
  `ClearProvisioningPartitionTest`) get it in their mustWipe lists. No `CURRENT_SCHEMA_VERSION`
  bump.
- The anchor map lives in `ChatState` (never a side MutableMap), so every recompute sees threads +
  anchor as one atomic snapshot. When one state transition changes BOTH threads and anchors, they
  persist in a SINGLE SharedPreferences edit() batch (one store method writing both); anchor-only
  transitions write alone safely.
- Resolve the anchor to a row by exact (epoch, seq) EQUALITY. Unread = count of inbound rows
  (seq > 0) positioned AFTER that index, in the (now durable) list order.
- **Missing-anchor semantics, two distinct cases:**
  - The runtime derivation with NO anchor entry counts ALL inbound seq > 0 rows as unread - a
    brand-new team's first message badges immediately.
  - A ONE-SHOT startup migration (first run after the update) writes a seed anchor at each
    EXISTING thread's last inbound seq > 0 row. Per D7, a leftover bar notification for a
    seed-zeroed team is dismissed by the reconciler on first emission - accepted.
  - Anchor entry exists but its row is gone: treat as index -1 (everything counts), and receipts
    ALWAYS advance when the current anchor is unresolvable - no deadlock.
- Monotonicity is POSITIONAL: a receipt advances the anchor only when the newly resolved row index
  is greater than the current anchor row's index (unresolvable current anchor = index -1).
- **Single-writer unread:** `bumpUnread`'s increment is REPLACED by the same pure recompute, run
  inside the same `_state.update` that appends the row. Every writer (append, receipt, markRead,
  startup rebuild) converges on one derivation function. Side effects stay OUTSIDE `_state.update`
  lambdas (CAS retries re-execute them).
- `markRead(team)` (swipe-away) also advances the persisted anchor to the thread's LAST inbound
  seq > 0 row by list position. The stale NotificationReceiver doc comment is updated.
- `forget(team)` drops the team's anchor entry AND re-anchors any OTHER thread whose anchor row
  the cross-thread peer sweep removed (re-anchor to the nearest surviving inbound row
  at-or-before, by list order). `clearAll`/re-provision wipes the map.
- Startup rebuilds `unread` from persisted threads + anchors.

**Payload fields (messagesToJson, shipped on EVERY sync):**

- Per-row `counts` flag: pure eligibility (inbound && seq > 0), never anchor-dependent.
- Per-row `ownSend` flag (D5): true only for the locally-originated optimistic append.
- Per-row `arrivedVisible` flag: process-transient (never persisted - loaded rows only reach a
  renderer through setMessages paths whose hold decision is anchor-derived, so post-death
  suppression rests on the anchor, not the tag). Tagging rule in Phase B.
- Top-level `firstUnreadId` (nullable): the boundary, computed from the anchor in the same
  ChatState snapshot. This - not the `counts` flags - is what setMessages and the reveal read as
  the snap/hold position, so crash-recovery and shrink rebuilds land at the true first unread, and
  "empty region / null boundary when unread == 0" is well-defined.
- **Wire-shape change** (mechanical but real): `messagesToJson`'s payload is a bare `JSONArray`
  today, sent verbatim via `eval("window.thread.setMessages(${toJson(messages)})")`
  (ThreadRenderer.kt:223-232), and thread.js's `setMessages`/`appendMessages` iterate it directly
  as an array. A genuinely top-level field requires wrapping: the payload becomes
  `{messages: [...], firstUnreadId}`, and both JS entrypoints' signatures update to destructure it.

**Read trigger (scroll-driven pointer - NOT an IntersectionObserver):**

- IO fires only at threshold crossings; no threshold coincides with "a tall row's bottom edge
  enters the viewport", and the final rows never exit the viewport. thread.js keeps a monotonic
  NEXT-UNREAD pointer, tracked by `data-id` (never element identity; a pointer id with no matching
  DOM row is skipped without a receipt).
- **Region membership**: rows with `counts` true. The appendChild branch extends it for genuinely
  new eligible rows; the replaceWith branch joins a row whose flag TRANSITIONED to eligible (the
  waking-placeholder resolution arrives as an id-repeat - without this the badge strands at 1 on
  every cold wake). A reveal's shipped region applies as a UNION (never removes ids); the pointer,
  when unset or exhausted, adopts the first region row positioned after its last-passed DOM
  position, never an earlier one. A re-push of an already-passed row never re-extends.
- **Walk events** - while the pointer row's `getBoundingClientRect().bottom <= window.innerHeight`,
  advance: (1) the passive scroll listener, debounced to scroll-settle; (2) the resize repin; (3)
  appendMessages (new-row branch only); (4) PIN RELEASE - when any programmatic scroll's pinning
  window closes, run one walk. Pin-release IS the "once after the open snap" event: it runs a full
  rendering step after the jump, so content-visibility relevancy has updated and rects are real.
  It also covers the at-bottom follow, Q4's send-jump, and threads shorter than the viewport (no
  scroll events at all). (5) The resume walk (visibility transition, below).
- **Suppression, evaluated at WALK time**: while `pinning` is true, the walk is deferred to pin
  release. While the app is NOT VISIBLE, the WALK ITSELF is suppressed (pointer advance included,
  not just reporting - an invisible-time mermaid/image settle must not consume unread rows that a
  deferred report would credit on resume). Transport: `ThreadRenderer.setVisible(boolean)` evals
  pushed to every pooled renderer from onForeground/onBackground (independent of sync payloads);
  the true-transition also schedules ONE walk - this is the resume walk, ordered after any reveal
  already queued by the same resume (same eval queue). The Phase D ResizeObserver walk obeys the
  same gates.
- **Reporting**: the debounced settle report names the LAST-PASSED REGION ROW ONLY (id + data-at).
  Region rows' `at` never mutates in place (the seq-dedup fold redelivers identical coordinates),
  so the at-guard cannot false-positive; reporting the raw bottom row would race the sent-echo and
  waking folds, which rewrite `at`, and a dropped report would strand the Q4 flow. The accumulator
  is module-level (survives setMessages rebuilds); `Android.readUpTo(id, at)`.

**Kotlin wiring (named seams):**

- Bridge posts to main via `webView.post`; `ThreadRenderer.onReadUpTo`; `ThreadRendererPool.get()`
  forwards TEAM-BOUND. A late receipt after a tab switch credits the right thread.
- `ChatRepository.readUpTo(team, rowId, at)`: drop if no row with that id, or the row's `at`
  mismatches (forget can free an id for reuse; the residual same-millisecond collision is accepted
  - bounded, self-heals). Otherwise the anchor becomes the max-index inbound seq > 0 row AT OR
  BEFORE the reported row's index (walk-back stays as pure defense).
- **Notification reconciler (replaces both the cancel-on-open sites and any repo callback):**
  SwitchboardService's state collector gains the PER-TEAM unread map in its keyed projection (the
  current sum-only Triple cannot drive per-team duties), runs under `collect` (not collectLatest),
  and reconciles LEVEL-BASED per emission: for each team, "showing" = NotificationManager
  `.activeNotifications` contains `teamNotificationId(team)`; cancel iff showing && unread ==
  0/absent; silently refresh (`setOnlyAlertOnce`) iff showing && unread > 0 && shown count
  differs. Presence-checked means: a tap-consumed entry (D6) is gone and never re-posted; a
  never-posted team (visible-arrival, Close-Tab-muted) never gains a phantom entry; a process
  restart converges the shade on first emission (D7). The refresh shares ONE builder with
  notifyBurst, fed from the state snapshot (preview lines + Play actions derive from the team's
  trailing unread rows), so a mid-drain refresh does not degrade the notification.

### Phase B: snap to first unread on open

- First-unread derivation (one definition): the first inbound seq > 0 row positioned after the
  resolved anchor row; thread start when no anchor entry resolves. Shipped as `firstUnreadId`.
- One JS entrypoint: `revealFirstUnread(idOrNull)`, always shipping the current region (UNION
  merge). `null` skips only the scroll. Pending debounced receipts are flushed FIRST via a
  callback-chained eval - the reveal computation runs inside `evaluateJavascript`'s result
  callback for `flushReadUpTo()` (the JS flush synchronously enters the bridge, whose
  `webView.post` lands the receipt on main BEFORE the result callback, so the anchor is current
  when the reveal computes).
- **Reveal trigger**: ADDS a SECOND, separate LaunchedEffect inside ThreadWebView (the chat-view
  branch - placement is load-bearing), keyed on `(team, renderer, openNonce)`. The EXISTING
  `LaunchedEffect(renderer, messages) { renderer.sync(messages) }` (MainActivity.kt:2757) STAYS
  UNCHANGED for ongoing delta-sync on every message-list change - this is not a replacement, and
  the two effects coexist. The new effect calls `renderer.sync(messages)` again (a no-op per
  renderedCount, since the first effect already ran it) then evals the reveal (the eval queue
  guarantees the row exists). Composition RE-ENTRY is itself a reveal trigger (LaunchedEffect
  relaunches on re-entry regardless of keys) - this covers terminal-mode toggle-off,
  settings/manage dismissal, and any surface that unmounts the WebView. `openNonce` is bumped by
  the notification-tap LaunchedEffect, SessionsScreen onOpen, and tab-switch onGateway GUARDED by
  `t != openTeam` (tapping the active tab stays a no-op) - so a notification tap on the
  already-composed thread re-fires the reveal. Ordinary messages-change never re-issues the reveal
  (only the first, unchanged effect reacts to it) - the transcript keeps syncing live either way.
- The reveal's scroll runs inside a pinning window and latches `stuck = false` when positioning
  away from the bottom. The pin-release walk performs the initial visibility check (a burst fully
  visible at the snap is read immediately BY DESIGN - bottom-visible IS the trigger).
- The divider (Q2) inserts at reveal time and on the suppressed-hold path, idempotently.
- Renderer crash recovery AND sync()'s shrink-rebuild path (forget's cross-thread peer sweep can
  shrink an OPEN thread) reuse the same rule: setMessages reads `firstUnreadId` from its payload -
  snap/hold there when non-null (with `stuck = false`), bottom when null. Never an unconditional
  scrollToBottom.
- **Arrival suppression - visibility, with the resume-backlog correction**: Kotlin tags each
  appended row `arrivedVisible = repo.isVisible && !resumeBacklogPending`, where
  `resumeBacklogPending` is set by `onForeground()` alongside `visible = true` and cleared after
  the first COMPLETED drain pass post-foreground. Without it, the foreground transition front-runs
  the resume-kicked drain and the entire away-backlog would tag visible (onForeground sets the
  flag then kicks the poll - fail-unsafe silent auto-read; with the correction, a genuinely-live
  message in that first pass gets a false HOLD, the fail-safe direction, one scroll from read).
  `appendMessages` suppresses the stick auto-follow iff the batch's NEW rows (appendChild branch
  only) include an unread-eligible row with `arrivedVisible == false` (hold position, insert the
  divider). A visible-at-bottom arrival follows as today; the pin-release walk reads it.
  `sentByUser` follow applies only to `ownSend` rows (D5).

### Phase C: retire wholesale clearing; unify the open paths

- `openThread()` stops clearing unread. Tab switch, board open, and notification tap converge on
  the receipts model (plus the openNonce reveal re-fire).
- BOTH explicit cancel-on-open sites are retired (MainActivity.kt:361-363 and :636). The
  reconciler (Phase A) is the only programmatic cancel; `setAutoCancel(true)` stays (D6).
- Notification swipe-away `markRead` stays, now anchor-advancing (Q3).
- Terminal-mode opens never compose the chat WebView, so no receipts fire there: the badge holds
  until the user toggles to the chat view - and the toggle IS a reveal trigger (composition
  re-entry), so the toggle lands held at first unread rather than auto-reading.
- Sitting at the bottom of an open, VISIBLE chat when a message arrives: tagged arrived-visible,
  no suppression, auto-follow lands its bottom in view, the pin-release walk reports it - a
  momentary badge blip at most.

### Phase D: re-pin against async content growth

- One ResizeObserver on the transcript container, three duties under the same pinning/visibility
  gates: (1) while `stuck`, re-run `repin()` (load-bearing for Phase C's at-bottom claim); (2)
  while SNAPPED (from reveal until released), re-run the first-unread scroll; (3) in all states,
  run the pointer walk (content shrink pulls bottoms into view eventlessly - but never while
  invisible, per the walk suppression).
- The snapped state releases on first user INPUT (touchstart/pointerdown/wheel/keydown), NEVER on
  a scroll event. Every snapped re-pin scroll rides a pinning window. Set `overflow-anchor: none`
  on the scroller so the custom re-pin is the ONE growth-compensation mechanism.

### Phase E: cross-device read-index sync (SEPARATE follow-on landing, not part of the A-D PR)

Depends on A-D being shipped. A-D makes the read anchor `(epoch, seq)`, which is the SYNC PAYLOAD
for free: it is the mailbox's own journal coordinate, and all of an owner's devices drain ONE
`DeviceMailbox` keyed by `ownerKeyId` (each device is a `consumerId` cursor within it,
device-mailbox.ts:399-406). So the coordinate means the same thing on every device with NO
per-device translation - the whole reason this is cheap. Not adversarially audited yet; this is
the scoped shape, to be run through its own plan-refinement laps before building.

**Known issues (found by the pre-implementation confirmation pass, NOT yet resolved - Phase E's
own refinement laps must close these before it is buildable):**

- The multi-gateway fan-out this Tier explicitly targets is UNDERSPECIFIED for BOTH wire-shape
  options: `fanOutConsolePush`'s relay validates against `FederatedOpSchema`'s `console_push`
  variant in `federation-protocol.ts`, a SEPARATE hand-maintained schema whose `entry.kind` enum
  is a hardcoded subset (`["notice","peer","plugin_action"]`) - NOT derived from
  `MailboxEntrySchema`. A dedicated `read_receipt` kind needs adding to BOTH schemas, not just
  `schemas.ts:487` as currently written; reusing `plugin_action` needs `{team, epoch, seq}` packed
  inside its existing `payload` field, since new top-level fields on that entry object are
  silently STRIPPED (verified against the live zod schema) rather than validated or rejected.
- The "clean ordering invariant" (a receipt always arrives after the rows it acknowledges) holds
  ONLY within one `DeviceMailbox` instance. Across the cross-gateway fan-out, a message's own
  relay and its later receipt's relay are two independent fire-and-forget `relayWithRetry` calls
  with no ordering guarantee between them - a receiving gateway can see the receipt before the
  rows it names. No resolution path is defined for an incoming `(epoch, seq)` that has not
  arrived yet (distinct from Phase A's LOCAL unresolvable-row handling, which does not apply to
  this incoming-cross-device case).
- Self-exclusion is mis-specified: the mirrorPeer analogy does not transfer (mirrorPeer skips
  composing an entry at all for a console sender; a `mark_read` op IS always console-originated,
  so the same gate would block it for every device, not just the sender). Real self-exclusion
  needs a sender-identifying field on the entry (following the `sent` kind's existing `opId`
  convention) and NEW client-side logic on drain to skip the fold when it matches - nothing like
  this exists today. Non-blocking in the sense that Phase A's positional-monotonicity guard makes
  a missed self-exclusion a harmless no-op, but the mechanism as described does not work.
- Minor: the Tier-2 `readAnchors` register-reply field codegens fine but decodes to an opaque
  Kotlin `JsonObject` (like `payload` already does for `plugin_action`) - the per-team epoch/seq
  must be hand-unpacked client-side; not a blocker, just undocumented follow-on work.

**Tier 1 - live convergence (both devices online):**

- New console op `mark_read {team, epoch, seq}` (a `kind` on `ConsoleOpSchema`, schemas.ts:203;
  codegen'd to Kotlin). A device POSTs it whenever its local `readUpTo` advances the anchor
  (Phase A), debounced with the existing receipt.
- The gateway lands a `read_receipt` entry in the owner's shared inbox through the EXISTING
  `landMailboxEntry` + `fanOutConsolePush` path (routes.ts:311-417 - the same rails `mirrorPeer`,
  `humanNotify`, and `pluginAction` ride, so it also reaches the owner's OTHER route-gateways).
  Add `"read_receipt"` to the `MailboxEntrySchema` kind enum (schemas.ts:487; codegen'd) carrying
  `{team, epoch, seq}`; OR ride the existing `plugin_action` kind with a first-party `read-sync`
  pluginId to avoid a new wire kind (decide at refinement - a dedicated kind is clearer, reusing
  plugin_action is zero-schema-churn).
- The originating device is SELF-EXCLUDED (tag the entry with the sender's `consumerId` /
  conversationId; the sender ignores its own receipt on drain, exactly as `mirrorPeer` never fires
  for a console sender).
- Every OTHER device drains it (shared inbox, per-consumer cursor) and folds `(epoch, seq)` into
  its LOCAL anchor with the SAME positional monotonic rule Phase A already has (the anchor only
  advances; resolve by equality, count positionally). It dispatches like a `plugin_action` - a
  command, never a rendered chat row - through `ChatRepository`'s drain, with the mandatory
  idempotency contract that kind already requires.
- **Clean ordering invariant (why Tier 1 needs no "row not yet arrived" handling):** the receipt
  entry is appended AFTER the messages it acknowledges, so any device that drains the receipt has
  necessarily already drained every row up to that `(epoch, seq)` - the anchor always resolves.
- Convergence, not a distributed-lock problem: two devices reading concurrently each emit a
  receipt; each other device advances its anchor monotonically; the highest position wins and the
  lower one is a no-op (Phase A's positional-monotonicity guard).

**Tier 2 - fresh device / offline > 1h catch-up (the real cost):**

- The shared inbox is evicted after 1h idle (DEFAULT_TTL_MS) and under LRU pressure, taking its
  entries with it - so a device away past that window, or a newly enrolled one, never sees the
  live receipt. This is the case that needs DURABLE server-side state.
- Add a small gateway store: a per-`ownerKeyId` map `team -> {epoch, seq}` (mirrors `SessionStore`
  in shape - durable, swept, persisted on the state tick). `mark_read` writes it (in addition to
  landing the Tier-1 entry) with epoch-aware last-writer-highest-seq-wins: the gateway owns the
  CURRENT inbox epoch, so a receipt naming the current epoch advances by max(seq), and a
  stale-epoch receipt is dropped (an epoch flip means the acknowledged mail is gone anyway).
- Hand the current read state to a device at register: add a `readAnchors` field to
  `ConsoleRegisterResultSchema` (schemas.ts:550; codegen'd), so a fresh install / re-enroll seeds
  its local anchors from the server before its first poll. On receipt, a device folds each
  `(epoch, seq)` with the same monotonic rule (never regresses a locally-newer anchor).

**Costs:** one new codegen'd wire kind (or reuse plugin_action), one new codegen'd op, a durable
per-owner gateway store + register-reply plumbing, and the Phase-A anchor writer now also emits a
`mark_read`. Everything rides existing rails; nothing new in the transport, trust, or fan-out
layers.

**Tests / verification (Phase E only, run at its own build time):** gateway-side unit tests for
the durable store's epoch-aware last-writer-wins (current-epoch advance, stale-epoch drop, LRU/TTL
sweep); the self-exclusion (a device's own receipt is a no-op on its own drain); the ordering
invariant (a receipt's seq always exceeds the rows it acknowledges). On-device: read on phone,
confirm the desktop badge drains within a poll cycle; a fresh install seeds read state at register;
two devices reading different amounts converge to the higher.

### Tests (pure-function pattern - the codebase has no Robolectric/mocks)

Each derivation is a top-level internal function over `ChatState`/`List<Message>`:

- Anchor resolution + unread recompute: cross-epoch identity (new random epoch numerically smaller
  than the anchor's), the placeholder-fold inversion (placeholder -> peer row -> fold; readUpTo of
  the bottom REGION row yields 0) INCLUDING a simulated persist/reload with NO re-sort (order and
  count survive), the missing-anchor-entry case (fresh team's first message badges 1), the
  unresolvable-anchor-row case (index -1, receipts still advance), and POSITIONAL-MONOTONICITY
  REGRESSION (a receipt at index j < anchor index k leaves anchor and unread unchanged; duplicate
  re-report of k is a no-op).
- readUpTo report validation: absent row id dropped; id present but `at` mismatched dropped.
- First-unread derivation with an interleaved fromMe echo.
- openThread's fold no longer touching unread; markRead advancing the anchor (swipe-away then
  simulated restart yields 0); forget dropping the anchor entry AND re-anchoring a sibling thread
  whose anchor row the peer sweep removed.
- The one-shot migration seed (existing threads get tail anchors; a post-migration team gets none
  and counts all).
- `SchemaMigrationWipeTest` + `ClearProvisioningPartitionTest` mustWipe lists gain
  `"read_anchors"`.

thread.js has no JS test harness; the JS additions stay small, behavior-verified on the debug APK
with DebugLog lines on the bridge callback.

### Verification (debug APK, per /debug discipline)

Fixture note: steps 2-4 need messages TALLER than the viewport (short bursts that fit on one
screen are read at landing BY DESIGN). Step 1's team must not be muted (a Close-Tab'd team
suppresses its banner, vacuously passing notification assertions).

1. Send 3 tall messages to a non-muted chat that is not on screen.
2. Tap the chat from the board: lands on message 1 with the divider, badge 3, bar notification
   STILL PRESENT (the second cancel site is the regression canary).
3. Scroll past message 1's bottom: badge 2 (observe on the status-notification line live, or the
   board badge after backing out); past 2: badge 1; reach bottom: badge clears AND the bar
   notification disappears. During the drain the team notification keeps its preview lines and
   Play actions with the corrected count.
4. Same flow via in-thread tab switch. Via notification tap: the tapped entry self-dismisses (D6)
   and does NOT reappear during the drain (presence-checked refresh), badge still 3, snap + drain
   per steps 2-3. Repeat the tap with the thread ALREADY open and scrolled mid-history: must
   re-snap to first unread (the openNonce canary).
5. A brand-new session's first inbound message badges 1 (missing-anchor semantics).
6. Open chat sitting at bottom, VISIBLE: new inbound message follows + instant read, including one
   with images/mermaid (growth re-pin). Then background the app, receive 3 messages, and return
   BOTH ways: (a) quickly, before any background poll drained them (the resume-kicked drain path -
   the resumeBacklogPending canary), and (b) after the notification appeared (background-drain
   path). Both returns, via app switcher AND via notification tap: held at first unread, badge 3,
   divider present.
7. Process kill + relaunch with a nonzero anchor gap: badge and status-line show the rebuilt
   count; swipe-away then relaunch shows 0.
8. With the thread open in TERMINAL mode, receive 2 tall messages, toggle to chat view: lands held
   at first unread with divider and badge intact (composition re-entry reveal).
9. 3 tall unread where rows just above the divider contain mermaid/images: the divider holds while
   they render (snapped re-pin) and does not fight the first user scroll.
10. Unread == 0 re-open keeps old scroll position; fresh open lands pinned at the true bottom even
    with images/mermaid in the tail.
11. Reply from a SECOND device while this device has unread (D5): this device does not jump or
    clear; reply locally with unread remaining (Q4): jumps to bottom and clears.
