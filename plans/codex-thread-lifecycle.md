# Codex thread lifecycle

A Codex thread switchboard starts is never told it is finished. `codex app-server` spawns every MCP
server in the owner's `~/.codex/config.toml` as its own child on `thread/start`, before any turn
runs, and keeps the thread loaded until the app server dies. The daemon supervises one app server
per execution target for its whole lifetime and reaps it only on shutdown or a failed open, so every
delegated thread since the host daemon started stays loaded with its servers. One day of audit
fan-outs left 22 lexicon and 22 nyaaskills servers idle under one app server, about 1.2GB, and one of
them had spawned a stale lexicon daemon that held that workspace's store.

The owner's decision: no per-thread MCP selection and no new parameter. Threads inherit the owner's
codex config on start and on resume alike; what this plan adds is the other half of the thread's
life. Adversarially reviewed over four rounds (Sol, gpt-5.6-sol); every finding vetted against the
code. The probes below ran against scratch app servers on codex-cli 0.147.0, never switchboard's.

What the app server does, measured:

- `thread/archive` after a completed turn unloads the thread and kills its MCP children and any
  background terminal it started. `thread/read {includeTurns: true}` still returns its turns.
- `thread/archive` on a thread that never ran a turn refuses ("no rollout found"), and a second
  archive on an archived thread refuses the same way. `thread/unarchive` on a thread that is not
  archived refuses ("no archived rollout found"). Neither is idempotent.
- `thread/resume` on an archived thread refuses; `thread/unarchive` then `thread/resume` reloads it
  with fresh children. Resume inherits the ambient config exactly as start does.
- `thread/delete` on a thread that never ran a turn unloads it and kills its children.
- `thread/unsubscribe` unloads nothing.
- `SIGTERM` to the app server reaps every descendant.
- Every one of those refusals arrives as JSON-RPC code -32600 with a sentence.

## Step 1 - Structured transport failures

✅ Shipped. `createJsonlTransport` in `src/mcp/devcontainer/codexAppServer.ts` rejects every failed
request with an `AppServerFailure`: an `Error` carrying `kind: "refused" | "timeout" | "unreadable" |
"closed"`, and for `refused` the JSON-RPC `code` and `data`. The messages are the ones the transport
always sent, so `describe`, `errorText` and every existing catch keep their words. A reply arriving
after its timeout is dropped by id. The lifecycle in Step 2 branches on `kind` and on nothing else:
every lifecycle refusal the App Server sends carries code -32600, so the code discriminates nothing.

The class is module-private, exported as a type only, minted with a symbol the constructor requires,
and recognised by `isAppServerFailure` over a `WeakSet` of minted instances, so constructing one
elsewhere is a compile error, a constructor reached through an instance throws, and a borrowed
prototype does not pass. The pending waiter's `reject` is typed to the minted failure, so an ending
that rejects with a bare `Error` does not compile. `AppServerTransport.request` states the contract
for every double. `codex-failure-residue.test.ts` forbids the transport's three sentences and the two
fragments only the App Server's lifecycle refusals carry, held to refusals recorded from
codex-cli 0.147.0, across production source outside the two transports.

The transport ends three ways, child exit, a write the pipe refuses, and `close()`, and every ending
runs one `fail()` that settles every waiter as `closed` and clears its timer; a refused write also
kills the child so the supervisor's exit path drops the lease, and `close()` is idempotent.
`unsubscribeThread` is gone: nothing called it, and `thread/unsubscribe` unloads nothing.

Tests: `src/__tests__/codex-app-server.test.ts` through `fakeChild()`, which can refuse writes and
counts kills: a refusal with code and data, a malformed reply, a reply landing after its timeout,
the child dying, a refused write, and `close()` twice and after an exit, each asserting the kind,
and the three endings asserting that no timer remains; the guard refusing an ordinary error, a
borrowed prototype and a reached constructor.

### Bug Classes

- Three endings of the transport each responsible for failing their waiters, and two forgot, one
  rejecting with a bare error and one leaving them to the timeout. Closed by one `fail()` every
  ending calls and a reject type that admits only the minted failure.

## Step 2 - The thread lifecycle owner in the Codex client

✅ Shipped. `CodexAppServerClient` speaks `thread/start`, `thread/resume`, `thread/read`, `turn/start`,
`turn/steer` and `turn/interrupt`. It holds no state per thread. Both drivers resume a thread they did not just create before starting a turn, which is the
half of the lifecycle that exists; nothing ever unloads one.

The client composes `ThreadLifecycle` (`src/mcp/devcontainer/codexThreadLifecycle.ts`) and is its
only user: the failure guard is injected, so the two modules do not import each other. A record
exists from the moment the server returns a thread id, or from the first time a caller names a
thread this client never started. Phases: `unloaded` (reached by name only, so not known to be
loaded; its first activation resumes it), `idle` (loaded with no turn of ours, whether just started
or resumed and then refused a turn), `active(turnId, epoch)`, `parking`, `parked`, `disposed`,
`poisoned(reason)`. The epoch is the record's own counter, advanced by every activation, so a retry
scheduled for an earlier life of the thread drops itself. Every request for a thread, the read
included, and every terminal accepted for it passes through that thread's queue, so two operations
on one thread never interleave on the wire. `open` takes the two consumer hooks, `onTerminal` and
`onPoisoned`, both defaulting to nothing. `stateOf` answers a thread's phase for a consumer.

- `startThread` leaves the thread `idle`. `startTurn` loads the thread first and then sends
  `turn/start`: nothing for `idle` or `active`; for `parking` the pending retry is dropped, since the
  thread is still loaded; for `parked` or `unloaded` a `thread/resume`, and on a refusal
  `thread/unarchive` then `thread/resume`, surfacing the original resume failure if the unarchive
  refuses. `resumeThread` is the same loading for a caller that needs the thread loaded and nothing
  else, and is a no-op on a thread already loaded. The turn id the response returns moves the thread
  to `active` with the next epoch. A terminal that arrives for this thread before that response
  resolves is buffered outside the queue; once the id is known the buffered one for that turn settles
  it and any other is published without parking. A `turn/start` that fails publishes them too, since
  no turn of ours will ever own them, and then the failure reaches the caller.
- `settleTurn(threadId, turnId, terminal)` is the only entry for a terminal, from whichever observer
  saw it. A terminal is the one report a turn gets, so a thread this client has no record of is
  tracked rather than dropped: after a restart the daemon routes terminals for threads a previous
  generation started. It is handed to the injected `onTerminal` once per turn, so it is published and
  retained before anything is unloaded; the thread then parks only when that turn is its own active
  one, or when it had no turn of its own (`idle`, or `unloaded`, since a terminal proves the thread
  was loaded). A terminal for another turn while one of ours is active is published and changes
  nothing. Parking a thread this client never loaded is safe because one client owns a target's
  threads at a time: a generation is retired before its successor opens.
- `park` archives. A refusal runs the dispose rule rather than a retry: `thread/read` twice across a
  short quiet interval (`DISPOSE_QUIET_MS`); two reads proving zero turns delete the thread
  (`disposed`); a read showing a running turn adopts it as `active`; anything else, a refused delete
  included, counts against a bounded budget (`PARK_ATTEMPTS`) with a retry after `PARK_RETRY_MS`, and
  exhausting it poisons the generation with reason `exhausted`. Logging a failed archive is not a
  state, and no path leaves a thread `parking` with nothing scheduled.
- `adoptOrDispose` is the same read for a thread whose first turn is in doubt: a running turn becomes
  `active`; a settled one is accepted the way `settleTurn` accepts a terminal, after which the read is
  authoritative over a stale `active`, and one already published here parks without publishing
  again; two quiet reads proving nothing delete it; an unknown read changes nothing.
- `steerTurn` and `interruptTurn` are refused only for what this client knows is wrong: another turn
  of its own is active, or the thread is `disposed` or `poisoned`. Everything else, an idle or
  unloaded thread and a thread with no record here, goes to the server, which arbitrates: after a
  daemon restart the daemon steers turns a previous generation started, and Step 3 is where those
  are adopted. They are queued like every other request all the same, so two controls on one thread
  never race. `readThread` is the same: queued, and refused for a thread that ended.
- A transport failure of kind `timeout` or `unreadable` on any lifecycle request (`thread/archive`,
  `thread/unarchive`, `thread/delete`, `thread/read`, `thread/resume`, `turn/start`) moves the thread
  to `poisoned` with reason `failure` and fires the injected `onPoisoned`, since the request may still
  land on the server after a later activation and a local epoch cannot recall it; the caller sees the
  minted failure. A well-formed reply the schema rejects is not that: a read answers `unknown`, and a
  `turn/start` throws the parse error with the thread unchanged. The consumer retires a poisoned
  generation; nothing on it is activated again, and every request for a `disposed` or `poisoned`
  thread is refused.
- A park retry is a timer outside the queue's lock, one per thread; an activation cancels it and
  advances the epoch, and a retry that fires after the thread moved on finds a phase or epoch that is
  no longer its own and drops itself. A follow-up waits only for a request already on the wire.
- `close` cancels every timer and retry; an operation paused between its two reads is released at
  once and meets the closed transport, so nothing is left hanging.
- A `thread/start` reply is authoritative: the server minted that id, so whatever this client believed
  about it is stale and the record is replaced by a fresh loaded one, with the old record's retry
  cancelled and any operation still in flight on it stopped at its next request, so neither can
  archive or delete the thread that now holds the id. Every other path refuses a `disposed` or `poisoned`
  thread. A thread remembers each turn it published, so a duplicate terminal is suppressed for as
  long as the record lives; retiring records is Step 6's retention, and bounding that set instead
  would trade the once-per-turn promise for it.

Tests: `src/__tests__/codex-app-server.test.ts` through the real transport over `fakeChild`, each
request answered by hand in any order under fake timers, so every failure is one the transport
minted: terminal before the `turn/start` response, follow-up during archive, the same terminal from
two observers, archive response lost, archive refused with a running turn to adopt, archive refused
with two zero-turn reads, archive refused with an unknown read and no delete, a park retry dropped
by a follow-up, resume refused then unarchive and resume, unarchive refused surfacing the resume
failure, steer and interrupt gated to the active turn, and `adoptOrDispose` for each of its four
answers. The exact `thread/archive`, `thread/unarchive`, `thread/delete` and `thread/read` shapes are
pinned there; `src/__tests__/codex-app-server-wire.test.ts` pins `thread/resume` and
`thread/archive` through `RecordingTransport`.

### What Step 3 inherits

Three readers now answer "what happened to a turn" from different sources: `CodexTurnTracker` from
the live event stream, `outcomeFromRead` from a read keyed by a turn id, and `inspectRead` from a
read with no turn id, with `CodexDaemonService.runningTurn` interpreting a read a fourth time. They
share the settled, running and unknown vocabulary and duplicate the schema check, the turn selection
and the answer classification, so a change to a status or an item phase has four places to reach.
Step 3 is where the daemon's three terminal paths meet the owner, which is where the shape of one
reader with live and snapshot adapters becomes clear; decide it there rather than guessing here.

`AppServerSession` still names only the pre-lifecycle methods, so Step 3 widens it with `settleTurn`
and whatever the daemon needs, and every double follows or fails to compile.

## Step 3 - The daemon path through the owner

`CodexDaemonService.onServerEvent` feeds `CodexTurnTracker` and calls `emitTerminal`;
`runReconcile` resumes the thread, reads it, and calls `emitTerminal` directly; `beginTurn` asks
`runningTurn` after a failed `turn/start` and `runStart` rejects with no terminal when the answer is
`none` or `unknown`; `settlePending` has no caller, so a completed turn whose final item never
arrives is held forever (`plans/pain-points.md`).

Every terminal reaches `client.settleTurn`: the event path, the reconcile read, and a bounded hold
deadline that performs one `thread/read` and then calls `settlePending`, publishing an empty answer
as an explicit degraded outcome. `onTerminal` is `emitTerminal` plus retention in the daemon's
outbox, which is what "published before park" means; the gateway's acknowledgement stays
asynchronous. `onPoisoned` releases the target through `TargetSupervisor.release` and moves every
binding on that generation into recovery, so the gateway reconciles them; an ambiguous `turn/start`
is never replayed, since the fresh generation resumes and reads first and adopts whatever turn the
thread holds. A settle parks by the outcome's thread id before the binding lookup, so a terminal for
a binding the session no longer holds still unloads its thread.

Tests: `src/__tests__/codex-daemon-service.test.ts`, with `FakeSession` gaining the lifecycle calls,
deferred request gates, coded failures and recorded call order: event settlement, reconcile
settlement, the hold deadline, terminal retained before the archive request, no binding at event
arrival, sole-turn adoption, an unknown first turn without delete, an ambiguous `turn/start` without
prompt replay, and poisoning releasing the target with the other agent recovering.

## Step 4 - The local path through the owner

`CodexLocalSession` keeps `pending` as turn id to resolver, so `settle` receives a turn id and no
thread id, and `startTurn` resumes any thread it did not itself create. `LocalAgentRuntime` caches
the session, evicts it on `onClosed`, and reaps the child after `LOCAL_IDLE_REAP_MS` under a lease
held across the whole request.

Each pending entry carries its thread id, the tracker's outcome reaches `client.settleTurn`, and
`onTerminal` resolves the parked promise. `onPoisoned` closes the session, which the runtime already
evicts and reopens on the next call, so a poisoned generation costs one relaunch and a resume. The
runtime's reaper and lease are unchanged; the thread is parked long before the child is.

Tests: `src/__tests__/local-agent-runtime.test.ts` through `FakeBackendSession` with deferred park
and activate gates: two concurrent agents settling on one session, a terminal racing a follow-up,
a follow-up after park, a follow-up after the reaper replaced the child, and pending resolved by
thread and turn id.

## Step 5 - Watchdog, leases and reaping

The daemon path has no reaper: `ExecutionTargetManager.release` runs on shutdown and on a failed
open. `LocalAgentRuntime.reapIfIdle` shows the shape, with `inFlight` held across a whole request so
the reaper cannot fire between a turn starting and its record being written.

A watchdog in `CodexDaemonService` reads only overdue active turns: a read proving settlement feeds
`settleTurn`; a read whose state changed refreshes the turn's clock; a read unchanged or unknown past
a bounded interval interrupts the turn, and a second such interval retires the generation. Progress
is an event or a changed read, never another identical `inProgress`. A lease counter is taken for
every command and every lifecycle callback, atomically against reaping; the reaper releases the
target only with zero leases and every thread `parked` or `disposed`, after a configurable quiet
period whose default clears the 240s wait budget and the 300s reconcile guard. A follow-up after a
reap activates directly through Step 2 with no reconciliation. Both use the injected clock.

Tests: `src/__tests__/codex-targets.test.ts` for lease and reap atomicity and a poisoned generation
replaced under a live sibling session; `src/__tests__/codex-daemon-service.test.ts` for the watchdog's
settled, changed, unchanged and unknown reads, no-progress retirement, park budget exhaustion and the
other agent's recovery; `src/__tests__/local-agent-runtime.test.ts` for a follow-up after a reap.

## Step 6 - Bounded bookkeeping

`TargetSession.threads` and `turns` never delete an entry; `CodexTurnTracker` bounds settled turns
at `SETTLED_MEMORY`.

Only acknowledged `parked` and `disposed` lifecycle entries age out, bounded the way the tracker's
settled set is. `firstTurn`, `active`, `parking` and `poisoned` entries stay registered until they
reach a terminal state or force retirement, so the reaper never mistakes an evicted record for an
all-parked target.

Tests: `src/__tests__/codex-daemon-service.test.ts` churned past `SETTLED_MEMORY`: settled entries
evict while active, first-turn, parking and unknown threads stay visible.

### Bug Classes

- Two observers of one fact. The event path and the reconcile path each emitted a terminal on their
  own; the fix for one could not reach the other. `settleTurn` is the single entry, and Step 3 makes
  `emitTerminal` unreachable except through it.
- A hold with no deadline. `settlePending` was written for the held terminal and never wired, so the
  hang was designed in. Every hold this plan adds carries its deadline in the same construction.
- Prose as protocol. The transport threw away the JSON-RPC code, so any branch on a refusal would
  have read the sentence. Step 1 makes the sentence unreachable as a discriminator.
- A retry that cannot end. "Retry until acknowledged" with no budget is the same infinite lifetime
  in a new form; every retry here has a budget whose exhaustion is itself a transition.

## Verification

- Unit: each step's tests above, and the whole suite. Doubles are extended, never invented: a fixture
  inventing a wire shape is the recorded lesson in `plans/pain-points.md`.
- The gate: `bun run lint` and `bun run test`, both halves read.
- Live, after Step 3 and again after Step 5: drive `codexStartAgent` through the installed plugin
  against the host daemon, run a fan-out of three short threads, and watch `ps` for the app server's
  children: three pairs while the turns run, none once every turn has settled, and `codexMessageAgent`
  on one of them bringing exactly one pair back. `thread/loaded/list` against the daemon's app server
  is the second witness.
- Release: a patch of the plugin; no wire shape changes. The daemon must be restarted to run it
  (`./start-host-daemon.sh`), since the daemon is the component whose staleness has no symptom.

## Painpoints

- The pain-points file recorded `settlePending` as a known hang before this plan; it ships in Step 3.
- A Codex sandbox cannot bind loopback and lacks a dependency the transport tests import, so an
  auditor reporting those tests as failing is reporting its own sandbox. Every auditor proves its
  sandbox on a named file first. This lap every auditor could run the named files.
- `src/__tests__/ref-end-to-end.test.ts` drives a live lexicon daemon and fails inside
  `awaitIndexed` when the machine is loaded: the full suite went red once while a red-team sandbox
  ran vitest beside it, and green alone and again once the machine was quiet. The commit gate runs
  the whole suite only after the auditors have finished.
- The two JSONL-over-stdio transports, `createJsonlTransport` in `codexAppServer.ts` and
  `createAcpTransport` in `copilotAcp.ts`, implement the same operation: id minting, a pending map,
  a timeout, server-request refusal, exit rejection, framing and buffering. The failure class and its
  one minter landed on the Codex side only, so "the transport is the only minter" is true of one
  transport. A shared core with backend policy injected (per-method timeouts, the exit reasons, the
  refusal table) is the unification; it is outside this plan's goal and filed as the owner's call.
- The cycle tool refuses a plan outside the session's project root, by absolute path and by symlink,
  so a plan for a sibling repository is driven from an excluded copy that has to be re-copied after
  every edit to the real one. Filed against nyaaskills.
- An auditor generalized "avoid lazy dash-joins" into a no-semicolons rule and filed four findings
  under it. A finding that cites a rule is vetted against the rule's own text before it is applied.
- Four readers now interpret a turn: `CodexTurnTracker` from the event stream, `outcomeFromRead` from
  a read keyed by a turn id, `inspectRead` from a read with none, and `CodexDaemonService.runningTurn`
  from a read again. They agree on the settled, running and unknown vocabulary and duplicate the
  schema check, the turn selection and the answer classification. Step 3 is where three of them meet.
- An architecture fix landed a defect the red team then found in three forms, all one cause: reusing
  an existing record in `ThreadLifecycle.started` for a thread id the server handed back. A
  `thread/start` reply is authoritative, so the record is replaced; the audit's real point was the
  stale retry and the in-flight operation the old record still held, and those are what the fix
  cancels and stops. Reusing state to preserve history was the wrong shape for an authoritative reply.
- The same fix bounded the per-thread published set to stop it growing, which traded the once-per-turn
  publication promise for a leak that is really Step 6's record retention. A bound on the wrong
  collection buys nothing: bound the thing whose lifetime is unbounded, not the thing inside it.
- A test asserting a phase is weaker than one asserting the wire. Several lifecycle tests read
  `stateOf` as their only evidence, and two of them could not tell a correct implementation from a
  no-op until the audit said so. Where a phase decides a request, assert the request.
