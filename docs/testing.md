# Testing

How the wire is tested: one composed federation in a vitest process, two minted fixture corpora,
and two Bun smoke gates.

## Gates

| Command | Proves |
|---|---|
| `bun run lint` | Biome and `tsc` |
| `bun run test` | Vitest under Node, including the harness scenarios and both fixture replays |
| `bun run check:fixtures` | Regenerating the TS wire fixtures changes no byte. Every committed fixture and manifest entry on both sides parses under the schema |
| `./scripts/kotlin-gate.sh` | Kotlin import guard, `Protocol.kt` regenerated unchanged, Kotlin fixtures regenerated unchanged, the unit tests |
| `bun run check:pinning` | The shipping runtime pins the Router certificate |
| `bun run check:boot` | The real entry points boot under Bun and answer one console op |

## The fixture world

`tests/fixtures/identity/set.json`, minted once by `scripts/gen-identity-set.ts` through
`mintIdentitySet`: the Router identity, the Domain and its owner, the gateway and console
identities with their admissions, the three bearer tokens, and the epoch 1 content key. Everything
below reads this one file; the harness mints further sets with the same function for its friend
Domains.
`src/shared/fixture-identity.ts` names its signing keys; `main-federation` and `composeGateway`
refuse them unless `ALLOW_FIXTURE_IDENTITY=1`, which only the harness and the boot smoke set.
Re-minting the set invalidates every derived fixture.

Each runtime builds one `FixtureWorld` from the identity set. It asserts that the content key is
derived from the Domain owner and that both admissions verify, and assembles the values its
participants have: TS the gateway boot and content key store, Kotlin the phone boot and client.
`FixtureDraws` gives each case one counter. Draws are the first N bytes of
`sha256("<producer>:<composer>:<case>:<n>")`, recorded in `inputs.draws` by index. `WireSealed`
blocks on both producers (`phone.sealed` on TS fixtures, `sealed` on Kotlin ones) declare every
envelope path, its AAD kind, and the plaintext, JSON subset, or decode class the other runtime
checks; each reader scans its frame for undeclared envelopes.

## The harness

`src/testing/federationHarness.ts` composes a real `RouterServer` on port 0 and a real gateway
graph through `composeGateway`, joined by the real pinned client over loopback. The host daemon
and the sessions are fake sockets at the gateway's own WebSocket handlers (`fakeHost.ts`,
`fakeSession.ts`); the phone is a TypeScript driver on `RouterServer.handle` (`phoneDriver.ts`)
plus a console socket against the Router's TLS listener (`consoleSocket.ts`).
`restartGateway` recomposes over the retained directories. `restartHost`
reconnects the daemon, and with `newDaemon` as a fresh process.

## The ambient

The gateway and the Router read the clock, the entropy, the ids, and the timers only through an
injected `Ambient` (`src/shared/ambient.ts`). `processAmbient()` is the one reader of `Date.now`,
`crypto.randomBytes`, `crypto.randomUUID`, and the global timers; every timer it hands back is
unref'd. `ambient-residue.test.ts` fences direct reads across `src/gateway`, `src/federation-server`,
and `src/shared`, and names the reason for each of its nine allowed files.

`fakeAmbient` (`src/testing/fakeAmbient.ts`) is the harness's. Its clock is an offset on the
harness `now`, and its entropy is a per-instance stream seeded from a fresh draw, so two peers in
one scenario never mint the same nonce. Its timers have two drives:

- **"real"**, the harness default. Timers ride the process ones, so the persist tick, the presence
  watch, the awareness tick, the inbox pump, and the reconciler fire on their own cadence and every
  scenario makes progress with no sleeps. This is what the gateway did before the ambient existed.
- **"manual"**, per scenario. Nothing fires until `advance(ms)`, which runs each timer at its own
  deadline (intervals repeating) and yields to the event loop between firings, so the I/O and
  promises a real elapsed second would have settled do settle. `startFederationHarness({ drive:
  "manual" })` selects it; the fake is exposed as `h.ambient` for the home gateway,
  `h.routerAmbient` for the Router, and `peer.ambient` for a Domain added with `addDomain`.

Only a scenario that must move a deadline needs manual drive. The handshake re-send window and the
handshake expiry sweep are the two that do.

The fake host is also the Codex daemon. It answers `codex_command` frames through a responder:
`stockCodexResponder` accepts and completes at once, and a scenario installs its own for a running
or refused turn. It keeps one `FakeCodexDaemon` per machine across gateway restarts and validates
every Codex frame it sends against the daemon schemas. A fake session can answer the lead
handshake as a worker, present a binding token, or name a project path.

`addDomain` roots a second Domain in the Router under a minted identity set and composes its own
gateway, host, and phone; `link(receiver, requester)` runs the real listening-token handshake
through the Router and submits both owner-signed link edges. The phone driver's `console()` posts
any console-surface body and `enroll()` an enroll op, so tenant provisioning, first root, device
approval, and the trust rendezvous run against the real surfaces.

Each scenario asserts what the phone, a session, or the daemon observes, never a fake's
bookkeeping:

| File | Covers |
|---|---|
| `federation-harness.test.ts` | One Domain: send and reply, host launch, presence, board, notices, a queued reply across a gateway restart, the empty keyring |
| `federation-harness-boot.test.ts` | Reach before roster, the bounded bootstrap install, Router and gateway restarts, a notice held through a Router outage |
| `federation-harness-sessions.test.ts` | Session bindings and impostors, worker answers, transcript handover, duplicated deliveries, reply authority, the wake boundary, the console's create, rename, close, forget, tmux, peek, and notify rules, daemon capabilities |
| `federation-harness-handshake.test.ts` | A session verifying before its lead confirms, a reconnect within retention, a stale close under a newer registration; under manual drive, the re-send throttle window and the expiry sweep |
| `federation-harness-domains.test.ts` | Two and three Domains: the handshake, shares and the Router record, cross-Domain send and reply, opaque refusal, unshare, unlink, colliding gateway ids, forged replies, a repeated send opId |
| `federation-harness-xdomain.test.ts` | The share gate, a cross-Domain wake, return-route authentication, a relay retried across a Router restart, unlink of in-flight work, share auto-forget |
| `federation-harness-router.test.ts` | Router-only: tenant provision, first root, rename and its refusals, removal, deletion, replay across a restart, device approval, the trust rendezvous |
| `federation-harness-codex.test.ts` | Codex through the gateway and the daemon: start, message, list, stop, replayed frames, gateway and daemon restarts |

`startRouterOnly` composes the Router without a gateway, so a scenario can add an arming or active
gateway itself. `restartRouter` replaces the Router on its port over a store reopened from disk.
The phone driver's `reach()` is the token-gated reach and gateway roster. A friend Domain from
`addDomain` shares the Router identity and app token and carries its own host token.

The coordinators and services behind the scenarios keep pure-rule suites beside them:
`cross-domain-handshake` (limits, cancellation, mismatch refusals), `router-coordinators`
(rendezvous, approval, and tenant limits), `owner-op-intake` (in-flight duplicates, caps,
admission refusals, quarantine), `cross-domain-presence` (consumer, pusher, reconciler, source),
and `share-rules`. The host daemon's Codex service has its own bench in
`codex-daemon-service.test.ts`: the real `ThreadLifecycle`, tracker, and JSONL transport over a
scripted App Server child, with only the launcher as a double.

## Minted wire fixtures

Each runtime drives its real composers under the identity set, a fixed clock, and deterministic
nonces, and commits what they produced; the other runtime consumes it with its real parser.

- `scripts/gen-wire-fixtures.ts` writes `tests/fixtures/wire/ts/<composer>/<case>.json`: the
  gateway frames (owner rows, presence, session registry, key requests, board writes, value
  results, registration). `src/__tests__/wire-fixtures-ts.test.ts` feeds every frame through the
  live pinned link; `WireFixturesDecodeTest.kt` opens every phone-bound answer.
- `WireFixtureGenerator.kt` writes `tests/fixtures/wire/kotlin/<composer>/<case>.json`: the signed
  owner ops of the real phone composers (hello, key request and receipt, cursor translation, board
  write, the board read, the four inbox ops, a scheduled send's delivery, a value op, the key
  grant answering a gateway's request, the read report, the capabilities report) and the transport
  request family. Regenerate with `./gradlew :app:generateWireFixtures` from `android/`. An
  ordinary unit-test run asserts the committed files, and `kotlin-gate.sh` diffs a fresh
  regeneration against them. `src/__tests__/wire-fixtures-kotlin.test.ts` replays every request
  through `RouterServer.handle` at the fixture clock in manifest order, so the board read follows
  the board write. It also replays the socket upgrade against the real listener, reproduces every
  signed op through the phone driver, and opens every phone-sealed envelope (the key grant with the
  gateway's box key, the delivered row, the value payload, the board title) with the content key.

Fixture shape is `src/shared/schemasWireFixture.ts`, generated into Kotlin as `WireFixture`:
`producer`, `composer`, `case`, `clock`, `inputs`, `expect` (the real peer's answer as a subset),
then `frame` (TS) with an optional `phone` block naming the decode target (`RowEnvelope`,
`ContentEnvelope`, `BoardOp`) and its `sealed` values, or `request` (Kotlin) with its `sealed`
values. Each generator builds the value through the
schema and derives the manifest from it. `check:fixtures` validates every committed file and
manifest entry on both sides. The n-th random draw of a case is the first N bytes of
`sha256("<producer>:<composer>:<case>:<n>")`, recorded in `inputs`.

## Wire vocabulary

`src/shared/wire-vocabulary.ts` declares the Router paths, the console header and Bearer prefix,
the signing tags, the outcome and reason constants, and the nonce lengths. The owner-op kinds
come from `src/federation-server/ownerOpRegistry.ts`, the catalog every kind registers through.
`scripts/codegen-kotlin.ts` emits both as `Protocol.Wire`, with the console op kinds, socket
frame types, and key op kinds from the Zod literals. `wire-vocabulary-residue.test.ts` rejects
the literals anywhere else on either runtime.
