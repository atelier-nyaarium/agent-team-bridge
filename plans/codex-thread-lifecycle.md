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

Shipped. `createJsonlTransport` in `src/mcp/devcontainer/codexAppServer.ts` rejects every failed
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

`CodexAppServerClient` speaks `thread/start`, `thread/resume`, `thread/read`, `turn/start`,
`turn/steer` and `turn/interrupt`. It holds no state per thread. Both drivers resume a thread they did not just create before starting a turn, which is the
half of the lifecycle that exists; nothing ever unloads one.

The client gains a per-thread lifecycle record and becomes its only owner. States: `starting`,
`firstTurn`, `active(turnId, epoch)`, `parking`, `parked`, `disposed`, `poisoned`. Every request
for a thread and every terminal accepted for it passes through that thread's queue, so two
operations on one thread never interleave on the wire.

- `startThread` leaves the thread in `firstTurn`. `startTurn` in `firstTurn` goes straight to
  `turn/start`; in `parked` it activates first: `thread/resume`, and on a refusal `thread/unarchive`
  then `thread/resume`, surfacing the original resume failure if the unarchive refuses. The turn id
  the response returns moves the thread to `active` with a new epoch. A terminal that arrives for
  this thread before that response resolves is buffered and matched by thread and turn id once the
  id is known.
- `settleTurn(threadId, turnId, terminal)` is the only entry for a terminal, from whichever observer
  saw it. It validates thread, turn and epoch, hands the terminal to the injected `onTerminal` so it
  is published and retained before anything is unloaded, then parks.
- `park` archives. A refusal runs the dispose rule rather than a retry: `thread/read` twice across a
  short quiet interval; two reads proving zero turns delete the thread (`disposed`); a read showing a
  turn adopts it, `active` if in progress or settled through `settleTurn`; anything else counts
  against a bounded retry and age budget, and exhausting it poisons the generation. Logging a failed
  archive is not a state.
- `steerTurn` is accepted only in `active` with the matching turn id. `interruptTurn` is accepted in
  `active` and changes nothing; the terminal or the watchdog in Step 5 decides what follows.
- A timeout or an unreadable reply on `thread/archive`, `thread/unarchive`, `thread/delete`,
  `thread/resume` or `turn/start` moves the thread to `poisoned` and fires the injected `onPoisoned`,
  since the request may still land on the server after a later activation and a local epoch cannot
  recall it. The consumer retires that generation; nothing on it is activated again.
- Retries are a cancellable desired state outside the queue's lock; an activation cancels any
  unsent retry by advancing the epoch and waits only for a request already on the wire.
- `close` cancels every timer and retry.

Tests: `src/__tests__/codex-app-server.test.ts` with a gated transport whose individual request
promises release in any order: terminal before the `turn/start` response, follow-up during archive,
the same terminal from two observers, archive response lost, archive refused with a sole settled
turn to adopt, archive refused with two zero-turn reads, archive refused with an unknown read and no
delete, resume refused then unarchive and resume, unarchive refused surfacing the resume failure.
`src/__tests__/codex-app-server-wire.test.ts` through `RecordingTransport` pins the exact
`thread/archive`, `thread/unarchive`, `thread/delete`, `thread/read` and `thread/resume` shapes.

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
  sandbox on a named file first.
