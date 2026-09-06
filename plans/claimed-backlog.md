# Questionaire

## Question 1 - Which items?

Q: Four backlog entries were pushed without warning and then claimed. Which get done?
A: All four. Two are in switchboard and two in the lexicon submodule, both the owner's.

> "whichever ones are your repo related, do em"

## Question 2 - Does the rename reach the wire?

Q: `operationShape` and `operationSet` read alike, and the wire fields `shape` and `shapes` are one
letter apart. Does the rename take the wire with it?
A: Yes. `shape` becomes `displayShape` and `shapes` becomes `coveredShapes`, one name per concept
from the gateway to the phone.

> "rename wire too if it is confusing and wrong". One is what the owner reads and one is what the
> grant enforces. `coveredShapes` is a free rename, since nothing reads it yet. `displayShape` takes
> the optional-then-required crossing, since the phone reads `shape` today.

## Question 4 - When do the lexicon phases run?

Q: Phases 3 and 4 are in the lexicon submodule. Now?
A: No. Parked until the owner says lexicon is free.

> "Don't mess with Lexicon yet. they are busy."

## Question 3 - Does the phone read the set now?

Q: `plans/operation-shape.md` Question 4 said the phone stays unchanged and the grant is narrower
than the words. Does that still hold?
A: No, superseded. The request sheet and the grants tab render the set, so the promise on screen is
what the grant covers.

> The gateway already sends `shapes` on every request row and stores it on a window grant, so the
> phone has the data and shows the owner less than it holds.

# Plan

## Phase 1 - Name the vault's two readings apart ✅

Switchboard. `operationShape` becomes `displayShape`, in `gateway/vault/decisions.ts` and its three
callers, the test, and the prose in `docs/vault.md` and `plans/vault.md`.

The wire follows. `coveredShapes` replaces `shapes` outright, since no console reads it. The grant
store accepts the old key on load, so a grant already on disk stays readable, dated with the rest.
`displayShape` joins `shape` as optional and both are emitted, until `shape` comes out on the same
date. An empty set never validates, so a request naming no program is covered by no grant.

## Phase 2 - Show the owner what a window covers ✅

Switchboard and the console. The request sheet prints the programs a window would cover, under the
operation and bounded to three lines so a long set cannot hide the answers. The grants tab lists a
window's set. Both say nothing rather than guess: a row carrying no set names a coverage this phone
cannot see, a typed request takes no window at all, and a grant recorded without a set covers
nothing. `plans/operation-shape.md` Question 4 marked superseded.

### Bug Classes

- **The phone restating a gateway rule, `windowCovers` and `grantCovers`:** a line on screen
  promising something the gateway does not do. Three rounds found three instances. Round one: an
  empty set fell back to the display shape, which a pre-rename gateway never covered, so
  `sudo apt update` would have read `30 min covers sudo apt`. Round two: the line rendered on a
  typed request, which is always answered once and records no grant at all. Round three: the grants
  tab named a shape for a window recorded without a set, which the gateway refuses outright. The
  structural cause is that `covers` lives in TypeScript and the console restates it in Kotlin, with
  nothing between them. A shared fixture for the rule, as `tests/fixtures/` already holds for the
  wire, would keep the two predicates honest.

## Phase 3 - Rebase bindings through withOccurrences (parked)

Another team holds the lexicon repository. Both lexicon phases wait for the owner's word.


Lexicon. `protocol/src/occurrences.ts` repoints `fromId`, container ids, literals and docs when it
re-mints a repeated declaration, and leaves `binding.symbolId` and an ambiguous binding's candidates
pointing at the pre-mint id. Apply the same `repoint` to both, so a reference to a local inside a
second definition binds inside that definition. `docs/provider-protocol.md` says a provider may mint
its own occurrences; it becomes a choice rather than a requirement, and says so.

## Phase 4 - A literals expectation in the corpus

Lexicon. Fourteen providers declare `literals: true` and every one fails
`claimed-tier-is-tested/literals`, because the corpus's only literals case is markup's oversized
value. An exact ordered `literals` list on `ConformanceFixtureSchema`, one shared case, the runner's
check, and a fixture for each of the fourteen.

## Painpoints

- `federation-harness-boot.test.ts`, the presence convergence case, fails under a full-suite run and
  passes alone, twice over. A flake in a suite of 2,435 costs a rerun and a paragraph explaining it
  every time, and it teaches a reader to disbelieve a red suite.
- Every review agent running the suite in a sandbox reports two federation harness files failing on
  `listen EPERM`, then spends a paragraph saying it is environmental. Seven agents have now paid
  that toll. The harness could name the sandbox and skip itself.
- A wire rename is four edits in the schema, one in the writer, one in the reader, a Kotlin
  accessor, a Kotlin test, and a codegen run, and nothing checks that the set is complete. The
  compiler catches the TypeScript half and `ignoreUnknownKeys` hides the Kotlin half, so a missed
  reader is found by a person or not at all.
- The emulator variant exists so a screen can be seen without a gateway, and `SandboxFixtures`
  seeds teams, threads, drafts, goals, dirs and the board. It seeds no vault, so a change to the
  request sheet or the grants tab cannot be looked at without a real gateway and a real request.
  Every check on this phase's two new lines was a unit test and a compile.
- `kotlin-gate.sh` runs `testDebugUnitTest`, which compiles the test sources and the main sources
  they touch. It never assembles the app, so a Compose call that only the UI reaches, a missing
  `TextOverflow` import for one, passes the gate and fails later. `compileDebugKotlin` is the
  cheap addition.
