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
A: Parked while another team held it, then resumed on the owner's word. Phase 4 was theirs by the
time it was free.

> "Don't mess with Lexicon yet. they are busy." Then: "NOW Lexicon is free."

## Question 3 - Does the phone read the set now?

Q: `plans/operation-shape.md` Question 4 said the phone stays unchanged and the grant is narrower
than the words. Does that still hold?
A: No, superseded. The request sheet and the grants tab render the set, so the promise on screen is
what the grant covers.

> The gateway already sends `shapes` on every request row and stores it on a window grant, so the
> phone has the data and shows the owner less than it holds.

# Plan

All four accounted for. Two built here, one built in lexicon, one already done by another team.

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

## Phase 3 - Rebase bindings through withOccurrences ✅

Shipped in lexicon 3.7.0, after the owner said the repository was free.


Lexicon. `protocol/src/occurrences.ts` repoints `fromId`, container ids, literals and docs when it
re-mints a repeated declaration, and leaves `binding.symbolId` and an ambiguous binding's candidates
pointing at the pre-mint id. A binding into a re-minted declaration follows it, under three guards:
the target is a descriptor path the re-minting strictly holds, the rebased id is one this
settlement minted, and a target naming the declaration itself stays. `docs/provider-protocol.md`
said a binding is left as the provider bound it, and now says what moves and what does not.

No current provider's served facts change. A function-scoped local is a module-wide `local` ordinal
carrying no descriptor path, so it never matched; Typescript and Bash mint their own occurrences,
and the rest pre-disambiguate. The guarantee is for the provider that does none of those.

## Phase 4 - A literals expectation in the corpus ✅

Done by another team in lexicon `ebd0214`, released in 3.6.0, while this repository held the two
switchboard phases. `ExpectedLiteralSchema`, a `literals` list on both the shared case and the
per-language fixture, `checkLiterals` and `checkLiteralRanges`, and corpus cases. Bash now runs 28
passed and 0 failed, where `claimed-tier-is-tested/literals` used to stand.

Their shape beats the one planned here. The expectation is overridable per language, because a
boolean is `True` in Python and `true` in most others, so no shared list survives every fixture;
`5c9996a` then made every provider decode a boolean to the same value.

## Painpoints

- The federation harness flakes under a full-suite run and passes alone. Twice today in roughly
  eight full runs: once named, `federation-harness-boot.test.ts` on presence convergence, and once
  unnamed because the failure scrolled past a grep. Four consecutive clean runs followed each. A
  flake in a suite of 2,435 costs a rerun and a paragraph every time, and it teaches a reader to
  disbelieve a red suite, which is the expensive part.
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
- A backlog entry written from a hunch outlives the hunch. This one said a repeated declaration
  could strand a reference on the first definition's LOCAL. Locals carry a module-wide ordinal and
  no descriptor path, which `isWithin` refuses outright, so no provider was ever at risk. The entry
  was right that the gap existed and wrong about who fell in it, and nothing between writing it and
  reading it said so. An entry naming the symbol it doubts, rather than the story, would have.
- Only one provider's unit tests call `withOccurrences`; every other provider tests its extractor
  directly, and the wire applies the settlement in `serve.ts`. So a change to the settlement is
  invisible to thirteen provider suites, and only conformance, which runs the real wire, sees it.
  That is the right split, but it means the gate that would catch a settlement regression is the
  slow one nobody runs by reflex.
