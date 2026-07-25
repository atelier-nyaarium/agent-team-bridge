# Emulator sandbox build type

## Why

Every visual question about the console has to be answered by the owner, on their phone. A night
spent chasing vanished attachment chips cost hours for exactly that reason: the agent could read
source, read the gateway's state, and read a debug log stream, but could never look at the screen.
Each hypothesis needed a build, a sideload, and a human awake at 2am to describe what they saw.

An emulator already exists on the dev host with the app installed. What it cannot do is get past
onboarding, because the console needs a real provisioned Gateway, a real owner key, and a real
admission before it renders anything but "Can't connect".

This build type removes that gate so the agent can look for itself.

## Scope

A sandbox, not a product surface. The owner's framing:

> that would be up to you on what you need to test. very much a sandbox. so let the comments know on
> it to add or remove that sort of stuff on-demand

So the seeded fixtures are explicitly scaffolding. Anyone working in here should add a thread shape,
delete one, or bend the fake state to whatever is being tested that week, with no obligation to keep
any of it. That intent belongs in the source set's own comments, not only here, since that is where
someone will actually be standing when they wonder whether a fixture is load-bearing.

Decided: **canned state only**. No network, no evie, no crypto handshake, no provisioning scan. An
option to proxy a real local Gateway was considered and rejected: it drags real enrollment back in,
which is the precise thing this exists to escape.

## Design

### Isolation

- A third build type beside `debug` and `release`, with its own `applicationIdSuffix` so it installs
  alongside the real app and can never overwrite the owner's install.
- All sandbox code lives in an `src/emulator/` source set, so the fake state and the onboarding
  bypass are not compiled into `debug` or `release` at all. A hatch that cannot exist in a shipping
  build cannot become a hole in one, which matters more here than convenience does.
- Minify off, for iteration speed. The R8 gate stays `assembleRelease`'s job.

### The one seam in shared code

`ChatState.teams` is never restored from disk. It is only ever whatever the Gateway last reported
(`ChatRepository.connect` -> `client().teams(...)`), and the board renders `EmptyBoard` whenever
there are no sessions, which is the screen that shows "Can't connect". So seeding threads alone is
not enough to reach the board: a build with no network has no sessions, and no amount of persisted
thread history changes that.

That requires one entry point in shared code. It is deliberately narrow rather than a general state
mutator, and it is inert by construction outside this build type:

```kotlin
fun seedSandbox(teams: List<TeamInfo>, threads: Map<String, List<Message>>) {
    if (BuildConfig.BUILD_TYPE != "emulator") return
    ...
}
```

The guard is not decoration. A hook that only happens to be unset in release is one refactor away
from being set; a hook that checks its own build type stays inert even if someone wires it up by
mistake.

### What gets seeded

Chosen to cover exactly what could not be seen during the attachment investigation:

1. A ref message carrying a real manifest and real snapshots, so the claimed-link styling and the
   code viewer are both reachable on first launch.
2. An image attachment, since a thumbnail whose bytes are missing renders as nothing and is
   indistinguishable from a missing chip.
3. A plain file chip, the non-image path through `buildFiles`.
4. Enough history to exercise scrolling, the read pointer, and the unread divider.

## Phases

- [ ] **Phase 1** - build type, source set, the `seedSandbox` seam, and one seeded thread covering
      the four cases above. Verified by installing on the emulator and reaching a board.
- [ ] **Phase 2** - fixtures for the cases the investigation could not reach: a stale ref, a ref
      whose bytes are gone, a hidden-chip row beside a visible one.
- [ ] **Phase 3** - a scripted screenshot pass, so a visual regression is catchable without a human
      describing a screen.

## Open

- Whether the sandbox should also fake presence states (`working`, `verifying`, `available`), which
  drive the pulse bar and the terminal view's own gating. Not needed for attachments; likely needed
  the first time a board tile misbehaves.
- Whether `SwitchboardService`'s poll loop should be suppressed entirely in this build, or left to
  fail into a cosmetic banner. Leaving it running is more faithful and costs nothing while the board
  has sessions; suppressing it removes noise from the log.
