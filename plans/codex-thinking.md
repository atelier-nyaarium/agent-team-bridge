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
A: Yes, confirmed against a live App Server. `thread/start` accepts `model` and echoes it back, so `codexStartAgent` takes an optional model defaulting to `gpt-5.6-luna`, fixed for that thread's life like every other thread setting. `codexMessageAgent` gains nothing from it.

Q: What about reasoning effort and the other per-thread dials?
A: Pinned to the strongest the chosen model advertises, and exposed nowhere. Luna's own default is `medium` and its ceiling is `max`, so an unset thread would quietly think less than it can. Nothing here is a caller choice: the model is the one dial, and it defaults rather than inheriting.

> "Ensure that our tool defaults to Luna. not use default. And if it makes you choose context size and effort, max it out. No choices."

> "when you invent the codex start and messageing MCP tools, discover if we can specify model, slip it in then. otherwise gpt-5.6-luna permanent."

## Question 20 - How is a Codex pipeline shaped, and who states the guardrails?

Q: Which legs of a fan-out belong to Codex, and which to Claude?
A: Fan-out dimensions run on Codex, consolidating steps on Claude, with the join sized to its difficulty rather than pinned to a tier. Research is the one exception and stays on Opus, web research especially. An iterating dimension reuses one Codex thread across its attempts rather than starting a fresh agent per loop.

> "As long as the fan-out portions are Codex Luna, and the consolidating steps are Claude."

> "The only exception is All research (esp. the web) must be Opus."

> "put Sonnet/Opus depending on complexity. Architecture is a difficult job, so that was explicitly Opus. But a simple collating of simple things don't need flagship models"

Q: Does Switchboard state a default permission posture?
A: No. Read-only stays unstated and every scope is the caller's to set. The start tool's description instead urges the caller to state them: whether the agent may write and to which paths, whether it may reach the network, and what done looks like. Code edits are explicitly fine when the scope is narrow.

> "I want it non-stated. Let it be whatever. BUT the tool description needs to urge you to guide it."

# Plan

## Phase 1 - Lock the shared contract and ownership boundary ✅

Runtime-validated shared schemas for every Codex wire shape, tolerant of unknown additive App Server fields and strict about the ones Switchboard reads. Later phases are written against these vocabularies:

- Agent state: `creating | idle | working | recovering | unavailable`.
- Native turn state: `inProgress | completed | failed | interrupted`.
- Switchboard observation: `accepted | idle | terminal | waitTimedOut | interruptRequested | indeterminate | unavailable`, with `terminal` qualified by the native turn state.
- One result envelope for every per-agent tool: `{ agentId, agentState, observation, turn?, delivery?, activities, finalResponse?, error? }`. `delivery` appears only after App Server acceptance, and `activities` is that exact turn's retained commentary, never cross-turn and never a delta.
- A failed or interrupted Codex turn is a terminal turn result, not an MCP transport error.

`CodexAgentService` is the only component allowed to transition an agent record. One strict session-authority resolver serves all five operations and never accepts an owner or session id from tool input, so a forged or cross-session agent id is indistinguishable from an unknown one. Execution target and working root resolve only from trusted session data: a container session against the daemon's `offlineCatalog` rather than the mixed-provenance `knownTeamPaths`, a host session against a daemon-canonicalized workdir. A start with no trusted root is refused.

### Bug Classes

- Runtime state validation: repeated alignment and red-team rounds found lifecycle, reference, and causal-time drift between persisted records and their public list projections. Phase 1 now applies one shared history validator to both contracts and exposes one validated persisted-to-public projector that explicitly removes recovery-only fields.

## Phase 2 - Add session-owned persistence with checked commits ✅

Each `SessionRecord` carries its own Codex-agent catalog, reached through narrow store APIs rather than nested mutation, so a session's agents live and die with it. No independent Codex TTL, kill operation, or thread deletion.

It holds ids, canonical target and root, thread and turn state, every prompt in full with its hidden operation id, one terminal outcome per native turn (shared by prompts steered into that turn), bounded commentary with an explicit truncation marker, and the fences recovery needs. Deliberately NOT held: raw App Server events, deltas, reasoning, plans, commands, diffs, tool and approval payloads, and the internal transcript. Exchange history is never capped or paginated. A malformed Codex entry is dropped on restore without taking its Claude session with it.

Writes go through a checked, immediate, atomic path rather than the periodic save. A self-sufficient recovery intent commits BEFORE dispatch, and acceptance is not reported until the native ids and resulting state are also durable. A dispatch that may have happened but whose acceptance failed to commit returns `indeterminate` and is never replayed; after both sides restart, an uncommitted native thread may be orphaned and is not claimed recoverable.

### Bug Classes

- Recovery ordering and durability in the catalog writer, service, and schema: alignment made ambiguous retries non-dispatchable; red-team rounds serialized prompt mutations, made receipt fences monotonic, and crossed the filesystem durability barrier; architecture review distinguished pre-install failure from an installed-but-unconfirmed snapshot, requires a checked checkpoint before replaying restored acceptance, and added daemon receipt correlation without fabricating Claude request authority.

## Phase 3 - Announce and aggregate config-based capability ✅

The host daemon reads `CODEX_THINKING_ENABLED=true` through both launch paths and declares its own capabilities on every authenticated host register, honoured only past the `HOST_WS_TOKEN` gate and only from the register that actually takes the slot. An empty declaration is an affirmative "nothing enabled" that replaces the prior one; an absent field leaves it standing. The gateway persists it beside the console's, with no TTL, favouring last-known over second-accurate.

`/capabilities` serves the two sources APART. A pre-merged union was specified here first and was wrong: the sources own disjoint id spaces, so only a consumer holding its own last answer can decide what to keep, and that needs to know whether the source owning an id spoke this round. Both attempts to answer it from one list silently lost or resurrected a capability. The consumer carries forward per section and folds with `unionCapabilities`, whose `known` is an AND meaning complete.

`capabilityInstructions` carries NAMES only, since every surface it appends to is length-capped by the harness, and emits nothing at all when nothing is enabled. Its instruction is unconditional, because a hint phrased as a precondition is one an agent can decide does not apply. Guidance moved behind an ungated `switchboard_capabilities` tool, ungated because it is the one surface that explains an absence. It answers from the startup snapshot, adds a drift warning from one bounded fresh read, and says so when that read could not be made at all.

`codex-thinking` is in `GATED_CAPABILITY_IDS`. Capability gates discoverability, not health: later phases still check live availability per request, and enablement gates new work rather than control of existing work. No second endpoint, and a toggle is picked up at the next session start.

Both sides tolerate the pre-split shape, marked in code for removal after 2026-11-01, because the plugin and the gateway update on separate triggers and the plugin usually leads.

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

Shaping a pipeline:
- Fan-out dimensions run on Codex: an audit of one subsystem, an
  adversarial second read, an isolated repro, an iterative fix.
- Research is the exception, web research especially. It stays on Opus.
- Consolidating steps run on Claude, since a join reads every dimension
  and needs your session context and this repo's conventions. Size it to
  the work: Sonnet collates, Opus decides.
- Shapes that work, not an exhaustive list:
    Research (Opus)                  -> Rank (Sonnet)
    Audit (Codex)                    -> Synthesize (Sonnet)
    Architecture assessment (Codex)  -> Synthesize (Opus)
    Iterative fix until pass (Codex) -> Report (Sonnet)
- Ask before fanning out whether the dimensions should be Codex or
  Claude. Left to you, choose Codex for anything that is not research.

Driving one from a dimension:
- The agent on a dimension owns its Codex thread for that thread's life,
  starting it with codexStartAgent and following up with
  codexMessageAgent until its question is settled.
- An iterating dimension reuses that one thread across its attempts
  rather than starting a fresh agent per loop. A thread holding its own
  last three failures fixes the fourth.
- Give each a schema so it returns data, not prose. Condense where the
  detail does not change what you do next; never paraphrase a finding you
  will act on.
- Too large to carry back: have Codex write a scratch file and return the
  path.
- Put constraints in the prompt you delegate. A Codex thread keeps
  workspace-write and web access for its whole life, and GPT-family
  agents pursue a goal through unexpected or suspect actions.
- The triage gate still applies to what comes back. A confident tone is
  not evidence; verify against the code.

Budget and recovery:
- A waiting call blocks up to nine minutes and holds a concurrency slot.
  Size the fan-out for that, or pass awaitResponse: false and collect
  with codexAwaitAgent.
- Codex agents belong to this session, not to the dimension that started
  one. If an agent dies, codexListAgents returns every thread with its
  full history, so re-run the collection, not the work.

Call this tool again after your next context compaction.
```

### Bug Classes

- Source-scoped truth handled as whole-answer truth, twice in the same mechanism, then fixed at the root. Round one: the union's `known` was an OR across two sources owning disjoint id spaces, so the daemon's affirmative "nothing enabled" answered for the console's ids and stripped them from every session. Round two: the repair merged an incomplete answer over the MCP cache but wrote the merge back as verified, so on an install where a source is never known a withdrawn capability was read back out of the cache forever. Both patches worked around the same missing fact, that nothing recorded WHICH source owns an id. The route now serves the sources apart and the cache stores them apart, so a carry-forward is per section and the question never has to be asked of a merged list.
- State mutated before a request is accepted: the daemon's declaration was applied after the token gate but before the reserved-name gate, so a second daemon refused for the slot still replaced the live declaration on its way out. Every register-time side effect belongs after the last rejection, not after the first.
- A wire change shipped without a rollout boundary: splitting `/capabilities` by source broke both skew directions at once, and the plugin leading the gateway by several releases is the ordinary case rather than an edge one. A new session against a not-yet-restarted gateway lost every gated tool silently and for its whole life, with the legacy cache rejected too so it could not even fall back. Both sides are now tolerant: the MCP lifts a pre-split answer from either the wire or its own cache file, and the route carries the flat fields alongside the sections. Both are marked for retirement. The lesson is that this repo's components update on separate triggers, so any shared shape needs a skew plan before it lands, not after.
- One guarantee asserted in several places with no owner: reducing the always-on block falsified the same claim in `skills/crosstalk/SKILL.md`, a CLAUDE.md cross-reference, a `humanTools.ts` docstring, and a reach test that passed on a source substring while what it guaranteed had gone. The test now asserts each hop's real output, which is the only one of the four that can fail.

### Human Acceptance

PASSED on 7.20.0. The block assembles to 1097 characters with no truncation marker, against 2979 with 931 cut before. The tool serves the references guidance whole, including the ten worked `ref://` examples that had never reached a session. The MCP cache migrated itself, and a 7.19.9 devcontainer kept working against the restarted gateway.

This phase changes how every capability's guidance reaches every session, so it does not end at a green test suite. The owner cannot see the assembled system prompt from any surface, which is exactly why the defect this phase repairs stayed invisible.

- Complete the real ritual before the gate: commit, `bun run build`, push, `reload_plugins` on the target, set `CODEX_THINKING_ENABLED=true`, restart the host daemon.
- **Ask the artifact, not a session.** Spawn the installed `dist/main-mcp.js` and send it an `initialize`; the `instructions` field it returns IS the system prompt block, byte for byte. A session cannot report its own prompt honestly, because a resumed conversation replays the transcript it started with, and reading that back reports the old text with full confidence.
- Report any truncation marker verbatim and name what it cut. No marker anywhere is the pass condition for the overflow repair.
- Confirm the block is absent entirely when no capability is enabled, and exercise the enabling flag in both directions against the running daemon.
- The owner reads and approves the formatting. This is a blocking gate, and no later phase starts until it passes.

## Phase 4 - Supervise App Server by execution target ✅

Shipped as `mcp/devcontainer/codexTargets.ts`: `ExecutionTargetManager` over an injectable `ExecutionTargetLauncher`, one child per target keyed by `targetId`, started on first use. A host child launches directly with a scrubbed environment; a container child goes through `docker exec -i -u vscode -w <cwd>`, the boundary the terminal ops already use, because `devcontainer exec` buffers to completion and cannot hold a conversation. Failures are bounded-backoff `recovering`, then `unavailable` after five fast failures, with a cooldown so a repaired target recovers without a daemon restart. The daemon mints one instance id per process and reaps every child on exit.

Two things the environment work had to get right: `docker exec` does not forward the caller's environment, so container settings ride as explicit `-e` pairs and only `CODEX_*` is worth carrying, and the container name is slug-asserted before it reaches argv the way every other exec call site in the daemon does.

The targetId grammar now has one owner in `shared/codex-thinking.ts`: `host`, or `container:<project-slug>`. It was implied only by test fixtures before, and the launcher had read the field its own way, which would have rejected every real container target while its own fixtures passed. A cache hit also re-checks kind and cwd rather than trusting the id alone, matching the gateway's own target comparison, since a child's cwd is fixed for its whole life.

A working directory is NOT a target property. A thread carries its own cwd, so the child only needs a sane one for its target, and taking a per-session path would have split one target across several children and handed an arbitrary absolute path to `docker exec -w`. Every host session shares one child; each thread points itself.

### Bug Classes

- A failure path that takes down more than its own target: child streams were handed out with no `error` listener, so one broken pipe would have thrown, hit the daemon's `uncaughtException` guard, and killed every other target's App Server with it. Any stream this daemon adopts needs its error sink attached at the point of adoption.
- A type-narrowing gap that fails OPEN: the launcher branched on `kind === "devcontainer"` and let everything else reach the unsandboxed host spawn, so an unrecognized kind would have run on the host rather than being refused. A dispatch whose branches differ in privilege has to be exhaustive with an explicit refusal, never an else.

Deliberately left for later phases, so a re-audit does not raise them again:

- `acquire` has no production caller yet. Phase 6 routes Codex commands to it.
- The daemon sends `daemonInstanceId` and nothing reads it. Phase 6 consumes it for reconciliation fences.
- A failure class is derived from spawn errors and exit codes only. An auth failure or an incompatible handshake that does NOT exit the process is invisible here by construction, since this layer never speaks the protocol. Phase 5's client reports those.
- Per-target reaping exists but has no trigger beyond daemon exit. It wants a container-stopped signal the daemon does not track yet.

### Original spec

- Add a daemon-owned execution-target manager that lazily runs:
  - One `codex app-server` JSONL/stdio child for host sessions.
  - One child inside each devcontainer/project execution target that receives Codex work.
- Multiplex all Codex threads for a target through that target's single child; never spawn one process per conversation. Key commands and persisted records by a stable canonical target identity.
- Launch inside the selected target so Codex sees the same project path, toolchain, services, and environment as the managed Claude session. Do not emulate container paths through a host-only App Server.
- Keep the manager small and target-keyed rather than building a general process framework. Launch host children directly; launch container children through the daemon's existing derived container/user execution boundary with interactive stdio and the canonical in-container workspace as cwd.
- Supervise children independently from unrelated daemon services. Missing binaries, authentication failure, incompatible initialization, or a child crash produce bounded-backoff `unavailable/recovering` results rather than crashing the daemon. Reap every supervised child when its execution target or daemon exits.
- Give each daemon process a stable instance ID across WebSocket reconnects and each child a new App Server generation. A connection epoch admits only messages from the current authenticated socket; durable event validity is fenced separately by daemon instance, target, generation, thread, turn, and item/event IDs so reconnect replay is not discarded merely because the socket changed.
- Scrub Switchboard credentials and unrelated daemon secrets from each child environment while retaining the target environment needed for Codex authentication and tools. Emit structured lifecycle logs containing only IDs, generations, state, and sanitized error class. Never log prompts, raw events, credentials, or tool payloads.

## Phase 5 - Implement the App Server client fail-closed ✅

Shipped as `codexAppServer.ts` (transport plus client) and `codexTurnTracker.ts` (ingress). Verified against the real binary end to end: handshake, model check, thread, turn, and a selected answer.

`initialize` advertises no version and no capabilities, so there is nothing to check compatibility against. `model/list` is the only capability source, and a model it does not offer refuses the thread. A per-call model override is verified against that same list, since it is the path Phase 7's optional input takes.

Sandbox and network are deliberately not sent, leaving the App Server's ordinary workspace-write behavior, which is what the questionnaire chose.

Two spec items are deliberately left to Phase 6, which owns durability and scheduling. The tracker HOLDS a terminal that beat its final item and exposes `settlePending`, but the bounded scheduler-driven `thread/read` reconciliation that decides when to stop waiting is the caller's. Likewise `unsubscribeThread` exists, but "only after the terminal is durably acknowledged" is an ordering only the side that acknowledges can enforce.

### Bug Classes

- A parser that trusts its input's shape: `JSON.parse` accepts `null`, a bare array and a bare number, and reading a property off any of them throws inside a stream handler, where an uncaught throw reaches the daemon's `uncaughtException` guard and reaps every other target's App Server. This is the same blast radius as Phase 4's unlistened streams, from a different direction: anything parsed off a child's output needs its type checked before a field is read.
- A lookup table exposed to attacker-chosen keys: the decline table was a plain object, so a request method named `constructor` or `toString` resolved to an inherited function, and the reply serialized to neither a result nor an error. A table keyed by anything a peer names has to be a Map or a null-prototype object.
- Verification placed where it can be walked past: `open` checked the model, then `startThread` accepted a per-call override and sent it unchecked, so the guarantee held only for the default nobody would use. A check belongs at the point of use, not only at the point of construction.
- **Two reads of one fact, drifting apart under a fix.** Narrowing which message may answer a turn changed WHAT was reported but not WHEN reporting was allowed: the hold guard still tested the old field, so a commentary item made a turn look finished and it settled with no answer, after which the real answer arrived and was refused as a duplicate. That is Codex's ordinary streaming order, not an edge case, and the earlier bug at least leaked the wrong text where this one lost the right text silently. `answerOf` is now the single reader that both the guard and the outcome go through. Any predicate asking "do we have X yet" has to call the same accessor that later produces X.

### Original spec

- Build an injectable `AppServerTransport`/child factory around JSONL stdio. Perform `initialize`/`initialized` before any work and verify compatibility with the documented supported Codex CLI/App Server version.
- Use stable operations only: thread start/resume/read/unsubscribe and turn start/steer/interrupt. Do not use experimental dynamic tools or experimental terminal-cleanup APIs.
- Configure every thread with its trusted canonical cwd, normal App Server workspace-write, network/web access, and `approvalPolicy: "never"`. Keep the ordinary workspace-write/temp behavior selected in the questionnaire; do not add a custom per-platform read-root policy.
- Request `gpt-5.6-luna` EXPLICITLY on every thread, overridable by `CODEX_THINKING_MODEL` or the start tool's optional model. Never omit it and inherit whatever the operator's `config.toml` happens to say, since that file is theirs and moves without warning. Verify the id against `model/list` and refuse the thread with an explicit unavailable when it is not offered, rather than falling back to the server default and leaving a caller believing it got one tier while running another. Report the model actually in use on every agent record so a list call can show it.
- Pin reasoning effort to the STRONGEST tier that model advertises in `model/list`, read per model rather than hardcoded: luna tops out at `max` while sol also offers `ultra`, so a fixed string would silently under-drive one of them. An unset thread runs at the model's own default, which for luna is `medium`.
- Expose no other per-thread dial. The model is the single choice, and it has a default rather than an inheritance.

### Confirmed against a live App Server

Spiked on `codex-cli 0.146.0`, so these are observations rather than assumptions:

- `initialize` returns only `userAgent`, `codexHome`, `platformFamily`, `platformOs`. It advertises NO capabilities and NO model list, so the version and model checks must come from elsewhere. `model/list` is the model source.
- `model/list` offers `gpt-5.6-sol` (default), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Luna is real and reads as "Fast and affordable agentic coding model".
- `thread/start` accepts `cwd`, `model`, and `approvalPolicy: "never"`, and echoes the model back.
- `turn/start` takes `{ threadId, input: [{ type: "text", text }] }`.
- Every method the plan relies on exists: `thread/start`, `thread/resume`, `thread/read`, `thread/unsubscribe`, `turn/start`, `turn/steer`, `turn/interrupt`.
- The terminal is `turn/completed`, carrying `turn.status` and its items. A completed answer arrives as an `item/completed` whose item has `phase: "final_answer"`, exactly the selector Phase 5 assumes.
- `item/agentMessage/delta` streams token deltas, which is the traffic Phase 2 refuses to persist.
- Also seen and ignorable: `thread/started`, `turn/started`, `item/started`, `thread/status/changed`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `configWarning`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed`.
- An untrusted cwd logs a `configWarning` and continues with project-local config disabled. It is not an error, so do not treat it as one.
- `modelProvider/capabilities/read` reports `webSearch: true`. Codex can reach the web on its own, which is why keeping research on Opus is a prompt-level instruction to the caller and not something the transport enforces.
- Per-model `supportedReasoningEfforts` and `defaultReasoningEffort` both live in `model/list`, which is what makes the strongest-tier rule readable at runtime.
- Implement every App Server server-initiated JSON-RPC request explicitly and fail closed:
  - Decline/cancel command, file-change, user-input, elicitation, and app/tool approval requests.
  - Grant no additional permission roots.
  - Return a bounded protocol error for unknown request methods instead of ignoring them.
- Filter output at ingress. Keep the last completed agent message for the active turn in volatile memory regardless of phase, but persist only bounded completed `commentary` activities and the terminal answer or a controlled, sanitized failure summary derived from documented error fields. Never stringify a raw App Server event, command, tool call, or approval payload into an error.
- Treat `item/completed` as the completed-message signal and `turn/completed` as the authoritative terminal signal. For a successful turn, prefer the last completed `final_answer`; if phase is absent, fall back to the last completed agent message for that exact turn.
- If the terminal event arrives before its final item, hold it pending while draining already-correlated items and perform a bounded scheduler-driven thread/read reconciliation. Persist/acknowledge the terminal only after that barrier, then use the exact-turn fallback if no phased final exists. Never borrow a message from another thread/turn/item; failed and interrupted turns receive no invented final response.
- Unsubscribe an idle thread only after its terminal state has been durably acknowledged. Resume/read it before a later follow-up.

## Phase 6 - Relay, reduce, acknowledge, and reconcile ✅

Shipped: `codexDaemonService.ts` (the daemon half: commands in, receipts and events out, per-agent
serialization, ack-gated outbox, reconnect replay), `codexRelay.ts` (the gateway half: per-agent
critical section, cumulative per-generation acknowledgement, gateway-enumerated reconciliation), and
the event/terminal/interrupt/rejection/reconciliation reducers on `CodexAgentService`. Wire additions:
`codex_ack` and `codex_hello`. Verified live against a real App Server for start, terminal,
reconciliation, steer-to-new-turn and interrupt.

Deferred to crust, both from the architecture pass and both deliberately NOT taken before Phase 7:

- **`Observation<T>` as a shared primitive**, with a fold that makes routing "could not find out" into
  a definite branch a compile error. The rule is applied at all three sites already; what is missing
  is enforcement. Worth doing once Phase 7's three further readers of the same fact exist.
- **`codexAckAuthority.ts`** as the sole owner of "may the daemon retire this". The verdict is still
  re-derived at each return site; the `unresolved` flag narrowed it but did not centralize it. Large,
  and it collides with the reducer work below, so it wants its own lap.
- **A transition reducer for the persisted agent.** Ten functions now share one shape (read record,
  build candidate, `CodexPersistedAgentSchema.parse`, catch the throw and reinterpret it as a domain
  outcome). Three of them do not catch it at all, so a reducer bug and a legitimate race are
  indistinguishable in the other seven.

### Original spec

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

### Bug Classes

**"Cannot say" collapsed into a definite answer.** Patched THREE times in one lap, in three different
readers of external state, which makes it a design defect rather than three mistakes:

- `isReliable` read "carries a generation" as "is reliable". An activity event carries one because a
  fence ORDERS it, not because losing it matters, so commentary was retained in the durable outbox
  and replayed forever.
- `outcomeFromRead` returned `TerminalOutcome | null`, folding "settled", "still running" and "could
  not read" into one absent value. The caller read absence as failure, so reconciliation reported a
  completed turn as failed and a live turn as dead. Repaired with a three-way `ReadOutcome`.
- `runningTurn` then repeated it exactly, folding "no turn" and "could not ask" into `undefined`. The
  steer fallback read that as "the turn ended" and would start a second concurrent turn, with write
  and network access, on a thread still working. Repaired with the same three-way shape.

The rule this yields: **a reader of external state returns what it KNOWS, and "I could not find out"
is one of the things it can know.** Any two-valued return from an I/O boundary is the defect forming.

**Acknowledgement safety decided per return site.** An ack retires the daemon's only copy, so every
refusal path has to answer "may this be retired?" — and each one answered independently. The accepted
receipt acked an unpersisted commit; a foreign fence acked a receipt from a live newer child; the
deferred-queue eviction released a receipt's hold without ever reading it. Repaired by making
`unresolved` an explicit property of the result rather than a judgement each caller re-derives, and
by making a completed reconciliation the single thing that supersedes an agent's undecided frames.

**Also worth keeping:** `thread/read` returns `turns: []` unless `includeTurns: true` is passed. It
answers successfully either way, so every reconciliation read parsed cleanly and found nothing. Found
only by running it against a real App Server; no test or type could have caught it.

## Phase 7 - Expose session-scoped Claude tools ✅

Shipped: `codexRoute.ts` (one authenticated discriminated route behind all five tools) and
`mcp/codex/codexTools.ts`. Released, reloaded, and dogfooded - the tools audited themselves, and the
`switchboard:codex` agent drives them.

Deviations from the spec text below, each deliberate:

- **The wait budget is ~240s, not nine minutes.** Node's fetch abandons a silent connection at 300s
  (measured: `UND_ERR_HEADERS_TIMEOUT` at 301s), so a longer hold could never deliver its answer.
  A turn outliving the budget keeps running and `codexAwaitAgent` collects it.
- **A refused REQUEST answers HTTP 400 with `CodexRequestErrorSchema`, carrying no `agentId`.** The
  spec asks every result to return its agent id, but an agent RESULT may only carry an error when the
  agent is genuinely unwell, so routing refusals through it produced three separate 500s.
- **`awaitResponse: false` reports `accepted`**, not `waitTimedOut`. Nothing timed out.
- **Reconciliation on await fires only for a record with no active turn.** Asking about a live turn
  makes the daemon answer `recovering` when it cannot confirm that exact turn, which settled the wait
  and reported running work as unconfirmed.

### Bug Classes

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
- Write the start tool's description to this text. It is the whole safety story, since Switchboard enforces nothing and the thread holds write and network access for its life whatever the prompt says.

```
Start a Codex agent: a second-model-family thread this session owns, for a
self-contained sub-task.

State its guardrails in the prompt. Switchboard sets none for you, and the
thread holds workspace-write and network access for its whole life whatever
you write, so the prompt is the only boundary that exists. Say plainly:
  - whether it may write at all, and if so which paths
  - whether it may reach the network
  - what done looks like

Codex is strong and it is literal. Given a goal and no edges, it will reach
that goal by whatever route works, including routes you would not have picked.
A narrow explicit scope gets excellent work out of it. An open brief gets
surprises. Code edits are fine when the scope is narrow and you can state it.

Reuse an agent rather than starting one per attempt. A thread that already
holds its own last three failures fixes the fourth; a fresh one relearns the
problem every time. Follow up with codexMessageAgent.

awaitResponse (default true) waits up to nine minutes. Pass false to return on
durable acceptance and collect later with codexAwaitAgent.

The agent belongs to this session, not to its caller. If the caller dies,
codexListAgents still returns it with its full history.
```
- Pass Claude's prompt through without Switchboard-injected red-team/read-only prose and without Switchboard-authored workflow status/final tools.
- First real use is this phase's own red-team audit, run on Codex. That needs the tools callable, which needs a release and a plugin reload, which needs a commit, so this lap commits and releases BEFORE its red-team step rather than after. Run the Claude-driven audit first as usual, then re-run it on Codex once released, and treat the second pass as the dogfood: a tool set that cannot audit itself is not ready to be trusted with anything else.

### Bug Classes

**A fix moves a decision; the readers of that decision do not move with it.** Now SIX rounds, and it
has stopped being bad luck. This lap alone:

- Splitting request refusals into a typed 400 left `routerPost` still reading `error` as a string, so
  every structured refusal reached a caller as the literal text `[object Object]`.
- Three separate repairs, each correct alone, combined so that `codexAwaitAgent` broke the turn it was
  asked about: await reconciles, reconciliation writes `recovering` when it cannot confirm that exact
  turn, the waiter settles on `recovering`, and the reporter treats `recovering` as unconfirmed. The
  service's own comment calls `recovering` transient; the waiter treated it as terminal.

The cheapest guard found so far remains one accessor owning a fact. The unguarded shape is a VALUE
whose meaning is agreed by convention across modules - `recovering`, an `error` field that is
sometimes a string and sometimes an object - rather than by a function both sides call.

**Deferred redesign, ranked and left undone deliberately.** The architecture pass named one target
above the two already recorded in Phase 6's crust: `CodexAgentState`'s five members are read by
roughly fifteen inline predicates across three modules, forming at least six groupings that are named
nowhere. The shipped `recovering` defect was two of those groupings colliding - the relay reads it as
"still working, go ask", the route as "stop waiting, report unconfirmed" - and a third pair
(`refuseDelivery`'s start-to-unavailable / message-to-recovering rule, rewritten independently in
three places) is the same collision waiting to happen.

The fix has a precedent in this repo rather than needing invention: `gateway/sessionAuthority.ts`
plus its residue test solve exactly this for credentials, and say so in the test's own words. One
owner module exporting a named question per grouping, plus a residue test that fails the build if a
state literal appears outside it, converts the plan's discipline ("enumerate that decision's
readers") into a compile-time fact. It is medium-sized, touches the surface that has broken on every
repair, and wants to land alone with no behaviour change in the same commit - which is why it is
recorded here rather than done in a lap that is also shipping features.

**A refusal's reason is worth more than its existence.** `receipt.error` was stored nowhere and the
caller was told "delivery was not confirmed within the wait budget" instead, which was both useless
and false. It defeated the entire safety story of the model input, whose value is that a bad model is
refused rather than swapped - information that only exists in the reason.

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

### Known gaps, left open deliberately

A coverage pass mapped Phase 8's checklist to named tests: 41 requirements are covered, and these are
not. Recorded rather than rushed, because each wants more care than the end of a lap affords.

- **`CodexTurnTracker.settlePending` is never called in production, and that is a HANG.** It exists,
  it is exported, and only its own unit test invokes it. So a turn whose `turn/completed` arrives
  with `status: "completed"` but whose final-answer item never arrives is held forever: the tracker
  waits for an item that is not coming, no terminal is emitted, and the record stays `working`.
  `codexAwaitAgent` cannot rescue it, because Phase 7 deliberately skips reconciliation for a record
  with an active turn. The caller's only escape is guessing to call `codexStopAgent`. The fix is a
  bounded timer in the daemon that settles a held terminal with whatever it actually holds, which is
  exactly what `settlePending` was written for and what Phase 5's spec called a "bounded
  scheduler-driven reconciliation". It needs an injectable clock to stay testable.
- ~~**Nothing exercises `mcp/codex/codexTools.ts` end to end.**~~ CLOSED. The body-building split off
  into an exported `codexRequestBody`, checked against the gateway's OWN request schema rather than
  against a hand-written expectation, and `routerPost` driven against a real `node:http` socket so a
  structured refusal is proven to render its message. What remains uncovered is the registration
  itself: `registerTool`'s wiring of an MCP input schema to a handler, which needs an MCP client and
  is the next layer down again.
- **No large-history test.** Exchanges, operations and turns are uncapped and unpaginated by design.
  Nothing builds an agent with hundreds of entries and checks that persistence, restore and the list
  projection still behave. A cost that only appears at scale would land on a long-lived session,
  which is exactly the session that most needs its history.
- **The conditional registration line is untested.** `if (hasCapability(...)) registerCodexTools(...)`
  in `mcp/index.ts` is one line whose inversion would either expose the tools to every session or
  hide them from every session, and no test would go red.
- **`initialize` incompatibility is untested.** Phase 5 found the handshake advertises no version, so
  there is nothing to check compatibility against; a future App Server that rejects or reshapes it
  would surface as an opaque unavailable target rather than a clear signal.

## Painpoints

- `src/shared/codex-thinking.ts` intentionally exposes one compatibility import today, but its public, persistence, daemon, and App Server boundaries now occupy one high-conflict module. Preserve the barrel import and split the implementation by trust boundary when later phases add their consumers.
- `src/gateway/codexAgentService.ts:CodexAgentService` is the correct single transition owner, but its begin and acceptance branches already hand-build state changes. Introduce the planned pure per-agent reducer before Phase 6 adds terminal, reconciliation, interrupt, and activity transitions.
- The Codex contract and persistence tests have strong mutation coverage but now repeat several valid histories, receipts, and restored-service setups. Introduce canonical creating, working, settled, and receipt builders before the Phase 6 race matrix multiplies them further.
- The assembled Switchboard MCP server instructions ALREADY arrive truncated in a live session, which is a shipped defect rather than a Codex concern. The block assembles to 2979 characters and approximately 2048 arrive, cutting the last 931: the tail of the `references` guidance plus all ten of its worked `ref://` examples have never reached any session. That the delivered length lands on 2048 exactly points at a fixed harness limit rather than a token budget, so prompt caching buys no room. Phase 3's names-only block is the repair, and it should be confirmed by reading a live session's own instructions rather than by arithmetic.
- The same `ref://` prose is duplicated into the `channel_reply` and `notify_human` tool descriptions, and both are truncated at their own limit too. Moving guidance behind `switchboard_capabilities` is the same repair for all three surfaces, but those descriptions sit outside Phase 3 as scoped.
- **A session cannot see its own instructions, and will confidently tell you it can.** Asking one what its system prompt says returns the copy the transcript started with, so a resumed session reports pre-deploy text as current with no way to notice. This cost several rounds of wrong conclusions in both directions before the answer turned out to be spawning `dist/main-mcp.js` and reading the `instructions` field from its `initialize` reply. Any future "what does an agent actually see" question wants that probe, not an agent's self-report.
- **The harness length cap is unobservable from the code.** Nothing errors, nothing logs, and no unit test can reach it, because the limit lives in the client rather than in anything this repo runs. That is exactly why 931 characters went missing for however long. The `capabilityInstructions` length test is a proxy at best. The real check is the probe above, and it belongs in the release ritual rather than in CI.
- **Nothing states that this repo's components update on separate triggers.** CLAUDE.md documents each deploy path on its own, so the reader learns them one at a time and never learns the consequence: the plugin updates on a marketplace pull, the gateway only on a manual `./down.sh && ./start-gateway.sh`, the daemon separately again, and the console whenever the owner opens it. Any shared shape therefore meets an older peer on both sides. This is worth a short Deploying subsection of its own, since it caused a high-severity outage this lap and would have caused the same one for anyone touching a wire type next.
- **My own fixtures have now hidden two real breaks.** The Phase 4 launcher's target id and a Phase 5 item id both used shapes the real system never produces, and both suites passed against code that could not work. A fixture is the one place nothing else checks your assumptions, so anything it invents is invisible until production. Fixtures for wire shapes want to come from the schema or a recorded response, not from a helper's imagination.
- Every one of the four fix rounds so far introduced at least one new defect in the code it repaired, and the red-team pass on the repair is what caught them each time. That is not bad luck at this point, it is the shape of the work: a fix moves a decision, and the other readers of that decision do not move with it. The cheapest guard found so far is making one accessor the sole reader of a fact, which is what `answerOf` and `parseCodexTargetId` now are.
- **A test fixture inventing its own shape is worse than no test.** The Phase 4 launcher read `targetId` as a bare slug while the rest of the repo writes `container:<project>`, and the new suite's own fixture used the bare form, so 25 tests passed against code that would have rejected every real target. The existing convention lived only in older test files, never in a parser. Any field whose shape is agreed by convention rather than by a function is one fixture away from this.
- `OpaqueIdSchema` is used for ids with real internal structure. `CodexResolvedTarget.targetId` carries a grammar, but its schema says only "a string up to 512 chars", so neither zod nor tsc could catch the mismatch above. Where an id has a grammar, the schema should carry it.
- `capabilityInstructions` output lands on THREE length-capped surfaces (the server instructions, plus the `channel_reply` and `notify_human` descriptions) and nothing at its definition says so. Both extra call sites had to be found by grep. A function whose return value is appended to capped surfaces should name them where it is defined.
- **Six repair rounds, six new defects.** The earlier entry counted four; it is six now, and the shape has stopped varying. A repair moves one decision, and the readers that were reading the OLD decision keep reading it. This lap: narrowing `hasPendingPrompt` stranded the very operations the narrowing was meant to free; making `requestReconciliation` return a boolean turned "I could not send" into "this frame does not matter"; and then holding a frame independently of dispatch stalled a whole stream, because the thing that RELEASES a hold still read `agentState`. Every one was caught by the red team on the repair, never by the repair's author. Treat "I just moved a decision" as the trigger to enumerate that decision's readers, not as the end of the work.
- **Two facts that can disagree, will.** Every stall this lap came from state kept in two places: the hold (`undecided`) and the memory of having asked (`reconciling`); the ack watermark (`committedThrough`) and whether the ack actually left the socket. Each fix made one derive from the other. Where that is not possible, the pair wants a single writer.
- **The App Server can generate its own protocol schema, and nothing said so.** `codex app-server generate-json-schema --experimental --out DIR` emits the whole thing, including that `thread/read` needs `includeTurns: true` and returns empty turn history otherwise. Phase 1 built its projections by hand-probing a live server and guessed that one wrong; the guess survived Phases 1 through 5 because the wrong answer parses cleanly. Reach for the generator before writing a projection against this API.
- **`git stash` round-trips corrupted two source files**, inserting stray null bytes that tsc, biome and vitest all accepted in silence. Only `file` reporting `data` instead of `JavaScript source` gave it away. If a stash is used to check that a new test really discriminates, verify the files afterward.
- **A Codex fan-out shares one account budget; local subagents do not.** Five threads opened at once all died at their REPORTING step on a shared usage limit, so five partial runs cost what five whole ones would and returned nothing citable. Two at a time, or one deep thread with follow-ups, degrades gracefully instead. Parallelism is free for local agents and is emphatically not free here.
- **A Codex thread streams confident commentary long before it can cite anything.** Its early lines carry no file references, because citations arrive in the final report. A run killed mid-turn therefore leaves only the confident half, which is the least trustworthy half. Commentary is a pointer to where to look, never a finding.
- **The result envelope's rules live in one ~200-line `superRefine` and are discoverable only by failing.** Every combination the route can build must be checked against it by hand, and FOUR separate 500s shipped because a construction site was written without re-reading it. A builder per observation - one function per legal shape, returning an already-valid envelope - would make the illegal combinations unwritable rather than merely rejected at runtime. That is the same shape as the deferred state-predicate owner and probably wants doing in the same lap.
- **`CODEX_THINKING_MODEL` was documented in CLAUDE.md, read by the daemon, and forwarded by nothing.** Setting it did exactly nothing, silently. A config value three layers must agree on wants a startup log line naming what it actually resolved to; the alternative is discovering it by experiment, which is how this one surfaced. It has since been deleted in favour of a tool parameter, which is the better answer anyway: a per-thread choice never belonged in machine-wide config.
- **A daemon-only change still costs a full gateway image rebuild.** `./down.sh && ./start-gateway.sh` ran over five minutes on one lap, and several laps changed only daemon source. A daemon-only restart path would have paid for itself repeatedly during this plan.
