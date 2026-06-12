# Cleanup: transport framework, parked bugs, God files

Framework-first cleanup of the debt catalogued during the 2026-06-12 audit laps
(notify_human feature cycle + epoch-collision incident), refined by a
plan-refinement cycle whose auditors verified every claim against the code.
Ordered by dependency: the codec/transport extraction is the only true framework
gap and it unblocks every Android test, so it goes first; the parked bugs become
red-test-then-fix once it lands; the God-file splits are filing and ride last.

Honest scoping: MainActivity.kt and routes.ts are big but not broken (state
already hoisted, DI closure already tested). ChatRepository fused to PhoneClient
is the real missing framework: no seam to fake, which is why the Android side
has zero unit tests while the TS side has 160+.

## Phase 1a: MailboxCodec + Android test infra

Smallest-blast-radius first lap: extract the pure codec and stand up the test
classpath. The codec is independently testable before any transport seam exists.

- `MailboxCodec`: a plain JVM class (org.json only, NO android.* imports). Owns:
  wire entry decode (the hand-parse currently inline in `PhoneClient.poll`,
  PhoneClient.kt:213-238 - it produces `MailboxEntry` carrying base64 STRINGS in
  `RawFile.base64`, so the codec never touches `android.util.Base64`),
  `Message <-> JSONObject` persistence both directions (currently hand-rolled
  twice in `persistThreads` / `loadPersistedThreads`), and the session grammar
  as `teamForEntry(entry, selfName)` (collapsing `teamFromSession` + the
  notice-prefix branch; `NOTICE_SESSION_PREFIX` moves here as the single Kotlin
  owner, still doc-mirrored to phone-protocol.ts).
- Base64 boundary: ENCODE stays in the transport (PhoneClient.kt:186). The
  base64-to-bytes decode + file write is `Attachments.decode` (Attachments.kt:57,
  imports android.util.Base64), invoked from the reducer at ChatRepository.kt:379.
  It is NOT part of the codec and stays in `Attachments`.
- Test infra (NEW build wiring, none exists today): in `libs.versions.toml` add
  junit 4.13.2 (`junit:junit`) and `org.json:json` 20240303; in
  `app/build.gradle.kts` add `testImplementation(libs.junit)` +
  `testImplementation(libs.orgJson)`. The real org.json jar is MANDATORY: on
  `testDebugUnitTest` the bundled android.jar ships stub org.json classes that
  throw "Method not mocked". Do NOT use `unitTests.isReturnDefaultValues = true`
  (it would return null/0 silently and corrupt the codec under test). Create
  `app/src/test/java/...`.
- First tests (codec only, no transport needed): entry decode round-trip
  including `title` and notice kinds; `Message` persist-then-load round-trips
  any list including the waking-drop and legacy-opId demote rules
  (ChatRepository.kt:604-610); `teamForEntry` grammar table (conv tail, notice
  prefix, empty/malformed).
- CI wiring (none today: `_build-android.yml` runs only `:app:assembleDebug`):
  add `./gradlew :app:testDebugUnitTest` BEFORE the assemble step so a red test
  fails the run before artifacts build. Without this the new tests are
  local-only and will rot. Note: main-push.yml triggers on push to main, so
  this gates post-merge; add a pull_request trigger only if pre-merge gating is
  wanted (not required by this plan).
- Ride-alongs: correct the stale `MessageFile` doc comment (ChatRepository.kt:24
  claims attachment decode is "a later phase"; it shipped via Attachments.decode).
- Verification: `:app:testDebugUnitTest` + `:app:assembleDebug` green locally
  and in CI; `bun run lint && bun run test` untouched.

## Phase 1b: PhoneTransport seam + injected ChatRepository

The framework extraction proper. Android reducer becomes testable end to end.

- `PhoneTransport` interface: the ops as plain BLOCKING functions with typed
  results - `register()`, `teams()`, `send(to, body, files, opId)`,
  `poll(cursor, epoch, holdMs)`. Blocking is deliberate: `PhoneClient` is
  blocking OkHttp `.execute()` today and `ChatRepository` already owns the
  dispatcher boundary (`withContext(Dispatchers.IO)` in connect/send/retrySend/
  startPolling/reconcilePending); the held poll's read-timeout block IS the
  long-poll. A suspend interface would double-wrap dispatchers and force reducer
  tests async for no reason. `PhoneClient` gains `: PhoneTransport` with NO
  signature change; TLS pinning, timeout chain (35s read, holdMs+18s held-poll),
  and the OkHttp builder stay verbatim.
- Inject a transport FACTORY, not a flat transport: the transport is minted from
  the provisioning blob and re-minted on credential change (`provision`,
  `setDeviceName`, `clearAll` null the client today at ChatRepository.kt:166-175,
  492, 503). New constructor:
  `(transportFactory: (Provisioning) -> PhoneTransport, codec: MailboxCodec,
  store, filesDir, contentResolver)`. The lazy `client()` becomes
  `transportFactory(Provisioning.parse(blob))`.
- `readUri`/`queryName` (contentResolver URI-to-bytes, ChatRepository.kt:322-332)
  stay for now; they are outgoing-attachment I/O used before the transport call.
  If reducer tests ever need them faked, lift behind a small seam then - not
  speculatively now.
- Composition root stays `Repo.get(context)` (MainActivity.kt:80-88), the SINGLE
  wiring point shared by BOTH composition paths - MainActivity and
  `SwitchboardService.onCreate` (SwitchboardService.kt:46) both obtain the
  singleton through it. Production passes `::PhoneClient` as the factory; tests
  pass `{ FakeTransport(...) }`. Constructor injection, no DI framework.
- `FakeTransport : PhoneTransport` blocking fake (mirror the fake-routes harness
  shape of src/__tests__/phone-handler.test.ts). Reducer tests stay synchronous.
  Reducer tests feed poll entries with `RawFile.base64 = null` (metadata-only)
  so `Attachments.decode` short-circuits (Attachments.kt:56) before any
  android.util.Base64 call - the test-classpath landmine.
- First reducer tests: drain a faked poll into the right thread; epoch-change
  resets cursor and lastSeq (ChatRepository.kt:362-366); seq dedupe drops
  re-drained entries; unread/burst bookkeeping.
- Verification: testDebugUnitTest + assembleDebug green; one emulator lap
  (status board + thread + send) to confirm zero behavior change.

## Phase 2: Parked bugs (red-test-then-fix) + append ownership

Reachable now via FakeTransport. Cross-runtime phase: arbiter AND app change.

- Mis-thread (bug): agent-initiated `channel_push` to a phone mints
  `conv:<senderConvId>:<phoneName>` (routes.ts deriveChannelJobId), so the
  phone's tail-parse threads the message under ITSELF instead of the sender
  (tail beats the `?: e.from` fallback). Confirmed host-window-safe: host
  channel consumers read `payload.from`, never the session tail, so only the
  phone mis-threads. THE FIX IS PHONE-SIDE ONLY: `teamForEntry` prefers `from`
  when the session tail equals this device's own name. The `from` field already
  carries the sender on every entry (routes.ts:330 -> phonePeer.ts:56), so this
  is complete on its own and works against any arbiter version.
  - Do NOT change the minted session string. It is ONE string serving three
    coupled roles: the pending-job store key (per-sender-per-target idempotency
    and continuity), the wire session_id the phone responds to (recordInbound),
    and an independent reconstruction at phoneHandler.ts:250 for the
    backgrounded-send error path. Putting the sender in the tail collapses the
    per-target store key (two phones messaged by one window would share an
    entry) and silently drifts from the :250 reconstruction. Threading must
    read an attribution field, never the store key - that overload IS the bug
    class. If durable arbiter-side attribution is ever wanted for a second
    consumer, add a NEW additive mailbox field (e.g. `thread_under`) at the
    PhonePeer append, leaving session_id byte-identical; skip unless that
    consumer appears.
  - Tests: faked entry with tail==self + real `from` threads under `from`; a
    NEW phone-handler assertion that the threaded team for an agent-initiated
    push is the sender (the existing test at phone-handler.test.ts:295 asserts
    only kind/body/cursor, so the coverage must be added, not edited in place).
- Notify idempotency (bug): `POST /human/notify` is at-least-once because
  `routerPost` retries ONLY on transport-layer rejection (helpers.ts: the
  res.ok check is outside the try, so HTTP errors do NOT retry - a repro must
  drop the socket post-handler, not return a 500). Fix: `notify_human` sends an
  `opId` (crypto.randomUUID per call); route schema accepts it; a replay cache
  in the `createRoutes` closure (keyed on opId ALONE - it is already globally
  unique, `from` adds no correctness; 60s TTL covering routerPost's ~22.5s retry
  envelope; 256-entry cap like the phone opCache) replays the cached
  `{delivered}` count. Old plugins that omit opId stay at-least-once (additive).
  Rejected alternative: a routerPost no-retry flag converts duplicate-delivery
  into silently-lost milestone notices - worse.
- Append ownership (quality, NOT a bug - demoted by audit): `appendIfLive`
  (binding-gated late-continuation guard, phoneHandler.ts:117) and humanNotify's
  raw `mailboxStore.forEach(box.append)` answer DIFFERENT questions and do not
  produce wrong deliveries. Cleanup only: fold the broadcast into
  `DeviceMailboxStore.broadcast(input): number` so the store owns
  iterate+append+count and stops exposing raw boxes via forEach. broadcast must
  not evict and inherits append's releaseWaiters (held polls drain notices
  immediately). `appendIfLive` stays separate.
- Ride-along: resolve `parseNoticeSession` (phone-protocol.ts) - currently a
  dead export with no TS caller. Either the arbiter-side mis-thread work gains a
  caller, or delete it (Phase 5 codegen supersedes the mirror anyway).
- Verification: new TS tests (routes.test.ts, phone-handler.test.ts,
  device-mailbox.test.ts) + Android regression tests; full `bun run test` +
  `testDebugUnitTest`. Deploy: full cross-runtime ritual (arbiter rebuild + app
  + plugin bump); the notify opId is an additive protocol change held to the
  3.9.0 tolerance bar.

## Phase 3: MainActivity screen-per-file split

Pure filing, zero logic change. Order is load-bearing: Phase 1b already rewrote
`Repo.get`; this phase moves files around it and must not re-touch the
constructor.

- One file per screen: `ProvisionScreen.kt`, `SessionsScreen.kt`,
  `ThreadScreen.kt`, `SettingsScreen.kt`, and `LockScreen.kt` (the `locked`
  branch at MainActivity.kt:209 is a real screen state). `AppUpdateRow` +
  `BatteryExemptionRow` are called only from SettingsScreen and move with it.
  `ThreadWebView` moves beside ThreadScreen.
- Shared chrome to its own file (NOT into any one screen): `StatusChip` +
  `presenceColor` and `ConfirmDialog` + `RenameDialog` (each used by both
  Sessions and Thread), `HealthHeader`, `SectionLabel`, `SessionCard`,
  `SessionActionsDialog`, `DemoCard`, `relativeTime`, `sessionOrder`.
- `App(...)` (MainActivity.kt:113) STAYS the coordinator and keeps unchanged:
  nav state (`openTeam`/`showSettings`/`unlocked`/`viewer` locals),
  `rendererPool` + onRetry/onAttachmentTap wiring, the AttachmentViewer overlay
  wiring (:284-293; the viewer is already its own file - only wiring stays),
  the biometric gate (`locked` derivation :194 + LaunchedEffect :195), the
  lifecycle observer, the demo gating (isDemo/demoMessages/DEMO_TEAM), and the
  `when` screen router. `App` in MainActivity.kt or its own App.kt is the
  implementer's call.
- Add a `@Preview` per extracted screen.
- Verification: assembleDebug + testDebugUnitTest + emulator lap through every
  screen (board, thread, settings, provisioning gate, lock screen, attachment
  viewer, demo).

## Phase 4: routes.ts module split + ChannelHolder

Mostly filing; one real extraction. Arbiter-side: rebuild on deploy.

- Split the `createRoutes` closure into modules sharing one `RoutesDeps`:
  `routes/send.ts` (send + fileBytes/stripFileBytes/deriveChannelJobId),
  `routes/respond.ts` (respond, poll), `routes/human.ts` (humanRespond,
  humanTransfer, humanNotify + holderMatchesSender), `routes/misc.ts` (teams,
  health, pending, ingest, evieToolCall, evieTools - note: "evie" is two
  handlers). `createRoutes` keeps its current flat return shape
  (`{ ingest, send, respond, ... }`); the ~35 destructuring call sites in
  routes.test.ts must not change - modules are internal, createRoutes
  re-aggregates.
- Extract `ChannelHolder`: owns `pinnedHolders` and ALL its mutators - the
  ownership test fails otherwise. Pin writes live at index.ts:210, 227, 246,
  254 and routes.ts:629, 696; every one moves behind the holder. That includes
  the index.ts lifecycle: `clearPinsForTeam` (clear-on-disconnect) and the DM
  holder-selection/auto-assign in `tryDeliverDm` (incl. pickFirstOnlineTeam).
  index.ts calls `holder.clearForTeam(team)` / `holder.resolveForDm(channelId)`
  instead of touching the Map. If any pin write stays in index.ts, the
  extraction failed. `RESERVED_TEAM_NAMES` and `formatHolderConnectedMessage`
  stay as imports from websocket.ts (no cycle: websocket does not import
  routes).
- The Phase 2 notify replay cache lives in the createRoutes closure; this split
  relocates it into `routes/human.ts` with humanNotify - do not orphan it.
- Fold in cosmetics: capitalize + punctuate the humanNotify 503 message to match
  sibling 503s.
- Verification: `bun run lint && bun run test` green with the unchanged test
  destructure sites; arbiter smoke (health, send round trip, notify broadcast,
  DM holder pin/transfer/disconnect-clear).

## Phase 5: moved to plans/schema-first.md

The constants-only codegen stub that lived here was absorbed and expanded by
plans/schema-first.md (full zod -> Kotlin type codegen, drift-checked CI,
golden fixtures, STTS descriptors, cross-repo contract sync). Interplay for
this plan: Phase 1a's MailboxCodec consumes schema-first's generated types if
they exist, or swaps its hand types for them when schema-first Phase 1 lands;
whichever plan runs first wires the Android junit test classpath.

### Notes for implementers

- One phase per lap; commit each phase locally when green. Phase order is
  load-bearing: 1a before 1b before 2 and 3 (1b rewrites the Repo.get
  constructor that 3 files around; 2 needs FakeTransport).
- Deploy shape per phase: 1a/1b/3 are app-plugin only (no arbiter rebuild);
  2 and 4 change the arbiter (full ritual: version bumps, branch+automerge PR,
  arbiter rebuild).
- Each phase that moves or adds files updates CLAUDE.md Key Paths in the same
  commit (Phase 1a/1b add the codec/transport seam lines; Phase 4 replaces the
  single routes.ts entry with the routes/ module list + ChannelHolder).
- Keep the phone protocol additive throughout; old apps must tolerate every
  change (the 3.9.0 tolerance checks from the notify cycle are the bar). New
  apps must also tolerate old arbiters (the mis-thread phone guard exists for
  exactly this).
- Emulator harness: `source ~/android-dev/env.sh`, AVD phone35,
  `wm size 720x1600` + `density 280`, reset after.
- Known debt, out of scope here: the pending-job store is in-memory, so an
  arbiter restart drops persistent channel conversations and replies bounce
  with "No pending request" until the peer sends again (bit twice on
  2026-06-12). A durable conversation store is its own future plan.
- Shipped plan docs were archived to plans/done/ (2026-06-12); the CLAUDE.md
  cross-reference points there now.
- Already fixed, do NOT redo: mailbox epoch collision (random mint + drain
  guard, PR #29); capless respond_to_human reader; notice session grammar
  pinning; notify_human registration drift.
