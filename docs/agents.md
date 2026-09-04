# Delegated agents

A session can hand a self-contained sub-task to a Codex or Copilot child. The daemon supervises one
child per execution target; the gateway owns the durable record.

## Codex delegation

**A fence is `(daemonInstanceId, targetId, generation, lastEventId)`.** Reconciliation is the only
path that may install a non-advancing fence.

**An acknowledgement retires the daemon's only copy.** `ignored` and `applied` permit it; only a
withheld decision does not. Held frames are keyed by agent, although the stream is per target.

**`thread/read` needs `includeTurns: true`.** Without it, a successful live-server response has an
empty `turns` array.

**`ThreadLifecycle` owns parked threads.** `codex app-server` starts every configured MCP server in
`~/.codex/config.toml` as its own child on `thread/start`. A thread nobody unloads holds those
servers for the app server's whole life. `thread/archive` unloads the thread and kills them;
follow-up use unarchives and resumes it.

**A retired generation publishes nothing new.** `publish` checks liveness, and retirement retracts
nothing already retained in the outbox. `release` must name the generation, or a late exit tears down
its successor.

**`startTurn` hands the turn id to `onStarted` before draining.** A terminal can beat its own
`turn/start` reply. Scheduling registration does not work. The local session and the daemon both rely
on this ordering.

**A terminal hold names its release event and bound.** The tracker holds a terminal that precedes its
final item until that item arrives or the deadline releases it. A read still reporting `inProgress`
leaves it held.

**Progress is any frame from the turn's own thread.** Matching only a turn id, or counting only
tracker-parsed frames, misattributes or interrupts live work. Reconciliation treats an unconfirmed
turn as `recovering`.

**A silent turn is interrupted, then its child retired.** Ten minutes without a frame from its thread
and the daemon sends `turn/interrupt`; a second silent window releases the whole target, which ends
every other agent's turn on that child, since the App Server has no per-thread kill. Both steps are logged on the daemon pane, as are a frame arriving
more than 60 s after the last one and any interrupted terminal, so an interruption nobody asked for
is attributable there.

**Bookkeeping names the record, never only the id.** `mutate` checks identity before its request and
never after it; an awaited reply can resume after that record was replaced. Retire, load, and poison
refuse or drop by record identity. Retirements move the record to the back, and eviction leaves
queued or non-parked records for a later pass.

**A turn's clock and warning live with its binding in `CodexLiveTurns`.** Rebinding to another thread
creates a different identity and inherits neither.

**A request failure is a `kind`, never a sentence.** The transport emits `refused`, `timeout`,
`unreadable`, or `closed`. Callers must not branch on wording. Notifications dispatch in a microtask,
preserving reply-before-notification wire order.

**A refused request is not an unavailable agent.** Request failures use the request-error envelope
and HTTP 400; genuine agent failure uses the unavailable result envelope.

**Result availability is explicit.** A terminal result means finished. `agent_dead` means the agent
cannot run. `agent_unreachable` means its App Server may still be running, so do not duplicate work.

**Reconnect adopts persisted threads.** The daemon reopens the execution target, resumes the stored
thread, and adopts its running or settled turn before accepting a follow-up. Reconciliation emits its
receipt before an adopted terminal, preserving the fence. It reads and never deletes a thread.

**The model is a start parameter, not configuration.** It is checked against `model/list` at use time
and is never silently substituted.

**`ignored` and `failed` differ.** `ignored` may be acknowledged and retired; `failed` is never
acknowledged, because this gateway could not build its record.

**A waiting call holds for less than the client survives**, bounded by `CODEX_WAIT_BUDGET_MS`. Node's
fetch abandons a silent connection at 300s and `routerPost` re-posts, so a longer hold never delivers
its answer. A turn outliving the budget keeps running, and `codexAwaitAgent` collects it.

**Enabling it:** the capability is announced when `codex` is on `PATH`. A session picks the tools up
at its next start, never mid-session.

## Local agent mode

A session without a serving daemon runs the child itself (`src/mcp/local/`). Installing the CLI is
the opt-in.

- **The gate is reachability, not configuration.** A daemon declaration wins; otherwise
  `shared/agent-binary.ts` probes `PATH`.
- **`AgentDispatch` hides the serving mode.** Local dispatch calls `LocalAgentBackend.handle` with
  the same body; local validation and result parsing reuse the gateway schemas.
- **The list is projected per backend.** `projectCopilotListAgent` in `copilot-agent.ts` is the sole
  owner of Copilot's strict field set. `CopilotListAgentSource` makes the wrong record a compile
  error.
- **Child errors are normalized where stored.** `errorText` covers every `fail()` site and
  `applyTerminal`.
- **A closed local child must be evicted.** `LocalBackendSession.onClosed` is identity-guarded so a
  late close cannot evict its successor.
- **Idle reaping is Codex-only.** `threadsResumable` gates it. The hold spans the whole `handle()`
  request, not one child call; at every instant either that hold or `activeTurnId` guards the child.
  `applyTerminal` stamps the idle clock.
- **Codex loads before every follow-up turn.** `ThreadLifecycle` owns the rule; a fresh child
  unarchives and resumes a parked thread.
- **Local settlement uses the same owner.** `CodexLocalSession` calls `client.settleTurn`;
  `onTerminal` resolves the caller. Child exit, close, and retirement settle parked turns directly.
- **`LocalTurnHandle.settled` never rejects.** A rejection becomes a failed terminal.

The Codex thread retains workspace-write and network access for its whole life. Switchboard does not
enforce a stronger boundary.

## Copilot delegation

A session can delegate a self-contained task to a logged-in Copilot CLI through ACP stdio. Follow-ups
wait for the previous turn, because ACP has no steer operation.

**Enabling it:** `copilot` on `PATH` announces the capability. Login uses the CLI and `/login`; no
API key is forwarded. Default model `gpt-5.6-luna`, with agent permissions enabled for the supervised
target.
