# Android Status Board (UX v3)

Follow-up to `android-dashboard-redesign.md`. The thread renderer is good; the Sessions
screen is a contact list pretending to be a dashboard, and the send/wake feedback loop is
unwired. This plan turns Sessions into a real status board, gives the thread screen an
identity and a pulse, and replaces the ACTION_VIEW chooser with an in-app viewer.

Approved direction (user, 2026-06-11): "UX plan sounds like a hit." Big swings welcome;
this is a personal app, keep it lean. Fix obvious security issues; no enterprise pass.

## Verified current state (recon, all file:line checked)

- The wake path is already correct: phone send to an offline catalog team triggers
  `tryWakeTeam` -> host `devcontainer up` + persistent Claude channel daemon in tmux
  (`routes.ts:256-265`, `hostWakeListener.ts:191-204`). The phone thread is the
  deterministic `conv:<phoneConvId>:<team>` key. No random IDs on this path.
- REAL BUG (user hit this): the phone's CLI-mode rejection only checks ONLINE teams
  (`phoneHandler.ts:225-234`). A sleeping CLI team slips through, wakes, registers
  CLI-mode, and `routes.send` falls into the CLI branch generating
  `sessionId = crypto.randomUUID()` (`routes.ts:333-334`). A phone send must never land
  in the CLI random-uuid branch.
- The wire already says `status: "available"` for wakeable catalog teams
  (`routes.ts:209-212`); the app discards it and renders any non-online as "offline"
  (`MainActivity.kt:371,393`). Available teams have no `mode`, so an EMPTY chip renders.
- Loose host windows register under random 6-hex team ids by design (`mcp/index.ts:50`).
  That is the `2fb1f8` card; it currently sorts above real projects (list is raw wire
  order, never sorted - `ChatRepository.kt:50-55`).
- Team kind is not on the wire, but `offlineCatalog`/`knownTeamPaths` membership is a
  precise devcontainer predicate already in scope in `routes.teams()` (`routes.ts:192-214`).
  `offlineCatalog` clears when the host daemon disconnects; `knownTeamPaths` never clears
  and is the durable fallback (needs adding to RoutesDeps).
- Interim `running` replies already reach the phone mailbox with a `status` field
  (`phonePeer.ts:66-79`, `phone-protocol.ts` MailboxEntry.status); `PhoneClient.poll`
  drops the field; `Message` has no status; `thread.js:160-165` already has a styled
  running/error badge sitting as dead code. Both ends exist, middle unwired.
- Cold wakes exceed the 25s relay bound (`SEND_BOUND_MS`, `phoneHandler.ts:52`), the op
  returns `{status: "running"}`, and the app shows nothing for the minutes the container
  boots. Correct behavior, zero feedback.
- `queue_depth` is parsed by the app and never rendered.
- Rename is a local display label only (`repo.setLabel`); offered for every team via the
  thread top bar. Forget lives inside the same dialog, no confirmation.
- Attachment taps: `thread.js` -> JS bridge rel path -> `Attachments.resolve` (traversal
  guard) -> FileProvider -> ACTION_VIEW chooser. Files are app-private under
  `filesDir/attachments`, so an in-app viewer needs no FileProvider. The renderer pool is
  App-scoped (`MainActivity.kt:109`), so the tap callback can flip Compose state.

## P1 - Wire: kind, status fidelity, sleeping-CLI fix

- Add `kind: "devcontainer" | "loose"` to `TeamInfo` (`shared/types.ts`) and compute it in
  `routes.teams()`: catalog/knownTeamPaths membership = devcontainer; everything else
  loose. Add `knownTeamPaths` to RoutesDeps as the durable fallback. Catalog-only
  ("available") entries are devcontainer by construction. The phone gets the field for
  free (`list_teams` re-serializes `routes.teams()`).
- Close the sleeping-CLI hole: a phone-originated send must get a clean, descriptive
  error instead of the CLI random-uuid branch, even when the CLI team was asleep at
  pre-check time. Cleanest shape: phoneHandler passes a `channelOnly` marker into
  `routes.send` (or post-wake mode check before the CLI branch) - implementer's call,
  but the invariant is: no `crypto.randomUUID()` session ever reaches a phone mailbox.
- Android `PhoneClient`: parse `kind`, carry wire `status` verbatim ("online" |
  "available"), parse mailbox `status` into the Kotlin `MailboxEntry`/`Message`.
- Tests: teams() kind flags (online devcontainer, online loose, catalog-only); phone
  send to a sleeping CLI team -> clean error, no uuid session in the mailbox; status
  field survives PhoneClient parse (repository-level test if practical).

## P2 - Sessions: a real status board

- Two sections: **Projects** (kind=devcontainer) first, then **Windows** (loose),
  visually quieter. Quiet all-caps section labels. Demo card (debug only) sinks to the
  bottom.
- Within each section: live first, then the rest; sorted by lastActivity desc, then name.
- Vocabulary: wire "online" -> `live`; wire "available" -> `available` (wakeable);
  loose team that is gone -> `ended` (it cannot be woken; "available" would be a lie).
  Never render an empty mode chip. CLI teams (visible, un-chattable) get a muted `cli`
  marker and a disabled/explanatory card rather than a dead-end send error.
- Working indicator: `queue_depth > 0` or an in-flight/running thread state shows a
  `working...` chip (this is the dashboard's whole point: glanceable "what is everyone
  doing").
- Unread badge stays. Snippet + relative time stay. Card layout freeform to the
  implementing agents - lap against the emulator until it reads as a status board, both
  themes.
- Rename: devcontainers NOT renameable (the name is the project). Loose windows
  renameable (local label). Move rename/forget to a long-press sheet on the card and an
  overflow menu in the thread; forget gets a confirm.

## P3 - Thread screen: identity and a pulse

- Top bar: status presence (live / available / waking / working) next to the title;
  replace the Rename/Close text-button soup with an overflow menu (rename only for
  loose teams).
- Empty state for a fresh thread: who this is, and for available teams "Sending will
  wake <team> - first boot can take a minute or two."
- Wire the running badge end to end: `Message.status` -> `ThreadRenderer.toJson` emits
  `status` -> the existing `thread.js` badge renders running/error. Interim running
  replies should read as progress, not final answers.
- Trap (P1 red team): `ChatRepository`'s poll loop only appends entries with a non-empty
  body or files, so a status-only interim reply is dropped. Relax that gate when wiring
  the badge.
- Cold-wake feedback: sending to an `available` team immediately shows a synthetic
  status row ("Waking <team>...") that resolves when the first real reply or status
  change arrives. Implementation shape freeform.
- Send states on the local echo: pending until the op returns; failure -> error badge +
  tap-to-retry. No silent "send failed" buried under the WebView.
- Demo fixture: extend with a running-status message and an error-status message so the
  badge path is lappable offline.

## P4 - In-app attachment viewer

- Tap image/* -> fullscreen in-app overlay (Compose, BackHandler dismiss): decoded from
  the app-private file (guard absurd dimensions), with a bottom bar offering
  **Save to Downloads** (MediaStore.Downloads) and optionally share. Pinch-zoom is a
  nice-to-have, not a gate.
- Tap video/* -> fullscreen playback (VideoView is fine) with the same Save bar.
- Other files -> bottom sheet: filename, size, mime; actions Save to Downloads and
  "Open with..." (the existing chooser as fallback).
- JS bridge contract unchanged (rel path only); mime comes from `Message.files` or
  `contentResolver.getType`. Keep the traversal guard exactly as is.
- Demo fixture already has gallery images + file chips; add a video entry only if cheap
  (data-URI video is not; a tiny bundled asset or skip is fine - chooser fallback for
  video is acceptable if VideoView fights the lap budget).

## P5 - Audit lap + deploy

- `bun run lint`, `bun run test`, `:app:assembleDebug`, emulator laps on both themes:
  sections + vocabulary + working indicator, sleeping-CLI error path, wake feedback row,
  running badge, viewer (image fullscreen + save, file sheet).
- One live pass against the real bridge (provisioning blob injection via
  `provisioning_b64` intent extra works headlessly; real teams visible from the
  emulator).
- Version bump (3.8.0: `.claude-plugin/plugin.json` + `package.json`), push via
  auto-merge PR, CI refreshes the `android-app` release. Arbiter restart is user-owned.

### Deferred findings (P1 red team, out of scope here)

- `transfer_human_to` targeting a phone device name pushes a `channel_push` with a
  random-uuid brief session into the phone mailbox (pre-existing; the app tolerates it
  by falling back to the `from` field). Revisit if phones should ever receive DM
  transfers properly.
- `knownTeamPaths` never deletes entries, so a project removed from the host catalog
  keeps `kind: "devcontainer"` until arbiter restart. Accepted as the durability
  tradeoff; the catalog refresh corrects status on every host reconnect.

### Notes for implementers

- Personal app, ~10 MB. Lean passes; fix obvious security, skip enterprise ceremony.
- Visual phases (P2/P3/P4) are freeform: lap screenshot -> judge -> fix until it looks
  right in light and dark. The emulator harness: `source ~/android-dev/env.sh`, AVD
  `phone35`, `adb shell wm size 720x1600` + `wm density 280` for readable screenshots
  (reset after).
- Keep `ChannelFile`/TeamInfo shapes in lockstep with evie-bot expectations; `kind` and
  `status` are additive optional fields, so old phones keep working.
- Known limitation, explicitly out of scope: threads are local-only (no transcript
  backfill from the host). Do not build history sync in this plan.
