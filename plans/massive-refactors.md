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
