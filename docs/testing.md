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

`tests/fixtures/identity/set.json`, minted once by `scripts/gen-identity-set.ts`: the Router
identity, the Domain and its owner, the gateway and console identities with their admissions, the
three bearer tokens, and the epoch 1 content key. Everything below reads this one file.
`src/shared/fixture-identity.ts` names its signing keys; `main-federation` and `composeGateway`
refuse them unless `ALLOW_FIXTURE_IDENTITY=1`, which only the harness and the boot smoke set.
Re-minting the set invalidates every derived fixture.

Each runtime builds one `FixtureWorld` from the identity set. It asserts that the content key is
derived from the Domain owner and that both admissions verify. The world supplies the Router and
Gateway bootstrap state, one content key store, and phone facts. `FixtureDraws` gives each case one
counter. Draws are the first N bytes of `sha256("<producer>:<composer>:<case>:<n>")`, recorded in
`inputs.draws` by index. Kotlin sealed blocks declare every envelope path, its AAD kind, and the
plaintext or JSON subset the other runtime must open.

## The harness

`src/testing/federationHarness.ts` composes a real `RouterServer` on port 0 and a real gateway
graph through `composeGateway`, joined by the real pinned client over loopback. The host daemon
and the sessions are fake sockets at the gateway's own WebSocket handlers (`fakeHost.ts`,
`fakeSession.ts`); the phone is a TypeScript driver on `RouterServer.handle` (`phoneDriver.ts`)
plus a console socket against the Router's TLS listener (`consoleSocket.ts`). Both clocks take
the harness `now`. `restartGateway` recomposes over the retained directories.

Scenarios live in `src/__tests__/federation-harness.test.ts`. Each asserts what the phone or the
session observes, never a fake's bookkeeping.
The harness also supports `restartRouter`, and the phone driver exposes `reach()` for the token-gated
reach and gateway roster. Scenarios cover reach before roster, owner-id reply routing, bounded bootstrap
installation with missing-epoch requests, and Router restart incarnation fencing with presence recovery.

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
`ContentEnvelope`, `BoardOp`) or `request` (Kotlin). Each generator builds the value through the
schema and derives the manifest from it. `check:fixtures` validates every committed file and
manifest entry on both sides. The n-th random draw of a case is the first N bytes of
`sha256("<producer>:<composer>:<case>:<n>")`, recorded in `inputs`.

## Wire vocabulary

`src/shared/wire-vocabulary.ts` declares the Router paths, the console header and Bearer prefix,
the owner-op kinds the Router dispatches, the signing tags, and the nonce lengths.
`scripts/codegen-kotlin.ts` emits them as `Protocol.Wire`, with the console op kinds, socket
frame types, and key op kinds from the Zod literals. `wire-vocabulary-residue.test.ts` rejects
the literals anywhere else on either runtime.
