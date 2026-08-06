# Questionaire

## Question 1 - Who invokes Codex thinking?

Q: Who can invoke Codex thinking, and where is it exposed?
A: Claude sessions invoke it through Switchboard tools during red-team workflows. It is not a user-selectable agent.

> "Claude will be the invoker of it via tool calls, during it's red-team workflows."

## Question 2 - How is the feature enabled?

Q: What daemon configuration enables Codex thinking?
A: `CODEX_THINKING_ENABLED=true`. No additional Codex configuration is planned.

> "CODEX_THINKING_ENABLED=true is all we need. skip the rest."

## Question 3 - How does Switchboard speak to Codex?

Q: Should Switchboard drive a Codex terminal through tmux or use a programmatic interface?
A: Use Codex App Server for short-burst, Claude-managed Codex threads.

> "sounds very much the perfect fit for short burst Claude managed Codex sessions."

## Question 4 - Do managed Codex threads expire?

Q: Should Switchboard automatically terminate or delete Codex threads after 24 hours?
A: No. Add no Codex-specific expiry or cleanup timer. The Switchboard catalog follows the lifetime of its owning Claude session record, while underlying App Server threads remain governed by Codex's native storage.

> "ohh the 24-hour expiry. we can skip that."

## Question 5 - What Codex activity does Switchboard retain?

Q: Should Switchboard retain and return the full App Server event stream?
A: No. Retain only bounded completed commentary messages and the final response; do not burden the calling Claude with every intermediate event.

> "I dont want to bog down the calling Claude with every single intermediate step message in that 9 minutes. So we do want it to not store the whole transcript."

## Question 6 - Should agent handles survive restarts?

Q: Should Switchboard durably retain the mapping from agent handles to Codex threads?
A: Yes. Persist the Codex-agent catalog with the invoking Claude session so agents remain addressable across frequent Switchboard updates and restarts. The host daemon owns live App Server runtime state, not a globally visible agent catalog. This is simpler than Claude session recovery because no tmux lifecycle is involved.

> "We update and restart a lot, so just as switchboard remembers Claude sessions, this needs to remember Codex sessinos. But much simpler since we arent juggling tmux"

## Question 7 - What happens when a message arrives during an active turn?

Q: What should `codexMessageAgent` do when the Codex agent is already working?
A: Steer the active turn immediately. If that turn finishes during delivery, start a new turn instead and report which delivery occurred.

## Question 8 - What authority does Codex thinking receive?

Q: Is Codex thinking restricted to one fixed sandbox policy?
A: Codex keeps its normal tools, web access, and workspace-write capability. Example red-team workflows preseed behavioral rules not to mutate the project, while still permitting scratch files.

> "whatever Claude wants to give it. Tools and web is fine. But for the example proposed workflows I was envisioning, we preseed the prompt rules to be readonly"

> "Meaning write is fine too. If claude happens to trust it's guardrails for writing"

## Question 9 - When can Claude choose or change permissions?

Q: Are permissions fixed for the lifetime of a Codex thread?
A: Yes. Leave workspace writing enabled for every turn and omit permission controls from the Claude-facing tools. Claude controls behavioral guardrails through the prompt instead of changing App Server policy.

> "Leave it on always. Less headache. It's perfectly reasonable for it to write temp scratch files anyways, even if we said dont mutate the project."

## Question 10 - How does Codex report progress and completion?

Q: Should Codex call custom workflow status and final-response tools?
A: No. Use only native App Server messages: retain a bounded set of completed `commentary` messages for timeout activity, identify the final answer from completed `final_answer` messages, and treat `turn/completed` as the authoritative terminal signal. Do not expose custom workflow tools to Codex.

Native events are more reliable than requiring model-authored tool calls and eliminate unnecessary custom tool plumbing.

## Question 11 - Should completed calls still return the agent ID?

Q: Should the stable Codex agent handle be returned only at the nine-minute timeout?
A: No. Every per-agent result returns `{ agentId, status }`, plus the final response or bounded activity appropriate to the state.

Always returning the ID keeps the response schema stable and permits follow-ups even when Codex completes quickly.

> "Always return the ID"

## Question 12 - Should Claude be able to rediscover Codex agents?

Q: Should Switchboard expose `codexListAgents` for recovery after context compaction, lost responses, or restarts?
A: Yes. The invoking Claude session owns its Codex-agent records. Listing returns only that session's agents and includes their prior Claude-to-Codex calls and Codex-to-Claude responses so Claude can recover the working history after compaction. Do not retain the internal App Server transcript.

Session-scoped listing makes the durable registry recoverable without exposing another Claude session's work.

> "we shall now ensure the records are relevant to THAT claude session. So the store that the session owns should record codex agents."

> "Actually would be handy for them to look up previous calls and responses as well, especially after a compact."

> "As for the list running large, no need to worry. Best agent hygine is to start a new session after a while anyways."

## Question 13 - What does stopping a Codex agent do?

Q: Should `codexStopAgent` permanently close a Codex thread?
A: No. It idempotently interrupts the active turn, or succeeds as a no-op when the agent is already idle. The thread remains listed, retains its history, and accepts later follow-ups. Do not expose `codexKillAgent`.

Completed and interrupted App Server threads consume no ongoing compute, so permanent closure adds destructive state without providing process cleanup.

## Question 14 - Do start and follow-up calls wait for Codex?

Q: Should `codexMessageAgent` return immediately after delivering a follow-up, or wait like `codexStartAgent`?
A: Both `codexStartAgent` and `codexMessageAgent` accept `awaitResponse?: boolean`, defaulting to `true`. When true, wait up to nine minutes for completion. When false, return immediately after durable acceptance so Claude can background the work and check it later with `codexAwaitAgent` or `codexListAgents`.

Waiting by default keeps ordinary short exchanges to one tool call while preserving explicit background execution.

> "in both cases, there should be an optional parameter to await. Default true. Good for backgrounding and checking on it later"

## Question 15 - Does Switchboard ship Codex red-team workflows?

Q: Should this change include opinionated red-team skills or workflow prompts?
A: No. Switchboard ships only the generic Codex-thinking capability, transport, persistence, and Claude-facing tools. Claude and skills external to Switchboard supply prompts and behavioral guardrails; Switchboard does not inject a hidden read-only preamble.

The `codexStartAgent` tool description warns that GPT-family agents may pursue goals through unexpected or suspect actions, advises explicit constraints, and recommends reviewing consequential work.

Keeping workflow methodology external avoids coupling the transport to one red-team style or exposing a static skill when the daemon capability is unavailable.

> "It's up to claude and the skills external to Switchboard."

> "include a statement in the start tool that caution is advised, since GPT-family likes to achieve the goal by any means possible, even if actionsare suspect."

## Question 16 - How are daemon capabilities exposed?

Q: Should daemon capabilities use a separate API from console capabilities?
A: No. Keep daemon and console announcements separate internally, then union them in the gateway's existing `/capabilities` response. The MCP continues using its existing last-known capability cache and registers the Codex tools only when `codex-thinking` is present.

One aggregated capability contract avoids a second fetch, schema, and cache while preserving source ownership internally.

## Question 17 - Where does Codex App Server run?

Q: Should one host-side App Server serve every managed session, including sessions inside devcontainers?
A: No. Run one App Server per execution target: one for host sessions and one lazily managed server for each devcontainer/project target. Each server still multiplexes many Codex threads; there is not one server process per Codex conversation.

Running the server in the same execution target as the invoking Claude session gives Codex the correct project paths, toolchain, services, and environment without inventing host-to-container path emulation.

## Question 18 - How does Claude learn how to delegate to Codex?

Q: Where does the delegation guidance live, and how does a session re-read it?
A: Not in the always-on block. That block is reduced to a list of enabled capability names plus one instruction to call `switchboard_capabilities`, which becomes the single source of guidance for every capability, Codex included. Both the block and the tool description say to call it again after a context compaction.

This replaces the per-capability prose in the MCP server instructions rather than adding to it. Those instructions sit in the system prompt and are re-sent on every request, so the always-on copy was going to be the whole playbook on the grounds that a cached prompt makes its token cost negligible. Measurement overrode that: the harness caps the block near 2048 characters, it already overflows by roughly 931, and the cut is silent. Length is the binding constraint, not cost. A name list fits with room to spare and no capability has to compete for the budget.

> "we use your idea because caching."

> "Instead of giving full text prose for everything, just return a list of module names enabled."

Q: Should the tool answer only from the startup snapshot?
A: It stays authoritative about the startup snapshot, because the tool set was gated on it and a fresh answer could describe tools this session does not have. It additionally performs one fresh capability read and appends a drift warning, which is the only way a running session can learn that the owner toggled a plugin.

> "sure drift check."

## Question 19 - Which model does a Codex agent run?

Q: What work tier should a managed Codex thread use?
A: `gpt-5.6-luna` by default, overridable by `CODEX_THINKING_MODEL`. It is light to run while still turning over the rocks a heavier model skips.

The id is verified against what `initialize` advertises, and an unoffered id refuses the thread rather than falling back to the server default. A silent fallback would leave a caller believing it had one tier while running another.

> "It's light like Haiku, but as thoroough as Fable. Even Opus (you) gets lazy and leaves many critical rocks unturned."

This is a Codex thread setting and has no bearing on Workflow subagents, whose `model` option accepts only Claude tiers.

Q: Can Claude choose the model per agent?
A: Only if the App Server turns out to support it. Phase 5 establishes whether thread configuration accepts a model at all. If it does, `codexStartAgent` takes an optional model defaulting to `gpt-5.6-luna`, fixed for that thread's life like every other thread setting, so `codexMessageAgent` gains nothing. If it does not, the default is the only value and no tool input is added.

> "when you invent the codex start and messageing MCP tools, discover if we can specify model, slip it in then. otherwise gpt-5.6-luna permanent."

# Plan

## Phase 1 - Lock the shared contract and ownership boundary ✅

- Add shared, runtime-validated schemas for MCP requests, the gateway route, gateway/daemon commands and events, App Server projections, persisted records, and tool results. Tolerate unknown additive App Server fields while rejecting incompatible shapes used by Switchboard.
- Keep native and Switchboard state distinct:
  - Agent state: `creating | idle | working | recovering | unavailable`.
  - Native turn state: `inProgress | completed | failed | interrupted`.
  - Switchboard observation: `accepted | idle | terminal | waitTimedOut | interruptRequested | indeterminate | unavailable`; an observation of `terminal` is qualified by the native turn state.
- Use one exhaustive result envelope for per-agent tools:
  - `{ agentId, agentState, observation, turn?, delivery?, activities, finalResponse?, error? }`.
  - `turn` contains the exact App Server turn ID and native state. `delivery` reports `started` or `steered` only after App Server acceptance; a creation-stage result can return its agent ID without pretending a turn exists.
  - `activities` is the chronological retained commentary snapshot for that exact `turn.id`, including any truncation marker. It is neither cross-turn nor a delta since the previous await.
  - Stable error codes distinguish invalid input, not-found, disabled/unavailable daemon, unavailable App Server, an interrupt in progress, protocol incompatibility, and an indeterminate delivery. A failed or interrupted Codex turn is a terminal turn result, not an MCP transport error.
- Introduce a gateway `CodexAgentService` as the only component allowed to transition agent records. HTTP routes authenticate/translate and the daemon performs execution; neither mutates session-owned Codex data directly.
- Add one strict session-authority resolver for all five operations. It requires the active token binding and a confirmed Switchboard-managed Claude session, returns its exact canonical `SessionRecord`, and never accepts an owner/session ID from tool input.
- Scope every agent and operation lookup to that resolved owner. Unknown, forged, and cross-session agent IDs all return the same not-found result; knowing an opaque ID grants no authority.
- Resolve execution target and working root only from trusted session data:
  - Devcontainer/project sessions validate their target against the authenticated host daemon's `offlineCatalog`, never the mixed-provenance `knownTeamPaths`. The daemon maps that catalog entry to and returns the canonical path inside the execution target.
  - Host sessions use a daemon-canonicalized, sanitized session workdir.
  - Do not trust bridge-reported team paths and do not accept a target or working directory from Claude. Refuse start if no trusted root can be resolved.

### Bug Classes

- Runtime state validation: repeated alignment and red-team rounds found lifecycle, reference, and causal-time drift between persisted records and their public list projections. Phase 1 now applies one shared history validator to both contracts and exposes one validated persisted-to-public projector that explicitly removes recovery-only fields.

## Phase 2 - Add session-owned persistence with checked commits ✅

- Extend each `SessionRecord` with its own Codex-agent catalog; do not create a second global catalog. Access it through narrow `SessionStore`/presence APIs rather than direct nested-object mutations.
- Persist for each agent:
  - Agent ID, canonical execution target/root, App Server thread ID, current state, active turn, timestamps, and reconciliation fences.
  - Every start/message prompt in full, its hidden operation ID, delivery mode, target turn, and timestamps.
  - One full terminal response or bounded sanitized error per native turn. Multiple prompts steered into the same turn reference that one outcome instead of copying it into every exchange.
  - Count- and length-bounded completed commentary with shared constants and an explicit truncation marker.
  - Pending interrupt and idempotency receipts needed for recovery.
- Do not persist raw App Server events, deltas, reasoning, plans, commands, diffs, tool/approval payloads, or its internal transcript. Do not add repeated await/list observations to exchange history. Do not cap or paginate the full sequence of prompt/response exchanges.
- Validate the nested catalog during restore. Drop malformed Codex entries while preserving the owning Claude session, and keep the existing full session-resume snapshot envelope compatible.
- Add a narrow checked, immediate, atomic save path for Codex transitions; do not rely on the current periodic save or a save API that swallows failures. Keep the broader persistence implementation unchanged.
- Commit a self-sufficient recovery intent before dispatch: owner, agent/operation IDs, target, method, full prompt/fingerprint, expected native IDs when known, and pre-dispatch state. Do not report durable acceptance until App Server thread/turn identifiers and the resulting state are also durably committed.
- If dispatch may have occurred but the acceptance commit fails, return `indeterminate` from the already-durable intent and never replay it. Reconciliation is possible only while the daemon still retains an unacknowledged acceptance receipt with the native IDs; after both sides restart, a newly created but uncommitted native thread may be orphaned and is not claimed recoverable.
- Let existing Claude-session forget/sweep behavior remove its nested catalog. Add no independent Codex TTL, kill operation, or App Server-thread deletion.

### Bug Classes

- Recovery ordering and durability in the catalog writer, service, and schema: alignment made ambiguous retries non-dispatchable; red-team rounds serialized prompt mutations, made receipt fences monotonic, and crossed the filesystem durability barrier; architecture review distinguished pre-install failure from an installed-but-unconfirmed snapshot, requires a checked checkpoint before replaying restored acceptance, and added daemon receipt correlation without fabricating Claude request authority.

## Phase 3 - Announce and aggregate config-based capability

- Read only `CODEX_THINKING_ENABLED=true` and pass it through the existing POSIX and PowerShell host-daemon launch paths.
- Include a complete daemon capability declaration in every authenticated host-register frame: `codex-thinking` when enabled and an explicit absence when disabled. A subsequent register replaces the prior daemon declaration.
- Accept daemon capability announcements only from the reserved authenticated host socket. Keep console and daemon capability sources separate internally, and serve them SEPARATELY through the existing `/capabilities` response.
- A pre-merged union was specified here first and is wrong. The sources own disjoint id spaces, so only a consumer holding its own last answer can decide what to keep, and that decision needs to know whether the source owning an id spoke this round. Serving one list makes the question unanswerable, and both attempts to work around it silently lost or resurrected a capability. The consumer carries forward per section and folds to one list itself.
- Persist the last complete authenticated daemon declaration separately from console capabilities. Preserve it across disconnect and gateway restart, and atomically replace it on the next authenticated register, including an empty declaration when the feature is disabled. This intentionally favors the user's accepted last-known cache behavior over second-accurate advertising.
- Add `codex-thinking` to the MCP's gated capability IDs. Capability controls tool discoverability, not health: each request for new work still checks current configuration/daemon/App Server availability, while already-registered control/read calls can operate on persisted agents during an outage.
- Current enablement gates new work (`start` and `message`), not control of existing work. A stale registered `stop` may still interrupt an owned active turn after disablement; `stop`, `await`, and `list` report daemon/App Server unavailability when the target cannot be reached rather than reporting the feature disabled.
- Do not add a second capabilities endpoint or attempt second-accurate tool removal. Document that enabling/disabling may require a Claude MCP reload before the advertised tool set changes.
- Reduce `capabilityInstructions` to the enabled capability names plus one instruction to call `switchboard_capabilities`. No capability's prose rides the always-on block any more, which repairs the existing overflow instead of working around it and stops capabilities competing for a length budget. This needs no schema change: `Capability.instructions` is untouched and only its delivery moves.
- Keep the existing behavior of emitting nothing at all when no capability is enabled, so a session with none is told nothing rather than pointed at an empty tool.
- Word the instruction unconditionally. A conditional hint ("before using it") lets an agent decide it does not need the call, and everything the block used to say is now behind it.
- Register an ungated `switchboard_capabilities` tool returning the enabled capabilities of this session's startup snapshot, each with its full `instructions`. Gating it would hide the one surface that explains which capabilities are absent, and it is now the only path to any guidance at all.
- Have that tool also perform one bounded fresh capability read and append a drift warning when the current union differs from the startup snapshot. The startup snapshot remains the authoritative answer for which tools exist, so a drift line only ever advises restarting the session.
- Say when that read could not be made at all. Silence has to mean "checked and unchanged" alone, or the one surface that exists to be authoritative gives the same answer whether or not it knows.
- Carry the Codex playbook below as the `instructions` of the daemon's `codex-thinking` declaration, as one exported constant in shared code since the daemon has no manifest to read it from. It reaches an agent only through the tool.
- State the after-a-compaction instruction in the always-on block and in the tool description, so an agent can reach it from the tool list alone.
- Verify the assembled block against a live session's own instructions once the names-only form is in, and keep a test asserting it stays under the cap as capabilities are added.

The always-on block:

```
Switchboard capabilities enabled: codex-thinking, designer, references.
Call switchboard_capabilities once to understand their features. If your
context has just been compacted, call it again.
```

The Codex `instructions`, reachable only through the tool:

```
Codex agents are enabled. A Codex agent is a second-model-family thread
this session owns, for handing off a self-contained sub-task.

Choosing the engine:
- Before fanning out parallel work, ask whether the branches should be
  Codex or Claude. If it is left to you, choose Codex.
- Codex suits self-contained branches: an audit of one subsystem, an
  adversarial second read, an isolated repro. Claude branches suit work
  needing this repo's conventions and your own session context.

Structuring a fan-out:
- You decide the splits. Each branch is one agent() call in a Workflow
  script, or one Agent tool call, driving a single Codex agent through
  codexStartAgent and codexMessageAgent.
- Give the branch a schema and have it return Codex's response in a
  schema field; do not ask it to summarize what Codex said. For output
  too large for a field, have Codex write a scratch file and return the
  path.
- Put constraints in the prompt you delegate. A Codex thread keeps
  workspace-write and web access for its whole life, and GPT-family
  agents pursue a goal through unexpected or suspect actions.

Budget and recovery:
- A waiting call blocks up to nine minutes and holds a concurrency slot.
  Size the fan-out for that, or pass awaitResponse: false and collect
  with codexAwaitAgent.
- Codex agents belong to this session, not to the branch that started
  one. If a branch dies, codexListAgents returns every agent with its
  full history, so re-run the collection, not the work.

Call this tool again after your next context compaction.
```

### Bug Classes

- Source-scoped truth handled as whole-answer truth, twice in the same mechanism, then fixed at the root. Round one: the union's `known` was an OR across two sources owning disjoint id spaces, so the daemon's affirmative "nothing enabled" answered for the console's ids and stripped them from every session. Round two: the repair merged an incomplete answer over the MCP cache but wrote the merge back as verified, so on an install where a source is never known a withdrawn capability was read back out of the cache forever. Both patches worked around the same missing fact, that nothing recorded WHICH source owns an id. The route now serves the sources apart and the cache stores them apart, so a carry-forward is per section and the question never has to be asked of a merged list.
- State mutated before a request is accepted: the daemon's declaration was applied after the token gate but before the reserved-name gate, so a second daemon refused for the slot still replaced the live declaration on its way out. Every register-time side effect belongs after the last rejection, not after the first.
- A wire change shipped without a rollout boundary: splitting `/capabilities` by source broke both skew directions at once, and the plugin leading the gateway by several releases is the ordinary case rather than an edge one. A new session against a not-yet-restarted gateway lost every gated tool silently and for its whole life, with the legacy cache rejected too so it could not even fall back. Both sides are now tolerant: the MCP lifts a pre-split answer from either the wire or its own cache file, and the route carries the flat fields alongside the sections. Both are marked for retirement. The lesson is that this repo's components update on separate triggers, so any shared shape needs a skew plan before it lands, not after.
- One guarantee asserted in several places with no owner: reducing the always-on block falsified the same claim in `skills/crosstalk/SKILL.md`, a CLAUDE.md cross-reference, a `humanTools.ts` docstring, and a reach test that passed on a source substring while what it guaranteed had gone. The test now asserts each hop's real output, which is the only one of the four that can fail.

### Human Acceptance

This phase changes how every capability's guidance reaches every session, so it does not end at a green test suite. The owner cannot see the assembled system prompt from any surface, which is exactly why the defect this phase repairs stayed invisible. Only a live session can report what actually arrived.

- Complete the real ritual before the gate: commit, `bun run build patch`, push, `reload_plugins` on the target, set `CODEX_THINKING_ENABLED=true`, restart the host daemon, then start a FRESH Claude session. A running one picks up neither the tool set nor the block.
- In that session, report the loaded Switchboard MCP server instructions verbatim: every field, value, and line exactly as received, with no summarizing, reformatting, or silent repair. Report the `switchboard_capabilities` output the same way.
- Report any truncation marker verbatim and name what it cut. No marker anywhere in the block is the pass condition for the overflow repair.
- Confirm the block is absent entirely from a session with no capability enabled.
- The owner reads and approves the formatting. This is a blocking gate, and no later phase starts until it passes.

## Phase 4 - Supervise App Server by execution target

- Add a daemon-owned execution-target manager that lazily runs:
  - One `codex app-server` JSONL/stdio child for host sessions.
  - One child inside each devcontainer/project execution target that receives Codex work.
- Multiplex all Codex threads for a target through that target's single child; never spawn one process per conversation. Key commands and persisted records by a stable canonical target identity.
- Launch inside the selected target so Codex sees the same project path, toolchain, services, and environment as the managed Claude session. Do not emulate container paths through a host-only App Server.
- Keep the manager small and target-keyed rather than building a general process framework. Launch host children directly; launch container children through the daemon's existing derived container/user execution boundary with interactive stdio and the canonical in-container workspace as cwd.
- Supervise children independently from unrelated daemon services. Missing binaries, authentication failure, incompatible initialization, or a child crash produce bounded-backoff `unavailable/recovering` results rather than crashing the daemon. Reap every supervised child when its execution target or daemon exits.
- Give each daemon process a stable instance ID across WebSocket reconnects and each child a new App Server generation. A connection epoch admits only messages from the current authenticated socket; durable event validity is fenced separately by daemon instance, target, generation, thread, turn, and item/event IDs so reconnect replay is not discarded merely because the socket changed.
- Scrub Switchboard credentials and unrelated daemon secrets from each child environment while retaining the target environment needed for Codex authentication and tools. Emit structured lifecycle logs containing only IDs, generations, state, and sanitized error class. Never log prompts, raw events, credentials, or tool payloads.

## Phase 5 - Implement the App Server client fail-closed

- Build an injectable `AppServerTransport`/child factory around JSONL stdio. Perform `initialize`/`initialized` before any work and verify compatibility with the documented supported Codex CLI/App Server version.
- Use stable operations only: thread start/resume/read/unsubscribe and turn start/steer/interrupt. Do not use experimental dynamic tools or experimental terminal-cleanup APIs.
- Configure every thread with its trusted canonical cwd, normal App Server workspace-write, network/web access, and `approvalPolicy: "never"`. Keep the ordinary workspace-write/temp behavior selected in the questionnaire; do not add a custom per-platform read-root policy.
- Request `gpt-5.6-luna` on every thread, overridable by `CODEX_THINKING_MODEL`. Verify the id against what `initialize` advertises and refuse the thread with an explicit unavailable when it is not offered. Never fall back to the server's own default, since a caller would then believe it is getting one tier while receiving another. Report the model actually in use on every agent record so a list call can show it.
- Establish here whether thread configuration accepts a model at all, and record the answer in the questionnaire. It decides whether Phase 7 exposes a per-agent choice or ships the configured default as the only value.
- Implement every App Server server-initiated JSON-RPC request explicitly and fail closed:
  - Decline/cancel command, file-change, user-input, elicitation, and app/tool approval requests.
  - Grant no additional permission roots.
  - Return a bounded protocol error for unknown request methods instead of ignoring them.
- Filter output at ingress. Keep the last completed agent message for the active turn in volatile memory regardless of phase, but persist only bounded completed `commentary` activities and the terminal answer or a controlled, sanitized failure summary derived from documented error fields. Never stringify a raw App Server event, command, tool call, or approval payload into an error.
- Treat `item/completed` as the completed-message signal and `turn/completed` as the authoritative terminal signal. For a successful turn, prefer the last completed `final_answer`; if phase is absent, fall back to the last completed agent message for that exact turn.
- If the terminal event arrives before its final item, hold it pending while draining already-correlated items and perform a bounded scheduler-driven thread/read reconciliation. Persist/acknowledge the terminal only after that barrier, then use the exact-turn fallback if no phased final exists. Never borrow a message from another thread/turn/item; failed and interrupted turns receive no invented final response.
- Unsubscribe an idle thread only after its terminal state has been durably acknowledged. Resume/read it before a later follow-up.

## Phase 6 - Relay, reduce, acknowledge, and reconcile

- Add typed Codex commands, acceptances, reconciliation messages, asynchronous events, and event acknowledgements to the existing authenticated gateway/host WebSocket. Leave the terminal `HostOpCoordinator` and its 20-second protocol unchanged.
- Carry the gateway-issued canonical owner key on every Codex command, receipt, and event. The daemon echoes it for durable correlation; it is never accepted from Claude, and the gateway still verifies that the referenced agent and operation belong to that exact live session record.
- Generate a private operation ID once in each mutating MCP tool invocation, before `routerPost`, and reuse it across that invocation's automatic HTTP retries. Do not expose request IDs to Claude. The gateway generates the stable `agentId` for start.
- Scope idempotency to `(owner session, operation ID)` and fingerprint the operation kind, agent, and prompt. A retry with the same ID and payload returns the committed result; the same ID with a different payload is a conflict. A separate Claude tool call is a new requested mutation, even when its text matches.
- Route command acceptance, App Server events, stop results, and reconciliation through one per-agent reducer/critical section. Release the section during daemon I/O and nine-minute waits, then compare-and-apply only if the captured fences and expected state still match.
- Have the daemon retain command acceptances, terminal transitions, and interrupt-result receipts until the gateway durably commits and acknowledges them; replay those receipts across gateway WebSocket reconnects. Commentary is bounded, coalescible, and best-effort rather than a durable daemon outbox. Give reliable receipts a daemon-assigned per-generation event ID, deduplicate by `(daemonInstanceId, targetId, generation, eventId)`, and validate their correlated thread/turn/item against the persisted agent before applying them.
- On each authenticated host reconnect, send daemon instance and App Server generations. The gateway, not the daemon, enumerates its session-owned working/recovering records and requests explicit reconciliation. List/await may trigger reconciliation of stale records even though they never start a turn.
- Treat App Server state as authoritative. A persisted `working` flag cannot resurrect work; a missing/unreadable active turn becomes `indeterminate` or `unavailable`. After daemon restart, rebuild whatever terminal state and bounded activities are still available from exact-thread/turn `thread/read`; do not promise daemon receipt replay across a daemon crash or claim that an active turn survived a child death unless App Server proves it.
- Never blindly replay an operation whose delivery cannot be proven. Return its recoverable persisted history and an indeterminate result so Claude or an external workflow decides whether to retry.
- For `codexMessageAgent`:
  - If a turn is active, steer it with the exact `expectedTurnId` and report `delivery: "steered"`.
  - If App Server proves that turn completed during delivery, reconcile it and start exactly one new turn, reporting `delivery: "started"`.
  - Do not fall back to a new turn for unrelated steer errors, and do not steer while an interrupt is pending.
- For stop, durably enter `interruptRequested`, dispatch one interrupt for the exact active turn, and return immediately. A repeated stop while pending does not redispatch; idle stop is a successful no-op. The authoritative later outcome may be `interrupted`, or `completed` if completion won the race. Stop does not promise cleanup of background subprocesses started by Codex.

## Phase 7 - Expose session-scoped Claude tools

- Add one authenticated, discriminated gateway Codex route so validation and session authority cannot drift across five handlers.
- Conditionally register only these tools when the cached capability contains `codex-thinking`:
  - `codexStartAgent(prompt, awaitResponse = true, model?)`. The model input exists only if Phase 5 found the App Server accepts one, and belongs on start alone since it is fixed for a thread's life.
  - `codexMessageAgent(agentId, prompt, awaitResponse = true)`.
  - `codexAwaitAgent(agentId)`.
  - `codexStopAgent(agentId)`.
  - `codexListAgents()`.
- Allocate and commit a start agent ID before daemon dispatch, so every accepted/background/timed-out/terminal start result returns the same ID. Every message/await/stop result likewise returns its supplied stable agent ID.
- `start` and `message` wait up to nine minutes by default; `awaitResponse=false` returns after checked durable acceptance or an explicit error/indeterminate result. A nine-minute expiry returns `waitTimedOut`, not a failed turn.
- The nine-minute budget begins at tool invocation. With waiting enabled it ends with a terminal result, `waitTimedOut`, or an explicit unavailable/indeterminate result. If the deadline arrives before acceptance is proven, omit the turn/delivery and do not describe the operation as background work.
- Each waiter captures one exact turn ID at invocation. A later turn cannot satisfy an earlier waiter; concurrent steers may wait on the same active turn. A waiter settles early if that turn becomes unavailable/indeterminate, and await with no active turn returns the latest settled state immediately.
- `codexStopAgent` is the asynchronous interrupt described above, not a close/delete operation. The retained thread remains reusable for later messages. Do not expose `codexKillAgent`.
- `codexListAgents` returns only the invoking Claude session's agents and their complete stored prompt/response exchange history inline, without pagination or a separate detail tool. During outages it may return persisted state plus an unavailable/recovery observation.
- Render each prompt exchange once with its delivery and target turn, and associate prompts sharing a steered turn with that turn's single stored activities/final outcome. Do not imply that a shared turn's final response belongs exclusively to one prompt.
- Use strict tool inputs: a documented bounded non-empty prompt, a validated opaque agent ID, and an optional boolean `awaitResponse` defaulting to true. Reject unknown/invalid fields before allocating an agent or operation.
- Put the requested warning directly in the start tool description: GPT-family agents may pursue goals through unexpected or suspect actions; callers should state constraints explicitly and review consequential work.
- Pass Claude's prompt through without Switchboard-injected red-team/read-only prose and without Switchboard-authored workflow status/final tools.

## Phase 8 - Verify races, recovery, isolation, and operability

- Unit-test shared schema projections, exhaustive reducer transitions, result envelopes, hidden operation-ID replay, native final selection, truncation markers, and sanitized logging.
- Test strict session authority on every operation, including unbound/manual sessions and forged/cross-session IDs with indistinguishable not-found responses. Test trusted host/container target resolution and rejection of bridge-poisoned or unresolved paths.
- Test immediate checked persistence, failure before/after dispatch, restore/migration, malformed nested records, full large histories, and catalog removal with the owner session.
- Test capability source union and `known` transitions, explicit empty daemon announcements, reconnect replacement, stale MCP cache behavior, conditional registration, and runtime-unavailable responses.
- Test that `switchboard_capabilities` registers with no capability present, reports the startup snapshot rather than the fresh read, warns only on real drift, and stays silent when the fresh read fails or matches. Assert the always-on block carries names only, and that it stays under the length cap as capabilities are added.
- Inject a fake checked-commit result, scheduler/clock, `ExecutionTargetLauncher`, `AppServerTransport`, child factory, and redacted logger. Cover host/container root selection, launch failure, partial/multiple JSONL frames, initialize incompatibility, server-initiated request denial, target multiplexing, generation fencing, and child backoff without Docker or Codex service usage.
- Fault-inject gateway, host socket, daemon, execution target, App Server, and persistence loss before/after intent, dispatch, acceptance, reliable-event commit/ACK, completion, and interrupt. Verify replay of unacknowledged reliable receipts and no blind replay of ambiguous prompts.
- Test duplicate, delayed, reordered, and stale events; connection-epoch changes; daemon crash before/after ACK; terminal-before-final-item with a stale first read; concurrent messages; completion-versus-steer; message-versus-stop; repeated stop; exact-turn wait isolation/unavailability; and completion immediately before/at/after the nine-minute boundary.
- Add end-to-end tool tests for immediate completion, background start/message, repeated await, list after simulated Claude compaction, daemon/gateway restart recovery, stop then follow-up, unavailable App Server, and host versus devcontainer target selection.
- Keep a real logged-in App Server smoke test opt-in and separate from deterministic CI. Run lint, type checking, unit/integration tests, and build.
- Document only `CODEX_THINKING_ENABLED=true`, the five tools, wait/stop/recovery semantics, execution-target placement, the caution statement, capability cache/reload behavior, `switchboard_capabilities` and its drift warning, and the residual risk that Codex can mutate its workspace and start subprocesses. Ship no Switchboard red-team skill.

### Human Acceptance

Run Phase 3's gate again, same ritual and same verbatim reporting, now that the five Codex tools exist and their playbook is what the tool serves rather than a constant nothing reads yet. Report the five registered tool descriptions in full as well, since each is its own always-on text subject to the same limit.

The owner approves before merge. What is being checked is not the wording, which is readable in source, but how the union, the assembly, and the harness's limits render it, which is readable nowhere else.

## Painpoints

- `src/shared/codex-thinking.ts` intentionally exposes one compatibility import today, but its public, persistence, daemon, and App Server boundaries now occupy one high-conflict module. Preserve the barrel import and split the implementation by trust boundary when later phases add their consumers.
- `src/gateway/codexAgentService.ts:CodexAgentService` is the correct single transition owner, but its begin and acceptance branches already hand-build state changes. Introduce the planned pure per-agent reducer before Phase 6 adds terminal, reconciliation, interrupt, and activity transitions.
- The Codex contract and persistence tests have strong mutation coverage but now repeat several valid histories, receipts, and restored-service setups. Introduce canonical creating, working, settled, and receipt builders before the Phase 6 race matrix multiplies them further.
- The assembled Switchboard MCP server instructions ALREADY arrive truncated in a live session, which is a shipped defect rather than a Codex concern. The block assembles to 2979 characters and approximately 2048 arrive, cutting the last 931: the tail of the `references` guidance plus all ten of its worked `ref://` examples have never reached any session. That the delivered length lands on 2048 exactly points at a fixed harness limit rather than a token budget, so prompt caching buys no room. Phase 3's names-only block is the repair, and it should be confirmed by reading a live session's own instructions rather than by arithmetic.
- The same `ref://` prose is duplicated into the `channel_reply` and `notify_human` tool descriptions, and both are truncated at their own limit too. Moving guidance behind `switchboard_capabilities` is the same repair for all three surfaces, but those descriptions sit outside Phase 3 as scoped.
