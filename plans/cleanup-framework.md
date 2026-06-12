# Cleanup: transport framework, parked bugs, God files

Framework-first cleanup of the debt catalogued during the 2026-06-12 audit laps
(notify_human feature cycle + epoch-collision incident). Ordered by dependency:
the transport extraction is the only true framework gap and it unblocks every
Android test, so it goes first; the parked bugs become red-test-then-fix once it
lands; the God-file splits are filing and ride last.

Honest scoping from the assessor: MainActivity.kt and routes.ts are big but not
broken (state already hoisted, DI closure already tested). ChatRepository fused
to PhoneClient is the real missing framework: no seam to fake, which is why the
Android side has zero unit tests while the TS side has 160.

## Phase 1: PhoneTransport port + MailboxCodec

The framework extraction. Android reducer becomes testable; wire grammar gets
one owner instead of three.

- `PhoneTransport` interface in its own file: the ops as suspend functions with
  typed results - `register()`, `teams()`, `send(to, body, files, opId)`,
  `poll(cursor, epoch, holdMs)`. `PhoneClient` becomes its one production impl
  (`: PhoneTransport`); its TLS pinning, timeout chain (35s read, holdMs+18s
  held-poll), and OkHttp builder stay verbatim - they are correct and
  load-bearing.
- `MailboxCodec`: a plain JVM class (org.json only, NO android.* imports so it
  runs on the test classpath). Owns: wire entry decode (the hand-parse currently
  inline in `PhoneClient.poll`), `Message <-> JSONObject` persistence both
  directions (currently hand-rolled twice in `persistThreads` /
  `loadPersistedThreads`), and the session grammar (`teamForEntry(entry)`
  collapsing `teamFromSession` + the notice-prefix branch; `NOTICE_SESSION_PREFIX`
  moves here as the single Kotlin owner, still doc-mirrored to phone-protocol.ts).
  Base64 stays in the transport so the codec is pure.
- `ChatRepository` keeps StateFlow + reducers, loses all org.json and all
  OkHttp; constructor takes `(transport: PhoneTransport, codec: MailboxCodec,
  store, filesDir)`. Composition root stays `Repo.get(context)` - constructor
  injection, no DI framework.
- Test infra: Android unit test sourceSet + `FakeTransport` (mirror the shape of
  `src/__tests__/phone-handler.test.ts`'s fake-routes harness). First tests:
  reducer drains a faked poll into the right thread; persist-then-load
  round-trips any `List<Message>` including the waking-drop and legacy-opId
  demote rules; epoch-change resets cursor and lastSeq.
- Verification: `./gradlew :app:assembleDebug` + new `:app:testDebugUnitTest`
  green; one emulator lap (status board + thread + send) to confirm no behavior
  change; `bun run lint && bun run test` untouched.

## Phase 2: Parked-bug regression tests and fixes

All three live in the reducer/append zone Phase 1 just made reachable. Each one:
write the failing test first, then fix.

- Mis-thread: an agent-initiated `channel_push` to the phone threads under the
  phone's own name (session `conv:<id>:<phoneName>` parses to the phone, not the
  sender). Test: feed FakeTransport an entry whose session tail is the phone's
  own name with a real `from`; assert it threads under the sender. Fix in
  `teamForEntry` (prefer `from` when the session tail equals self), plus
  whatever arbiter-side session shape correction falls out - keep the protocol
  additive.
- Liveness asymmetry: `appendIfLive` (binding-gated) vs `humanNotify`'s direct
  `box.append`. Unify on one append path with an explicit liveness policy
  parameter, or document-and-test the broadcast exemption; either way the two
  paths must stop disagreeing silently. Consider folding in the deferred
  `DeviceMailboxStore.broadcast(input): number` so the store owns
  iterate+append+count and `forEach` stops exposing raw boxes.
- Notify idempotency: `POST /human/notify` is at-least-once under `routerPost`
  transport retry (no opId, unlike send/respond). Add an opId to the
  notify_human tool call + route schema with a short-TTL replay cache keyed
  `(from, opId)`; duplicate delivery becomes impossible rather than unlikely.
- Verification: new TS tests in routes.test.ts / device-mailbox.test.ts + the
  Android regression tests; full `bun run test` + `testDebugUnitTest`.

## Phase 3: MainActivity screen-per-file split

Pure filing, zero logic change. One file per screen, MainActivity keeps only the
activity shell, nav state, and the composition root.

- Extract `SessionsScreen.kt`, `ThreadScreen.kt`, `SettingsScreen.kt`,
  `ProvisionScreen.kt`, and shared leaf composables; updater + battery rows move
  with Settings. Add a `@Preview` per screen now that they are isolated.
- Fold in cosmetic sweeps that ride free: none currently known on the Android
  side beyond the split itself.
- Verification: assembleDebug + emulator lap through every screen (board,
  thread, settings, provisioning gate, attachment viewer, demo).

## Phase 4: routes.ts module split + ChannelHolder

Mostly filing; one small framework bit.

- Split the `createRoutes` closure into modules sharing one `RoutesDeps`:
  `routes/send.ts`, `routes/respond.ts`, `routes/human.ts` (respond, transfer,
  notify), `routes/misc.ts` (teams, health, pending, ingest, evie). Body schemas
  and the `fileBytes`/`stripFileBytes` helpers move beside their handlers.
- Extract `ChannelHolder`: owns `pinnedHolders` + `holderMatchesSender` + the
  transfer state machine. This is the one piece that passes the ownership test
  (it survives an app swap); the rest is filing.
- Fold in cosmetics: capitalize + punctuate the humanNotify 503 message to match
  sibling 503s.
- Verification: `bun run lint && bun run test` (160+) green; arbiter smoke
  (health, send round trip, notify broadcast).

## Phase 5: build-enforced cross-runtime contract (stretch)

Kill the comment-enforced mirror class that produced today's epoch-style drift
risk. Only sensible after Phase 1 gives Kotlin a single grammar owner.

- Generate the Kotlin mirror constants from phone-protocol.ts (a small bun
  script emitting `Protocol.kt`: `NOTICE_SESSION_PREFIX`, mailbox field names,
  op kinds), run in CI or a precommit check that fails on drift.
- `MailboxCodec` consumes the generated constants; the hand-written mirror
  comments become pointers to the generator.
- Verification: intentionally skew one constant locally and confirm the check
  fails; then full both-side test suites.

### Notes for implementers

- One phase per lap; commit each phase locally when green. Deploys follow the
  standard ritual (version bump in plugin.json + package.json, push via
  branch+automerge PR, arbiter rebuild only when arbiter-side code changed -
  Phases 2 and 4 do, Phases 1 and 3 are app/plugin only).
- Emulator harness: `source ~/android-dev/env.sh`, AVD phone35,
  `wm size 720x1600` + `density 280`, reset after.
- Keep the phone protocol additive throughout; old apps must tolerate every
  change (the 3.9.0 tolerance checks from the notify cycle are the bar).
- Already fixed, do NOT redo: mailbox epoch collision (random mint + drain
  guard, PR #29); capless respond_to_human reader; notice session grammar
  pinning; notify_human registration drift.
