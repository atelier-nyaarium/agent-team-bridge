# Named / dynamic loose sessions + terminal for all

Vision (human, 2026-06-27): once the host daemon is in perfect order it becomes the capture
poller and reports ALL sessions - host-loose and the loose sessions of devcontainers. Mirror
how the host's fixed `claude` session was eliminated in favour of dynamic loose peers: the
devcontainer also demotes its fixed session to loose sessions. UX changes - tapping an
"available" devcontainer no longer jumps to chat; it shows a "session name" dialog, then wakes
and spawns a tmux of that name, restoring the Claude session if it exists.

## Per-phase execution loop (DURABLE - survives compaction, human-mandated 2026-06-27)

Work ONE phase at a time. For each phase, run this loop:
1. **Refinement cycles** (`cycleStartPlan` cycle=`plan-refinement`: propose -> audit-fan-out -> audit-rethink).
2. **`/questionaire`** if the refinement surfaces phase-specific forks needing the human.
3. **Implementation cycles** (`cycleStartPlan` cycle=`audited-implementation`).
4. **Phase done -> on the NEXT loop, REASSESS the remaining phases** against what changed before starting them.

Standing pre-authorization: launch Workflow audits at any point I decide. Commit direct to main (workflow preference). Currently executing: **P1**.

---

Phased delivery (each phase gets its own `/questionaire` + Workflows fan-out, verified one at a time):
- **P0** - map the substrate (no code). <- current
- **P1** - enumerate all sessions (host daemon as capture poller, read-only listing).
- **P2** - de-hardcode the session name (thread a name through peek/tmux_send/reload/create_session + both gates).
- **P3** - demote the devcontainer fixed session to loose (mirror the host precedent).
- **P4** - the new wake UX (tap available -> session-name dialog -> wake + spawn named tmux -> restore if exists).
- **P5** - surface host-loose sessions in the app.

## Questionaire

### P0 - map the substrate (findings)

Six-reader Workflows fan-out (`wf_4551a0b8-51f`). Key substrate facts:

**Identity today (the central knot):**
- `isDevcontainer(name) = offlineCatalog.has(name) || knownTeamPaths.has(name)` (`routes.ts:424`). `offlineCatalog` is ephemeral (host catalog scan; cleared on host disconnect, `websocket.ts:334`); `knownTeamPaths` is durable (set on register with `projectPath`, never cleared).
- kind = `isConsole ? console : isDevcontainer ? devcontainer : loose` (`routes.ts:456`). A loose name is just anything not in those sets.
- A devcontainer agent uses `PROJECT_NAME` env as its team name directly. A loose agent derives `stableTeamName(CLAUDE_CODE_SESSION_ID)` (6-char hex, stable across resume) or random (`mcp/index.ts:35`, `team-name.ts`).
- Container name = `${team}_devcontainer-dev-1` (compose convention, `tmuxCore.ts:9`). ONE container per project name; ONE agent pane `.0` per session.
- `TeamRegistry = Map<team, Map<subId, ws>>` - a team CAN have multiple subs, but a send **broadcasts to ALL subs** (`routes.ts:684`). So multiple chats under one team name is not viable without changing send routing.

**The `"claude"` hardcode:** `consoleHandler.ts:233` default (peek/tmux_send/reload), `hostDaemon.ts:208/224/242/257` (has-session/new-session/capture/auto-accept), `reloadPlugins.ts:30`. Only `create_session` already passes an arbitrary `sessionName`. `TmuxTarget = {kind, name, sessionName}` already carries a session name on the wire; the schemas for peek/tmux_send/reload just don't expose it.

**Wake today:** host daemon, on a wake for `team`, ensures the container is up then creates the fixed `claude` tmux running the daemon-owned `cd /workspace/<project> && claude <fixed flags>`; readiness = screen-scrape `"Claude Code v"`; sends `wake_result`. Wake is keyed by team name = project name.

**Host-loose precedent:** host runs no fixed claude. `start-session.sh` spawns a tmux running `claude --name <name>` with NO `PROJECT_NAME`; the MCP self-registers as a loose peer via `connectToRouter`. The daemon does NOT wake host loose agents - they connect when a human/script launches them. KEY DIFFERENCE for containers: a container must be woken (started) before anything can run in it, so the daemon needs to know which container a session belongs to in order to re-wake it.

**Restore:** no resume logic today; wake only `has-session -t claude` then creates if absent. "Restore if exists" (reattach live tmux vs `claude --resume`) is unbuilt.

#### Structural answers

**Q1 - addressable identity of a spawned session: A) composite `project/session`.**
The container tile stays a non-chat spawn point; each spawned session is a loose card addressed `project/sessionname`. The address self-describes its container, so re-wake and federation re-reach need no separate durable mapping. (Chosen over a flat-name + side-map, and over container-stays-the-team sub-sessions which would break the broadcast-to-all-subs send model.)
- Wire note to resolve in P2: `gateway/name` already uses `/` as the qualifier separator, so `gateway/project/session` has two segments after the gateway. Either `parseQualifiedTeam` must handle a multi-segment local name, or the intra-name separator is something other than `/` (e.g. `project:session`). Implementation detail, flagged.

**Q2 - session lifecycle across container sleep: A) durable + resumable, UNTIL the chat is "Forget"-ed.**
A spawned `project/session` is remembered after the container sleeps (shows "available", like a devcontainer does today); tapping it wakes the container and restores (reattach if tmux alive, else `claude --resume` the mapped session id, else fresh). The durable record (incl. the `name -> claudeSessionId` mapping) is the lifetime of the chat: pressing **Forget** on the chat is what drops the record (and should tear down / stop listing that session). So "Forget" becomes the single delete verb for a named session.

**Q3 - source of truth for the session list: A) self-registration is truth.**
Each spawned `project/session` runs the switchboard MCP and self-registers like a host-loose peer (online); durable records (until Forget) supply the asleep "available" ones. No continuous background poller. Implied mechanism (decided by A): the spawned claude launches WITH the MCP plugin and its identity pinned to `project/session` (via env, the way `PROJECT_NAME` pins a devcontainer today) - NOT the `stableTeamName(sessionId)` hash - so it registers under the user-given name.
- **Polling constraint (human):** the terminal capture poll (peek) runs ONLY while the user is sitting on the App's Terminal view (as peek already does while RESUMED today). No violent/continuous polling. On-demand enumeration of a container's live tmux (`tmux ls`) is a one-shot when you open its spawn point, not a loop.
- Agent-less bare tmux sessions are NOT surfaced (the case that would have justified B/C). Only registered agent sessions + durable records appear.

**Q4 - board layout / spawn UX: A) container = collapsible group header that is the spawn point.**
Each devcontainer project renders as a group header; its `project/session` chats nest under it. Tap the header -> session-name dialog (spawn new). Tap a child -> open that chat. Host-loose chats keep their own flat group. Reuses the existing devcontainer-vs-loose grouping. The name dialog is for NEW sessions only (existing ones are tappable children); typing an existing name just opens that session rather than erroring.

### New capability the model unlocks: crosstalk session targeting + multi-party (human-stated)

`crosstalk_send` (agent -> agent) must also carry a session dimension now. The calling agent decides a session id against the target devcontainer:
- **MISS** (session id not known) -> create a new `project/session` (wake container + launch).
- **HIT** (session id exists) -> resume/route into that existing chat.

The unlocked dynamic: an agent can be told to talk to "**this chat here**" - i.e. crosstalk into the session id of the chat the human is currently in - so a second Claude joins the human + first Claude in ONE thread to brainstorm. This is the agent-facing twin of the console's create_session/resume, plus a multi-party conversation model. Scope + model resolved in Q5.

**Q5 - multi-party thread model: B) star / relay (matches the current crosstalk model).**
No conversation-core change. Each session stays its own 1:1 thread. The ONLY addition is making crosstalk **session-addressable**: an agent delivers a message into a specific `project/session` (a HIT routes into that existing thread; a MISS creates the session), and the human's current session is itself a valid target so an agent can "message here." The recipient reads it as an incoming channel message in its own thread and it's up to it to crosstalk back; the reply lands in the sender's own chat (exactly today's `crosstalk_send` -> `<channel>` -> `channel_reply` flow, just at session granularity). Human's words: "I'm talking here. Other agent messages here. It's up to you to crosstalk respond to them. their own chat shall handle your response."
- **Scope consequence:** because B needs no multi-writer thread primitive, the multi-party work folds into a single phase (crosstalk session-addressing), not two. No separate "thread core" phase.

**Q6 - restore behavior on reopen: A) best-effort, with a status chip.**
Reopen unifies into one `openSession(project/session)` op (wake container if needed, then reattach -> `claude --resume <id>` -> fresh, in that order). It always lands you somewhere and shows a chip ("resumed" vs "started fresh") so continuity is never silently misrepresented. Needs the durable `project/session -> claudeSessionId` map, captured at spawn when the in-container MCP reports its CLAUDE_CODE_SESSION_ID on register. (Chosen over confirm-before-fresh and resume-only-error.)

**Q7 - host machine scope: A) host is a spawn point too (full symmetry).**
A "host" group header (the bare `host` slot stays the daemon's); tapping it spawns a `host/sessionname` loose session - the daemon launches `claude` in a new host tmux (the start-session.sh logic, daemon-driven). Host and devcontainers behave identically: spawn, list, chat, terminal, resume. Human accepted the tradeoff over the recommended view-only B.
- **Security note (carry into build):** a `host/*` session runs with full host access, no container sandbox, and is now spawnable by a phone tap. This widens the phone's blast radius and intersects the parked `gateway-auth-surface.md` work. The owner-auth on console ops is the gate; host-spawn must not be reachable by an unauthenticated/cross-Domain path. Flag for the security review before this ships.

## Plan (rough - to be refined per phase)

Locked design (Q1-Q7): sessions are durable, resumable `project/session` (and `host/session`) loose peers, addressed by composite name; the container/host tile is a non-chat spawn point; lifecycle ends at Forget; the list is driven by self-registration (+ durable records for asleep ones), terminal capture polls only while the Terminal view is open; reopen is a unified best-effort `openSession` (reattach -> resume -> fresh, with a chip); crosstalk becomes session-addressable (star/relay, no thread-core change) enabling "talk to this chat here."

Per the human's model, **each phase below gets its own dedicated `/questionaire` + Workflows fan-out when we start it**; this is the skeleton, not the refined per-phase design. Phases are ordered so each leaves the system working and is independently verifiable.

- **P1 - Composite addressing + de-hardcode the session name.** Teach `TeamAddress` / `parseQualifiedTeam` the `project/session` local name (resolve the `/`-vs-separator collision); thread `sessionName` through `peek` / `tmux_send` / `reload_plugins` (console schema + `resolveTmuxTarget` + host-op), retiring the `"claude"` default in `consoleHandler.ts` and `reloadPlugins.ts`. Pin a spawned session's MCP identity to its given name (env, like `PROJECT_NAME`) instead of `stableTeamName(sessionId)`; have the MCP report `CLAUDE_CODE_SESSION_ID` on register. Back-compat: an unqualified devcontainer keeps working via an implicit default session. *Verify:* existing single-session devcontainers unchanged; a named op reaches a named tmux.
- **P2 - Unified `openSession` op + durable session map (daemon/gateway).** Collapse wake + create_session into one `openSession(project/session)` host-op: ensure container up, then reattach (tmux alive) -> `claude --resume <id>` -> fresh, returning `{restored|fresh}`. De-hardcode the `"claude"` session in `hostDaemon.ts` (has-session/new-session/capture/auto-accept). Persist `project/session -> claudeSessionId` in the durable store; capture the id at spawn. *Verify:* reopen across container idle reattaches; across container stop resumes; missing id -> fresh; chip data correct.
- **P3 - Registration, listing, Forget teardown (gateway).** Named sessions self-register as `project/session`; `teams()` / `discover()` report them with `kind:'loose'` (or a new session kind) under their project; durable records surface asleep sessions as `available`; the container/host becomes a non-chat **spawn-point** roster entity. Forget drops the durable record AND tears the session down (stop listing + kill). *Verify:* a spawned session lists online; after sleep lists available; Forget removes it everywhere.
- **P4 - App UX (devcontainer + host view).** Collapsible spawn-point group headers; tap header -> session-name dialog (new only; existing name opens the existing child); session children nested; `restored`/`started fresh` chip; expand terminal-eligibility from `kind=='devcontainer'` to **any local daemon-drivable session** (`project/session` + host sessions); update rename rules. *Verify:* full tap-to-spawn-to-chat-to-terminal loop on device.
- **P5 - Host spawn point (Q7=A).** Daemon-driven host `claude` launch (start-session.sh logic as a host-op) behind the `host` spawn header. Carry the security note: gate host-spawn behind owner-auth, never a cross-Domain/unauthenticated path. *Verify:* spawn a `host/*` session from the phone; confirm it is owner-gated.
- **P6 - Crosstalk session-addressing + multi-party.** `crosstalk_send` gains a session target (`project/session`); MISS -> `openSession` (create), HIT -> route into that session's thread; "this chat here" = the caller's current session id (the agent must learn its own session id); federation re-reach by composite address. Star/relay only - no thread-core change. *Verify:* one agent directs another into the human's session; 3-way relay brainstorm works; replies land in each sender's own chat.

**Cross-cutting / risks:** the `/` separator collision (P1); back-compat for today's single-`claude` devcontainers (P1-P3); host-spawn security (P5, intersects gateway-auth-surface); the existing fragile TUI readiness screen-scrape is reused by `openSession` (P2, a logged painpoint); send still broadcasts to all subs of a team (fine - each `project/session` is its own team key, so no multi-sub send needed).

---

## P1 - detailed design (refinement lap 1)

**Goal:** introduce the composite `project<SEP>session` address and make the console terminal-drive ops (peek / tmux_send / reload_plugins) session-aware *via the address*, de-hardcoding `"claude"` while preserving today's single-session devcontainers byte-for-byte. **Nothing spawns named sessions in P1** (that is P2); P1 only makes them addressable + drivable.

**Separator decision (the crux).** Grounded in code: `TeamAddress.parse` / `parseQualifiedTeam` split on the FIRST `/`, but `qualifyTeam` decides "already qualified" with `name.includes("/")`; and `SessionId.parse` is `conv:<id>:<team>` splitting on the last `:` and rejecting a conv-id containing `:`. The tmux/docker layer validates every name to the slug `^[a-z0-9][a-z0-9-]*$` (tmuxCore `TEAM_NAME_RE`, reloadPlugins `SLUG_RE`). So the session separator must be `!= "/"`, `!= ":"`, and outside `[a-z0-9-]`.
- **Proposed `SESSION_SEP = "."`** Both segments are slugs (no `.`), so a composite has exactly one `.` and splits unambiguously; it contains no `/` (qualifyTeam still prepends the gateway correctly; the first-`/` split is unaffected) and no `:` (SessionId.parse unaffected). The composite is NEVER used as a tmux name - only its `session` segment is - so the `.`-vs-pane-index (`session.0`) concern does not arise.

**Grammar (`src/shared/session-id.ts`, the grammar owner):**
- Add `SESSION_SEP = "."` + a guard/test asserting `SESSION_SEP ∉ {GATEWAY_QUALIFIER_SEP, ":"}`.
- `DEFAULT_SESSION = "claude"` (back-compat).
- `composeSessionName(project, session) -> "project.session"`; `parseSessionName(localName) -> {project, session}` where a bare name (no SEP) yields `{project: localName, session: DEFAULT_SESSION}`.
- **Cross-language surface:** update `tests/fixtures/session-id/vectors.json` AND the Kotlin twin (`android/.../proto/SessionId.kt` + the `Protocol.kt` codegen that emits the separators) so both runtimes agree. (Audit must confirm the codegen path and that the app reads the new constant rather than hand-mirroring it.)

**Console de-hardcode (`src/gateway/console/consoleHandler.ts`):**
- `resolveTmuxTarget(qualifiedTarget, explicitSession?)`: strip the gateway, then `parseSessionName(name)` -> (project, session); `explicitSession` overrides the derived session when given. Map `project==="host"` -> `{kind:"host", name:"host", sessionName}`; `isProjectName(project)` -> `{kind:"devcontainer", name:project, sessionName}`; else reject. **`name` is now the PROJECT (container), never the composite**, so `containerName()` stays correct.
- peek / tmux_send / reload_plugins: call `resolveTmuxTarget(op.target)` with no explicit session - the session rides in the address; the `"claude"` literal now lives ONLY in `parseSessionName`'s bare-name back-compat.
- create_session: keep passing `explicitSession = op.sessionName` (untouched in P1; harmonized with `openSession` in P2).
- `isProjectName` unchanged (tests the PROJECT segment against offlineCatalog/knownTeamPaths).

**reloadPlugins.ts:** leave the in-session tool's `TMUX_SESSION="claude"` (an agent driving its OWN pane, conventionally claude until identity-pinning in P3). The daemon-side `spawnReloadPlugins` already honours `target.sessionName`, so it is session-aware the moment `resolveTmuxTarget` fills it.

**Explicitly OUT of P1:** the daemon WAKE path's hardcoded claude (P2 `openSession`); MCP identity pinning + self-register as composite (P3); spawning (P2). Flagged for P3: a session reachable both as bare `project` and as `project.claude` is the same tmux pane but two distinct registry keys - P3 must canonicalize so they don't split identity.

**Verification (P1):**
- Unit: compose/parse round-trip; bare -> `claude`; `resolveTmuxTarget` maps composite -> (project, session), bare -> (project, claude), host; cross-gateway + unknown-project still reject.
- Shared session-id vectors pass in TS and Kotlin.
- Back-compat: an existing devcontainer addressed bare still drives the `claude` pane (peek/tmux_send/reload behaviour unchanged).
- Integration: a hand-created tmux session `foo` in a running devcontainer is peekable via `project.foo`.
- `bun run lint` (biome ci + tsc) and `bun run test` green.

**Possible `/questionaire` fork (only if the audit finds a concrete problem):** `SESSION_SEP` char `.` vs `~`/`+` - readability vs any place that treats `.` as special in a name. Default to `.` unless the audit surfaces a real break.

### P1 - audit refinements (lap 1)

10-auditor fan-out (`wf_dbd68e42-cea`). Most findings just confirmed the plan's own TODO list (the helpers/constants "don't exist yet" - expected). Two REAL refinements survived triage; the `.` separator is kept (audit confirmed it safe).

**R1 (real catch): project dir names are NOT slug-validated.** `scanDevcontainerProjects` (hostDaemon.ts) pushes the raw directory `entry` as the team name, so a dir like `my.app` enters the catalog. A naive split-on-first-`.` would misparse it as project=`my`, session=`app`. FIX - **catalog-first disambiguation in resolveTmuxTarget** (do NOT assume the project is a slug; do NOT filter the catalog - dotted-named devcontainers must keep working):
1. If `name === "host"` or `isProjectName(name)` -> bare: `{project: name, session: explicitSession ?? DEFAULT_SESSION}`. A full-name catalog hit wins, so a real dotted project resolves correctly.
2. Else `parseSessionName(name)` splits on the **LAST** `SESSION_SEP` (a session is a dotless slug, so last-`.` recovers it even if the project has dots) -> `(project, session)`; if `project === "host"` or `isProjectName(project)` -> `{project, session: explicitSession ?? session}`; else reject.
   - `parseSessionName` is a mechanical splitter (bare -> `{project:name, session:DEFAULT_SESSION}`, else last-sep split); the catalog precedence lives in `resolveTmuxTarget` (it owns `isProjectName`).
   - Rare residual collision (documented; enforced at spawn in P2): if both `foo` and `foo.bar` are real projects, `foo.bar` resolves AS the project, shadowing a `bar` session under `foo`. P2 rejects spawning a session name that would collide with an existing project.

**R2 (phase boundary): P1 is SERVER-SIDE ONLY; the cross-language surface moves to P4.** In P1 the app still emits only BARE targets (it learns composites in the P4 UX), so no composite crosses from Android. Therefore the Kotlin twin (`android/.../proto/SessionId.kt` parseSessionName/composeSessionName), the shared FUNCTION vectors in `tests/fixtures/session-id/vectors.json`, and `SessionIdVectorsTest.kt` move to **P4**. P1 keeps the grammar + logic in TS only. The `SESSION_SEP`/`DEFAULT_SESSION` *constants* go in session-id.ts now; mirror them into `scripts/codegen-kotlin.ts` + Protocol.kt ONLY if a codegen-drift CI check requires it (trivial one-liner), else defer to P4 with the functions.

**Confirmed clean by audit:** `.`-as-hazard (no durable-store / path / object-key / Android-storage breakage); federation cross-gateway round-trip (a dotted local name survives qualification + sealing); TmuxTarget dedup key stays unique (`devcontainer:proj:claude` vs `devcontainer:proj:foo`); every `TmuxTarget.name`/`.sessionName` consumer works with project-as-name; existing console-handler/tmux-core tests stay green given `parseSessionName("project") == {project:"project", session:"claude"}`.

**Final P1 file list (server-only):**
- `src/shared/session-id.ts` - add `SESSION_SEP="."`, `DEFAULT_SESSION="claude"`, `parseSessionName`, `composeSessionName`, + the `SESSION_SEP ∉ {"/",":"}` guard.
- `src/shared/console-protocol.ts` - re-export the four new symbols (consoleHandler imports the addressing layer from here).
- `src/gateway/console/consoleHandler.ts` - refactor `resolveTmuxTarget` (catalog-first disambiguation + optional `explicitSession`); peek/tmux_send/reload call sites unchanged (now session-aware via the address); create_session keeps `explicitSession = op.sessionName`.
- `src/__tests__/session-id.test.ts` - compose/parse round-trip, bare->claude, last-sep split, dotted-project, the guard.
- `src/__tests__/console-handler.test.ts` - resolveTmuxTarget cases: bare, composite, dotted-project-via-catalog, host, `host.session`, cross-gateway reject, unknown reject; back-compat unchanged.
- NOT in P1: `android/*`, `scripts/codegen-kotlin.ts` (unless CI drift), shared function-vectors.

**Status:** P1 design hardened. No `/questionaire` fork needed (the `.` separator concern is resolved by catalog-first disambiguation, not by changing the char). Ready for the implementation cycle.

### P1 - implementation audits (audited-implementation lap 1)

Implemented server-side per the spec. Files touched: `session-id.ts` (SESSION_SEP/DEFAULT_SESSION/parseSessionName/composeSessionName), `console-protocol.ts` (re-export), `consoleHandler.ts` (resolveTmuxTarget catalog-first + boundary validation), `host-op.ts` (shared `isTmuxName`), `hostOpRunner.ts` (lastCapture eviction), + tests. `bun run lint` and `bun run test` (713) green.

- **Coding-guideline audit (2 Sonnet):** trimmed two over-long constant comments; replaced a state-assertion test (`SESSION_SEP !== "/"`) with two behavioral round-trip tests (composite survives gateway-qualification and the `conv:` grammar - which implicitly require the separators distinct).
- **Alignment audit (5 agents):** fully aligned, zero misalignments.
- **Red-team (5 agents):** injection confirmed SAFE (assertSlug/assertName gate the now-user-controlled session before any shell/argv sink). Two real fixes applied:
  - **Boundary validation:** a malformed session (trailing-dot -> empty, bad chars, oversized) now rejects cleanly at `resolveTmuxTarget` via shared `isTmuxName` (slug + 64-char cap), instead of a cryptic late host-side failure. Also rejects a dot in a `create_session` session name (a dot would break the composite round-trip). 5 new rejection tests.
  - **lastCapture eviction:** the peek cadence map (keyed by the now-user-varying `session`) gained TTL eviction (mirrors the proven sentCache cleanup), so it cannot grow unbounded.
  - **Triaged OUT (not a P1 issue):** the "cross-tenant project access" finding is pre-existing and does not match the architecture - a gateway serves ONE Domain, and P1 does not widen WHICH projects are reachable (still the global catalog, already true pre-P1), only adds session granularity within an already-reachable project. Per-console scoping within a Domain, if ever wanted, belongs with `gateway-auth-surface.md`, not P1.
