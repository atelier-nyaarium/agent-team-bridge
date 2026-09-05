# Questionaire

Post-rewrite hardening. Five opportunities from the audit of `plans/router-hub.md` and the 70
commits after `a20384d2`, one phase each.

## Context - the audit

Rewrite: 98 commits, 467 files, +40k/-20k. After it: 70 commits, about 45 of them fallout, in
five classes.

1. **Wire disagreement across three runtimes (~15).** Phone minted UUID nonces the Router's
   `b64Field` refused. A transport rename left `"******"` as the app token header. The Router
   schema demanded `type: "value_result"` the gateway never sends. Plane payload required on one
   side, optional on the other. Owner rows sealed as a shape the phone does not decode. The phone's
   tests posted to `/relay` against their own mock after the Router moved to `/console`. Each
   runtime tests its own idea of the wire; `tests/fixtures/protocol` is hand-written and
   pre-composed, so it pins decoding and never composition.
2. **Composition-root residue (~5).** One dropped `inbox` line in `RouterServer` made every
   gateway append answer "inbox unavailable". `startGateway` is one ~1300-line function with 83
   constructions and no test calls it. No test wires the gateway's `routerClient` to the Router's
   `gatewayBridge`. `makeConsoleSeam` hands `createConsoleDispatcher` canned `routes` and
   `relayToHost` answers.
3. **Identity bootstrap (~6).** Domain id needed for signing before the roster that carries it.
   Owner conversation after a gateway restart. First key epoch on an empty keyring. One key grant
   per request storm. The phone's cold start with nothing was never a written state.
4. **Phone state with no seam (~6).** Drain mutex re-entered by presence application. Welcome
   versions marked applied instead of fetched. Roster landing over one already landed. `PresenceOps`
   and the other repository ops reach through `repo` and cannot be constructed in a test.
5. **Debugging in production (6 commits).** Instrument, log, trim, trim, flush on a clock. The
   bill for having no bench.

Tests: 285 TS files, 3136 cases, 55k lines against 55k source. 152 Kotlin files, 18k lines
against 38k. 32 residue tests grep the source tree. 615 `toBe("...")`, 240 `toContain("...")`.
9 files use `vi.mock`, 25 `vi.spyOn`; the disease is hand-built fakes passed into constructors.
Full run: 10s. Pure-rule tests were right. Tests that stubbed their peer amounted to nothing.

Opportunities, ranked:

| # | Name | Shape | Closes | Depends on |
|---|---|---|---|---|
| 1 | Federation harness | build | classes 1, 2; a bench for 3, 5 | none |
| 2 | Test cull by kind | repair | maintenance tax | 1 |
| 3 | Phone repository seams | repair | class 4 | none, parallel to 1 |
| 4 | Cold-start identity state | build | class 3 | 1 to test it |
| 5 | Split `startGateway` and `routes` | repair | falls out of 1 | 1 |

Owner's steer: all five, one phase each. Luna fan-out per question.

## Question 1 - Where does the harness run?

Q: In-process under vitest with a thin Bun adapter, that plus one Bun boot smoke, or Bun
subprocesses as the harness?
A: In-process under vitest, plus one Bun boot smoke (`check:boot`) beside `check:pinning`.

Recommendation reason: in-process and in-process-plus-smoke share the catch table (18 of 38
fallout hashes caught, 6 partial); the smoke spends one script on the one thing vitest cannot
see, the Bun runtime, without making scenarios pay for it. Subprocesses as the harness scored 55:
no store, clock, or host control, and it pressures keeping `startGateway` whole.

Constraint the owner set while deciding: nothing leaves Bun and no dependency is added.
`composeGateway` returns `{ router, wsHandlers, close }`; `startGateway` keeps its `Bun.serve`
block verbatim; the harness calls the graph, never serves it. Runtime deps stay at five.

> "double check their reasoning, namely features. since just changing it may add a bunch of
> dependencies just to get away from Bun."

> "ok recommended"

Two build rules carried from the evaluators: the extraction preserves construction order, and
`close()` then recompose is not restart coverage; Phase 4 gets an explicit retained-state scenario.

## Question 2 - How is the phone side pinned to the wire?

Q: Two-way minted fixtures; two-way plus replaying the phone's minted requests as the harness's
driver; or one-way plus Kotlin request-capture tests?
A: Two-way minted fixtures, committed and drift-checked, on one fixed identity set shared by the
TS generator, the Kotlin generator, and the harness. The harness's TS phone driver composes
freely for scenarios but is pinned to the phone by an equivalence test: for every Kotlin fixture
case, the driver given the same inputs produces the same signing bytes and JSON. One scenario
replays every Kotlin-minted request through the composed Router and asserts the fixture's
declared verdict. Replay is a scenario, not the driver.

Owner delegated the pick.

> "analyze the choices yourself one last time and take your favorite"

Reason: one-way plus capture recreates the failed pattern, hand-written twins, and proves what
Kotlin builds rather than what the Router accepts. Replay as the driver welds every scenario to
a Kotlin fixture case and a Gradle run, which fights the harness's job as a fast bench for the
identity and debugging classes; a signed fixture cannot be varied. The equivalence pin closes the
gap replay was for (the driver as a third source of truth for the phone's bytes) while leaving
scenario authoring in TS.

Scope rule: Phase 1's Kotlin corpus is the eight composers deterministic today plus `OwnerOps`
after `now`, `newNonce`, and `newOpId` injection. The repository-bound `reportRead` and scheduled
delivery, and the `SecureRandom` sealers, join in Phase 3 with their seams. The generator
instantiates the real composer named in each fixture's metadata and refuses hand-built JSON; each
side's output is consumed by the other runtime's real parser. The hand-pinned vocabulary (op and
frame kinds, versions, paths, header names, preimage field order) moves into `codegen-kotlin`
output as constants, a Phase 1 item.

## Question 3 - How deep does Phase 1's injection go?

Q: Strict move plus close plumbing only; that plus one clock seam on both graphs; or full ports
(clock, timers, fs, logger, process) now?
A: Strict move plus close plumbing plus one clock seam.

Recommendation reason: it is exactly what Q2 needs and no more. `deps.now`, `newNonce`, and
`newId` on the gateway graph reach only the composers the corpus needs (`consolePushOps`,
`presenceReporter`, `keyRequester`, `routerClient`'s call id, `shareAttestor`'s bypass) and
`createConsolePushOps` takes its directory. `RouterServerParams.now` threads into the
constructors that already accept it, plus two signature changes (`verifyRegistrationClaim`,
`GatewayBridgeParams`) and a public `handle(Request)` split from the private `route`. Timers stay
real and the harness ticks the retained boot timers. The 42-site sweep, timers, fs, logger, and
process handlers belong to Phase 5, where every module gets its seam as it moves.

> "sounds good"

## Question 4 - What is the cull rule for Phase 2?

Q: By kind only; by kind plus a per-file pass over the fake-backed suites gated on scenario
coverage; or kill the fake-backed suites and rewrite what remains as behavior?
A: Kill. Delete the fake-backed suites (about 480 cases behind the twelve helpers), the by-kind
categories (prose, call order, stubbed answers), and the seven rotting residue inventories.
Prune and merge the rest, then update every remaining test to assert behavior: a sequence of
actions and the state or output it produces, never a static string. The exception is a test whose
string IS the behavior (tmux pane parsing, `agent-screen`, `limit-notice`, canonical bytes).
Decision rules the killed suites carried (send addressing, wake bounds, refusal mapping) are
re-expressed as harness scenarios or pure-rule tests, not dropped silently.

Owner overrode the recommendation (B).

> "tbh 3K is too much. and I doubt even Fable can salvage them. C) for Kill. Prune, merge,
> update remaining tests to make them test the right way. Behavioural. not some stupid static
> string test (unless it's testing a tmux output or something)"

## Question 5 - What shape do the phone seams take?

Q: One host per ops class following `PresenceHost`; one shared `RepositoryHost`; or constructor
lambdas everywhere?
A: One host per ops class. `DrainHost` and `SessionHost` expose behavior-level methods and never
the six heavy ops classes; a standalone `DrainGate` owns the re-entrant mutex;
`buildOwnerOpRequest(base, appToken, ownerOp): Request` on the transport; pure
`composeReportRead` and `composeScheduledSend` split out of the repository lambda and `fireOne`.
Order: gate and welcome, `PollDrain`, `SessionOps`, transport builder, `reportRead`, scheduled
send, then the five defect tests.

Recommendation reason: the code chose this shape twice after the rewrite (`8d60af34`,
`cf416b5b`), its fakes are proven small, and a heavy ops class stays behind a method instead of
leaking into the test. A shared host reproduces the coupling under a new name; lambdas reproduce
the repository's surface unnamed.

> "sounds good"

## Question 6 - What is the cold-start identity state?

Q: An explicit bootstrap value per participant plus the five scenarios; scenarios only; or a
bootstrap wire op?
A: An explicit bootstrap value per participant, plus the five scenarios. `PhoneBootstrap`,
`GatewayBootstrap`, and `RouterDomainBootstrap` (the name for what `RouterServer`'s constructor
already builds). The rest of the code takes the value as a parameter. The five behaviors (reach
before roster, late reply across restart, owner-id routing, missing-epoch retry, bounded install)
stay harness scenarios. A bootstrap wire op collapsing reach, roster, and the first key request is
a later refinement, not a phase.

Recommendation reason: it erases the class rather than tidying instances, and it is the same
shape Q3 gives the gateway: `GatewayBootstrap` is the top of `composeGateway`'s deps.

> "sounds good"

**Shape, as answered to the owner's "how":** a value type with a private constructor, one
assembler, and a sealed result. Not strict typings alone (a type anyone can construct is
decorative) and not a workflow engine. Kotlin:

```kotlin
internal class PhoneBootstrap private constructor(
	val provisioning: Provisioning,
	val consoleIdentity: Crypto.Identity,
	val ownerSignPub: String,
	val domainId: String,
	val conversationId: String,
	val device: String,
	val keyring: ContentKeyring,
) {
	companion object {
		fun assemble(store: AppStateStore, prov: Provisioning, reach: RouterReachAnswer?): BootState
	}
}

sealed interface BootState {
	data class Ready(val boot: PhoneBootstrap) : BootState
	data class Missing(val needs: Set<Need>) : BootState
}
```

`OwnerOps(boot: PhoneBootstrap)` replaces four nullable providers and `repo`. `ChatRepository`
holds `StateFlow<BootState>` and exposes `suspend fun ready(): PhoneBootstrap`; the onboarding
screen is the one site that renders `Missing`. The Domain id arriving later from reach is the
one `Missing` to `Ready` transition, not a phase machine. TS gateway: `resolveGatewayBootstrap`
extends `decideBootPhase` so `FederationSlice` is built from a `GatewayBootstrap` with
non-optional identity, admission, transport, and keys, and `buildFederationSlice(boot)` stops
re-reading files; `fed()?.x` optional chains shrink to the slice's own lifetime. A residue test
on the existing pattern pins that only the assembler constructs the value.

## Question 7 - The Phase 1 scenario list

Q: Confirm the twelve, or add or drop?
A: Confirmed. Ten path scenarios against the real Router and gateway graph with a fake host and
fake session sockets: live send and reply; `notify_human` by socket and by poll; peek; host
`create_session`; devcontainer wake; presence baseline, delta, projection, plane push, and
`planes_read`; phone `board_write` through to session awareness; session `board_op`; missing
content key through grant, install, and retry; gateway restart with a pending reply on a
retained data dir. Plus the replay-all scenario and the driver-equivalence test. The Bun boot
smoke runs `list_dirs` end to end and stays separate.

> "seems good"

## Question 8 - Phase order, and the clean break

Q: 1, 3, 4, 2, 5; the audit's 1, 2, 3, 4, 5; or 1, 3, 2, 4, 5?
A: 1, 3, 4, 2, 5. Harness and fixtures; phone seams; bootstrap values and the cold-start
scenarios; kill and rewrite; split. Clean break: the 22 hand-written protocol fixtures are
regenerated or deleted; killed tests are deleted, not skipped; no compatibility routes. One shim:
`OwnerOps` keeps defaults for `now`, `newNonce`, `newOpId` between Phase 1 and Phase 4, with a
remove-by comment naming Phase 4.

Recommendation reason: every phase's inputs exist when it starts. Phase 3 completes Phase 1's
Kotlin corpus; Phase 4 needs the harness and a constructible phone; Phase 2 deletes only after
the scenarios carry the rules; Phase 5 moves code and wants the smallest suite to drag along.

> "A it is"

## Facts - Q1 research (six Luna finders)

- **Router is Node already.** `RouterServer` is `node:https` plus npm `ws`; no Bun API under the
  federation server. `startRouter` in the federation-router test helper boots a real Router
  in-process on port 0 with real identities, an owner-signed admission, and real TLS; six
  `*.socket.test.ts` files drive it, but through a native WebSocket helper, not the pinned client.
  `route()` is private and reads the socket; the gateway WS path bypasses it via the HTTPS
  `upgrade` handler, so a real `RouterServer.start()` is the only composition.
- **Gateway is Node except the listener.** `startGateway` is ~1300 lines; `Bun.serve` serves HTTP
  and WS on 20000 (MCP plugin routes, `/bridge` host slot, connector) and the enrollment TLS
  listener. Everything else is Node: the Router client is npm `ws` with `tls.connect` pinning in
  `pinnedDial`, proven under Node by the cert-pinning test. `check:pinning` exists because Bun
  substitutes bare `ws` imports (no peer cert, ignores `createConnection`). Seams today:
  `RoutesDeps`, `WebSocketDeps` with `createMockWs` faking the host slot, and
  `ConsoleHandlerDeps.relayToHost`. `createConsolePushOps` reads `DATA_DIR` on its own. Eleven
  boot timers; the cross-domain reconciler interval is the one without `unref`.
- **The Bun surface is two calls, and the harness does not replace them.** Checked by hand
  after the finders: `Bun.serve` appears twice in the gateway (the main listener and the
  enrollment TLS listener) and once in the MCP connector; every `from "bun"` import is
  `import type { ServerWebSocket }`, erased at runtime. Inside the main listener, `fetch` does
  two `server.upgrade` branches (`/bridge`, connector) and otherwise calls `router(req)`, a plain
  `Request` to `Response` function; the `websocket` handlers delegate to `wsHandlers`. Tests
  already call route functions directly and drive `wsHandlers` with `createMockWs`, a five-field
  object. So `composeGateway` returns `{ router, wsHandlers, close }`, `startGateway` keeps the
  `Bun.serve` block verbatim around them, and the harness CALLS the graph rather than serving it.
  No `node:http` adapter, no second WebSocket server, no new package: runtime deps stay at five
  (`ws` is already there for the Router server and the gateway client). Production keeps
  `Bun.serve`, `server.upgrade`, `maxRequestBodySize`, and the TLS enrollment listener as they are.
- **Every gateway-to-Router frame can drift.** `callTool` takes `Record<string, unknown>`; each of
  ~25 frame kinds is composed as an object literal at its call site and parsed by an independent
  Zod schema in `GatewayBridge` or a registered service. No pair is tied by the compiler; the
  `value_result` `type` field was one instance.
- **Loopback under Node works.** Real `RouterServer` plus real `startRouterClient` over
  `wss://127.0.0.1` with the Router's own `certFp`. Nothing today composes the two.
- **Host daemon.** `HostOp` is a TS union with no Zod schema, seven kinds. Wake is a separate frame
  on the host slot, and `WakeCoordinator` waits for the woken session to register. A harness needs
  both an injected `relayToHost` and a fake host socket.
- **Phone.** `tests/fixtures` is the JVM test resource root via `build.gradle.kts`, so a fixture
  vitest writes is read by the next Gradle run with no config change. No Kotlin test spawns a
  process; only `PostRouterDirectTest` uses MockWebServer. A Gradle test against a spawned bun
  Router is a new system with no precedent.
- **Composers.** 34 wire composers (21 TS, 13 Kotlin). About four are pinned by a fixture and none
  of the operational frames by a fixture its real composer produced. The protocol manifest can
  carry a `producer` field today; the signing manifest's entries are strings and cannot.

Three Luna evaluators scored the harness shapes against 38 fallout hashes. In-process Node (A)
and A plus one Bun boot smoke (B) share a catch table: 18 caught, 6 partial. Seven are Kotlin-only
and no TS harness reaches them (`98424b2e`, `ee02dfe0`, `db7cb073`, `d198b437`, `89da4b82`,
`154a4c09`, `42e1b933`); they are Phase 3's list. Five are instrumentation and two are removal
residue off any live path. Bun subprocesses as the only harness (C) scored 55: no store, clock, or
host control, Kotlin still unreached, and it pressures keeping `startGateway` whole. Both A and B
evaluators warned that the extraction must preserve construction order, and that `close()` and
recompose is not restart coverage.

## Facts - Q2 research (five Luna finders)

- **Kotlin determinism.** 8 of 13 composers can mint deterministically today. `OwnerOps.sign`
  reaches `System.currentTimeMillis` and `randomNonceB64` with no injection; the repository
  `reportRead` lambda and scheduled delivery are reachable only through a full `ChatRepository`,
  which no test constructs; `ContentKeyring.wrapFor` and `wrapAllFor` seal with `SecureRandom`
  inside `Crypto.seal`. `KeyDeliveryOps` already injects `now` and `newNonce`. Signing preimages
  are explicit newline-joined fields, so a fixed clock, nonce, and key set make an `OwnerOp`
  byte-reproducible. JVM tests write only to temp dirs; a committed fixture should come from a
  Gradle generator task, not from ordinary tests mutating resources.
- **Router intake freshness.** `OwnerOpIntake` takes `now` and existing tests pin it. Freshness
  is `REGISTER_MAX_SKEW_MS` (120s). The outer nonce is durably recorded per owner store, so a
  committed request replayed against retained state is refused; a fresh data dir accepts it.
  `RouterServer` exposes no clock: 13 direct `Date.now()` sites under the federation server, and
  `verifyRegistrationClaim` and `rememberRegisterNonce` hard-code it. The one change that makes
  a fixed-time phone request acceptable is a `now` on `RouterServerParams` threaded into the
  owner registry, intake, key service, and registration verification. A committed `board_write`
  also needs `board.meta` seeded at its `expectedRevision`.
- **Why `ee02dfe0` slipped.** `PostRouterDirectTest` asserted the literal `Bearer app-token`, on
  `ConsoleHttp.postRouterDirect`. The masked literal lived in `ConsoleRouterTransport.postOwnerOp`,
  a second `Request.Builder` with no seam, since `51714e8e`. `ConsoleSurface.handleRequest` takes
  a Fetch `Request`, so TS can feed a recorded `{method, path, headers, body}` to the real handler
  socket-free; a wrong PATH is only refused by the private `route`, so path drift needs a public
  route seam or a socket test. No fixture family captures the phone's transport layer today.
- **Fixture lifecycle.** Commit-and-drift-check. `Protocol.kt` and the STTS catalog already use
  regenerate-then-`git diff --exit-code`; `gen-sealed-blob-vectors.ts` has no drift check and can
  rot silently. Mint-at-test-time creates a producer cycle across vitest and Gradle that no single
  pass satisfies.
- **Kotlin tests today.** 1,152 `@Test` methods. `OwnerOps`, `KeyDeliveryOps`, `BoardRouterWriter`,
  `PresenceOps` (through `PresenceHost`), and the socket client are constructible with fakes.
  `ConsoleRouterTransport`, `PollDrain`, `ScheduledSendOps`, and `ChatRepository` are not
  constructed by any test. `PollDrain` reaches `repo` 34 times over 18 members; `SessionOps` 65
  times over 17. Of the seven Kotlin-only defects, three fixes added a test (all `PresenceOps`,
  seam already present); four added none, and two of those could not be tested without crossing
  `ChatRepository`. Phase 3 is mostly seams, then tests.

Three Luna evaluators scored the pinning contracts against the seven Kotlin-only hashes and the
eight phone-decoding halves. Two-way minted fixtures, committed and drift-checked (A) scored 84;
A plus replay of Kotlin-minted requests in the harness under one shared fixed identity set (B)
scored 86; one-way fixtures plus Kotlin request-capture tests (C) scored 58. A and B catch both
Kotlin composer defects (`98424b2e`, `ee02dfe0`) and all eight decoding halves; C catches the
nonce only through the regex twin that was itself a patch (`e8eb7bc5`), and its capture tests
prove construction, not Router acceptance. All three leave about twelve vocabulary families
pinned by hand (signing preimage order, op and frame kinds, versions, paths, header names); that
is a constants class for codegen, not a fixture class. The five `PollDrain`, `PresenceOps`, and
`SessionOps` defects stay Phase 3's regardless. A's evaluator warned that the Kotlin generator
boundary must be narrowed in Phase 1 or the repo-bound composers and `Crypto.seal` randomness
turn the contract into a Phase 3 rewrite. B's evaluator: the generator must instantiate the real
composers named in each fixture's metadata and refuse hand-built JSON, and each side's output
must be consumed by the OTHER runtime's real parser, never re-derived by its own.

## Facts - Q3 and Q5 research (four Luna finders)

- **A strict move of `startGateway` preserves order.** No construction statement must move. The
  graph's cycles are all closed by late-bound `let` variables and optional chaining
  (`PendingJobStore` to `shareAttestor`, `sessionReporter` to `fed()`, the federation slice to its
  own `routerClient`, `inboxPump` to `consoleDeliveryHandler`, `ChannelDeliveryCoordinator` to
  `wsHandlers`, `keyRequester` to `routes`). What a move alone cannot give is `close()`: the
  `Bun.serve` result is discarded, the reconciler and share-sweep interval handles are dropped,
  four other handles are retained but never cleared, `SIGTERM`/`SIGINT`/`uncaughtException` are
  registered with no `process.off`, `sessionReporter` monkey-patches `SessionStore`, and
  `createPresenceReporter` and `createKeyRequester` expose no stop. `createConsolePushOps` reads
  `DATA_DIR` itself; `routerBootstrapOverride` reads its two env vars itself.
- **Clocks.** The gateway graph has 42 `Date.now()`/`new Date()` sites across its modules; a
  handful already take `now` (`createWebSocketHandlers`, `shareAttestor` partially, `CapabilityStore`,
  `IntentTracker`, the Codex and Copilot relays, `SessionStore`). The Router has 13 direct sites and
  9 timer sites; `OwnerStoreRegistry`, `OwnerOpIntake`, board, share, blob cache, console sockets,
  the three coordinators, `TenantAdmin`, and `PublicApproval` already accept `now` and `RouterServer`
  simply does not pass one. The three `RouterServer` sites (roster, transport, trust-pending) and
  `verifyRegistrationClaim` plus `GatewayBridge.rememberRegisterNonce` need a small signature
  change. Verdict from the finder: one clock seam in Phase 1, timers stay real, no fs/logger/process
  ports until Phase 5. Fake timers are used by ten tests, all on mock sockets; none against real
  `ws` or HTTPS.
- **Router seam.** `RouterServerParams` is seven fields, no `now`. A public `handle(Request)`
  split out of the private `route`/`resolve` is feasible (health, body caps per path, token check,
  dispatch, 404); `serve()` stays the sole `IncomingMessage` adapter and the WebSocket upgrade
  stays in `start()` because it needs the raw socket and head. `stop()` is nearly complete; scheduled
  `chainedTimer` handles are not retained. Two instances in one process are safe with separate
  data dirs. A fixed identity set needs the federation JSON seeded before `store.init()` or a
  `SecretIO` seam; the console admission is `{kind: "console", signPub, boxPub, issuedAt, nonce}`
  under `signAdmission`, and no existing test mints one.
- **Owner core paths.** All nine paths mapped hop by hop with schemas. The MCP plugin process is
  never needed: a fake session socket registered through `wsHandlers` with a `WsRegisterSchema`
  frame (`type: "register"`, `team`, `subId`, `mode`, `conversationId`, `deliveryProtocol: 1`,
  `sessionToken` when bound) receives `register_ok`, then a handshake `channel_push` it answers
  through `/respond`. The wake frame has no Zod schema. The late reply (path 9) is held in the
  gateway's durable `OwnerRowOutbox` until `inbox_append` succeeds, so the restart scenario must
  retain the data dir across recomposition. Smallest set that walks every hop once: ten scenarios
  (live send and reply; `notify_human` by socket and by poll; peek; host `create_session`;
  devcontainer wake; presence baseline, delta, plane push, `planes_read`; phone `board_write` to
  session awareness; session `board_op`; missing key to grant to retry; restart with a pending
  reply).

## Facts - Phase 2, 3, 4 research (three Luna finders)

- **Cull by kind is small.** Static count is 2,916 `it` declarations (3,136 at runtime with
  `it.each`). Prose assertions: 167 occurrences, top files `channelFiles`, `ref-artifacts`,
  `thread-markdown-link-rules`, `board-awareness`, `build-launch-command`. Call-order keys: 76,
  a third of them in `presence-reporter.test.ts`. Stubbed peer answers: 49 candidates. Residue:
  32 files, 172 cases; 25 keep (derived scans or cross-runtime pins), 7 rot candidates
  (`federation-manager`, `gateway-retained-state`, `inbox-service`, `install-layer`, `module`,
  `resolve-bun`, `setup-verify`). The categories overlap and together are roughly a tenth of the
  suite. The larger lever is the twelve fake helpers under `src/__tests__/helpers` (`fakeRouter`,
  `makeCtx`, `makeConsoleSeam`, `createMockWs`, `makeValueHarness`, `mountBlobWire`, and the rest)
  and the overlap groups: `routes.ts` has five test files and 101 cases, `session-store` five,
  `websocket.ts` three with 76. Kotlin: 45 prose asserts, 85 reflection sites in 37 files.
- **Phone seams follow `PresenceHost`.** The repo has settled on: the ops class owns behavior and
  takes a narrow interface; production supplies a `ChatRepository*Host` adapter; tests a small
  fake; constructor lambdas only for tiny stateless collaborators. `8d60af34` and `cf416b5b`
  used exactly this. `PollDrain`'s 18 members split into trivial lambdas and flows versus six
  heavy ops classes (`MailboxSync`, `AttachmentOps`, `PlaybackOps`, `PresenceOps`,
  `IdlePushbackManager`, `ConsoleTransportCoordinator`); `SessionOps`'s 65 reaches concentrate in
  five behaviors (terminal ops, spawn state, forget persistence, forget side effects, directory
  picker). Proposal: `DrainHost` and `SessionHost` exposing behavior-level methods, never the
  concrete ops classes; a standalone `DrainGate` for the re-entrant mutex; a welcome-plane
  method on `DrainHost`; `buildOwnerOpRequest(base, appToken, ownerOp): Request` on the
  transport; a pure `composeReportRead`; a `composeScheduledSend` split out of `fireOne`. Order:
  gate and welcome, `PollDrain`, `SessionOps`, transport builder, `reportRead`, scheduled send,
  then the five defect tests. Three of the five defects are already reachable through
  `PresenceHost`; `d198b437` and `89da4b82` need `DrainHost`.
- **Cold start has no bootstrap object on any participant.** The five identity patches each read
  as "X was needed before Y was available": Domain id before the roster that carries it; owner
  identity before a conversation map existed; owner id before a live-socket lookup; durable
  conversation ownership and a first epoch before restart recovery; a bounded bundle and
  `allowlist.domainId` before enrollment could install safely. The phone's `Provisioning` holds
  the Router endpoint, pin, app token, device, and conversation id but not the console identity,
  Domain id, keys, or roster; `confirmedDomainId` centralizes the Domain id with 24 call sites and
  `SessionsScreen` duplicates its predicate. The gateway assembles identity from seven loaders at
  the top of `startGateway`. Proposed: `PhoneBootstrap`, `GatewayBootstrap`, and
  `RouterDomainBootstrap` as values the rest of the code takes as parameters, which makes
  "sign with no Domain id", "route with no gateway identity", and "consume a mailbox with no
  keyring" unconstructible. The five patches themselves stay harness behaviors (reach before
  roster, durable owner routing across restart, direct owner-id routing, missing-epoch retry,
  bounded install, incarnation fencing).

## Facts - Phase 1 build inputs (two Luna finders)

- **The identity set.** The Router's `federation.json` holds its own identity and a Domain map
  (`ownerSignPub`, `ownerBoxPub`, `admissions`, `revocations`, `isAdminDomain`); console
  admissions live inside a Domain's `admissions`. `FileSecretStore.init()` generates the Router
  identity only when the file is absent and takes an optional `SecretIO`, which is the seam.
  The gateway needs `federation-identity.json`, `federation-allowlist.json` (with `domainId` and
  an owner-signed gateway admission whose keys match the identity), `transport.json`
  (`routerUrl`, `routerCertFp`, `bearer`), and `content-keys.json` (`{v: 1, keys: {"1": ...}}`);
  `buildRegisterAuth` finds its own admission by `selfAdmission(sign.pub)` and signs
  `REGISTER_V1`. The phone's `Provisioning` is a plain data class (`routerUrl`, `routerCertFp`,
  `appToken`, `device`, `conversationId`) constructible without Android; the console identity,
  owner identity, Domain id, gateway id, and content-key map live in `AppStateStore` under named
  keys. The epoch key is HKDF over the owner signing private key with the Domain id and epoch,
  so a fixed owner key fixes epoch 1. The signing vectors carry owner signing pairs
  (`provision-ops`, `transport-request`) but no complete owner, console, or gateway identity with
  a box private key. One fixture file: `router.identity`, `domain.{id, owner, isAdminDomain}`,
  `gateway.{id, identity, admission}`, `console.{device, conversationId, identity, admission}`,
  `transport`, `content.{epoch, key}`.
- **The boot smoke.** `RouterServer.start` binds `PORT=0` and logs the real port and TLS
  fingerprint; `main-federation.ts` then logs "ready on port 0". `startGateway` discards the
  `Bun.serve` result and logs the configured port, so a `PORT=0` gateway has no readable bound
  port. `decideBootPhase` activates on `transport.json` plus a Domain id, so pre-seeding avoids
  `ENROLL_NONCE` arming. `routerStart.ts` is a Docker and `.env` helper hardcoded to 20001, not
  reusable. The fake host registers on `ws://127.0.0.1:<port>/bridge` with `WsRegisterSchema`
  (`team: "host"`, `token`), answers `host_op` by `reqId`, and sends a `catalog`. The cheapest op
  that crosses all three is `list_dirs` (no session target). Steps: temp dirs, Router under bun on
  port 0, read `/health` for port and `certFingerprint`, seed Router Domain and gateway files,
  gateway under bun on port 0, poll its `/health`, fake host, wait for registration, post the
  console-signed `list_dirs` OwnerOp, assert the host's reply, SIGTERM gateway then Router,
  bounded kill. Two entry-point changes: `main-federation` reports the bound port, `startGateway`
  keeps the `Bun.serve` result and reports its bound port.

## Facts - Phase 5 and the constants item (two Luna finders)

- **`routes.ts`.** `RoutesDeps` is 36 fields. The shared context is `config`, `registry`,
  `conversationRegistry`, `store`, `auth`, and the address helpers; single-route fields are
  `capabilityStore`, `daemonCapabilityStore`, `tryWakeTeam`, `sessionStore`, `awareness`,
  `deliveries`, `boardClient`, `boardReplays`, `routerCertFp`; `resolveHandshake` is destructured
  and never used. Eleven HTTP handlers: `send` 281 lines, `respond` 240, `taskBoard` 230, the rest
  under 45. `humanNotify` and `pluginAction` come from `createConsolePushOps`, which `createRoutes`
  constructs inside itself. The blob routes (`/blob/stat`, `/blob/put`, `/blob/get`) and the
  enrollment routes are inline in `startGateway`'s `router`, not in `createRoutes`. Four helpers
  capture nothing and can be module-level today (`replayKeyOf`, `projectForAgent`, `liveSubtree`,
  `cutToBudget`). Split by the field matrix: `routesStatus`, `routesCapabilities`,
  `routesPresence`, `routesSend`, `routesRespond`, `routesBoard`, `routesHumanNotify`
  (a wrapper over `createConsolePushOps`), `routesBlob`, `routesFederationPresence`, behind a
  compatibility `createRoutes(ctx)` so the five `routes-*.test.ts` files and `makeCtx` keep their
  shape. The `startGateway` residue splits into thirteen modules in its existing compose order
  (bootstrap, stores, sessions, persistence, host, agents, awareness, federation, websockets,
  routes, router handlers, HTTP router, listener); four late-bound cycles must stay closures
  (`channelDeliveries` with `wsHandlers`, `routes` with federation, `routes` with the console
  handler, `routes` with the Router presence handlers). The `router` function needs
  `{handleEnrollPost, enrollNonce, admitPayload, blobStore, sessionAuthority, agentRoutes}` and is
  async because it parses JSON.
- **`codegen-kotlin`.** Reads twelve schema roots by `.meta({id})` plus twelve named constants,
  emits `object Protocol` (twelve constants today: console protocol version, session-id
  vocabulary, blob and board limits), data classes, and eight sealed classes; no enums, no
  serializers. CI regenerates and `git diff --exit-code`s the proto directory. Kotlin already
  reads `Protocol.*` values in `ChatRepository`, `SessionId`, `BoardOps`, and the blob code, so a
  generated `Protocol.Wire` needs only an import at `ConsoleRouterTransport` and
  `ConsoleSocketClient`. Hand-duplicated today: the Router paths (16 inline literal sites in
  runtime TS), the console header (named `APP_TOKEN_HEADER` in `ConsoleSurface`, inline lowercase
  in `RouterServer.resolve`, inline in five Kotlin files), the Bearer prefix (4 TS template sites),
  the dispatch-only owner-op kinds (`deliver`, `consumer_register`, `inbox_read`, `inbox_advance`,
  `board_read`, `board_write`: `OwnerOpSchema.op` is an open record, so no Zod literal exists),
  every signing preimage tag (`OWNEROP_V1`, `KEYENVELOPE_V1`, `REGISTER_V1`, `ADMISSION_V1`,
  `DEVICE_JOIN_V1`, the key, roster, transport, xdomain, and tenant tags), the federation floor and
  version, and the inline nonce lengths 12 and 18. The `ConsoleOp` kinds, socket frame kinds, key
  op kinds, `gateway_value`, and `planes_read` are Zod literals and emittable with a constants
  pass. Shape: `src/shared/wire-vocabulary.ts` as the sole TS declaration, the generator emits
  `Protocol.Wire`, and a residue test on the `aad-kinds-residue` and `board-refusal-residue`
  pattern rejects the literals anywhere else on both runtimes.

# Plan

Order: Phase 1, 3, 4, 2, 5. Clean break. Each phase lands as one commit series on `main` once
its gates pass; the tree builds at every step. Gates: `bun run lint`, `bun run test`,
`./scripts/kotlin-gate.sh`, `bun run check:pinning`, and from Phase 1 on `check:boot` and the
fixture drift checks. Each phase gets its own audit when written; alignment findings are judged
against this file, not a rendered step block.

Process: no refinement laps; the plan is too open to lock down ahead of the code. Each phase
runs as one `audited-implementation` lap without the compliance steps. At the end of each lap,
reassess the remaining phases against what the finished one taught and rewrite their slices
here before the next lap starts.

> "We can skip refinement. it's too vague to really concretely lock down. Just do a reassess of
> future phases, each phase you complete."

## Phase 1 - Federation harness ✅

The wire is tested by the code that composes it.

### Slices, as shipped (`1e0c7857`, `77e27c48`) ✅

1. **Compose seam.** `composeGateway(deps)` holds the whole graph and returns `{ router,
   wsHandlers, close }` plus the stores and clients the harness reads (`GatewayGraph`).
   `GatewayDeps` is `{ config, now, randomBytes, openEnrollTls, allowFixtureIdentity }`; ids and
   nonces derive from `randomBytes`. `close()` flushes, clears every retained timer, stops the
   reporters, the attestor, the awareness bank, the presence pusher, the key requester, the routes,
   and the Router client, and detaches `sessionReporter`. `startGateway` reads the environment,
   composes, registers the signal handlers, and keeps the `Bun.serve` handle to log the bound
   port. `routerBootstrapOverride(host, port)` is pure. `routes.ts` keeps an environment fallback
   for `dataDir` until Phase 2 kills its bare callers.
2. **Router seam.** `RouterServerParams.now` reaches every time-aware constructor,
   `GatewayBridge`, and `verifyRegistrationClaim`. Public `handle(request: Request)` shares
   `preflight` and `dispatch` with the `IncomingMessage` adapter; `serve()` and the upgrade stay in
   `start()`. `main-federation` logs the bound port and refuses the fixture identity unless
   `ALLOW_FIXTURE_IDENTITY=1`.
3. **Identity set.** `tests/fixtures/identity/set.json`, minted by `scripts/gen-identity-set.ts`:
   `router.identity`, `domain.{id, owner, isAdminDomain}`, `gateway.{id, identity, admission}`,
   `console.{device, conversationId, identity, admission}`, `tokens.{console, federation, host}`,
   `content.{epoch, key}`. The Router URL and certificate fingerprint are runtime values.
   Seeders in `src/testing/identitySet.ts`: `seedRouter` through `FileSecretStore`, `seedGateway`
   through the federation files. Kotlin reads the same file as a test resource and builds its
   `Provisioning` and identities from it. `src/shared/fixture-identity.ts` names the four fixture
   signing keys; the shipping entry points refuse them.
4. **Harness.** `startFederationHarness()`: temp dirs, a real `RouterServer` on port 0, a real
   gateway graph over loopback with the Router's own `certFp`, `attachFakeHost` and
   `attachFakeSession` at the gateway's own WebSocket handlers, a console socket against the
   Router's TLS listener, and a TS phone driver on `router.handle`. Real timers throughout;
   scenarios poll with `waitFor`. `restartGateway` recomposes over the retained directories;
   `close()` is host, gateway, Router in turn, and a failed start removes the temp root.
5. **Scenarios.** Fourteen in `federation-harness.test.ts`, each self-contained through lazy
   shared sessions: list_dirs through the host; an unknown path answers 404; send and reply; host
   create_session and notify_human by poll; presence projection; devcontainer wake; phone
   board_write into session awareness; session board_op; presence plane push over a socket;
   empty keyring grant and retry; peek; presence row after a close; notify_human by socket;
   restart with a pending reply. Presence baseline and delta frames are TS fixtures fed to the
   real Router. `wire-fixtures-kotlin.test.ts` holds replay-all and driver-equivalence.
6. **Minted fixtures, TS.** `scripts/gen-wire-fixtures.ts` drives `sealOwnerRow`, the presence
   reporter, `createSessionRegistryReporter` over a real `SessionStore`, `createBoardClient`,
   `createKeyRequester`, `composeValueResult`, and `registerFrame` with `buildRegisterAuth`,
   under the set, the fixed clock, and a per-case draw counter. Files are
   `tests/fixtures/wire/ts/<composer>/<case>.json` with `{producer, composer, case, clock, inputs,
   frame, phone?, expect}`. `check:fixtures` regenerates into a temp tree and diffs.
   `wire-fixtures-ts.test.ts` feeds every frame through the live pinned link and reads the owner
   rows back; `WireFixturesDecodeTest.kt` decodes and opens every fixture with a `phone` block.
7. **Minted fixtures, Kotlin.** `OwnerOps` takes `now`, `newNonce`, `newOpId` behind a dated
   shim. `WireFixtureGenerator.kt` runs under `./gradlew :app:generateWireFixtures` and, in
   ordinary test runs, asserts the committed files byte for byte. Corpus: `OwnerOps.sign`,
   `KeyDeliveryOps.requestMissing` and `onKeyGrant`, `BoardRouterWriter.write` (through the
   `BoardSealing` nonce seam), `CursorTranslationOps.onWelcome`, the four `PollDrain` ops through
   `ConsoleClient`, and the transport family from `buildOwnerOpRequest`, `buildHealthRequest`,
   `buildConnectedGatewaysRequest`, `buildReachRequest`, `buildSocketRequest`. The generator
   drives the real composers; no request or op JSON is hand-built. `kotlin-gate.sh` regenerates
   into a fresh directory and diffs. Vitest replays every request through `router.handle` at the
   fixture clock, asserts the declared verdict, replays the socket upgrade against the real
   listener, and reproduces every signed op through the TS driver: the same fields and the same
   signature, which covers the canonical signing bytes.
8. **Wire vocabulary.** `src/shared/wire-vocabulary.ts` declares the Router paths, the console
   header and Bearer prefix, the owner-op kinds the Router dispatches, the signing tags, and the
   nonce lengths; the federation floor and version stay in `router-protocol.ts`. `codegen-kotlin`
   emits `Protocol.Wire` with `ConsoleOpKind`, `SocketFrame`, and `KeyOpKind` from the Zod
   literals. Every Kotlin consumer reads the constants; `wire-vocabulary-residue.test.ts` scans
   every main-source Kotlin file and every runtime TS file.
9. **Bun boot smoke.** `scripts/check-boot-runtime.ts`: temp dirs; Router on port 0, port and
   fingerprint from its log lines; seed both from the set; gateway on port 0; `/health`; fake host
   over real `ws`; registration; the console-signed `list_dirs` over the gateway's `pinnedDial`;
   SIGTERM both; bounded kill. `check:boot` beside `check:pinning`.

### Bug classes

- Gateway-to-Router disagreement: every frame kind minted by its composer and parsed by the real
  peer; a `type` field the sender never writes is red before ship.
- Composition residue: a dropped constructor line fails the first scenario; `close()` lists
  every retained timer in one place.
- Phone decoding drift: Kotlin decodes what TS mints, not a hand-written sample.
- The two Kotlin composer defects: a UUID nonce or a masked header is refused by the real intake
  in vitest.
- Path and header drift: one declaration, generated twin, residue-fenced.
- Classes 3 and 5 gain a bench; they close in Phase 4.
- Clock defaults, patched three times in one lap (`routes.ts`, `CrossDomainShareState`,
  `consoleSockets.ts`): a per-module optional `now` whose default captures `Date.now` by
  reference defeats fake timers, and a module that takes `now` can still read the wall clock on
  one path. The mechanism is the per-module default; the fix is Phase 5's ambient context and its
  residue fence.

## Phase 3 - Phone repository seams ✅

### Slices, as shipped (`06431c53`, `4d0cfbb2`) ✅

`DrainGate` owns the re-entrant mutex, keyed to the gate instance; `PresenceHost` and `PollDrain`
share the repository's one gate. `DrainHost` exposes `readPlanes` and `applyPlane`;
`PollDrain.applyWelcomePlanes` skips the planes read when the welcome names nothing newer than
the held versions, and `applyPlane` gates the socket push. `SessionHost` exposes the forget
cascade as `cancelScheduled`, `cancelGoal`, `dropPlayback`, and the persistence calls;
`reapplyCachedTeams` is suspend so relaunch awaits it; `launchInBackground` runs on `repoScope`,
so a wake or a gateway forget before the first poll no longer vanishes; the spawn claim is one
atomic `getAndUpdate`. Pure `composeReportRead(team, anchor, at)` feeds both report-read paths
(`ConsoleClient.reportRead` and the migration lambda); signing stays with `OwnerOps`.
`composeScheduledSend(rec, at)` and `composeCapabilitiesReport(plugins)`. Entropy hooks, not
nonce-only: `Crypto.seal` draws the ephemeral key and the nonce from one `(Int) -> ByteArray`,
threaded through `wrapContentKey`, `ContentKeyring.wrapFor` and `wrapAllFor`, and
`KeyDeliveryOps.wrapEntropy`; `ConsoleClient.sealNonce` covers deliver and value ops; a null hook
draws from `SecureRandom`. `OwnerOps` takes its seven lambdas with no repository and no defaults;
`KeyDeliveryOps` is constructed with named arguments at every site. The five defect tests:
`PollDrainTest` (re-entry, welcome fetch, refetch after a cursor reset), `PresenceOpsTest` and
`PresenceMergeTest` (the three presence defects, with the pure roster rules kept as decision-rule
tests).

Corpus: `tests/fixtures/wire/kotlin` grew from 13 to 20 cases (deliver, gateway value, key grant,
report read, capabilities, board read; the inbox ops named for their composer `ConsoleClient`).
`WireFixture` is a Zod discriminated union with a generated Kotlin twin; both generators build the
value through it and derive the manifests; `check:fixtures` parses every committed file and
manifest entry on both sides; `kotlin-gate.sh` also diffs a fresh `Protocol.kt`; the draw
namespace follows `<producer>:<composer>:<case>:<n>` on both sides. The TS side opens every
phone-sealed envelope (key grant, delivered row, value payload, board title) with the set's
content key, which is what caught the generator sealing under the console identity instead of
the Domain owner's. `WireFixturesDecodeTest.kt` had decoded nothing since Phase 1; it now
decodes every TS fixture through the twin.

Not shipped, by decision: a `KeyDeliveryHost`, and the nine ops classes still bound to
`ChatRepository` (Attachment, Board, DeviceApproval, DomainAdmin, EnrollCeremony, Goal,
Playback, ScheduledSend, Trust). Both move to Phase 4, where the bootstrap value changes their
constructors anyway.

### Bug classes

- Phone state with no seam (class 4): met for the four host-taking classes (`PollDrain`,
  `SessionOps`, `PresenceOps`, `RenameOps`), each constructible in a JVM test over a fake; open
  for the nine repository-bound classes, Phase 4.
- The fixture contract reaches every signed-op composer and request builder on the phone, its
  shape is one schema on both runtimes, and every sealed fixture is opened by its real peer.

## Phase 4 - Cold-start identity state ✅

### Slices, as shipped (`72b8098d`, `18318587`) ✅

**Phone:** `PhoneBootstrap` (private constructor; `assemble(store, federation)` answers
`Ready(boot)` or `Missing(needs)`). Ready carries the provisioning, the console identity, the
Domain owner's sign pub, the Domain id, and the content keyring, and reads the admission keyring
live through `keyring()`. The Domain id is the stored one, else an invite's pending tenant, so an
invited device is Ready to first-root. `PhoneAmbient` carries `now`, `newNonce`, `newNonceBytes`,
`newOpId`, `wrapEntropy`, and the missing-epoch timer. `OwnerOps(boot, ambient)`;
`KeyDeliveryOps(boot, ambient, KeyDeliveryCollaborators)`; `ConsoleClient(boot, ambient, store,
coordinator, ConsoleClientCollaborators)` with no storage fallback keyring; `BoardSealing(boot,
ambient, onMissingEpoch)`; `CursorTranslationOps` with no defaults. `PhoneIdentity` is the one
door for identity facts (`provision`, `saveBlob`, `learnDomainId`, `installApproved`,
`importOwnerBackup`, `applyDomainSync`, `mergeAdmission`, `mergeRevocation`,
`ensureContentEpochs`, `installContentKeys`, `clear`): each write is serialized and re-assembles
the boot. `ChatRepository` exposes the door's `bootState`, `readyOrNull`, and `ready`, caches
`OwnerOps` and `KeyDeliveryOps` per boot, and syncs `ChatState.domainId` from the flow.
`confirmedDomainId` is gone: the token-only reach (`ConsoleRouterTransport.apiReachable`) and the
signed roster feed `learnDomainId`. Onboarding renders `Missing`; `SessionsScreen` reads
`ChatState.domainId`.

**Role ports:** four shared ports (`ClientPort`, `IdentityPort`, `PresencePort`, `PlaybackPort`)
plus one per-class collaborator record for the repository calls only that class makes; nine
adapters in `RepositoryCollaborators.kt`; shared fakes `TestIdentityPort`, `FailingClientPort`,
`IdlePresencePort`. State and persistence stay `MutableStateFlow<ChatState>` and
`ChatPersistence`. Behavior tests for all nine classes. `DrainHost`, `SessionHost`, and
`PresenceHost` stay flow seams. Pure decisions were extracted only where cheap
(`verifyDeviceJoin`, `scheduledSendJournalDecision`, `shedDeadAttachmentFailures`).

**Gateway:** `GatewayBootstrap.resolve(paths, env, io)` (private constructor) answers `active {
boot } | arming { nonce } | standalone { missing }`; the boot carries identity, Domain id,
transport, allowlist, content keys, and the cached reach, and `buildFederationSlice(boot)` reads
them. `composeGateway` builds the data dir, the identity loader, and the content key store first,
since arming and standalone need them, and re-resolves after a bootstrap install. `routes.ts`
requires `dataDir`. The registration hook requests every missing epoch below the oldest held.

**Router:** `RouterDomainBootstrap.assemble` names what the constructor builds.

**Fixture world:** `FixtureWorld.from(set)` on both runtimes verifies the content key derivation
and both admissions, and assembles the values its participants have (TS the gateway boot, Kotlin
the phone boot and client). `FixtureDraws.forCase(...)` is the one per-case counter. `WireSealed`
blocks declare every sealed value on both producers (`phone.sealed` on TS fixtures, `sealed` on
Kotlin ones), and each reader scans its frame for undeclared envelopes. `IdentitySet` keeps its
name; the file is `identity/set.json`.

**Residue:** `bootstrap-residue` (only the assemblers construct the values),
`phone-identity-residue` (only the door writes identity facts or assembles the boot).

**Scenarios:** reach before roster; bounded bootstrap install requesting the missing epoch;
Router restart with one registration in the reach roster and one presence row after
re-registration. Phase 1's live send-and-reply pins owner-id routing: the reply lands in the owner
mailbox with no console socket open.

### Bug classes

- Identity bootstrap (class 3) as a shape: held. Signing, routing, and mailbox consumption take a
  Ready boot.
- Identity facts written without re-assembling the boot: nine patches in one lap showed the
  mechanism (an eager flow beside stores open to any writer). The door and its residue fence make
  the class inexpressible.
- Constructor lambda bundles, and two fixture worlds: held.
- Phone state with no seam (class 4): held for the nine ops classes.
- Not held: stale-incarnation fencing is pinned through the roster, not by replaying an old
  frame; a second device's boot binds the local owner key, which predates this phase.

## Phase 2 - Kill and rewrite ✅

### Slices, as shipped ✅

**Kill:** About 23,000 lines of tests removed. The twelve fake helpers and their suites
(websocket, console seam and delivery, routes, codex-agent, codex-persistence, codex-relay,
cross-domain-handshake, cross-domain-presence, tenant-admin, federation, blobWire, replyTool)
went with the by-kind categories, the seven rotting residue inventories, the structure probes
(`data-dir-inventory`, `host-spawn-wiring`, `s10-residue`, the `session-authority` file scan),
the three Kotlin-scanning probes, and the gateway-board no-ops with their forwarders and the one
test over them. `bootstrap-residue`, `phone-identity-residue`, and the six fence consumers of
`helpers/residue.ts` stay. `helpers/federation-router.ts` serves the five socket suites, trimmed
of the no-op upgrade smoke test and the cases the harness covers.

**Merge:** `routes`, `session-store`, `websocket-live-incarnation`, `codex-agent`, and
`owner-state-store` are one file each.

**Rewrite:** Eight harness scenario files replace the killed suites on the real Router and
gateway graph: sessions (bindings, impostors, worker answers, transcript handover, duplicated
deliveries, reply authority, the wake boundary, create, rename, close, forget, tmux, peek,
notify, capabilities), handshake (verifying before confirmation, retained reconnects, a stale
close), domains (two and three Domains linked through the real handshake, shares and the Router
record, send and reply, unshare, unlink, colliding gateway ids, a forged reply, a repeated opId),
xdomain (the share gate, the wake authorization, return-route authentication, a relay retried
across a Router outage, unlink of in-flight work, share auto-forget), router (tenant provision
with replay across a restart, first root, rename and its refusals, removal, deletion, device
approval, the trust rendezvous), codex (start, message, list, stop, replayed frames, gateway and
daemon restarts), and boot (one presence row per team after a restart, a notice held through a
Router outage). The harness grew `mintIdentitySet`, `addDomain`, `link`, `restartHost`, the
fake Codex daemon with schema-checked frames, the phone driver's `console()` and `enroll()`, and
fake sessions that answer as workers or present binding tokens. Pure survivors assert sequences
on named rules: `federation-pure-rules`, `cross-domain-handshake` (the coordinator's limits and
mismatch refusals), `router-coordinators` (rendezvous, approval, and tenant limits),
`owner-op-intake` (one answer per in-flight duplicate, Domain-scoped caps, the admission
refusals, quarantine), `cross-domain-presence` (consumer, pusher, reconciler, source),
`share-rules`, `codex-relay`, `codex-turn-tracker`, `local-agent-publication`, `channel-file`,
`reply-attachments`. `codex-daemon-service` drives the real `ThreadLifecycle`, tracker, and
transport over a scripted JSONL App Server in 25 sequences; only the launcher is a double.

**Catalog:** `presence_read`, `schedule_send`, `capabilities_read`, `cursor_translate` joined
`OWNER_OP_KINDS`; `accepted`, `applied`, `cursor_stale`, `stale_incarnation`, `no_waiter` are
constants the codegen emits into `Protocol.Wire` and both runtimes read; `preimage-tag-twins`
reads `SIGNING_TAGS`. The TypeScript fence keeps paths, the header, and the tags: owner-op kinds
are typed by the schemas and serve as hook keys, so a literal there is not residue. The catalog
is still a hand list the codegen reads; deriving it from the schemas is Phase 5's registry.

**Kotlin:** Asserts on rendered sentences became kind, presence, or distinctness asserts; text
formatters keep their outputs. The eager stubs were already getters. The Proxy-based OkHttp fakes
stay. A share posts the Router record before the Gateway mirror and withdraws it when the mirror
refuses, pinned in `ConsoleClientOwnerOpsTest`.

### Defects the scenarios found

Six shipped defects, fixed in the same commit: the Router client dropped
`cross_domain_handshake_reveal`, so linking never completed; the requester's pairing carried the
console key instead of the Domain root, so the confirm refused; the phone never wrote the Router
share record, so every cross-Domain send was refused at the Router while `relayToGateway`
reported the refusal as running; a peer reply into the origin Domain failed the share gate;
Router unlink never dropped the link edge; a refused Codex delivery never woke the route's
waiter, so the call held for the whole budget.

### Bug classes

- The hidden class: held. No survivor asserts a fake's bookkeeping, a call order, or a sentence.
- False confidence from a hand-built peer: held for the Router, the gateway, the sessions, and
  the daemon boundary. The six defects above lived under green fake-backed suites.
- Not held: the daemon's App Server is a scripted child, not `codex app-server`; the phone is the
  TypeScript driver, not the app; host and session frames the fakes exchange are not
  schema-checked, since no shared schema names them.

## Phase 5 - Split

### Slices

Reassessed after Phase 4.

1. `routes.ts` into modules by the field matrix (`routesStatus`, `routesCapabilities`,
   `routesPresence`, `routesSend`, `routesRespond`, `routesBoard`, `routesHumanNotify` over
   `createConsolePushOps`, `routesBlob`, `routesFederationPresence`) behind a compatibility
   `createRoutes(ctx)`; the four captured-nothing helpers to module level; `resolveHandshake`
   dropped from `RoutesDeps`.
2. The `router` function to its own module taking `{handleEnrollPost, enrollNonce, admitPayload,
   blobStore, sessionAuthority, agentRoutes}`, with the blob and enrollment routes beside it.
3. `composeGateway`'s residue into the thirteen modules in compose order (bootstrap, stores,
   sessions, persistence, host, agents, awareness, federation, websockets, routes, router
   handlers, HTTP router, listener); the four late-bound cycles stay closures. `GatewayGraph`
   shrinks to `router`, `wsHandlers`, `close`, and an explicit fault port (link down, keyring
   state) that replaces the harness's `federation().routerClient.stop()`,
   `contentKeyStore.epochs()`, `federation().sealer`, and `crossDomainPeers` reads.
   `RouterHandlers` splits frame dispatch from the presence-push lifecycle. The gateway takes the
   phone door's shape: one active federation context published atomically on a bootstrap install
   replaces the outer `gatewayBoot` and `localDomainId` captures and the `routerCertFp` the
   routes read, which go stale after an install today. That context owns the share record: it
   posts the Router record when it writes its own mirror, replacing the phone's two posts and the
   compensating unshare.
4. **Ambient context:** One injected record (clock, entropy, ids, timers) through
   `composeGateway` and `RouterServerParams` replaces the per-module `now?`, `randomBytes?`,
   `newId?` defaults (25 `Date.now` sites; the timers in `routes`, `wake`, the relays,
   `crossDomainPresence`, `routerClient`, `gatewayBridge`, `consoleSockets`, and the websocket
   handshake re-send and expiry, which read the process clock behind `createWebSocketHandlers`
   and so have no harness scenario). A residue test
   fences direct `Date.now`, `randomBytes`, `randomUUID`, `Math.random`, `setTimeout`, and
   `setInterval` outside the adapters. Closes the clock-defaults bug class from Phase 1. The
   phone's fold shipped as `PhoneAmbient` in Phase 4; the two share the vocabulary (clock,
   entropy, ids, timers), not a type.
5. **Router:** One body reader feeds both `resolve` and `handle`. A typed owner-op registry:
   definitions carry kind, value schema, handler, and mutation class; built-ins register through
   the same path as the services; `OwnerOp.op` stops being `z.record`; the per-kind answer shapes
   become schemas the phone driver, the fixtures, and Kotlin read. The registry is the catalog:
   the codegen and the residue fences read the kinds, outcomes, and reasons from it, and the hand
   list in `wire-vocabulary.ts` goes.
6. **Names:** The two `Provisioning` types (the generated `proto.Provisioning`, eleven optional
   fields and positional hazards, and the parsed one in `ConsoleClientTypes.kt`) become a wire
   type and a credential blob; `Provisioning.parse` stops saving the conversation id, the last
   identity write outside the door. `ChatRepository.client` (a var) beside `client()` gets one
   name. `DrainHost`, `SessionHost`, and `PresenceHost` fold onto the role ports where their
   members overlap. `connect()` leaves `ChatRepository` for a JVM-testable coordinator over the
   door and the transport.
7. `startGateway` under 100 lines; no file over 600.

### Bug classes

- Structural: a root nobody can read or test, and the same fragility in `routes.ts`.
- The clock seam finishes, as one context with a fence.
- An owner-op kind with no schema, handler, or classification has no place to be added.

## Deploy

Additive only: `RouterServerParams.now` and `handle` are internal; `Protocol.Wire` is generated
into the app; no wire field changes. Gateway first as usual.

## Later, not phases

- A bootstrap wire op collapsing reach, roster, and the first key request.
- Fault injection under the real stores through a `SecretIO` and `DurableStore` fault seam;
  Phase 1's remaining blind spot.

## Painpoints

- **Structure-pinning tests.** `data-dir-inventory`, `host-spawn-wiring`,
  `gateway-retained-state-residue`, `s10-residue`, and the `session-authority` allowlist pin
  file names and source text. Moving `startGateway` into `composeGateway` broke five of them
  without changing behavior. Phase 2's kill list.
- **Two HTTP paths in the Router.** `RouterServer.resolve` (Node `IncomingMessage`) and
  `RouterServer.handle` (Fetch `Request`) each build the dispatched request; the GET-with-body
  refusal lived in only one of them. One body reader should feed both.
- **`composeGateway.ts` as one closure.** Threading `now` to `createShareAttestor` or a stop to
  the presence pusher means reading 1400 lines to find the construction site, and the federation
  slice rebuilds its handlers on activation. The harness reaches into `GatewayGraph` because no
  smaller seam exists. Phase 5.
- **Positional lambdas on Kotlin composers.** `KeyDeliveryOps` took eight positional
  constructor lambdas; `OwnerOps(repo = null, ...)` wanted a repository it never used. Phase 3
  named every site and dropped the repository; the count still grew (`OwnerOps` seven lambdas,
  `KeyDeliveryOps` eleven parameters, `ConsoleClient` eight optional collaborators with storage
  fallbacks). The fold into `PhoneBootstrap` and `PhoneAmbient` is Phase 4.
- **Wide hosts.** `DrainHost` and `SessionHost` carry about thirty members each; a fake is fifty
  lines of `Unit` and `error("unused")`, and the fake can pass while the adapter drops work
  (`launchInBackground` on a null poll scope). Role ports composed per ops class, Phase 4.
- **A consumer that walked the producer's JSON by hand.** `WireFixturesDecodeTest.kt` read the
  phone block from the manifest entry, which never carried one, and decoded nothing from Phase 1
  until the generated `WireFixture` twin replaced the hand walk. Hidden class: green for the wrong
  reason. One schema on both sides, no hand-walked JSON in a consumer.
- **Two fixture worlds.** The Kotlin generator derived its content key from the console identity
  and sealed under it; the Router accepted every op, and nothing on the TS side opened a
  Kotlin-sealed envelope until the key-grant opening was added. Each Kotlin case rebuilds
  `OwnerOps`, `ContentKeyring`, `Keyring`, `Provisioning`, and `ConsoleClient` by hand, and the
  draw namespace hashed every case under `OwnerOps.sign` against its own doc. Phase 4's
  `FixtureWorld` and per-case draw counter.
- **Entropy hooks keyed on size.** A `(Int) -> ByteArray` hook that returns the same bytes for
  every call reuses the ephemeral key and nonce across two epochs; the generator's first hook did.
  A counter object, not a lambda.
- **Background scope by accident.** `SessionOps` launched wakes, refreshes, and gateway forgets on
  the poll loop's scope, so an action before the first poll vanished; Phase 3 moved
  `launchInBackground` to `repoScope`. The forget order (local removal persisted before the
  gateway forget lands) is on the backlog.
- **The cycle tool's phase text is a snapshot.** Step instructions carry the Phase 3 text from
  `cycleStartPlan`, not the reassessed one; auditors must be told to read the plan file.
- **Kotlin compiles in waves and Codex cannot run Gradle.** The first compile stops at the first
  failing file set, so each Kotlin slice cost two or three gate runs of orchestrator time.
- **Narrative comment blocks** in `SessionOps.kt` (spawn, wake, relaunch, forget) and
  `ConsoleClientSessions.kt` (peek, tmuxSend, forget, closeSession), and inline fully qualified
  names in `PollDrain.kt`. Phase 5's split sheds them.
- **Bun and Node disagree at the socket.** Bun refuses an IP literal as SNI and ignores `ws`
  `createConnection` unless the real package is resolved; the same dial had to be proved twice
  (`check:pinning`, `check:boot`). `pinnedDial` is the one place that knows; nothing else should
  open a TLS socket.
- **Gradle cannot generate.** AGP owns the unit-test tasks, so the Kotlin fixture generator is a
  JUnit class behind a system property and a task-name check in `build.gradle.kts`; the worker's
  cwd is `android/app`, so every path is a property. Tolerable, not elegant.
- **The frame a composer emits is not the frame on the wire.** `callInboxTool` stamps the
  incarnation invisibly; the first fixture replay failed on `stale_incarnation` for a frame that
  looked complete. The stamping belongs in the composer or in one named transport step.
- **Router answers have no schema per op kind.** `board_read` answers a bare `BoardReadResult`,
  `gateway_value` an `OpResultEnvelope`, `consumer_register` `{cursor, cursorEpoch}`,
  `hello` `{outcome: "complete", hello}`; `OwnerOp.op` is `z.record`. Every consumer (the phone
  driver, the fixture expects, Kotlin) learns the shapes by running the Router. The typed
  owner-op registry in Phase 5 is the fix.
- **Clock defaults in three spellings.** Recorded under Phase 1's bug classes; Phase 5.
- **An eager boot beside open stores.** `StateFlow<BootState>` refreshed by hand cost nine
  `refreshBoot()` patches in one lap (reach, roster, provision, clear, install, endpoint, first
  root, owner restore, key ensure) before `PhoneIdentity` became the one writer. A published value
  needs one door, or the stores it reads need a version.
- **Test doubles that throw at construction.** `error("unused") as X` compiles and fails when the
  fake is built; two agents wrote it in one lap. A getter is the stub shape.
- **Positional construction of an all-optional generated type.** `proto.Provisioning` has eleven
  optional fields; positional args put the token in the certificate slot and every Kotlin
  fixture carried device "android" and a random conversation id until the corpus diff showed it.
- **The Kotlin gate diffs the corpus before running the tests.** A drift costs a regeneration
  round before the unit-test failures behind it appear.
- **Structure probes read as tests to every auditor.** Every audit slice flags the regex fences as
  non-behavior tests, and each lap pays the triage. A fence guards an invariant with no runtime
  expression; name it so, keep the set small, or derive it from the schemas (Phase 2).
- **Gateway ids collide across Domains.** A listening token names the receiver's gateway id and
  a requester refuses its own, so two Domains whose Gateways share an id pair only from a third
  Gateway. The token should carry the Domain id.
- **A receipt path that did not settle its waiter.** `applyReceipt` returned a disposition per
  branch; the refused-delivery branch returned none, and every call on that agent held for the
  whole budget. One settle site per operation, not one per branch.
- **The Router share record was the phone's to write, and nothing said so.** The gateway kept a
  mirror the phone did write, and the Router refused every cross-Domain row for want of the
  record the phone never posted. A share is one operation with one owner; Phase 5 moves the
  record to the gateway.
- **The first follow-up after a daemon restart is indeterminate.** The gateway reconciles the
  agent on the daemon's hello and refuses the delivery that raced it; the caller retries. The
  gateway could hold the delivery until the reconcile answers.
- **The `virtual` peer flag is dead code.** Nothing sets it; the eviction path and three
  liveness reads test it. Phase 5's websocket module drops it.
- **Codex cannot bind a socket.** Every harness scenario a Codex agent writes is unverified until
  the orchestrator runs it, and two agents shipped `describe.skip` around theirs. Harness
  scenarios are orchestrator work or a second pass; pure-rule tests delegate cleanly.
- **A fake that reimplements the lifecycle.** `codex-daemon-service` proved 63 rules against a
  `FakeSession` that copied `ThreadLifecycle`; the real lifecycle disagreed on where a terminal
  is archived. The scripted App Server at the JSONL boundary is the double; nothing above it is.
- **The fixture world built the client's transport over a store that never held the identity.**
  The reach fixture lost its signer; one store per case, or the world hands out both from one.
