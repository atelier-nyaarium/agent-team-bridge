# Massive Cleanup

Bring every source file under 600 lines across switchboard and the Switchboard-supporting half of
evie-bot, splitting by responsibility, cutting duplication, and reducing comments to what the code
cannot say itself. Run as an items-mode cycle: one queue entry per lap, five steps per lap.

The live queue and lap position are in `plans/massive-cleanup.cycle.json`. This file records what
each lap learned, not what it did. Git holds the diffs.

## Two passes, interleaved every 10 laps

**Pass 1, mechanical.** Get every file under 600 lines. Moves, not redesigns. Ship it and push.

**Pass 2, architectural.** Redesign anything that is only an ugly split: a file that exists because
600 lines had to go somewhere rather than because it owns something. Run it under /architecture, and
judge each new file by whether it has a name that describes what it OWNS.

**Cadence: after every 10 mechanical laps, run one refactor pass over what those laps produced**,
then return to the queue. This keeps redesign close enough to the split that the context is still
warm, without doing both jobs in one lap. The pass-2 items in the queue (the closure decompositions)
are the natural material for each refactor pass.

The order within a file still matters. A redesign attempted while a file is 2000 lines is a redesign
nobody can review; a split done with redesign in mind is slower and lands neither. Split first,
cheaply and verifiably; then ask what the pieces should have been.

Known pass-2 candidates as they surface:
- `createRoutes` in `src/gateway/routes.ts` is one ~1700-line factory closure holding ~40 inner
  functions over a captured `config`. Nothing can be lifted out of it without either passing the
  scope explicitly or duplicating it. That is a design change, so it is queued on its own.

## Bug Classes

Defect classes this cleanup keeps running into. Each one is a rule for later laps, not a log.

### A test pinned to a source file's PATH

Several TS tests assert on Kotlin source by reading a hardcoded path and slicing out a declaration.
Every lap that moves a declaration breaks one, and the failure names the test rather than the move.

- `draft-location-residue.test.ts` located `MessageFile` and `Draft` in `ChatRepository.kt`. Lap 1
  moved both, and its `expect(start).toBeGreaterThan(-1)` guard is the only reason it failed loudly
  instead of slicing an empty body and passing vacuously. Fixed by searching the Android tree for
  the declaration and throwing unless there is exactly one match.
- `draft-handoff.test.ts` has the same shape and still passes only because the functions it reads
  are ones lap 1 did not move. It throws a named error rather than going vacuous, so it will
  self-diagnose when drafts move. Give it the same tree search then, not before.

Rule: a source-residue test names a DECLARATION, never a file. Anything that resolves a declaration
to a path must fail loudly on zero matches and on more than one.

### A split brief that names groupings instead of the target

Lap 2 fanned out four Sonnet agents, one per new file, and every grouping I handed them was one
coherent screen. Four of the five resulting files are still over 600 lines: `SessionsScreen.kt` at
1220, `SettingsScreen.kt` at 1006, `ThreadScreen.kt` at 786, `MainActivity.kt` at 1124. The agents
did exactly what they were told, and what they were told was wrong.

I had optimized the brief for "one screen per file" when the goal is "under 600 lines". Those agree
only for small screens.

Rule: a split brief states the 600-line TARGET as the constraint and hands the agent a starting
grouping, not a final one. Tell it to measure as it goes and to propose its own sub-split, naming
the seam, whenever its file would land over. A grouping is a hypothesis, and the agent holding the
file is the one positioned to falsify it.

### A parallel fan-out cannot share a write target

Four agents each moving a chunk OUT of one file would clobber each other. Phase 1 authors the new
files read-only on the source; a single phase 2 agent then deletes every moved block in one pass.
The tree is deliberately broken between the phases, so phase 2 must be told to leave it compiling
whatever else happens.

Corollary learned the hard way: phase 2's agent died on an API content filter while writing its
final report, AFTER its edits had landed and compiled. A failed agent is not a failed step. Check
the tree before re-running anything, or a re-run doubles the work it already did.

Second corollary: a later agent handed a 47-line verbatim import list tripped the same filter after
five reads, having changed nothing. Both failures involved a long block of bare qualified names in
the prompt. Hand an agent a RULE it can apply ("prune every import the file no longer uses, keeping
getValue and setValue, which are delegate operators nothing names") rather than a machine-readable
list to transcribe. Whether the list is what tripped it is unproven, but the rule form is the better
brief regardless, and it is shorter.

### Kotlin has no unused-import gate

Nothing in this repo catches a dead import: Kotlin does not error on them, the Android build has no
ktlint, and `bun run lint` is TS-only. The MainActivity split left 152 dead imports and all four
gates stayed green.

Rule: every lap that moves declarations OUT of a file must prune that file's imports and verify by
compiling. A red-team angle should keep asking for it, since no tool will.

### A split silently changes the module's export surface

Twice in consecutive laps, and in opposite directions. Lap 7: widening four internals so split files
could share them let an `export *` barrel republish them, 99 public exports where HEAD had 95. Lap
8: re-exporting only what current importers pull dropped ten HEAD-public types, 4 where HEAD had 14,
after the splitter wrongly reported them module-private. Lint and tests were green both times; only
the verifier's checker-based `getExportsOfModule` comparison saw either.

Rule: the module surface is part of the split's contract, and the SPLITTER proves it, not just the
verifier. Every split brief includes: enumerate HEAD's exports with the TypeScript checker before
starting, re-verify after, identical sets. A barrel over files containing widened internals uses
NAMED export lists, never `export *`, so a future widening cannot silently become an API addition.

### A new umbrella comment overclaims for one member

Lap 21 grouped the three proof-of-possession query surfaces into one file and wrote a fresh intro
generalizing them. Its "resolves the key to the authority the surface demands" was true for roster
and transport but false for trust-pending, where possession of the owner key IS the authority and
evie resolves nothing. The file's own per-schema doc two paragraphs down said so correctly; the
audit caught the contradiction by reading evie's three handlers.

Rule: a comment that generalizes over N members must be checked against each member's actual
implementation, in whichever repo implements it. Where members differ, the umbrella states the
shared part and defers the rest ("see each schema's own doc") instead of averaging over them.

### Splitting a synced leaf is intra-repo safe

The sync machinery is self-describing per file: the header's `cp <src> <dst>` line IS the sync
target list, the SYNC-HASH is over the file's own body, and neither repo's CI diffs across repos.
So a leaf split lands on switchboard main immediately while the evie half rides a PR, with no
ordering hazard. The only enumerations to touch: both CI workflow lists, and the CLAUDE.md table.
Keep the barrel a pure re-export so no consumer changes in either repo, and let each new leaf keep
its internals private so `export *` cannot widen the surface.

### A redundant-looking test guarding a semantic invariant

Lap 22's sweep cut two strict-schema tests as mechanically redundant (same .strict() unknown-key
path, same missing-required-field failure). The adversarial pass defeated both with verified
mutations: `status` is the retired sibling schema's real field name, and attachments-only was a
real prior shape a refine could reintroduce - each deleted test was the ONLY thing standing between
the schema and that specific regression. Restored.

Rule: reduction needs two gates, not one. The sweep proves a cut is path-redundant; a separate
adversarial pass must fail to construct a production mutation only the deleted test catches. A test
whose probe value is a loaded name (a retired field, a withdrawn capability) is an invariant guard,
not a duplicate, however identical its mechanics look.

### A parameter no body reads

`ChatState.sessions(localGatewayId)` and `label(team, localGatewayId)` each took an argument neither
body ever referenced, and 25 call sites threaded it through. The parameter also read as a hint that
the function re-canonicalized its input, which it does not. Dropped in lap 1.

Rule: when a split surfaces a parameter nothing reads, drop it in the same lap. The compiler finds
every call site, and leaving it is a signature that lies.
