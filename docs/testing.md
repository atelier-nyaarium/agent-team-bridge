# Testing

How the wire is tested: one composed federation in a vitest process, two minted fixture corpora,
and two Bun smoke gates.

## Gates

| Command | Proves |
|---|---|
| `bun run lint` | Biome and `tsc` |
| `bun run test` | Vitest under Node, including the harness scenarios and both fixture replays |
| `bun run check:fixtures` | Regenerating the TS wire fixtures changes no byte |
| `./scripts/kotlin-gate.sh` | Kotlin import guard, a fresh Kotlin fixture regeneration diffs clean, the unit tests |
| `bun run check:pinning` | The shipping runtime pins the Router certificate |
| `bun run check:boot` | The real entry points boot under Bun and answer one console op |

## The identity set

`tests/fixtures/identity/set.json`, minted once by `scripts/gen-identity-set.ts`: the Router
identity, the Domain and its owner, the gateway and console identities with their admissions, the
three bearer tokens, and the epoch 1 content key. Everything below reads this one file.
`src/shared/fixture-identity.ts` names its signing keys; `main-federation` and `composeGateway`
refuse them unless `ALLOW_FIXTURE_IDENTITY=1`, which only the harness and the boot smoke set.
Re-minting the set invalidates every derived fixture.

## The harness

`src/testing/federationHarness.ts` composes a real `RouterServer` on port 0 and a real gateway
graph through `composeGateway`, joined by the real pinned client over loopback. The host daemon
and the sessions are fake sockets at the gateway's own WebSocket handlers (`fakeHost.ts`,
`fakeSession.ts`); the phone is a TypeScript driver on `RouterServer.handle` (`phoneDriver.ts`)
plus a console socket against the Router's TLS listener (`consoleSocket.ts`). Both clocks take
the harness `now`. `restartGateway` recomposes over the retained directories.

Scenarios live in `src/__tests__/federation-harness.test.ts`. Each asserts what the phone or the
session observes, never a fake's bookkeeping.

## Minted wire fixtures

Each runtime drives its real composers under the identity set, a fixed clock, and deterministic
nonces, and commits what they produced; the other runtime consumes it with its real parser.

- `scripts/gen-wire-fixtures.ts` writes `tests/fixtures/wire/ts/<composer>/<case>.json`: the
  gateway frames (owner rows, presence, session registry, key requests, board writes, value
  results, registration). `src/__tests__/wire-fixtures-ts.test.ts` feeds every frame through the
  live pinned link; `WireFixturesDecodeTest.kt` opens every phone-bound answer.
- `WireFixtureGenerator.kt` writes `tests/fixtures/wire/kotlin/<composer>/<case>.json`: signed
  owner ops from the real phone composers and the transport request family. Regenerate with
  `./gradlew :app:generateWireFixtures` from `android/`; an ordinary unit-test run asserts the
  committed files. `src/__tests__/wire-fixtures-kotlin.test.ts` replays every request through
  `RouterServer.handle` at the fixture clock, replays the socket upgrade against the real
  listener, and reproduces every signed op through the phone driver.

Fixture shape: `producer`, `composer`, `case`, `clock`, `inputs`, then `frame` (TS) or
`request` (Kotlin), an optional `phone` decode block, and `expect`, the real peer's answer as a
subset. The n-th random draw of a case is the first N bytes of
`sha256("<producer>:<composer>:<case>:<n>")`, recorded in `inputs`.

## Wire vocabulary

`src/shared/wire-vocabulary.ts` declares the Router paths, the console header and Bearer prefix,
the owner-op kinds the Router dispatches, the signing tags, and the nonce lengths.
`scripts/codegen-kotlin.ts` emits them as `Protocol.Wire`, with the console op kinds, socket
frame types, and key op kinds from the Zod literals. `wire-vocabulary-residue.test.ts` rejects
the literals anywhere else on either runtime.
