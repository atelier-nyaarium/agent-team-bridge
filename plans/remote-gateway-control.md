# Remote gateway control

Making a second machine visible and usable from the phone. Written after enrolling `ql-2815`
successfully and finding it registers, relays, and then does nothing you can see or act on.

## The problem, precisely

A gateway that is fully enrolled and running contributes **nothing** to the console, and cannot be
acted on from it. Two independent causes, which is why fixing one alone still leaves it useless.

**1. Invisible.** The console builds its list from SESSIONS, not machines. `routes.teams()` returns
presence rows and deliberately drops the headless host daemon, so a machine with no sessions and no
devcontainer projects contributes zero rows. The console groups by `gatewayId`, and zero rows means
no group, which means no section drawn. This was invisible-by-accident while one machine existed and
became wrong the moment a second did.

**2. Inert.** `SessionsScreen` gates Create on `key.gatewayId == state.localGatewayId`, so only the
gateway the phone polls offers it. That gate is not merely conservative UI: the op behind it is
local-only by construction (below), so exposing the button without the plumbing would just fail
against the wrong machine.

## What is actually local-only

Not one op. **Seven**, all reached through `relayToHost` in `consoleHandler.ts`, each refusing with
`terminal view unavailable on this Gateway` when there is no local daemon:

| Op | What it does |
|---|---|
| `peek` | capture the pane |
| `tmux_send` | type into the pane |
| `list_dirs` | browse for a workdir |
| `create_session` | spawn |
| `reload_plugins` | update sequence |
| `forget` | kill + dispose board work |
| `close_session` | kill |

`create_session` additionally resolves its target with `targets.localSpawn(op.target)`, so even the
address it accepts is local.

**Consequence for scoping: relaying `create_session` alone produces a session you cannot watch, type
into, or kill.** That is a worse state than today, because it looks supported. Either the family goes
or none of it does.

## Correction: the transport already exists

**The first draft of this plan proposed a new `host_op` relay kind and per-op routing in
`consoleHandler`. Both are unnecessary.** Reading the console transport rather than assuming from the
gateway side turned a cross-cutting four-phase change into a console-side one. Recorded because the
wrong version is the one that looks obviously right from the gateway.

A console op is **already sealed per target gateway**, end to end:

- `ConsoleClientSessions.kt` passes `targetGateway = transport.targetGatewayOf(target)` on peek,
  tmux_send, create_session, close_session, forget and list_dirs. Every one.
- `targetGatewayOf` parses the target Address and takes **its** gateway, falling back to the route
  gateway only for a bare name.
- The frame is sealed to that gateway's own `boxPub`, resolved from its owner-signed admission in the
  console's keyring (`requireGatewayKeys` -> `keyring.resolveGateway`).
- `consoleSurface` routes on it: `bridge.pushToGateway(route, frame)` when that gateway is
  registered, and `pushToGateway` is scoped to the ADMIN Domain, so a console frame cannot reach
  another Domain's gateway.
- The reply settles by `opId` through `settleConsoleRelay`, independent of which gateway answered, so
  the held HTTP request resolves normally.

So a `create_session` naming `<domain>.ql-2815.host` already seals to `ql-2815`, is already routed
there by the Router, and is already dispatched by that gateway's own handler against its own daemon
and its own `SessionStore`. Nothing on the gateway needs to learn anything.

**Why relaying a raw `HostOp` would have been actively wrong**, had I built it: `createSession`
carries `sessionToken` and `resumeSessionId`, which the comments in `host-op.ts` are explicit come
from gateway state and never from the console. Those belong to the OWNING gateway's `SessionStore`.
A relayed raw op would either carry a binding secret across a hop that has no business holding it, or
omit it and silently break resume and session binding.

**The remaining blockers are all console-side:**

1. No section is drawn for a gateway with no sessions, so there is nothing to press.
2. `showCreate` is gated to `state.localGatewayId`.
3. Create builds its target from a bare project name, which `targetGatewayOf` resolves to the LOCAL
   gateway. It has to be the qualified address of the section's gateway.

## What already works, and must not be rebuilt

- **Addressing.** `domain.gateway.spawn.session` already names a remote session; nothing new is
  needed to refer to one.
- **Chat.** `sendCrossGateway` already relays a send to another gateway and routes the reply back. A
  session on a sibling gateway is chattable from the phone the moment it exists.
- **Discovery.** `discover()` already fans out `list_teams` to every same-Domain gateway and merges.
  Confirmed answering `ok` from `ql-2815`.
- **The gateway roster.** The Router already serves a `gateways` list behind the app token (added for
  the setup header). The console can consume it directly.

## The principle

**Every gateway in your Domain behaves like the one your phone happens to poll.** Which machine the
console connected to is an accident of setup, and nothing about the interface should depend on it.

This is the whole design, and it settles the questions that were open here: all seven ops, including
`reload_plugins`, and a relay round trip on `peek` is simply the cost of the machine being elsewhere.
Anything less produces a second class of gateway that looks supported and is not, which is the state
that prompted this.

The one thing it does NOT extend to is another Domain. "Behaves like mine" is scoped to machines you
own; a linked friend's gateway is not one of them.

## Design decisions

### 1. The target is a qualified Address, and that is the whole routing mechanism

`targetGatewayOf` already seals to whichever gateway an Address names. So "make it work on another
machine" is entirely "name the machine in the target", and every guard that already exists keeps
applying: the seal is to that gateway's admitted `boxPub`, and the Router will only push it inside the
admin Domain.

This is why nothing gets a new cross-Domain gate here. There is no new path to gate - a console frame
for a foreign Domain cannot be sealed (no admission in the keyring) and would not be routed
(`pushToGateway` is admin-Domain scoped). The "behaves like mine, but only for machines you own"
boundary is already enforced by construction.

### 2. A bare target must keep meaning the local gateway

`gatewayOfTarget` falls back to the route gateway for a bare name, and a great deal already depends on
that. So the change is strictly additive: Create on a remote section builds a QUALIFIED target
instead of a bare one. Nothing reinterprets an existing bare name, which is what would silently
redirect today's working actions.

### 3. The roster is the KEYRING, not a fetch, and not synthesised session rows

Two sources were considered and rejected before this one.

**Placeholder `TeamInfo` rows** so the existing grouping draws a section: wrong, because they would
flow into every consumer of `TeamInfo` - send targets, share filters, the board's session resolver -
and each would then have to learn to ignore them.

**The Router's app-token `gateways` op** (added for the setup header): works, but needs a fetch, a
cache and a failure state, and can disagree with what the console is able to act on.

The right source is `federation.members()` filtered to `kind == "gateway"`: the owner-verified,
non-revoked admissions the console already holds. No network call, no new state, revocation-aware for
free, and - the reason it is the correct one rather than merely the cheapest - **it is exactly the set
the console can seal to.** A machine is drawn if and only if a frame can be addressed to it, so a
visible section is always an actionable one, and the two can never drift.

Online-ness stays derived from live sessions as it is today; an admitted machine with none reads as
present but idle, which is the honest description of QL-2815 right now.

### 4. The route Gateway keeps Create unconditionally

Every OTHER machine's Create requires a live admission, because a section can outlive one: a revoked
Gateway's session rows survive in the cached presence list until a poll replaces them, and a Create on
one cannot be sealed. The route Gateway is exempt.

That exemption is deliberate and it does leave one inert case - revoke the machine your phone polls
and its Create stays up until the rows clear, failing at the seal. The alternative is worse: a keyring
this device cannot read, for any reason, silently costs the owner the only Create they have, on the
one machine that is definitely theirs. A button that fails loudly beats a button that is not there.
It is also the pre-existing behaviour, since Create was gated to exactly this Gateway before.

### 5. An offline gateway refuses, it does not queue

These ops are interactive - someone is watching a spinner. `pushToGateway` already returns false when
that gateway holds no connection, which surfaces as a retryable bounce. Queueing a `create_session`
for a machine that may be off for a week produces a session appearing hours later with nobody
expecting it.

## Phases

All console-side. No wire shape, no gateway change, so the usual gateway-first ordering does not
apply and this ships as one app release.

**Phase 1 - visibility.** `groupByGateway` unions the admitted-Gateway roster into the session-row
grouping, so a machine with no rows still gets a section. The roster reaches the screen as
`ChatState.admittedGateways`, republished by `ChatRepository.refreshAdmittedGateways` after every
keyring fold - the keyring is durable state with no change signal, and resolving a member verifies
its admission, which is too expensive to read per recomposition.

**Phase 2 - qualified targets.** `CreateDialogTarget` owns the one rule turning a picked project into
a spawn target: bare on the route Gateway, `<domain>.<gateway>.<project>` on any other. The dialog
spells no address itself, and both its browse and its spawn are addressed to the Gateway it was
opened on.

**Phase 3 - ungate Create.** `showCreate` is `!isPeer`. Cross-Domain sections keep no Create, since
spawning on a friend's machine remains meaningless.

**Phase 4 - verify the rest of the family.** peek / tmux_send / close / forget / rename already pass
`targetGatewayOf` against `team.name`, which discovery already delivers qualified, so they follow.
`list_dirs` did NOT: it was the one op whose target was hardcoded bare, so a directory picked for
another machine listed this one's filesystem. It now takes the host spawn point.

Confirming the family against the real second machine is still outstanding. "Already passes the right
argument" is not "verified", and `list_dirs` is what that distinction cost.

## What the phases turned up that the plan did not predict

- **`list_dirs` was not in the family.** Every other op takes a target from a session row. This one
  composed its own, bare, so it was local by construction rather than by argument.
- **The empty board was a second invisibility.** `EmptyBoard`'s final branch is "No active sessions
  yet", a dead end with nothing to press - and a Gateway with a daemon but no devcontainers and no
  sessions contributes zero rows, so it lands there. The sections now replace that ONE branch;
  `emptyBoardHasCause` keeps every real not-yet-working state (error, enrolling, connecting, stalled
  poll) reporting, since a Create offered over a dead connection cannot be delivered.
- **The create dialog did not name its machine.** Every Gateway has a `host`, so three sections opened
  three identical dialogs. The title carries the Gateway.
- **`pendingSpawns` keyed on the project.** Two machines each have a `host`, so a create in flight on
  one suppressed a create on the other. It keys on the target now, and `spawnSession`'s retry-opId map
  with it.
- **The roster must land in the SAME state emission as the session rows.** Published as its own update
  after connect's, one emission carried a machine's rows while the roster was still empty, drawing its
  section with the Create missing until the next. Every other publisher is a keyring fold, where there
  are no rows to disagree with.
- **A Domain id is still never guessed.** With no session anywhere, `adminDomainId` is empty and no
  machine can be named - so the roster is filtered to the route Gateway, which a bare target already
  names. That is what makes the daemon-up-but-idle single machine reachable without inventing an id
  that the signing and routing sites all refuse to invent.

## The first field report, and what it actually was

The directory browser worked on the route Gateway and returned nothing on the second one. Three
defects stacked, and only the last was where it looked.

**The Router substituted a different machine.** `consoleSurface`'s relay fell through to
`pushGatewayFrame` whenever the named gateway was not connected, and that picks the first connected
gateway in the Domain. A frame sealed to ql-2815's box key was delivered to sakura, which cannot open
it and answered `unseal failed`. Its log carries the proof, at the minute the owner was typing. The
fallback is right for a frame that names no gateway and wrong for one that does; it was unreachable
while a single gateway existed, and this feature is what made a console address a second one. So the
claim that this shipped with "no gateway change" was wrong: the change was needed and missing.

**The console swallowed the answer.** `SessionOps.listDirs` collapsed every failure into an empty
list, so an offline machine, a Gateway with no host daemon and a folder with no subdirectories were
one indistinguishable blank picker. That is why the report could only be "it does not work".

**Nothing said the machine was offline.** The section header showed online/offline as the ELSE branch
of the Create button, so ungating Create removed the status word from exactly the machines whose
reachability had just started to matter. The plan had said an admitted machine with no sessions "reads
as present but idle, which is the honest description" - it was not honest, because it could not tell
idle from unreachable, and that sentence is what let the gap ship.

Liveness now comes from the Router's own app-token `gateways` roster, on the discovery interval. It is
the precondition the op itself turns on, so it cannot disagree with what the board can do. Null means
the Router did not say and nothing is drawn: a machine is called offline only on an answer that
arrived. A failed refresh KEEPS the previous answer rather than clearing it, so a stale "online" is
possible while the Router is unreachable - accepted, because a blip reporting every machine offline is
worse, and a console that cannot reach the Router is already saying so in the health header.

## Bug classes to avoid

- **Rebuilding the transport.** The first draft of this plan did exactly that. Anything that reads
  like "relay the host op" is re-deriving what `targetGatewayOf` + `pushToGateway` already do.
- **Relaying a raw `HostOp`.** `createSession` carries `sessionToken` and `resumeSessionId`, which
  belong to the owning gateway's `SessionStore` and must never cross a hop.
- **Reinterpreting a bare target.** A bare name means the local gateway today and must keep meaning
  it; only a qualified Address may name another machine.
- **Placeholder rows in `TeamInfo`.** They would flow into send targets, share filters and the board's
  session resolver, each of which would then have to learn to ignore them. See decision 3.
- **Silent local fallthrough.** Still the one to fear, from the other direction: a Create that fails
  to qualify its target does not error, it spawns on the WRONG machine. The documented `forget` bug is
  the same shape - a foreign address folding onto a same-named local session.
- **Assuming the family follows.** peek / close / forget already pass `targetGatewayOf`, but "already
  passes the right argument" is not the same as "verified against a second machine". `list_dirs` was
  the one that did not, and it shipped.
- **Collapsing a failure into an empty result.** An unreachable machine and an empty folder are not
  the same answer, and a picker that renders them identically turns every outage into "the feature is
  broken". Anything returning a list to a person needs somewhere to put the reason there is none.
- **Caching a failure the way a result is cached.** A failed listing stored under its directory key
  never retries, so the machine coming back does not clear it. Successes are cached; failures are
  displayed and stand aside.
- **A status word that is the ELSE branch of a button.** Adding the button to more places silently
  deletes the status from those places. Both belong in the header at once.

## Deploy order

**Router first, then the app.** The console-side work alone was one app release, which is what shipped
in 8.3.6; the Router refusal that followed is not, so the rule the first draft dropped applies after
all.

- Old console against the new Router: better immediately. A frame naming a disconnected machine is
  refused instead of being handed to another one; the old console still shows an empty picker for it,
  since it has no way to say more.
- New console against an old Router: the misdelivery persists, and the console reports it as
  "Couldn't reach that machine" rather than listing the wrong machine's folders. The new `gateways`
  request 501s and reads as unknown, so nothing is drawn as offline.

Neither order breaks. Router first is preferred because it fixes the routing rather than describing it.

## Resolved

- **All seven ops relay**, `reload_plugins` included. A machine you can spawn on but not update is
  the same half-supported shape this plan exists to remove.
- **Relayed `peek` costs a Router round trip per capture.** Accepted. The local single-flight and
  cadence floor still apply on the owning gateway, so the relay adds latency, not load.
