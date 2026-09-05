# Console

The Android console reaches the Router through signed OwnerOps.

## OwnerOps

`ConsoleClient` sends protocol version 3 operations with one `conversationId` and `opId`.

**The version is a documented floor, not a negotiated one.** No console sends it and no gateway
checks it. Adding a wire field stays optional and degrades field by field. Removing an accepted kind
is not additive: it bumps `CONSOLE_PROTOCOL_VERSION`, this file records what went, and a console
built before the bump gets the gateway's existing "not allowed" refusal until it updates. A kind
that must keep working for one more console build goes into `TOLERATED_DELIVERY_OP_KINDS` with a
`Remove-by` line instead.

- 3: removed the nine `board_*` delivery kinds (the board lives on the Router) and `peek` as a
  delivery op (it is a value op).

- `deliver` carries a `console_op` row. Delivery kinds are `DELIVERY_OP_KINDS` in
  `src/shared/schemasConsoleOp.ts`. The answer is an `op_result` row sealed under
  `opResultAadKind`.
- `gateway_value` carries a VALUE kind from `VALUE_OP_KINDS`. The Router forwards it as a
  `value_op` frame. The answer is sealed under `valueResultAadKind`. Results use typed `unreachable`
  or `timeout` outcomes.
- Other OwnerOps are `consumer_register`, `inbox_read`, `inbox_advance`, `planes_read`, `report_read`,
  and `capabilities_report`. Sharing a session with a friend Domain posts `cross_domain_share` to the
  Router first, then the Gateway's `cross_domain_share` value op; unsharing posts both in the same
  order.
- The phone socket uses `ConsoleSocketMode.INBOX`.
- `PollDrain.drainTick` calls `inbox_read` and `planes_read`. It sends one `inbox_advance` after
  rows drain.
- `OwnerOps` signs every op from its injected identity, clock, nonce, and op id. The bodies of
  `report_read`, `capabilities_report`, and a scheduled send come from the pure composers
  `composeReportRead`, `composeCapabilitiesReport`, and `composeScheduledSend`.

**Identity:** `PhoneIdentity` is the one door for identity facts (the provisioning blob, the
Domain id, the owner identity, the Domain snapshot, the content keys, the admission latches). Each
write is serialized and re-assembles `PhoneBootstrap`, published as `bootState`; `Ready` carries
the provisioning, the console identity, the owner sign pub, the Domain id, and the content keyring.
The Domain id is the stored one, else an invite's pending tenant. A fact a connect learns names the
blob it was learned for, and a later blob refuses it. The boot's `ContentKeyring` is the key
authority of its generation; a replaced boot refuses a late install. `phone-identity-residue`
fences the store setters and the FederationManager's writes to the door. `PhoneAmbient` carries the
clock, nonces, op ids, wrap entropy, and the missing-epoch timer.

**Repository seams:** `OwnerOps`, `KeyDeliveryOps`, `ConsoleClient`, `BoardSealing`, and
`CursorTranslationOps` take the boot and the ambient. `PollDrain`, `SessionOps`, `PresenceOps`, and
`RenameOps` take one host interface each (`DrainHost`, `SessionHost`, `PresenceHost`, `RenameHost`).
The nine other ops classes take the role ports (`ClientPort`, `IdentityPort`, `PresencePort`,
`PlaybackPort`) plus a per-class collaborator record, adapted in `RepositoryCollaborators.kt`, so a
JVM test constructs them over shared fakes. `DrainGate` is the repository's one re-entrant drain
mutex. Sealing takes an entropy hook (`Crypto.seal`, `ContentKeyring.wrapFor`,
`KeyDeliveryOps.wrapEntropy`, `PhoneAmbient.newNonceBytes`); a null hook draws from `SecureRandom`.

`homeGatewayId` selects the phone's home Gateway from the admitted gateways. Phone-bound rows are
appended by the Gateway through `deliverToOwner`. `src/gateway/consolePushOps.ts` owns the durable
`OwnerRowOutbox` for disconnected or uncertain appends.

Protocol-1 gateways receive `unsupported` for value and delivery ops.

## Add Device

The device signs `approvalId`, `nonce`, `newSignPub`, and `newBoxPub`. The held device refuses an unsigned or mis-signed join before admission or key sealing.

The install writes the transport, the latches, the Domain snapshot, and the content keys in one store commit.

An owner backup restore replaces a key that rooted nothing and refuses a key that differs from the Domain root. Epoch 1 regenerates once the Domain id is known.

## Terminal view

Terminal operations reach the host through correlated `host_op` RPCs. `hostOpRunner.ts` owns peek
single-flight, cadence and concurrency limits, and mutating-op deduplication.

- `tmuxCore.ts` builds spawn argv without a shell. Exact tmux lookup uses `-t =<name>`; prefix lookup
  would let `story` select `story-2`.
- `peekWithFallback` returns Docker logs before a pane exists. The result uses flat optional `kind`
  and `text`; a discriminated union does not work with the Kotlin wire model.
- A wake with no capturable pane is reported as failed, so `/send` fails instead of waiting forever.
- The **Wake** button sends the `wake` delivery op to the session's own address. The gateway resolves
  it to the local `spawn.session`, bounds the launch like `create_session`, and answers `pending` past
  the bound. A session the gateway holds no record for is re-created under its own id, as
  `create_session` does with a typed `sessionName`; a launch that never comes up forgets it again.
- The reserved `host` slot requires `HOST_WS_TOKEN`.

## Armed goals

Long-press **Goal** sends the message, then types `/goal <description>` into the session pane.
Console-only, over `send` and `tmux_send`.

- Waiting for the turn does not work: the message bypasses the composer, so the queued line runs
  after the turn.
- A single pasted `/goal` line does not work: the CLI reads the burst as paste. Use three tmux sends
  with Enter separate.
- Injection requires an empty composer and a ready pane. A draft or dialog consumes or joins the
  command.
- The live composer is the last prompt row. Earlier prompt rows may represent queued messages.
- Clear the pending record before the first keystroke. A partial sequence can be re-armed; a second
  injection can submit a duplicated goal.
- `sentAt` gates injection. Never type a goal for a message that did not send.

## Capability union

A session's tools use separate console and daemon capability sources. The MCP reads both before
creating `McpServer`. The console source has a 14-day TTL and 500-device cap; the daemon source has
no TTL.

- **`/capabilities` keeps sources separate:** `enabledPlugins` and `daemonCapabilities` are disjoint
  sections. Absent means no report, empty means affirmative none.
- **A flat capability answer lifts into `console`,** and the route serves flat fields beside
  sections.
- A daemon declaration counts only after the `HOST_WS_TOKEN` gate.
- Offline fallback is the last answer that actually arrived. `GATED_CAPABILITY_IDS` drives both
  gates; the daemon id is pinned separately.
- **Always-on instructions carry names, not guidance:** The harness caps `capabilityInstructions` and
  silently truncates long guidance; `switchboard_capabilities` serves guidance per call.
- That tool answers from the startup snapshot. A fresh read may warn about drift but must not
  describe tools absent from the session.
- A running session's tools do not change until its next start.

**File map:**

- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, source folding.
- `src/gateway/console/capabilityStore.ts` - durable console capability reports.
- `src/gateway/daemonCapabilities.ts` - daemon capability reports.
- `src/mcp/capabilities.ts`, `capabilitiesTool.ts` - startup gating and guidance serving.

## Android app

- **Plugin framework** (`android/.../plugins/`): the registry owns plugin claims and sweeps them when
  a plugin is disabled. `threadDockSlots` stays outside the caught-dispatch path, because Compose
  values cannot cross a non-inline lambda.
- **Inbound pipeline:** handlers receive wire fields and file names, never file bytes. Subscribers
  run synchronously before persistence commit.
- **Row re-render** (`ThreadRenderer`): any changing row payload must enter its fingerprint. JS
  bridge state mutates in place and intentionally does not.
- **Presence authority** (`Presence.kt`): the gateway's own presence is pushed; other machines are
  discovered by `/discover`. A bare presence value does not reveal which channel produced it.
- **Presence residue** (`presence-authority-residue.test.ts`): `status` is private, `Presence`
  construction is private, and consumers use authority-bearing members such as `isLive`, `isOnline`,
  `mayHavePane`, `authoritative`. Do not restore writable status strings.
- **Action receipts** (`ActionReceipt`): local actions are receipts, not status overrides. Evidence
  retires a receipt; it never loses to an optimistic local value. Receipts are scoped by `opId`.
- **Presence TTL** (`PresenceTest`): must exceed one discovery interval, or a slow cold boot expires
  before discovery speaks.
- **Unreachable presence:** do not peek a row marked `UNREACHABLE`. Failed peeks repeat until
  `failCount` backs off.
- **Non-authoritative presence:** probe once per terminal mount. Polling is not evidence.
- **Working and needs-login** (`ChatState.working`): presence first, local peek only as fallback.
  Foreground re-declares screen focus so an open thread does not stay at background cadence.
- **Session card rungs** (`SessionCardPreview.kt`): the session's own reply supplies the headline;
  the owner's row never does. Each rung carries its own row time; ordering uses `lastActivity`.
- **Card board branch** (`cardBranchOf`): retain the root and a window around the current entry;
  collapse contiguous finished runs. A prefix of finished titles can hide the active entry.
- **Unfinished gateway enrollment** (`PendingEnroll.kt`): admission is persisted before POST and
  before delivery. Resume only with the saved bundle and the arming it was sealed against; a 404
  requires re-arm and re-scan.
- **Terminal copy** (`TerminalCopy.kt`, `TerminalAnsi.kt`): trim only trailing cells with neither
  background nor reverse. Painted trailing cells are content. Join only a single whitespace-free URL
  with a scheme.
- **Terminal padding** (`shared/pane-trim.ts`, `TerminalCopy.kt`): trimming occurs at capture and at
  render because daemon and console updates are independent. Keep `-J`; it preserves spaces and joins
  tmux-wrapped rows.
- **Designer plugin** (`plugins/designer/`): owns design cards, live content-keyed rendering, and
  per-team `DesignStore`.
- **Unread tracking** (`ReadAnchor.kt`, `thread.js`): anchors match inbox rows by epoch and
  sequence equality. Reads drain by scroll position.
- **Idle pushback** (`IdlePushbackManager.kt`): owns aligned `AlarmManager` wakeups.
- **Playback requests** (`PlaybackRequests.kt`, `SttsPlayer.kt`): registry state mints and queues
  each event under the same lock as its transition. `PlaybackResidueTest` owns the single-mint
  boundary. Warm-up holds no claim and purge reaches it through the epoch.
- **Playback queue** (`PlaybackQueue.kt`, `PlaybackOps.kt`): yielding requests stand down when sound
  is taken. `advance` installs the next head before returning it; declining that handoff strands the
  entry.
- **Spoken markers** (`ChatRepository`): chime, sentinel, and body remain separate requests. Match
  terminals by returned request identity, not by current queue entry. Cache by spoken words, not
  entry alone. Resume does not re-announce parked markers.
- **Playback surfaces** (`SttsTransport.kt`, `QueueBubble.kt`, `QueueSheet.kt`): read repository
  state after queue settlement, not raw playback events. The bubble stays on Views because a Service
  lacks Compose's ViewTree owners. The board header is the third access path when notification and
  transport permissions are denied.
- **Abandon semantics** (`SttsPlayer.abandon`): callers declare whether position survives; there is
  no default. Markers and settings samples are never resumable.
- **Audio focus** (`SpeechFocus.kt`): a focus-induced pause retains the request and duckable loss
  keeps speaking. A refused focus request registers no listener. Becoming noisy is a route change,
  not focus loss.
- **Transport pause** (`transportPaused`): normalize in the getter so an idle queue cannot expose
  paused state.
- **Attachment viewer** (`AttachmentDisplay.kt`, `AttachmentViewer.kt`): choose the viewer stage by
  actual decoder capability, not MIME prefix. WebView and `BitmapFactory` disagree in both
  directions.
- **Zoom math** (`ZoomMath.kt`): derive limits per image and sample size; the layer scale is not the
  displayed zoom percentage. Emulator coverage is required for the 100% one-to-one seam.
- **Text preview** (`TextPeek.kt`): classify with `CharsetDecoder`. `String(bytes)` substitutes
  U+FFFD and makes binary data look textual.
- **Save targets** (`SaveTarget.kt`): SAF and MediaStore are separate paths. Revalidate stored
  grants; only a missing folder returns to the picker.
- **Composer drafts** (`Draft.kt`, `DraftStrip.kt`): drafts are per-team store state. File tiles key
  by file, not position. `Draft.locations` preserves source metadata and every writer must copy it.
- **Thumbnail sizing** (`ImageThumbs.kt`): bound both short and long edges. Extreme aspect ratios
  otherwise decode at full size.
- **Scheduled send** (`ScheduledSend.kt`, `ScheduledSendOps.kt`): one banked record per team and one
  shared earliest alarm; firing is mutex-guarded.
