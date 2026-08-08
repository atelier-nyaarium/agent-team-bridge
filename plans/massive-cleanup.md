# Massive Cleanup

Bring every source file under 600 lines across switchboard and the Switchboard-supporting half of
evie-bot, splitting by responsibility, cutting duplication, and reducing comments to what the code
cannot say itself. Run as an items-mode cycle: one queue entry per lap, five steps per lap.

The live queue and lap position are in `plans/massive-cleanup.cycle.json`. This file records what
each lap learned, not what it did. Git holds the diffs.

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

### A parameter no body reads

`ChatState.sessions(localGatewayId)` and `label(team, localGatewayId)` each took an argument neither
body ever referenced, and 25 call sites threaded it through. The parameter also read as a hint that
the function re-canonicalized its input, which it does not. Dropped in lap 1.

Rule: when a split surfaces a parameter nothing reads, drop it in the same lap. The compiler finds
every call site, and leaving it is a signature that lies.
