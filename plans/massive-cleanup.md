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

### A parameter no body reads

`ChatState.sessions(localGatewayId)` and `label(team, localGatewayId)` each took an argument neither
body ever referenced, and 25 call sites threaded it through. The parameter also read as a hint that
the function re-canonicalized its input, which it does not. Dropped in lap 1.

Rule: when a split surfaces a parameter nothing reads, drop it in the same lap. The compiler finds
every call site, and leaving it is a signature that lies.
