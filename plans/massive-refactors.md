# Questionaire

Scoping the redesign pass that follows the file splits. The board parent is "Massive Refactors";
this file holds the reasoning behind its ordering.

## Assessment inputs

Four assessors read the gateway core, the gateway console and board halves, the Android repository
layer and the Android UI, each naming structural defects rather than line counts, with candidate
directions and a foundational rating that had to name which other areas it would move.

### Named healthy, leave alone

- `wake.ts`, `hostOpCoordinator.ts`, `wsTypes.ts`
- `sessionAuthority.ts`, called out as already looking like the target end-state for the gateway
- `SettingsScreen.kt`, a clean hub-and-spoke router, named as the template for rebuilding the
  Android routing
- `SessionsEmptyState.kt`, `SessionCard.kt` with its pure preview rules, `SessionsScreen.kt`
- `ConsoleClient.kt` and `SwitchboardService.kt`: large but single-responsibility, leave as one file

### The two composition roots, both rated foundational

- `gateway/index.ts`: the whole boot lifecycle is about twenty mutable bindings in one function,
  with construction order enforced by comments and temporal dead zone rather than by types.
- `MainActivity.kt`'s `App`: about twenty mutually-toggling flags whose exclusive-choice priority
  order is hand-encoded three times (the render branch, the back handler, and a notification-tap
  reset checklist).

Both are the place every other unit receives its shape from.

## Commit hygiene for this pass

(The Lexicon Transactions constraint recorded here earlier was retracted by the owner; it belonged
to a different team. The hygiene it endorsed stays because it is good on its own.)

- Express structural changes as named operation sets in the commit message and this record, one
  operation set per commit.
- Never blend a structural move with a behavior edit in one commit.

## Question 1 - What orders the refactor pass?

Q: Composition roots first, by defect class, by blast radius, or by subsystem?
A: Composition roots first (`gateway/index.ts`, then `MainActivity`'s `App`).

Reason: both roots' "which other areas would this move" answers listed nearly every other entry, and
none of the other defects listed the roots. That asymmetry is the ordering. Every entry written after
a root moves would otherwise be written against a shape that is about to change.

## Question 2 - What does the gateway composition root become?

Q: A GatewayContext of named construction functions, an explicit boot state machine, or both?
A: The boot state machine (Standalone, Arming, FederationActive) first, then clean up whatever
context extraction is still unclear afterwards.

Reason: the replay bug was a lifecycle bug, not a wiring bug. The wiring was correct; nobody owned
"what survives this transition". A context extraction would not have prevented that class, and the
state machine forces the question at every transition by construction. It also has a house precedent:
`sessionAuthority.ts` made UNBOUND a value a resolver returns rather than an absence a gate falls
into, and this is that move applied to boot.

## Question 3 - What does the Android root become?

Q: One sealed Screen in a variable, a sealed Overlay plus an explicit stack, an ordered table over
the existing flags, or Navigation-Compose?
A: The sealed Overlay plus an explicit stack.

Reason: it is the same move as the gateway (replace N flags that can disagree with one authoritative
value) in the same vocabulary, with no new dependency, and it is the only option whose shape matches
the real nesting rather than flattening it. The flat sealed class is the same idiom, but its own
evaluator concluded the honest version needs per-variant return pointers once the four-deep return
chains are preserved, which is a stack drawn badly. The ordered table would have faithfully preserved
the masking bug below. Navigation-Compose is not a dependency today and its evaluator named a
hand-rolled sealed type plus a stack as the natural comparison.

Decided alongside: the stack stays in plain `remember`. Making it `rememberSaveable` to match
Settings would put an in-progress ceremony's crypto material into the saved-state Bundle, which is a
different persistence posture than today's.

## What the completed split laps yielded

All 29 done entries read one at a time, asking of each whether the split was unpleasant and whether
the shape underneath needs a rethink.

Twenty were clean and conventional: top-level types out of a big file behind a barrel, test suites
split by concern, the setup script split along its own menu groups. Five were already represented by
a deferred entry. Four had carried a recorded finding that never became an entry, which is the whole
yield of the sweep:

| From | Entry filed |
|------|-------------|
| Lap 24, ChatRepository round 3 | EnrollOps is a grab bag, and the ceremony engine spans two collaborators |
| Lap 26, SessionsScreen | Rehome the ThreadScreen docks and name the status vocabulary |
| Lap 27, SettingsScreen | The biometric gate is copy-pasted, and the rest of the duplication inventory |
| Assessment | ThreadScreen takes 49 parameters, and two of them are both called waking |

The first is the split this pass should be least happy with. Three of round 3's four siblings name a
real subject and EnrollOps is what was left over, so the enrollment ceremony's steps ended up spread
across two files with nothing holding the sequence.

## Question 4 - What does ChatRepository become?

Q: Extract the poll loop and drain, repair the delegate seams first, add read-side projection only,
or leave it?
A: Extract the poll loop and drain as its own object.

Reason: everything else in the file is downstream of the drain, so anything cut before it is written
against a shape the drain still owns. It is also the one cut that makes a real invariant explicit
rather than emergent: inbound subscribers inherit exactly-once BECAUSE they fire inside the drain
before the cursor commits, and today that holds only because of where the code sits. 372 lines, sole
writer of all four plane cursors, sole reader of both subscriber lists, and 15 of the 17 method
groups are reachable only through it or a field it writes.

Splitting `_state` was measured and rejected: 25 of its 30 fields form one cluster that must stay
together, and the check revised that UP from 22 on a second pass after finding inline `state.value.X`
reads its first scan had missed. It would move 19 percent of write sites while giving up the
atomicity boundary that 24 multi-field writes and 30-plus multi-field reads depend on. Two tears it
would introduce: the presence chip contradicting the waking notice in one viewport, and the composer
(hidden while a scheduled send exists, but fed from drafts) leaving restored text on screen nowhere.

Repairing the delegate seams is the rival worth remembering rather than dismissing. The four prior
extractions moved code but not coupling: consumers reach 170 endpoints through 11 pass-through
handles, and three live hazards came out of those splits (a memo keyed on `board.revision` querying
`boardOps`, a read-modify-write across both into an absolute setter, and `awaitSchedulerWired`, a
spin-wait bridging an ordering gap the Service cannot close). Fold these into the drain extraction's
lap rather than losing them.

### A third defect, not a refactor (FIXED, f950c8e)

`reconcileTeamNotifications` is keyed on `state.threads.keys`, so a showing notification whose thread
is gone can never be visited again. The forget path was already covered by call sites cancelling
directly, and the doc naming that hazard is at `cancelTeamNotification`. `clearAll` was not: it
replaces the whole state with a fresh `ChatState`, cancels the alarm, purges TTS and attachments, and
leaves every showing message notification stranded permanently. Reachable from the delete-domain,
leave and revoke flows, which means message previews outlive a security-motivated wipe.

Fixed at the class rather than the call site: team ids occupy their own disjoint range, so the
reconciler now sweeps any showing id in that range with no live thread behind it.

## A deferred entry's premise is a claim, not a record

Four deferred entries proposing cuts to the gateway route layer were checked against the code rather
than taken at face value. Two were substantially wrong, one was half wrong, one is still unverified.

- "Model a BoardRoute on CodexRoute, the same shape already built once." codexRoute.ts was created
  greenfield and never touched routes.ts, so it is evidence that a new subsystem deserves its own
  file. CodexRoute also holds no mutable state; its only field is its deps, and its own doc gives a
  fan-in reason. The state a BoardRoute would encapsulate is the reply map now living in
  RoutesCarryOver, so the class buys nothing.
- "Move the wake service into wake.ts, which shrinks the route table." tryWakeTeam and doWakeTeam are
  in index.ts. routes.ts only calls the injected one. The claim that the orchestration needs about
  what decideWakeCreate takes was wrong by roughly ten collaborators plus a mutable in-flight map.
- "resolveSealTarget captures nothing." The function is sealTargetFor and captures two closure
  values. The correction argues FOR extracting it as a pure function: both captured deps are
  federation-activation-dependent, so fields on an object would go stale at activation.
- The fourth (BridgeHandshakeCoordinator) has had no equivalent check, and its body now says so.

These were written from memory at the end of long laps and read as confident. Half were wrong about
facts one `git show` would have settled. An entry's premise gets re-checked before it is planned.

### What routes.ts is, measured

createRoutes returns 18 members and 11 are HTTP routes; the other 7 are called by consoleHandler,
crossDomainPresence and the blob route. Ten of the 11 routes hold no cross-call state. What the
members share is a dependency spine (address minters, impersonation refusal, the mailbox trio, the
seal-to-relay stack), which per-route classes would cut across, each re-declaring a subset of it.

The extraction that paid is PresenceFacade: a concern became an object and `teams()` collapsed to one
call plus two side effects it deliberately does not own. The two members here that genuinely want to
be objects are not routes at all: the blob fetch single-flight coalescer and the presence burst cache
with its invalidator.

Six deps are declared, destructured and never read: codexAgentService, isWakeInFlight,
offlineCatalog, knownTeamPaths, displayName, isAdminDomain.

### A second defect, not a refactor (FIXED, 991ba91)

The Users screen's "Add gateway" was dead. It set `showAddGateway` without clearing `showUsers`, and
the render checks `showUsers` first, so the branch was never reached; backing out of Users then
revealed the gateway screen from nowhere. The sibling path from Gateways works only because its arm
happens to sit BELOW `showAddGateway` in the same `when`. That is the defect class in one sentence:
whether a screen opens depends on where its flag sits in a hand-ordered list.

Found by agents evaluating a refactor direction, not by anyone looking for bugs.

### A defect, not a refactor (FIXED, fc6b058)

Federation activation mid-session runs `routes = buildRoutes()`, and `createRoutes` allocates its
board-reply replay map, in-flight blob-fetch coalescing map and presence snapshot cache per call.
Completing enrollment while running therefore discards all three silently. The board-reply map is
the one that matters: it is what makes a retried board mutation a replay rather than a second write.

# Executed refactors

## Refactor 1 - Gateway boot as an explicit state machine

Operation set (one commit):

- add `src/gateway/boot.ts`: `BootState` (standalone | arming | federationActive), `ArmingSlice`,
  `FederationSlice`, `EvieHandlers`, `DomainMeta`, `decideBootPhase`, `federationOf`, `armingOf`
- replace 17 nullable lifecycle bindings in `startGateway` (evieClient, sealer, consoleSealer,
  allowlistForConsole, crossDomainCoordinator, crossDomainShareState, crossDomainPeersForConsole,
  crossDomainPresenceSourceRef, replayPersist, evieStop, domainMeta, handleConsoleRelay,
  handleGatewayRelay, handleCrossDomainHandshake, evictConsolePeer, enrollInstall,
  armedAdmitPayload) with one `let boot: BootState` read through `fed()`
- rename + reshape `activateFederation` to `buildFederationSlice` (returns the slice)
- rename + reshape `activateEvieHandlers` to `buildEvieHandlers(federation)` (returns EvieHandlers,
  installed on the slice by the transition)
- rename `activateEvieBridge` to `enterFederationActive`; extract the enroll block as
  `enterArming(nonce)`
- add `src/__tests__/gateway-boot.test.ts` pinning `decideBootPhase`'s 8 rows and the accessors

Audit (2 fresh Luna threads, adversarial, then Sonnet synthesis): fix-then-ship. Comment findings
applied. One behavior finding OVERRULED deliberately:

- Finding: on a synchronous `startEvieClient` throw inside the slice build, HEAD had already
  assigned `replayPersist` (and sealer, peers, coordinator, shareState), so the persist tick kept
  saving a replay guard for a federation that failed to activate. The new code discards the whole
  slice and stays standalone, so that save no longer happens.
- Ruling: keep the new semantics. HEAD's behavior was the torn half-activated state this refactor
  exists to kill, and the transition is now all-or-nothing by construction. The suggested hoist of
  the replay pieces to boot scope was rejected because it introduces the opposite divergence:
  pure-standalone gateways would persist a replay-guard file they never use.

## Refactor 2 - Guard the delivery loop's saves and sweeps

Operation set (one commit):

- add `createPersistRunner` + `PersistStep` to `src/shared/durable-store.ts`, the write-direction
  sibling of `restoreDurable`: per-step containment, one report per distinct error per step,
  cleared on that step's next success (DurableStore.save's own throttle, generalized)
- replace `persistDelivery`'s statement sequence in `src/gateway/index.ts` with a named step table
  run through it, folding in the two hand-written catches (board trash sweep; the tick half of
  boardSessionEnded's)
- extend `src/__tests__/durable-containment.test.ts` with the runner's behavior suite

Reassessment note: DurableStore.save already swallowed write failures, so the live crash surface
was the snapshot builders (evaluated before save's try) and the five sweeps. The bug class killed:
a step added to the tick is contained by construction instead of by its call site remembering a
try. Same class as the restore boundaries, now closed in both directions in one module.

## Refactor 3 - Console dispatcher: target resolver and device registry

Three commits, in order:

1. Behavior (a11592a): two sites FOLDED a foreign-Gateway address onto the same-named local
   session instead of refusing. cross_domain_unshare's canonicalShareTarget would have unshared
   the local session; create_session minted a local record under the foreign spawn before
   resolveTmuxTarget refused, relying on rollback to undo it. Both now refuse first, pinned by
   dispatcher-level tests using the colliding-gateway trap shape.
2. Move (df38ee5): all target resolution into consoleTargets.ts, the ONE owner of parseTarget and
   the foreign-Gateway refusal. forget/close/rename resolve through requireLocalComposite(verb).
   console-target-residue.test.ts fails the build on any parseTarget outside it under console/,
   with a vacuity guard. Deliberate message change recorded: foreign is checked before spawn-point,
   because telling a caller to name a session on a target no session name could fix would lie.
3. Move (Opus-executed, audited): the device registry (bindings/signers/opCache/deviceOwner/
   ownerDevices + peer lifecycle) into consoleDevices.ts, byte-identical block, opCache behind
   three narrow methods. consoleHandler.ts 1614 -> 1348 lines.

Audit (2 fresh Luna threads + Sonnet synthesis): fix-then-ship; one stale comment naming the
extracted resolveTmuxTarget, fixed. The fold class here is the entry's own thesis confirmed: a
rule with one right answer and six independent implementations had already drifted at two of them.

## Refactor 4 - One commit-reveal engine under both federation ceremonies

The entry called EnrollOps a grab bag AND the ceremony engine split across two collaborators. The
second half was the real defect: FLOW-1 (enroll) and FLOW-2 (trust rendezvous) each carried their
own copy of the same commit-reveal walk, so a check added to one could miss the other. In security
ceremony that is not a legibility complaint.

Operation set (one commit, 4c39c85):

- add `SasExchange.kt`: `SasTransport` (a flow's broker frames) and `runSasExchange` (commit, poll,
  reveal, poll, verify the binding, authenticate the peer, derive the SAS). Android-free.
- move `pollEnroll` from EnrollOps.kt into it
- rewrite `EnrollOps.enrollExchange` and `TrustOps.trustExchange` as transport + peer-binding only
- add `SasExchangeTest.kt`, the first JVM coverage of the networked walk

Audit (2 fresh Luna threads + Sonnet synthesis): NO security findings, both originals reproduced
exactly. Three real items, all fixed in a follow-up commit:

- A behavior regression I introduced and only the audit caught: merging the two tamper messages
  lost FLOW-1's "Rescan to restart." (the enrollee HAS a QR; the trust flow does not). The recovery
  hint is now the caller's, pinned by a test.
- Each flow's out-of-band binding was still an inline lambda, so deleting it would pass CI. Both
  are now named pure functions on EnrollCeremony (`qrMismatch`, `ownerMismatch`) with their own
  tests. Honest residual: the one-line wiring that passes them is still unverified, since a real
  call-site test needs a fake ChatRepository the Ops layer cannot take today.
- The fake broker discarded the commitment, so nothing proved the commitment and the reveal were
  over the same salt. Now asserted.

Also fixed here, unrelated and separately committed (94a0c7f): a redundant `!!` in ChatRepository
that the eligibility check already proves, which had been flagged for autonomous cleanup.

## Refactor 5 - Android navigation root: one overlay stack

THE SECOND ONE (questionaire Q3). The App composable's 13 mutually-exclusive overlay flags, whose
exclusivity was hand-encoded three times (render `when` arm order, BackHandler check order, a
notification-tap reset checklist), became one `List<Overlay>` stack.

Operation set (one commit):

- add `Overlay.kt`: the sealed Overlay type (13 variants, carried params as fields) and the pure
  pushOverlay (top-deduped) / popOverlay
- add `OverlayHost.kt`: one composable dispatching on the stack top; every variant closes by pop,
  opens by push
- rewrite App's flag declarations, BackHandler, render `when`, and notification-tap reset onto the
  stack; showSettings/settingsRoute stay separate saveable base-layer state (the stack is
  deliberately NOT saveable: a ceremony entry carries key material)
- add `OverlayStackTest.kt` pinning the stack rules

Intended behavior improvements (the point of the entry): Users -> Add Gateway, Users -> Enroll,
Settings -> Your devices, and Settings -> Users now RETURN to their opener instead of clearing it;
back always dismisses what is on screen (the old arm order could close a thread hidden under
Settings).

Verified with my own eyes on the sandbox emulator: the four-deep chain Settings -> Domain & Trust ->
Users -> Add Gateway unwinds one screen at a time (the exact path that shipped 991ba91's dead
button), and the board editor opens above the shell and pops back to it. Emulator shut down after.

Audit (2 fresh Luna threads + Sonnet synthesis): no navigation regressions; all 13 variants mapped,
the one-shot ceremony guard held, the stack clear covers every old reset. Comment findings fixed.
One real gap accepted and filed as a board entry instead of half-fixed here: the new tests cover the
pure stack rules only, and nothing JVM-level exercises OverlayHost's dispatch or the BackHandler
wiring, because the project has no Compose unit-test harness; the emulator build is its answer, and
the click-through above is this lap's evidence.

## Refactor 6 - Rehome the ThreadScreen docks and name the status vocabulary

Two pure moves, Opus-executed, audited clean on the first pass (the only clean verdict so far).

Operation set (one commit):

- move ScheduledSendDock, SessionLimitDock, WakingNotice from SessionDialogs.kt into the new
  ThreadDocks.kt, so the dialogs file holds only dialogs
- move statusWord, presenceColor, StatusChip from SessionsHeaders.kt into the new SessionStatus.kt,
  the one vocabulary file its five consumers import
- forced minimum widening: STATUS_GREEN / STATUS_AMBER private -> internal (presenceColor left the
  file; HealthHeader and the freshness colors still read them in place)

Byte-identity proven twice: Opus diffed every moved block against the HEAD extract, and the audit
re-extracted and re-diffed independently, then re-ran the Kotlin gate itself rather than trusting
the report. Direction (b) from the entry (promote the vocabulary to a sealed type with label+color
members) was not taken: the single-file vocabulary already makes a second copy unnatural, and the
type change touches every render site for no defect it closes today.

## Refactor 7 - ThreadScreen's 49 parameters become three assembled subjects

Operation set (one commit):

- add ComposerState (draft + sendAwaitingWake + 7 handlers), ScheduledSendState (record + 3
  handlers), TerminalState (6 facts + refreshMs + 5 handlers) at the top of ThreadScreen.kt
- rewrite the signature (49 -> 27 params) and every internal read onto the clusters
- rewrite the one call site (MainActivity) to assemble the three objects inline
- the naming collision closed: `waking` is now ComposerState.sendAwaitingWake and `wakePending` is
  TerminalState.wakeInFlight, distinct names in distinct types, so swapping them is a type error
- fold-in: the redundant safe call in the eligible expression, now in a touched line

Verified with my own eyes on the sandbox emulator: the thread renders through the clusters (board
strip, transcript, Designer dock, the seeded draft's attachment strip, composer input flowing), and
the terminal view opens with its Wake path. Emulator shut down after.

Audit (2 fresh Luna threads + Sonnet synthesis): the wiring table checked out completely, and the
two wake booleans provably did not cross. The synthesis caught two stale comments the Codex threads
missed, on top of the one they found; all three fixed. Lesson kept for future prompts: comments
naming deleted parameters are a class the fidelity thread should grep for mechanically
(old-name-in-comment survives every compile gate).

## Refactor 8 - One owner-present gate, compiler-enforced

The entry's thesis proved itself before the lap started: the gate line had SIX verbatim copies at
reassessment, up from the five counted at scoping (SettingsSystem's delete-domain copied it in the
meantime), which is exactly the added-later-means-copied class the entry predicted.

Operation set (two concerns, one commit each was not needed; gate + extraction commit together
was avoided by keeping the extraction a pure move in its own file):

- gate (behavior-preserving unification): `requireOwnerPresent(lockOn, activity)` in Biometric.kt;
  `promptBiometric` file-PRIVATE, so the compiler forbids a seventh direct prompt site; six call
  sites rewritten; the null-activity posture (DENY) is stated once as the guard's invariant. The
  audit proved truth-table identity at all six sites including prompt side-effect counts.
- residue: biometric-gate-residue.test.ts (TS suite on purpose, pre-merge) bans promptBiometric
  and BiometricPrompt tokens outside Biometric.kt, vacuity-guarded.
- extraction (Opus, pure move): SttsVoiceSection's six playback-preference blocks into a private
  PlaybackPreferences(repo) in the same file, 436 -> 255 lines, byte-identity proven by sorted
  diff; the provider dialog stayed put because it reads four top-half locals.

Audit verdict fix-then-ship with one blocker that was MINE, not the Kotlin's: the new residue test
itself failed biome's width gate, which the whole pipeline missed until the synthesis ran
`bun run lint` independently. Pipeline lesson recorded: every stage that adds a TS file must run
the TS gates, not just the Kotlin ones beside it.

## Refactor 9 - One fence algebra, and the acceptance verdict out of the critical section

Reassessment sharpened the entry again: the two families' fence rules had ALREADY diverged on the
unfenced record (Copilot's fenceAccepts answered advance where Codex's classifyFence answered
foreign). The live cases differ by SIDE, not by family, so the shared home carries both rules under
names that say which side they serve.

Operation set (one commit):

- add `shared/agent-fence.ts`: AgentFence, fenceOf, sameFence, classifyAcceptanceFence (an
  acceptance INSTALLS a first fence), advancesFence, classifyEventFence (an event on an unfenced
  record is held foreign until reconciliation or an acceptance fences it)
- move Codex's four fence functions there (classifyFence renamed classifyEventFence at its three
  call sites); delete Copilot's file-local fenceOf/fenceAccepts (byte-equivalent to the acceptance
  rule; its call sites never compared the advance spelling)
- extract `decideAcceptance` into codexAgentReducers.ts: the full acceptance verdict as a pure
  function (replayed | unplaceable | conflict | refuse | unresolved | accept), with the service
  reduced to parse, look up, decide, apply
- move the two stragglers withActivity/withTerminal into codexAgentReducers.ts verbatim
- add agent-fence.test.ts and codex-acceptance-verdict.test.ts: the refuse-vs-unresolved boundary
  is directly pinned for the first time, including the minimal pair (a record an activity moved
  refuses; a non-advancing fence holds)

Audit (2 fresh Luna threads + Sonnet synthesis, both now REQUIRED to run the gates themselves after
last lap's lesson): zero behavior findings; the decision-path mapping rebuilt line by line from
HEAD and confirmed verbatim. Its real catches were three coverage gaps in MY new tests (a
confounded stop case, the unisolated refuse/unresolved minimal pair, sameFence's untested
coordinates), all closed. Two fixture attempts were rejected by the record schema's own
cross-invariants before landing on a reachable one, which is the schema earning its keep.

Not taken, recorded: the fold-the-whole-service-pure direction (b), since the apply half's side
effects (durability check, commit, refusal write) are exactly what the service is for; and the
relay progress-bookkeeping duplication (copilotRelay vs codexRelay) stays for a later entry, being
reliability plumbing rather than the retiring decision.

## Refactor 10 - The dead-surface sweep

The call graph was re-run fresh (grep + compiler + two adversarial Luna threads over both source
sets, reflection and codegen included), not trusted from the entry's list.

Deleted (4cffbf2): EnrollOps.ownerSas/ownerSignPub/ownerBoxPub (every consumer already reaches
repo.federation directly; the residue test pins WHO may do that, and the wrappers added nothing);
TrustOps.unlinkDomain and its now-orphaned ConsoleClient.crossDomainUnlink (the cascade the first
deletion exposed). Kept alive on evidence: ownerKeysForDisplay, exportOwnerBackup,
importOwnerBackup (Management, Users, Onboarding, Sharing all call them).

The entry's own caution answered: unlinkDomain is NOT a bug wearing dead code's clothes. Undoing a
link is exposed as untrustOwner (per person, Users row), which subsumes the teardown for every
Domain the person owns; per-Domain unlink has wire support (the gateway op and its consoleHandler
arm STAY, deliberately) but no UI, so restoring it is a product decision, not archaeology.

Behavior improvement the audit surfaced, committed separately: untrustOwner now pulls discovery
the way the deleted unlinkDomain documented, so an untrusted person's sessions leave the board
promptly instead of waiting out DISCOVERY_REFRESH_MS.

Reported again, still deliberately NOT deleted: the four CodexAppServer result schemas (wire
protocol vocabulary in the App Server definition file, re-exported by the barrel; local mode did
not consume them) and the console-protocol op types, both being protocol surface rather than
orphaned code.

## Refactor 11 - Cover the persistence codec

The seam first, then the tests: `ChatPersistenceStore` (13 slot methods declared beside the codec,
following the IdleSilenceStore precedent) lets a map-backed fake stand in for the Context-bound
AppStateStore, so the codec's whole surface runs on the JVM. `AppStateStore` implements it with
override markers; `ChatPersistence` takes the interface. Verified behavior-preserving by the audit
pair and by every existing gate.

Nineteen behavior tests over the fake, one per survival rule rather than per method: thread
round-trips with dense ids, the waking-row drop and legacy pending demotion, non-address keys
dropped on load and for good on re-save, malformed peer attribution degrading instead of surfacing,
anchor first-run seeding pinned against persisted-wins AND against the empty-map answer (only a
NULL slot reseeds), scheduled-send per-row poison isolation beside the blank-opId/zero-fireAt
drops, legacy bare-string drafts coexisting with the current shape, draft locations hiding blanks,
and per-row draft poison isolation.

The audit's fix-then-ship was earned: labels and absence streaks initially had zero coverage, and
nothing pinned the containment BOUNDARY. Threads, anchors and labels contain per FILE (one broken
sibling blanks the whole map), while scheduled sends and drafts contain per ROW. Both postures are
now asserted explicitly, so a future edit moving a codec across that line fails a test instead of
silently changing what a torn file costs.
