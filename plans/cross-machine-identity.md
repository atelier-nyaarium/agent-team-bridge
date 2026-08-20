# Questionaire

Revamp of the cross-machine identity and address bug class. Opened after enrolling a second Gateway
surfaced six defects in one afternoon, none of them new code.

## The class, in one sentence

A name, address, or identity that is correct where it is produced, and is re-derived, re-qualified,
or gated wrongly once it crosses a machine boundary.

## Instances, all confirmed in code

| # | Defect | Where | Status |
|---|--------|-------|--------|
| 1 | Forwarded `gateway_relay` omitted the required `v`, so every gateway-to-gateway relay was rejected at the far end | `gatewayBridge.ts` | fixed 8.3.8 |
| 2 | `list_dirs` composed a bare `"host"` target, listing the route Gateway's filesystem | `ConsoleClientSessions.kt` | fixed 8.3.6 |
| 3 | A notice carries a qualified `session_id` AND a bare `from`; the console prefers `from` and stamps its own Gateway on it | `consolePushOps.ts:214`, `PollDrain.kt:353` | OPEN |
| 4 | Create built a bare spawn target, so Create on B would spawn on A | `SessionsScreen.kt` | fixed 8.3.6 |
| 5 | `item(key = "spawn:$projectKey")` collided once two Gateways each had a `host` spawn | session list | fixed 7.25.0 |
| 6 | `/capabilities` is ungated and advertises what the gated routes then refuse | issue #252 | OPEN |

Two more that are the same shape one level down, and matter because they are what HID the others:

- `discover()` maps a failed relay to `[]` with no log, which concealed #1 for a full day.
- `SessionOps.listDirs` collapsed every failure into an empty listing, so #2 presented as "the
  feature is broken" rather than "that machine is offline".

## Ruling carried in from the owner

Anything that is purely a consequence of a peer running an old version is out of scope. Those get
updated by hand rather than designed around.

## Scope findings

### More instances, previously unknown

The address sweep found four beyond the six, each a wire-origin value reaching a local-defaulting
qualifier:

- `intent.ts:99` compares a qualified address against a bare presence team, so the comparison can
  **never** be true. The terminal-focus cadence ramp is dead for every session on every Gateway.
- `BoardOps.boardGatewayOf` falls back to the route Gateway for a team missing from state, so a
  remote session's board reads and its queued-write drop land on the wrong machine. Its sibling
  `boardGatewayOfKey` answers null for the same question and documents why.
- `wakeSession` / `relaunchSession` rebuild a bare target from parts; only a local-only guard stops
  the mismatch, so a remote session cannot be woken or relaunched.
- `bridgeDiscover`'s self-exclusion filters by bare `PROJECT_NAME`, hiding a same-named session on
  any other Gateway.

### The clean break is the expensive option with the worst coverage

Measured, not estimated: the sweep applied brands to a copy of `src/` and ran `tsc`.

- ~250-350 TypeScript edits across ~40 files, ~450-600 Kotlin edits across ~50 files.
- It would have caught **2 of the 6** defects, and both are already fixed.
- Kotlin costs double: `@JvmInline value class` is a distinct type, so 205 map-key/equality sites
  and 21 interpolation sites need unwrapping, and there is no precedent for the pattern in that half.
- Branding outputs is nearly free and nearly worthless; the cost is entirely in branding inputs.

### The actual generator is a default, not a missing type

`parseTarget` arity 1 and 2 fill in the local gateway, so a bare name is never rejected, only
silently adopted. `Team.kt:87 localFieldOrSelf` exists purely to paper over the ambiguity, and its
own doc calls that idempotence a feature. **A type cannot remove that default**; only deleting the
bare form from cross-machine wire positions can.

### Wire cost is mostly nil

`ConsoleOp.*.target` is already qualified and correct at all 7 ops. `MailboxEntry.from` can be made
always-qualified backward-compatibly with no console release. Defect 2 was fixed with no wire change
at all.

### Identity is a second, separate problem

`sessionAuthority.ts` documents itself as the SOLE owner of "may this caller act as X". It owns
**one of seven** gates. `handshakeConfirmed` is a full identity fact written in three places and read
by six modules with no single resolver, and it gates reply delivery, live-socket resolution, presence
status and awareness pushes. That is the gate that made the second machine mute. The existing residue
test pins three identifiers and cannot fail for a gate that decides identity by any other means.

### Today's fix does not reach the deepest case

The `[discover]` warning added with the `v` fix sits INSIDE the roster loop (`routes.ts:552`). When
the roster itself comes back empty the loop body never runs, so nothing logs. Three facts compose:

1. `gatewayBridge.ts:636` answers `{gateways: []}` for a connection it holds no registration for. A
   successful empty answer, not an error.
2. `routerClient.ts:352` logs a rejected `gateway_register` and returns WITHOUT closing the socket,
   so `isConnected()` keeps answering true.
3. `discover()` reads `rosterCall.result` and never reads `rosterCall.error`, and `callTool` never
   rejects. A Router timeout and a Router answering `[]` are the same value.

So a Gateway whose registration was refused reports "I am alone" in total silence, which is the exact
symptom instance 1 produced. Worse than an empty result: a partial discover is a **200 with fewer
rows**, and `ChatState.withFreshTeams` wholesale-replaces, so a machine's sessions vanish from the
board with no error state anywhere. Nothing on the wire carries how many peers were asked versus how
many answered.

`federation-router-routing.socket.test.ts:44` pins the empty answer as CORRECT behaviour, so the
suite cannot ever catch this.

### Frames are mostly safe by construction

Every `FederatedOp` literal is a contextually-typed argument, so a required field cannot be omitted
without a compile error. The unsafe population is the seven untyped `Record<string, unknown>` frames,
which is exactly where the `v` bug lived. `agentDaemonCore.hello()` is the one frame on its wire that
does not self-validate before sending, while every sibling does.

## Question 1 - which failure do we make impossible first

Q: Completeness (a cross-machine answer states whether it reached everyone), ambiguity (delete the
bare form from cross-machine positions), identity (one resolver for the seven gates), or the
type-level brand?
A: A (completeness) first. Re-evaluate B and C afterwards. D rejected on its measured cost.

> "Sounds good. Go for A first, then reevaluate B & C afterwards, as the codebase gets better."

# Plan

## Phase A - completeness rides the wire

A cross-machine answer must state its own completeness: how many peers were asked, how many
answered, and whether the roster itself was readable. A partial result can no longer be returned as
a plain success, and an unreadable roster can no longer masquerade as "no peers".

Status: A1, A2 and A3 are implemented. Remaining before B/C re-evaluation: verify against the live
second machine (kill ql-2815's gateway mid-session and watch the caveat and the held rows), and the
plane-merge fix rides along (the presence plane speaks for the route Gateway only; replacing
wholesale swept every remote machine's rows on each local presence change).

**A1 - gateway.**
- `routerClient` learns `isRegistered()`: true only after a `gateway_register` the Router accepted,
  false on a rejection or disconnect. Today a refused registration leaves the socket open and
  `isConnected()` true, which is how "revoked" reads as "alone".
- The Router refuses `list_gateways` from an unregistered connection instead of answering `[]`. An
  old gateway folds the error to `[]` exactly as today, so no deploy window.
- `discover()` reads `rosterCall.error` (it never has), and returns coverage beside the rows:
  asked / answered / unreachable gateway ids / rosterKnown. Logs when the roster is unknown, which
  is the case today's in-loop log can never reach.
- `list_teams` result carries the coverage as an OPTIONAL field; `/health` gains
  `router_registered`.

**A2 - MCP.** `crosstalk_discover` prints the coverage when present, so an agent sees "asked 2,
1 unreachable" instead of a silently shorter list.

**A3 - console.** `ConsoleListTeamsResult` gains the optional coverage. `withFreshTeams` stops
advancing absence streaks for rows whose gateway is named unreachable, so a machine that could not
be asked keeps its rows instead of having its sessions swept. The offline chip shipped in 8.3.6
already covers the display side.

Deploy order: gateway first, console last, field optional throughout - the standard rule.

## Phase B - ambiguity

Done in this pass:

- The notice misattribution (instance 3), fixed at BOTH ends. `humanNotify` and `ConsolePeer` stamp
  a qualified `from` before the fan-out; the console reads the notice store key's sender FIRST and
  only falls back to `from` (an older gateway).
- `boardGatewayOf` reads the gateway from the ADDRESS, not a presence-row lookup that could miss and
  fall back to the route Gateway.
- `wakeSession` / `relaunchSession` build a qualified spawn target, so both now work on any admitted
  machine instead of silently refusing or re-creating on the wrong one.
- `crosstalk_discover` self-excludes by (gateway, name), not bare name, using the `localGatewayId`
  the `?coverage=1` object now carries. A same-named session on another machine is listed again.
- The terminal-focus intent is normalized to the bare local team at intake (`tryLocalName`), so the
  cadence ramp compares like with like and actually fires.

Deferred within B: deleting `localFieldOrSelf` (its board-key callers are legitimate local-field
holders; revisit with the brand question), and the focus intent for a REMOTE session's terminal
(poll reaches the route Gateway only, so ramping another machine's cadence needs its own relay).

## Phase C - identity (first slice done, rest deferred)

Done in this pass, from issue #252:

- The gateway agent-tool branch requires the session binding token as well as the capability, so a
  hand-launched session gets working LOCAL agents instead of five tools that can never succeed.
- A token-less caller on `/codex` and `/copilot` is told it is unbound (401); an unknown token keeps
  the anti-probing "not found".
- `refuseForeignPoll` answers per-job instead of machine-wide: an unbound session can poll the job
  it created, refused callers get the same 404 a dead id gets (strictly less probe signal than the
  old 403), and a bound session's job still demands its binding.

Deferred: the single resolver for all seven identity gates, `handshakeConfirmed`'s six readers, and
the hand-launched channel deafness (a launch-mode fact the gateway cannot see).

## Convergence audit (post-funnel)

The `deliverToOwner` funnel plus its residue test closed the mailbox half of the class. Audit
findings deliberately recorded rather than fixed, each dormant until two devices poll DIFFERENT
route Gateways (not a live configuration; every device provisions against the admin Gateway):

- Read anchors do not converge between Gateways: `report_read` lands only on the route Gateway,
  and each Gateway's `read-anchors:${ownerId}` plane serves its own store. Fix needs owner-scoped
  origin-only relaying with a monotonic merge, its own design.
- The mailbox cursor is one `(epoch, seq)`, not per Gateway: a device that switched route Gateways
  would drain the sibling's converged copies as fresh rows (thread dedupe is `(epoch, seq)` only).
  Needs a Gateway-scoped cursor or a cross-epoch logical entry identity.
- The relay wire schema bounds `from`/`session_id` by length only. Producers all qualify today
  (`qualifyFrom`, `storeKey`), and a canonicality `.refine` would reject entries from an
  older-version sibling for the whole deploy window, so enforcement stays producer-side for now.

## Hold-expiry audit (post-#251)

The class: a hold whose release event may never arrive. The structural verdict, after evaluating a
shared Hold/Lease primitive against the real holds: the release semantics differ too much for one
abstraction (persisted results, read-time expiry, fan-out wakeups, external failAll), so the rule
stays per-site: **every hold names its release event AND a bound, and expiry lives in the read, not
in a sweeper's cadence.** A repo-wide Map/Set scanner was evaluated and rejected - most holds are
instance fields it cannot see, so it would enforce the wrong thing.

Fixed under the rule: handshake pending (TTL on blocking, answerability kept), the codex/copilot
reconcile guards (time-bounded + hello supersedes), connectorProxy's CONNECTING deadline, the
console's wakingTeams (TTL at the read).

Bounded already, deliberately not touched:
- The console opCache's in-flight promise coalesces same-opId retries onto whatever the op does;
  every current op is bounded (sendBoundMs, poll hold, hostOp timeouts). A per-entry timeout was
  considered and rejected: evicting a mutating op's cache entry while its first attempt may still
  run reopens double-execution, the exact thing the cache exists to stop. The bound is the op's.
- A goal whose process dies between the send's ok and its sentAt write expires via GOAL_TIMEOUT_MS
  without typing - a bounded miss, not a stuck hold.
