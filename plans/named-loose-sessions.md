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

Standing pre-authorization: launch Workflow audits at any point I decide. Commit direct to main (workflow preference).

**Loop status:** P0 done (substrate mapped). **P1 DONE + sealed** (composite addressing + de-hardcode, `3bd8d88`/`ca69866`/`ed88e37`). **P2 DONE + sealed** (hasSession/ensureSession reattach + create_session routing + buildLaunchCommand unify + wake dead-launch detection, `e262d6e`/`bb18599`/`828bf12`; CI green, 719 tests). **P3 next** - start with its plan-refinement cycle.

**Reassessment for P3 (after P2):** P3 now carries everything P2 deferred PLUS its original scope: composite-name self-registration (pin the MCP identity to `project.session` via env), which makes a woken named session register under its composite name (unblocking the composite WAKE de-hardcode in `doWakeTeam`/`handleWake`); the durable `project.session -> claudeSessionId` map + its population (register reports `CLAUDE_CODE_SESSION_ID`) + `--resume` activation in `openSession`/`handleWake`; and demoting the devcontainer fixed session to loose. The **DATA_DIR fork** surfaces here (the map's home - same `/app/log` dir vs a new `DATA_DIR` that fixes the federation-keys-under-the-log-dir landmine) - a likely `/questionaire` for the human. P2 left `tmuxCore.ensureSession` + the wake exec path ready to extend.

**Resume mechanics (empirically tested on host, claude 2.1.195, 2026-06-27):**
- `claude --resume <id>` from the matching cwd lands DIRECTLY at the REPL with full context - trivially easy. The id is the `.jsonl` filename uuid. Use it WITHOUT `--fork-session` (continue in place; fork branches a new id).
- **Resumability = file existence:** `~/.claude/projects/<cwd-dashed>/<id>.jsonl` (a devcontainer's cwd `/workspace/<project>` -> dir `-workspace-<project>`). No claude invocation needed to check.
- **NO compact prompt on resume** - tested 69.8MB AND 166MB, both loaded straight to the REPL, zero interactive prompts. So the launch needs NO new prompt-handling for resume (the worry about a "been going a bit, compact?" gate does not occur in 2.1.195).
- **ONE readiness tweak P3 needs:** a resumed session does NOT show the `"Claude Code v"` header in the visible pane (it jumps into the restored conversation); the pane shows the conversation + the idle `❯` prompt + `"? for shortcuts"`. So the readiness/idle marker must also accept the resumed-REPL shape, not only `"Claude Code v"`. P2's `captureOk` dead-launch signal still works.
- **Exec swap (from the earlier live test):** migrate handleWake's tmux ops to `tmuxCore` (docker exec) here; keep `ensureContainerUpAsync` on the devcontainer CLI.

---

The authoritative phase breakdown is the **## Plan** section below (P1-P6), refined after P0. The pre-refinement P0-P5 sketch was superseded once Q5 (crosstalk) folded multi-party into one phase and the separator resolved to `.`.

**Reassessment for P2 (after P1):** P1 already shipped the `project.session` grammar, the de-hardcode of the read ops (peek/tmux_send/reload), boundary validation, and the shared `assertTmuxName`. So P2 narrows to: the unified `openSession` op (wake + reattach/resume/fresh), the durable `project.session -> claudeSessionId` map, and de-hardcoding the **wake path** in `hostDaemon.ts` (still `claude`-only). The separator is settled (`.`), so no separator re-litigation. Pin a spawned session's MCP identity to its composite name (env) is P3.

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
- Wire note (RESOLVED in P1): the intra-name separator is **`.`** (`SESSION_SEP`), not `/`. A composite local name is `project.session`; the gateway qualifier stays `/` (so a full wire name is `gateway/project.session`), `:` stays the session-id separator. So the addressable identity is `project.session`, not `project/session`.

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
- **P4 - App UX (devcontainer + host view).** Collapsible spawn-point group headers; tap header -> session-name dialog (new only; existing name opens the existing child); session children nested; `restored`/`started fresh` chip; expand terminal-eligibility from `kind=='devcontainer'` to **any local daemon-drivable session** (`project/session` + host sessions); update rename rules. **"Check terminal" chip (human directive):** any unclean restore edge case (dead pane, ambiguous state, failed resume) chips the session "Check terminal"; tapping it defaults to the Terminal view. This is the catch-all fallback, so the backend does NOT need perfect restore-state classification - anything not cleanly resumed/fresh routes the user to look. *Verify:* full tap-to-spawn-to-chat-to-terminal loop on device.
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

## P2 - detailed design (refinement lap 1)

**Goal:** one daemon-side `openSession` core that ensures a NAMED tmux session exists in a (woken) container/host - reattach if alive, create if absent, detect a dead launch - and de-hardcode the wake path off `"claude"`. Both the wake trigger and the console `create_session` op delegate to it. The durable `project.session -> claudeSessionId` map + actual `--resume` activate in P3 (see boundary below).

**Reassessed P2/P3 boundary (the key reassessment).** Resume-by-id needs the map keyed by `project.session`, but a devcontainer session does not register under its composite name until **P3** (identity pinning). So in P2 the map cannot be populated and `--resume` would be inert. Therefore:
- **P2 delivers:** the unified `openSession` core (wake-if-needed + has-session **reattach** / **create fresh** + **dead-launch detection**), session-name awareness across the wake path, one shared launch-command builder, and the durable-map *structure + read path* wired but dormant.
- **P3 delivers:** composite-name self-registration (which POPULATES the map - register reports `CLAUDE_CODE_SESSION_ID`) and thereby ACTIVATES `--resume`. The P4 spawn UX rides on top.
- Net: P2's restore is **reattach-or-fresh** (the common "container idle, claude still alive" case works immediately); the `--resume`-across-stop case lights up in P3 when the map fills. The Q6 chip is `restored` (reattached) vs `fresh` now; `resumed` joins in P3.

**`openSession` core (daemon, `hostDaemon.ts` + `tmuxCore.ts`).**
- Signature: `openSession(target: TmuxTarget): Promise<{ outcome: "restored" | "fresh" | "failed"; screen: string }>` where `target.sessionName` is the session to ensure (no longer hardcoded `claude`).
- Steps: ensure container up (devcontainer) -> `tmux has-session -t <sessionName>` -> if alive, **reattach** (no relaunch; `outcome:"restored"`); else (P3) if a `claudeSessionId` is mapped, launch `claude --resume <id>` (`outcome:"resumed"`); else `tmux new-session -d -s <sessionName> <launchCommand>` (`outcome:"fresh"`) -> readiness poll.
- **Dead-launch detection (closes the open root cause):** after create, poll for the idle marker; if the tmux server/pane is gone OR no claude prompt appears within the window, return `outcome:"failed"` with the captured screen, instead of today's unconditional `success:true`. The wake-result/host-op reply carries the real outcome.
- One shared `buildLaunchCommand(target)` (already exists for create_session) replaces the duplicated inline `claudeCommand` in `handleWake`; host gets `exec bash` + effort low, devcontainer gets `cd /workspace/<project>` + effort high (unchanged behavior, single source).

**De-hardcode the wake path (`hostDaemon.ts handleWake`, gateway `doWakeTeam`).**
- `doWakeTeam(team)` parses the composite team via `parseSessionName` -> `(project, session)` and wakes THAT session (bare team -> session `claude`, back-compat). `handleWake` uses `target.sessionName` for has-session / new-session / capture / auto-accept (no literal `claude`).
- The send-to-offline-devcontainer trigger stays the wake path; it now ensures the addressed session, not a fixed one.

**Durable map (`shared/durable-store.ts` consumer in `gateway/index.ts`).**
- `new DurableStore(<dataDir>, "session-resume")` storing `project.session -> { claudeSessionId, lastSeen }`. Structure + the openSession read path land in P2; population (register reporting the id) is P3.
- **Landmine (flagged for /questionaire):** every durable store roots at `path.dirname(LOG_PATH)` = `/app/log` (federation keys, jobs, mailboxes live there too). Adding a 4th durable file deepens the "clear the logs wipes federation identity" trap. Options: (a) root the new map at the same dir for consistency (status quo, defer the rename), or (b) introduce a `DATA_DIR` independent of the debug-log filename now and move all durable stores onto it (bigger blast radius, fixes the landmine). This is a real fork for the human.

**Wire.** Keep the console `create_session` op name (console-facing, P1-stable) but route its handler through `openSession`; keep `wake_result` for the wake trigger. No new console schema in P2. `outcome` rides the host-op reply / wake_result.

**Out of P2 (explicit):** composite-name self-registration + map population + `--resume` activation (P3); the spawn-point UX + the restored/fresh chip rendering (P4); the in-session `reload_plugins` `args.team` injection (security pass); deleting the Hypothesis debug-log scaffolding that is intermixed in `handleWake` (separate cleanup - do NOT sweep it in P2, only edit the lines P2 must touch).

**Verification (P2).**
- Unit (host-op runner / a testable openSession seam): reattach when has-session succeeds (no new-session call); create when it fails; `failed` outcome when the post-create poll never sees the marker (dead-launch); session name is threaded (not `claude`).
- Wake: `doWakeTeam("proj")` -> session `claude`; `doWakeTeam("proj.foo")` -> session `foo`.
- Back-compat: an existing bare-`project` wake is byte-identical (session `claude`, same launch command).
- `bun run lint` + `bun run test` green.

**/questionaire forks (surface to the human after the audit):** (1) durable-map location - same `/app/log` dir vs a new `DATA_DIR` (landmine fix scope); (2) confirm the P2/P3 split (dormant map in P2, population in P3) vs pulling sessionId capture forward into P2; (3) dead-launch on the WAKE path - should a failed wake stop reporting `success:true` now (a behavior change to the chat wake path), or keep that for a focused fix.

### P2 - audit refinements (lap 1)

7-auditor fan-out (`wf_ed2eb74d-80e`). One BLOCKER drove a scope reassessment; it dissolves the two forks the proposal flagged.

**BLOCKER (verified): a composite wake is P3-coupled.** Wake completion gates on the woken agent REGISTERING under the team name (`wakeCoordinator.notify(team)` in `websocket.ts` on register); `wake_result success:true` is IGNORED (only `success===false` is handled). Until P3 pins a session's identity to its composite name, a woken `proj.foo` agent registers under its `stableTeamName` hash (or bare `proj`), so `wakeCoordinator` never resolves `proj.foo` -> `/send` hangs to `WAKE_TIMEOUT_MS` (600s) and the send route's `registry.get("proj.foo")` is empty ("not connected"). There is also no composite wake TRIGGER before P3 (no composite registration, no spawn UX). So de-hardcoding the wake path for composite NAMES belongs in P3, with the registration change that makes it reachable.

**Reassessed P2 scope (narrowed; standalone + testable, no P3 coupling, no open forks):**
- **`hasSession(target)` in `tmuxCore.ts`** - new primitive (parallel to peekPane/sendText), so the reattach-vs-create split is clean (today the check is inline in `handleWake`).
- **`openSession(target)` core** (daemon): ensure container up -> `hasSession` -> reattach (alive, no relaunch -> `restored`) / create (`fresh`). Drives the path that is NOT registration-gated.
- **Console `create_session` routes through `openSession`** - the standalone-testable named-session path: it is reply-by-`reqId` (host-op), not registration-gated, so creating/reattaching `proj.foo` works and is unit-testable NOW. (Console reply stays `{created:true}`; the `restored`/`fresh` outcome is not surfaced to the UI until the P4 chip.) **Reattach is the behavior change:** create_session for an existing session no longer double-launches; it reattaches.
- **`buildLaunchCommand` unification** - `handleWake`'s inline `claudeCommand` is replaced by the existing shared `buildLaunchCommand` (one source; bare `claude` behavior unchanged).
- **Dead-launch detection on the WAKE path** (closes the open root cause): `handleWake` delegates its session-ensuring to `openSession` (session stays `claude`, bare project), and the readiness poll's result maps to the EXISTING `wake_result` boolean - if the idle marker never appears, send `success:false` (not today's unconditional `true`), so `/send` fails fast instead of stalling. **No `wake_result` wire change** (keep the boolean; map `openSession`'s outcome to it internally - the auditor confirmed changing the shape breaks `websocket.ts`'s `success===false` check).
- **Timeout discipline:** the dead-launch readiness poll lives on the WAKE path only (it has the 600s budget). The console `create_session` path returns fast (create/reattach, no long poll) to stay within `HOST_OP_TIMEOUT_MS` (20s); a dead create-session pane is revealed by the terminal peek, not a blocking poll.

**Moved to P3 (with the registration change that makes them reachable):**
- De-hardcoding the wake path for COMPOSITE names (`doWakeTeam`/`handleWake` parsing `project.session`) - registration-gated.
- The durable `project.session -> claudeSessionId` map + `--resume` activation + map population. **This removes the `DATA_DIR` fork from P2** (the map, and thus the "where does it live" question, lands in P3).
- Composite-name self-registration (identity pinning).

**handleWake edits:** touch only the session-ensuring core (delegate to `openSession`) + the inline-launch dedup; LEAVE the `#region Hypothesis K/L` debug blocks (pure logging, not load-bearing) for the separate debug-scaffolding cleanup. Do not sweep them.

**Verification (P2):** `hasSession` true -> reattach (no new-session); false -> create. `openSession` via console `create_session` for `proj.foo` creates then reattaches on a retry. `handleWake` dead launch (marker never seen) -> `wake_result success:false`. Bare-project wake byte-identical (session `claude`, shared launch cmd). `bun run lint` + `bun run test` green.

**No `/questionaire` needed for P2:** the reassessment resolved both flagged forks by deferral (the `DATA_DIR` decision and the sessionId-capture/P2-P3 split both move to P3). The narrowing is a sequencing consequence of the registration-gating constraint, not a preference fork. Surfaced to the human at the refinement checkpoint.

### P2 - implementation audits (audited-implementation lap 1)

Files: `tmuxCore.ts` (`hasSession`/`ensureSession`), `hostDaemon.ts` (runner wiring -> `ensureSession`; `handleWake` uses `buildLaunchCommand` + dead-launch detection), `tmux-core.test.ts`. `bun run lint` + `bun run test` (719) green.

- **Coding-guideline audit (2 Sonnet):** 4 nits fixed (timeless-comment wording, trimmed a JSDoc-restating comment, symmetric spawn-count assertion, removed a redundant default assignment).
- **Alignment audit (5):** fully aligned to the reassessed spec, zero misalignments.
- **Red-team (5):** two real fixes applied:
  - **Wake dead-launch via `captureOk`:** the original final `has-session` check treated a transient docker timeout as a dead launch (false-negative -> /send fails fast). Replaced with "did any pane capture succeed across the 10-try poll" - a freshly launched session that captured zero times is gone; a reattached/slow-but-alive one captured at least once, so a single transient blip can't flip it. (`wake_result success:false` is the gateway's fail-fast signal; `success:true` defers to registration as before - so this only adds confident fast-fail, no regression.)
  - **`ensureSession` idempotent on duplicate:** after a failed `new-session` (a racing create or a transient `has-session` miss), re-check `has-session`; if it now exists, treat as a reattach (`created:false`) instead of surfacing a "duplicate session" error. 2 new race tests.
  - **Triaged OUT:** reattach-to-a-dead-pane (acceptable for P2; pane-health/`--resume` is P3, the chip is P4); the host-op reply's hardcoded `{created:true}` (P4 surfaces the outcome); the 600s wake-stall TOCTOU on `success:true` (pre-existing wake-stall painpoint, not introduced by P2); caching error results (rejected - retries should re-run, not replay an error).
- **Framework (2 agents):** no P2 code change. `buildLaunchCommand` unification + the `captureOk` dead-launch pattern were confirmed sound. The one "major" recommendation - unify `handleWake`'s inline tmux ops onto `tmuxCore.ensureSession`/`peekPane` - is **deferred** (not in P2): `handleWake` runs via the devcontainer CLI (`execInContainer`) while `tmuxCore` runs via `docker exec`, so the swap is an exec-mechanism change with failure-mode differences that cannot be verified without a live container. (One auditor mis-asserted the two share `tmuxArgv`; they do not.) Logged as a follow-up below.

## Painpoints (P1 crust)

Concrete leads surfaced while building P1. `file : scope : name`, no line numbers. Not fixed here.

- `src/mcp/devcontainer/reloadPlugins.ts : registerReloadPlugins : args.team` - the in-session `reload_plugins` tool interpolates agent-supplied `args.team` into a `docker exec "${team}_devcontainer-dev-1"` shell string with NO validation. `assertTmuxName` is now imported in this file (P1), so guarding it is a one-liner. Pre-existing injection surface (also in `gateway-auth-surface.md`); out of P1 scope.
- `src/gateway/console/consoleHandler.ts : resolveTmuxTarget : isProjectName scope` - `isProjectName` is the gateway-GLOBAL catalog, not per-owner/per-console. Harmless today (a gateway serves ONE Domain), but if multi-owner-per-gateway ever exists, terminal targeting would need per-console scoping. Track with `gateway-auth-surface.md`.
- `src/mcp/devcontainer/hostDaemon.ts : handleWake : (hardcoded "claude")` - the wake path still hardcodes the `claude` session (has-session / new-session / capture / auto-accept). P2's `openSession` unifies this with the composite model. Until then a woken devcontainer only ever gets the `claude` session, so a composite `project.other` peek before P2 finds "no server running" for `other`.
- `src/mcp/devcontainer/reloadPlugins.ts : module : TMUX_SESSION` - the in-session tool still hardcodes `claude`. P3 (MCP identity pinning) makes a spawned session register under its composite name, at which point the in-session tool should drive its own session name rather than the literal.
- `src/mcp/devcontainer/hostDaemon.ts : handleWake : inline tmux ops` (P2 follow-up) - the wake path runs has-session / new-session / capture / send-keys inline via the devcontainer CLI (`execInContainer`), duplicating `tmuxCore`'s `hasSession`/`ensureSession`/`peekPane`/`sendText` (which use `docker exec`). **RESOLVED by live test on evie-bot (2026-06-27): docker exec wins** - same user/socket/claude as the CLI, ~8x faster (0.05s vs 0.39s), cleaner raw-tmux errors, fewer failure modes; the CLI's only extra (remoteEnv/userEnvProbe + cwd) is moot because evie-bot has remoteEnv:null and the launch already `source`s `~/.bashrc`. Plan: in P3, migrate handleWake's tmux ops to `tmuxCore` (docker exec) while KEEPING `ensureContainerUpAsync` on the devcontainer CLI (only it can do the up + provisioning lifecycle). Caveat to honour: a project whose devcontainer.json sets `remoteEnv` not also in `~/.bashrc` that claude needs would be missed by docker exec - rare, but P3 should note it. Folded into P3 (which already rewrites handleWake for composite-name wake), not a standalone change.

## Painpoints (P2 crust)

P2-specific follow-ups (mostly accounted for by later phases; listed so they are not lost).

- `src/mcp/devcontainer/tmuxCore.ts : ensureSession` + `hostDaemon.ts : handleWake` - reattach checks only that the tmux SESSION exists, not that its claude is alive. A session whose agent exited (tmux pane survives) is reattached/reported alive. P3's `--resume` + P4's restored/fresh chip should detect a dead-but-present pane and offer a relaunch; until then a dead pane reads as "restored".
- `src/mcp/devcontainer/hostDaemon.ts : hostOpRunner.createSession` - the host-op reply hardcodes `{created:true}`, discarding `ensureSession`'s `{created}`. P4 should surface restored-vs-fresh so the app can render the Q6 chip.
