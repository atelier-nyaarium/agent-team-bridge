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

- [x] **Phase 1** - build type, source set, the `seedSandbox` seam, and one seeded thread covering
      the four cases above. Verified by installing on the emulator and reaching a board.
- [ ] **Phase 2** - seed through the mailbox drain rather than straight into state (see below), then
      add the fixtures the investigation could not reach: a ref whose bytes are gone, and a
      hidden-chip row beside a visible one.
- [ ] **Phase 3** - a scripted screenshot pass, so a visual regression is catchable without a human
      describing a screen.

## What Phase 1 confirmed, and what it caught

Confirmed by looking, on the first run:

- The build installs beside a real install and opens onto a seeded board and thread.
- Image thumbnails and plain file chips both render.
- A claimed ref link renders blue and underlined, which is the `--accent` fix. That bug had shipped
  for as long as references existed and no test on either side of the wire could see it.
- **The code viewer opens on the right lines.** A tap resolved to the snapshot, highlighted 33-36,
  and syntax-highlighted the file. That was the last unverified hop in the whole feature.

Caught immediately, both worth fixing in Phase 2:

- **Plugins default off**, so the first run rendered every ref as an inert red unhandled protocol and
  left the artifact chips visible. Now switched on by the sandbox before anything boots. This is the
  same toggle that cost hours of confusion on a real device.
- **Seeding straight into state bypasses the mailbox drain**, and drain time is where
  `RefDisplayIndex` learns which attachments are reference artifacts and what each ref's quality is.
  So in the sandbox the artifact chips are NOT hidden, and a `fuzzy` ref renders blue rather than
  amber. Both are fixture artifacts rather than product bugs, and both would be fixed by routing the
  canned rows through the same drain a real message takes.

## Open

- Whether the sandbox should also fake presence states (`working`, `verifying`, `available`), which
  drive the pulse bar and the terminal view's own gating. Not needed for attachments; likely needed
  the first time a board tile misbehaves.
- Whether `SwitchboardService`'s poll loop should be suppressed entirely in this build, or left to
  fail into a cosmetic banner. Left running for now: it costs nothing while the board has sessions,
  and its "Gateway not provisioned" banner is honest about what this build is.
- The board's version column is narrow enough that a longer `versionName` wraps one character per
  line. Noticed because a `-sandbox` suffix mangled it; the suffix is gone, the weakness is not.

