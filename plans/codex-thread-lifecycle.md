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

✅ Shipped. Every terminal the daemon has reaches `client.settleTurn` through one `settle`, and `emitTerminal` is
reached only from the lifecycle's `onTerminal` hook, so nothing publishes a terminal without parking
its thread. Three observers feed it: the event path (`onServerEvent`, through `CodexTurnTracker`),
the reconcile read (`runReconcile`), and a bounded hold deadline. `settlePending` finally has a
caller, which closes the hang recorded in `plans/pain-points.md`: a completed turn whose final item
never arrived was held forever, and the caller's only escape was `codexStopAgent`.

The deadline performs ONE `thread/read`. A read that settles the turn answers with its outcome; a
read that says nothing about it, a failed read included, settles the held terminal instead through
`settlePending`. That answer may be empty, and nothing on the event distinguishes a turn that
produced no answer from a read that never learned one. A read that still calls the turn in progress
contradicts the terminal that armed the deadline, so nothing is invented and nothing is re-armed:
that turn is what the Step 5 watchdog is for, and the tracker keeps holding it so a late item still
settles it normally. A deadline is armed only while `CodexTurnTracker.holding` says that turn is
waiting, so a redelivered terminal arms nothing and one turn never has two; it is dropped by whatever
settles the turn first, a reconcile included; it checks that its generation is still the current one
both before and after its read; and a shutdown or a replacement clears every one of them.
`HELD_TERMINAL_MS` is ten seconds, the final item's own latency rather than a request timeout, far
inside the 240s caller budget that used to be the only bound.

`onTerminal` is `emitTerminal` plus retention in the daemon's outbox, which is what "published before
park" means; the gateway's acknowledgement stays asynchronous. Retention is what the outbox already
promises and no more: a message its schema rejects is dropped, now with a log rather than in silence,
and the pre-existing overflow rule can still evict a retained one.

`AgentDaemonCore` owns whether a generation still speaks, because both daemons publish through it and
only one of them had learned to ask. `live` is registry membership and `retire` DROPS the session, so
giving one up and being replaced by a newer one are the same state rather than two that can disagree.
`publish` refuses on a dead one, which is what fixes the Copilot twin: it never had the check, and its
in-flight prompt published under a fence the gateway had already retired. A predecessor is
deregistered before it is closed, since a closed session left in the registry is still announced by
`hello` and still passes that fence, and a replacement that fails to open leaves the target with no
session rather than a dead one.

Both daemons still ask `live` themselves before a receipt, because that one cannot simply fall
silent: a command whose generation retires mid-flight is REFUSED, a refusal carrying no generation
and being delivered where an acceptance the gateway fences out hangs the caller waiting on it. Codex
asks it before a terminal and a commentary item too, which are dropped rather than refused. Already-published messages are not
retracted; the outbox still replays what it retained, since retirement does not make a terminal that
really happened untrue.

A binding is found by turn id only when its thread agrees, and by thread id otherwise, since the
event names the binding's thread rather than the outcome's: a turn id the session still maps to an
older thread would report the turn under the wrong thread and the wrong agent. The same answer says
whether the entry in `turns` is this terminal's to delete, since taking a live turn's binding leaves
the next message for it starting a turn rather than steering one.

`CodexTurnTracker` suppresses a redelivered terminal from its last `SETTLED_MEMORY` settled turns and
no further back, so "a redelivered terminal arms nothing" holds for the window its own comment
claims, a late duplicate arriving near its own turn, and not for one redelivered hundreds of turns
later.

`onPoisoned` releases the target through `TargetSupervisor.release`, which IS the retirement: the
next command acquires a new generation and the gateway reconciles its own stale records against that
one. The daemon has no frame that says "recovering", so it announces nothing of its own. A client
that condemns itself before `open` has built its session is released the same way and never
registered, since the hook has no session to retire and the lease would otherwise outlive the child
it condemns; a `close` that throws on the way out does not skip that release, because the release is
what actually retires the child. An open that finishes after `shutdown` is discarded through that
same path, and a command that arrives after one is refused before it can acquire anything, since
dispatching it would spawn the very child the shutdown exists to stop spawning.

`release` names the generation it gives up, and the manager reaps only that one. The rule already
existed for a late `onExit`, whose comment says a late exit must not tear down its successor, and
`release` was the single caller bypassing it: a slow open that condemned itself could reap the lease
a second agent had just acquired. Naming the generation is required rather than optional, so a caller
that forgets fails the type check. `AgentDaemonCore` fences the other end of the same race: an open
for an older generation neither closes the session already serving nor replaces it, and its caller is
handed that live session rather than a null, since refusing a command whose target is healthy is the
wrong answer to losing a race. An ambiguous
`turn/start` is never replayed, since `beginTurn` adopts whatever
turn the thread already holds. A steer that returns after its own turn's terminal published gets no
`steered` receipt, since that leaves the gateway waiting on a turn that has ended; the terminal may
have carried the prompt with it, so the same rule a failed steer follows decides what happens next,
and only App Server saying nothing runs on that thread makes it a new turn. A settle parks by the
outcome's thread id before the binding lookup,
so a terminal for a binding the session no longer holds still unloads its thread.

Tests: `src/__tests__/codex-daemon-service.test.ts`, with `FakeSession` gaining the lifecycle calls,
deferred request gates, coded failures and recorded call order: event settlement, reconcile
settlement, the hold deadline, terminal retained before the archive request, no binding at event
arrival, sole-turn adoption, an unknown first turn without delete, an ambiguous `turn/start` without
prompt replay, poisoning releasing the target with the other agent recovering, a client condemning
itself before its session exists, a terminal held across a generation change reaching nobody, a steer
whose turn ends while the steer is in flight, that same steer refused rather than re-sent while the
thread is still working, a retired generation publishing nothing more, a command refused when its
generation retires mid-flight, a condemned target released even when closing its client throws, an
open finishing after a shutdown serving nobody, a command arriving after one acquiring nothing, and a
terminal reported under the thread it happened on without taking another thread's turn binding.
`src/__tests__/codex-targets.test.ts` covers a release naming an older generation reaping nothing.
`src/__tests__/agent-daemon-core.test.ts` covers an open for an older generation neither closing nor
replacing the one already serving, a target whose replacement fails to open advertising no session,
and publishing nothing for a session that was retired or replaced, which is the check every backend
on this core inherits. `src/__tests__/copilot-daemon-service.test.ts` covers the twin refusing a
command whose generation retires mid-flight rather than losing its acceptance.
`src/__tests__/daemon-fence-residue.test.ts` allows each service on the core exactly one direct
`deps.send`, its own generationless refusal, so a later emitter cannot route a fenced frame around
`publish`.

### Bug Classes

**Mechanism:** whether a generation still speaks, asked before anything reaches the gateway.

**Class:** the answer lived beside the registry that decides it instead of in it, so every round
found another state where the two disagreed.

Four rounds. Round 1 put the check in the codex service as `core.getSession(...) === session`, which
misses retirement: a poisoned generation stays registered until something replaces it, so it kept
publishing. Round 2 moved the authority to a second registry the service kept itself, which fixed
retirement and broke replacement, since a slow open for a dead generation evicted the live one and
silenced a healthy child. Round 3 kept both registries and asked both, which was correct and still
wrong-shaped. Round 4 moved the question to `AgentDaemonCore`, where `retire` drops the session from
the one registry that already answers "which generation serves".

Two things fell out of that move which no amount of patching in the service would have reached. The
Copilot daemon publishes through the same core and never had the check at all, so it was publishing
from replaced generations the whole time. And `publish` itself now refuses a dead session, so a
backend added later cannot forget. The gate alone left Copilot's callers hanging on a dropped
acceptance, which is the one thing a silent drop must never do, so it takes the same explicit check
before a receipt that codex does.

The lesson is the shape: a fact ABOUT a registry belongs in it. Every arrangement that tracked
retirement beside the registry left either a live generation silent or a dead one talking.

**Carried forward, and Step 5 must not add a fifth.** Four readers interpret the same `thread/read`
snapshot independently: `outcomeFromRead`, `inspectRead`, `runningTurn`, and the tracker's own
classification. The architecture audit ranked collapsing them to one classifier as its single
recommendation, on the grounds that two call sites cannot then disagree about one snapshot, and that
a status or item-phase change would otherwise land in four places, three findable only by grep. The
watchdog reads thread state, so Step 5 either lands on one classifier or writes the fifth.

## Step 4 - The local path through the owner

✅ Shipped. `LocalAgentRuntime` caches the session, evicts it on `onClosed`, and reaps the child after
`LOCAL_IDLE_REAP_MS` under a lease held across the whole request. That is unchanged; what moved is
everything under it.

The tracker's outcome reaches `client.settleTurn`, `onTerminal` resolves the parked promise, and each
pending entry carries its thread id so a terminal matches on both halves of the key. The match is a
guard, not a proof: the tracker refuses an item whose thread disagrees and remembers a settled turn
id, so no terminal the owner publishes should reach the wrong parked turn, and the check is what says
so at the point of use. `onPoisoned` retires the session, which is closing it AND invoking
`closedListener`, since the runtime evicts on that callback alone; a close that stayed quiet would
leave a dead child cached until the idle reaper ran, sending every call in between into a closed pipe.
It costs one relaunch and a resume.

A terminal could be published BEFORE its own turn was parked, and the fix for it is the one place
this step changed the owner. `ThreadLifecycle` buffers a terminal that beats its `turn/start` reply,
because until that reply lands the turn has no id to file it under, and it drains inside the same
call. So `onTerminal` fired before `startTurn` returned the id its caller parks under, and a turn
whose whole life beat its own start reply resolved for nobody: the caller waited its entire budget,
which is the hang this plan opened to remove, one layer down.

`startTurn` now takes an `onStarted` callback and hands the id to it BEFORE draining. Registration is
ordered ahead of publication by construction, so neither consumer needs machinery of its own: the
local session parks there, the daemon binds there, and the caller-side hold does not exist. Ordering
it by SCHEDULING was tried first and is why the callback exists. Queueing the drain behind the start
reads as sufficient and is not: a caller resumes an unknowable number of microtasks after `startTurn`
resolves, since the client's own `async` wrapper adds two, so the drain still beat it. A guarantee
that depends on counting microtask hops is not a guarantee.

The callback is REQUIRED, which is what stops the next consumer from silently inheriting that losing
race by omitting it, and every call site that registers nothing now says so with a no-op instead of
by absence. TypeScript alone does not finish the job, since a double with fewer parameters still
satisfies the port, so `src/__tests__/app-server-double-residue.test.ts` requires every
`AppServerSession` double to take the callback and CALL it. The local session refuses a start whose
callback never ran rather than parking afterwards, since parking afterwards is the race itself.

Only the local path was ever hurt by the ordering. The daemon binds the thread before it starts a
turn, so `publishTerminal` finds that binding when the turn's own is still being written, and a
terminal drained mid-start reaches the right agent either way. Its callback is correctness for
`session.turns`, not a repair, and no test claims otherwise; a start that fails after binding drops
the binding it made, since that turn is not the daemon's to hold. A consumer callback that THROWS
does not strand the terminals it was to receive: the drain runs in a `finally` and the error follows.

Child exit, `close` and `retire` settle parked turns directly rather than through the owner. There is
no owner to ask when the child is gone: the terminals become `failed`, and nothing is parked.

`startTurn` no longer decides whether to resume. The session kept a `fresh` set naming threads it had
created and not yet run, and resumed everything else by hand, which is the load decision
`ThreadLifecycle` already owns and states per phase: `unloaded` and `parked` resume, with the
unarchive fallback behind a refusal; `idle` and `active` are already loaded; `parking` only cancels
its retry. Two copies of one rule is the shape this plan exists to remove, so the set is gone. The
deletion was proved on the wire rather than argued, since the set's own comment recorded a real bug
it had fixed: a thread this session created writes `thread/start` then `turn/start` and no resume; a
second turn after its archive writes `thread/resume` first; a thread INHERITED by a session that never
created it, which is the reaper's case and the one the comment warned about, writes `thread/resume`
before `turn/start`; a refused resume writes `thread/unarchive` and resumes again; a refused unarchive
surfaces the original refusal; and a disposed or poisoned thread writes nothing at all and refuses.

A closed session speaks for nothing: events already in the pipe outlive the close that emptied it, so
activity from one is dropped rather than recorded against an agent the runtime may have evicted, and
`close` is idempotent since `retire` calls it and the child's own exit may follow. The runtime holds
`LocalTurnHandle.settled` to its promise of never rejecting rather than trusting it, so a backend that
breaks the promise loses one turn instead of raising an unhandled rejection. The thread is parked long
before the child is.

Tests: `src/__tests__/codex-local-session.test.ts` drives the session through the real client and
transport over a fake child, since every local test until now ran through `FakeBackendSession` and
this class had none of its own: a turn settling and its thread archiving behind it, two threads each
answered with their own outcome, a follow-up after park resuming and settling, a terminal landing
while a follow-up is still starting, a turn whose terminal beat its own start reply, a child exit
failing every parked turn, no activity delivered after a close, and an unanswerable archive firing
`closedListener`, which is the callback the runtime evicts on.

## Step 5 - Watchdog, leases and reaping

✅ Shipped. Until this step the daemon path had no reaper at all: `ExecutionTargetManager.release` ran
on shutdown and on a failed open, which is why idle children accumulated. `LocalAgentRuntime.reapIfIdle`
showed the shape, with `inFlight` held across a whole request so the reaper cannot fire between a turn
starting and its record being written.

One sweep serves both, on the daemon's injected clock. It walks overdue turns first, since settling
one is what makes its target reapable, and reaps afterwards.

The watchdog asks App Server about a turn that has gone quiet and acts on the answer rather than on
the silence. Progress is ANY frame naming the turn, read structurally rather than through a schema:
a turn that spends its life running commands emits no agent message, so counting only the frames the
tracker parses would interrupt work that is progressing perfectly. A read that says `inProgress`
again is not progress either, since a hung turn reports that forever, which is the case this exists
to end. A read proving settlement goes through `settle` like any other terminal. A read still
running, or one that could not be had, interrupts the turn once; a second sweep in the same state
retires the generation.

`CodexLiveTurns` owns which turns a generation holds and whether each is moving, in ONE record per
turn carrying its binding, its clock and whether the watchdog has warned it. That is the whole fix
for the class below: a clock cannot exist apart from the turn it measures, a frame refreshes a turn
only from that turn's own thread, and a rebind keeps the warning already given, because the gateway
asking again is not the turn working. The daemon is handed `overdue` entries saying whether each was
already `warned`, never a counter. A rebind onto the same thread keeps both, since the gateway asking
again is not the turn working; onto another thread it is a different identity and inherits neither,
and the watchdog rechecks the binding after its read rather than acting on the thread it started
with. `live-turns-residue.test.ts` fails the build if another module in `devcontainer/` keeps a
turn's watchdog state, and is worth what a token check is worth: a second clock under another name
walks past it. `codex-live-turns.test.ts` holds the class itself by behaviour, which is the part a
spelling cannot be trusted with.

The first interrupt lands around 120s, inside the 240s caller wait budget, which is deliberate.
Retirement is nominally 240s but the sweep cadence can carry it to roughly 270s, so it is NOT
guaranteed before that budget expires; the caller sees its own timeout first and the generation goes
shortly after. `REAP_QUIET_MS` clears both that budget and the 300s reconcile guard.

The reaper releases a target nobody is using, which is the only thing that ends a codex child's life
on this path. Every condition is checked at the instant of the reap: no lease anywhere, no turn this
daemon still holds, no terminal on its deadline, and no thread the owner calls `active` or `parking`.
Refusing anything but `parked` and `disposed` reads as safer and is not: nothing parks a thread that
never ran a turn, so one left `idle` by a reconcile would block the reap for the daemon's life. The
question is whether the owner is mid-operation, not whether it tidied up. `REAP_QUIET_MS` is ten
minutes, past the 240s wait budget and the 300s reconcile guard. A follow-up after a reap resumes the
thread on the fresh child with no reconciliation.

The lease is counted for the DAEMON, not per session, and held across every asynchronous stretch that
touches one: a whole command, the held-terminal read, the settle behind a terminal, and the
watchdog's own read and interrupt. A sweep still running when the next interval fires is skipped
rather than run twice.

The quiet period the reaper measures runs from a command ENDING, not from its acquire, or a command
outlasting the period leaves its target reapable the instant it finishes. Only commands stamp it. Any
leased work stamping it looks more thorough and cannot work at all: the sweep leases its own reads,
so it would reset the clock it is about to read and never reap once.

Per-session is the obvious shape and is wrong, because a lease taken after the session
resolves leaves the acquire itself unguarded, which is the gap `LocalAgentRuntime` already records a
reaper firing in. Asking the owner what it believes about a thread put `stateOf` on `AppServerSession`,
which is what makes reapability a question with an answer rather than a guess about idleness.

Two readers interpret a `thread/read`, and that is the right number: `outcomeFromRead` reconstructs
ONE turn, and `inspectRead` reads the thread as a whole and delegates to it for the settled case.
Both have several callers, which is reuse rather than duplication. The plan's earlier count of four
was wrong twice over: it counted `inspectRead` as independent when it already delegated, and counted
`CodexTurnTracker`, which reads live events and never a read at all. `runningTurn` was the one place
re-deriving a reader's work by hand, and it projects `inspectRead` now; the watchdog reuses
`readOutcome` rather than adding a third.

Tests: `src/__tests__/codex-daemon-service.test.ts` drives the sweep by hand against a clock the test
moves: a turn the watchdog finds already finished, one that only ever reports itself in progress being
interrupted and then retiring its generation, a turn whose own frames count as the progress being
looked for, a frame the tracker does not parse counting all the same, a frame from another thread
counting for nothing, strikes surviving a reconcile, a quiet period starting when a long command ends,
a target reaped once its threads
are parked and quiet, a follow-up after that reap served from a fresh generation by a resume rather
than a reconcile, and two refusals to reap, one while the owner calls a thread active and one while a
command is held inside its own read. Both refusals are written so the guard under test is the ONLY
thing that can refuse: the first lets the daemon's turn go so the phase decides, the second uses a
reconcile that starts no turn so the lease decides. Written the obvious way, neither could fail: the
first was refused by the turn it still held, and the second blocked the open that installs the sweep,
so no sweep ran at all. The harness now throws rather than passing when no sweep is installed, since
a test that sweeps nothing asserts nothing.

### Bug Classes

**Mechanism:** the watchdog's answer to "has THIS turn made progress", which decides whether a live
turn is interrupted and its generation retired.

**Class:** the question was answered by a proxy that was cheaper than the turn's own identity, and
each round found another thing the proxy let through.

Three patches in one lap. First, progress was a frame the tracker PARSES, which is agent messages and
terminals; a turn running commands emits neither, so the watchdog would have interrupted work that was
progressing perfectly. Second, a turn with no clock of its own fell back to the SESSION's last-used
stamp, which any other turn's frames refresh, so a hung turn beside a chatty one was never overdue.
Third, a frame was matched to a turn by TURN ID alone, so another thread's frame carrying that id
counted as this turn working. A fourth of the same shape sat next to them: rebinding reset the strike
count, so a reconcile arriving each interval bought a hung turn unlimited second chances.

Every one of these is the same trade: a cheaper key than the full identity of the thing being
measured. Identity lived in one map and liveness in another, both keyed by turn id, which is half of
what a turn is. Two maps that must agree, keyed by half an identity, is a shape in which every one of
those mistakes stays expressible however carefully each site is written.

The redesign is `CodexLiveTurns`: one record per turn holding its binding, its clock and its warning,
so none of them can drift from the others or be reached without the thread that owns them. A residue
test fails the build if any other module in `devcontainer/` keeps a turn's watchdog state, since a
single-owner invariant that is not gated is a convention.

The same trade showed up once more in the reaper's quiet clock and was caught before it shipped:
stamping it from ANY leased work reads as thorough, and the sweep leases its own reads, so it would
have reset the clock it was about to read and never reaped once. Only a command stamps it.

## Step 6 - Bounded bookkeeping

✅ Shipped. Two maps grew for a generation's whole life: `ThreadLifecycle.threads`, one record per
thread ever reached, and `TargetSession.threads`, one binding per thread the gateway ever named.
`CodexLiveTurns` was never among them, since a turn leaves on its terminal and a turn that stops
reporting takes its generation with it.

Retirements live in an ordered map of one entry per thread, bounded at `RETIRED_MEMORY`, and retiring
MOVES a thread to the back rather than appending. That is the whole mechanism: a record cannot hold
two entries, so it cannot be forgotten on an older park's clock.

The entry always names the record the map holds, and every write to the map is keyed by the RECORD,
never by the id alone. That rule is the whole defence, because `mutate` tests identity only BEFORE
its request and never after, so any operation awaiting a reply can resume holding a record that
`started` has since replaced. `retire` refuses to write for a record the map no longer holds, which
is the case a check at eviction cannot replace. `load` drops the entry when a thread comes back, so a
reactivated thread stops counting against the window the threads behind it wait in, and it drops only
its OWN entry: keyed by id, a late resume deletes the retirement of the replacement that took the id,
and that record is then never forgotten. `poison` drops the entry too, since a poisoned record can
never become evictable and its entry would hold a slot no eviction could ever reclaim. `started`
drops the entry it replaces.

Eviction then asks only what is left: a record is passed over while an operation is queued on it, and
while its phase is anything but `parked` or `disposed`. A passed-over entry STAYS, so the next
eviction reconsiders it. Consuming it instead retains that record for as long as the lifecycle lives,
because parking is what would have enqueued it again.

What the bound costs is real and stays: a terminal redelivered after its record has aged out
republishes, because the record's published ids ARE the once-per-turn dedup and forgetting one
forgets them. It takes `RETIRED_MEMORY` retirements plus the tracker's own settled window to reach,
and the gateway drops the duplicate at persistence, where the turn is no longer `inProgress`. So the
wire promise is once per turn within the window, not for all time. Capping `published` directly was
tried in an earlier step and reverted for the same reason read the other way: the ids are what make
publication once-per-turn and the record outlives them, so the cap traded the promise for nothing,
while forgetting the record costs nothing because a parked thread has no turn left to publish twice.

The daemon's thread bindings are bounded the same way, at `THREAD_MEMORY`, evicting the oldest
binding the owner is not mid-operation on, and draining to the bound rather than evicting one per
bind. One per bind ratchets: a peak of live threads carries the map above the bound, and once they
settle every later bind adds one and removes one, so the map never comes back down. The scan also
passes over the binding the call just made. A bind moves its thread to the end of the insertion
order, so the newest entry is the last one a scan reaches, and a map of threads the owner is working
made `bindThread` delete the binding it was called to install. Both bounds are soft in the same
direction: a map holding only `active` or `parking` threads evicts nothing and exceeds its bound,
which is the right answer, since those are live work and bounded by real concurrency rather than by
history. A forgotten binding costs a terminal the fallback it would have used when its turn is
unbound, which the gateway answers by reconciling the thread.

Note that `parked` is not the end of a thread: `resumeThread` unarchives one and returns it to
`idle`, and only `disposed` and `poisoned` are refused. A retirement is therefore a claim about a
moment, not a verdict, which is why `load` withdraws it and why eviction rechecks the phase instead
of trusting the entry that survived.

Two phases of the original text did not survive contact. There is no `firstTurn` phase; a thread
reached only by name is `unloaded`, and eviction protects it along with every phase but `parked` and
`disposed`. Nor is eviction gated on acknowledgment: a record is retired when its archive or delete
lands, since acknowledgment is the ledger's concern and never reaches the lifecycle.

Tests: `src/__tests__/codex-daemon-service.test.ts` churns 400 threads past both bounds and asserts
what survives AND what does not: a terminal for an unbound turn on the thread the owner is still
working reaches its agent, one on a bound-out thread reaches nobody, and a thread churned out is
answered again once the gateway reconciles it. `src/__tests__/codex-app-server.test.ts` drives the
lifecycle's own retention over the real client: a settled record is forgotten while one resumed since
keeps its record and does not republish its turn, and a thread whose id was reused outlives the
retirement of the thread it replaced, a reactivated thread's window starts over instead of running
from its first park, and a record with a read in flight is passed over. Each of those also asserts a
CONTROL that must be gone, not only the thread that must survive, because two of them were calibrated
to the retirement queue's duplicate entries and stopped triggering eviction at all when it became a
map: they passed against the mechanism they were written to catch. Five more pin what the refactor
alone did not: a thread replaced mid-archive does not retire over its replacement, a late resume does
not delete the retirement of the thread that took its id, a thread that loads again stops crowding
the window, a poisoned thread gives up the slot it could never spend, and a record passed over for
being busy is forgotten once its work is done rather than never. Two more pin the eviction
rule itself: a bind with nothing else evictable keeps its own binding, and threads settling together
are drained in one bind rather than one per bind. Each was written by removing the guard it names and
watching it fail.

What this step did NOT bound, found by red-teaming it and left deliberately: a record for a thread
that never settles, since only `parked` and `disposed` retire, so reading threads that answer unknown
grows the map with a generation's history; `CodexTurnTracker.turns` for a turn that emits items and
no terminal; `record.buffered` while a `turn/start` is unanswered; and `record.published` for stray
terminals naming turns a thread never ran. The first is the one worth taking next, and the rest need
a workload no gateway produces.

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
- A name standing in for an identity. A thread id is reusable, so a bookkeeping entry keyed by id
  acts on whatever holds that name when it is read, not on the thing it was written for. Entries here
  carry the record, and a mismatch is skipped rather than resolved.
- An eviction decided from a snapshot the subject has moved past. `ThreadLifecycle.retire` wrote a
  queue entry and acted on it much later, and its predicate took four patches: a phase recheck, then
  record identity for a reused id, then a retirement sequence for a record parked twice, then an
  in-flight count. Each round asked one more way whether the entry had gone stale, and the fourth
  introduced its own leak, since a consumed entry that declined to evict never came back. Retirement
  now MOVES a record in an ordered map, the way `bindThread` already does with bindings, so identity
  and sequence have nothing left to check and a declined eviction leaves the entry in place. The
  class is gone rather than guarded, and the tests that pinned the guards pin the shape instead.
- An id used where a record was meant, once per write site. The same substitution reappeared at each
  new write to the retirement map: `retire` wrote a stale record's entry, `load` deleted whichever
  entry held the id rather than its own. Both delete the wrong thread's retirement, and the second
  was written while fixing the first. Any write here is keyed by the record, and the reason is that
  `mutate` re-enters after its await without rechecking identity, so EVERY continuation in this class
  may be holding a record the map has moved on from.

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
- Nothing about a `ThreadRecord` parameter says whether it is still the thread's. `mutate` tests
  identity before its request and never after, so every `await` inside `ThreadLifecycle` resumes
  holding a record that may have been replaced, and the function signature looks identical either
  way. Two critical bugs this lap were the same oversight at two write sites, and the second was
  written while fixing the first. A type that distinguished a record you have re-checked from one you
  have merely carried would have made both unwriteable.
- `stateOf` answers `undefined` for three different situations: a thread never tracked, one whose
  record was evicted, and one this client never loaded. `reapIdle` and `bindThread` both branch on it.
  Deciding whether an audit finding about the reaper was real meant working out which of the three a
  caller was actually seeing, and the type cannot tell them apart.
- Every retention test hand-derives how many filler retirements cross `RETIRED_MEMORY`, and the
  arithmetic depends on the data structure rather than on the property under test. There is no helper
  for "fill the retirement map to its bound", so each test recomputes it and two of them silently
  stopped crossing the bound at all when the structure changed.
- Planting a violation is a manual edit, run, revert, done about a dozen times this lap. It is the
  only way to know a guard is pinned, and every round of it is a chance to leave the mutation in the
  tree. Nothing here automates it, and nothing would catch a forgotten one but the next full run.
- A retention test calibrated to one data structure goes inert when the structure changes, and looks
  identical to a passing test. Two here counted fillers against the retirement queue's duplicate
  entries; as a map the counts no longer crossed the bound, so no eviction ran and both passed while
  asserting nothing. A test that something SURVIVED eviction must also assert something else did not,
  or it cannot tell "protected" from "never evicted".
- A relay agent twice returned its own status sentence instead of the report it was asked to relay
  verbatim, once as a whole audit pass. An empty relay reads exactly like a clean audit, so a pass
  with no findings is checked for a report before it is believed. Both times the missing angle held
  a real gap that a direct check then found.
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
- `bun run lint` reports `biome: FAILED` without saying which file or rule, and the summary reporter's
  output is dense enough in escape codes that finding out takes two more commands. Twice this lap tsc
  and the whole suite were green while a formatting failure sat unread. The gate's own warning about
  reading both halves is right, and the second half is the one that is hard to read.
- The core's own tests built sessions by hand and published through them. When `publish` gained the
  generation fence, four of them broke because they had never registered a session with the core, so
  they had been exercising a state the daemon cannot reach. A test that constructs a collaborator's
  private state instead of acquiring it through the real entry point proves less than it looks.
- `FakeSession` in `codex-daemon-service.test.ts` models `ThreadLifecycle.settleTurn` by hand, and
  nothing holds it to the real one. Widening `AppServerSession` made tsc check its SHAPE, which is how
  the missing `settleTurn` was caught, but its RULES are a copy: publish once, park only an own turn.
  A whole audit angle went on cataloguing where the copy diverges, and the answer each time was that
  the lifecycle's own tests cover the rule against the real client. The doubles are honest today
  because someone read both; there is no mechanism keeping them that way.
- Three audits in a row found the same class in this lap's work, and each found it one layer deeper:
  what counts as a frame, whose clock is refreshed, whose thread the frame belonged to. Each fix was
  correct and none was the fix, because the shape underneath went unquestioned until the architecture
  pass named it. A defect found three times in one mechanism is not three defects, and the cheapest
  moment to ask what shape permits it is the first repeat, not the third.
- A guard proved by planting can still be the wrong guard. Two reap refusals passed their plants and
  were still vacuous: one was refused by a different guard than it named, the other blocked the call
  that installs the sweep, so no sweep ran and it asserted nothing at all. Planting proves a test
  notices SOMETHING; it does not prove the test is about what its name says.
- An ordering guarantee argued in prose is not one. Three architecture angles converged on queueing
  the drain behind `startTurn` so a caller registers first, and every word of the reasoning is right
  except the conclusion: a caller resumes an unknowable number of microtasks later, and the client's
  own `async` wrapper adds two. It took a test, not a reader, to see that. Anything phrased as "then
  the caller gets there first" is a claim about a scheduler and has to be run.
- `CodexLocalSession` shipped with no tests of its own. Every local test drove `FakeBackendSession`,
  which stands in for the whole class, so the adapter between the runtime and the App Server client
  was exercised by nothing. A double placed at the top of a layer leaves everything under it dark,
  and the gap is invisible from a green suite: the tests that exist all pass, and they are testing
  the double.
- An optional parameter is not a contract. `onStarted` began optional, which reads as courteous and
  means a consumer that omits it silently gets the losing race the callback exists to remove.
  TypeScript does not close it either, since a double with fewer parameters still satisfies the port.
  It took a required signature AND a residue test holding every double to calling it.
- A cited finding deserves reading the line it cites. An auditor reported a test asserting
  `not.toContain("startTurn2")`, a call the double never records, so the assertion could not fail. It
  was rejected here on the grounds that it was invented, after checking a DIFFERENT test that happens
  to assert something similar and does bite. The finding was correct and the pre-existing test was
  dead. Rejecting an audit finding is a claim, and it needs the same evidence as accepting one.
- An audit round costs roughly half a million tokens and some of it is spent rebutting findings that
  quote code accurately and describe it wrongly. Five sources of that were found and fixed as
  misalignments this lap: a comment claiming retirement stops replay, one claiming a shape is unified
  when four readers exist, a field named `sessions` beside the core's real registry, a lifecycle
  header erasing its own buffering path, and a `read` field that reads as a fixture and is an
  injection point. Naming and comments are audit throughput, not just readability.
