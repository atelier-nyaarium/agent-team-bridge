# Host split: demote the host-agent + a headless multi-session daemon

The home-retire + naming + fail-closed-identity refactor (Phases 0-5) is SHIPPED and green; this plan
is now the vetting + refinement of its final phase. The host orchestrator's identity `"gateway"`
collided with the Docker Gateway server, but the refinement went further: the conversational host-agent
is no longer load-bearing (the console reaches devcontainers directly, containers crosstalk, the daemon
wakes them). So Phase 6 DEMOTES the host-agent to a normal peer, EXTRACTS a headless daemon that owns the
host plumbing, and GENERALIZES the tmux layer to named multi-sessions per target. Clean-break still
applies (the owner wipes evie + re-provisions; no migration / back-compat code).

## Shipped (Phases 0-5) - summary

The literal `home` / `DEFAULT_DOMAIN_ID` Domain id is retired for a random hex id; the overloaded
`operator` is split by sense; identity loading fails closed. Green across all three runtimes
(switchboard gateway, evie-bot, Android); the exact `"home"` literal greps nowhere as a Domain id,
and `isPrimary` / `operatorName` / `operatorDomainId` / `operatorSignPub` / `SET_OPERATOR_NAME` are
gone.

**The enduring model** (carried into Phase 6):
- A **person** = one **Domain** (their trust identity / owner key) who stands up their own
  **Gateways** (machines) under it. `home` died because it conflated Domain and Gateway.
- The **admin** is the evie-runner who provisions other people's Domains; their Domain is the one
  flagged `isAdminDomain` on evie's `EnrollmentState`, resolved by `KubeSecretStore.adminDomainId()`
  (fail-closed `string | null`). A guest owns a Domain + its Gateways but is not the admin.
- The console addresses **Gateways** (no domainId on the wire); evie scopes the console relay + the
  register bootstrap carve-out to the `isAdminDomain` marker.
- Naming splits: the display NAME (any user's label) is `displayName`; the provisioner ROLE is
  `admin*` (`adminDomainId`, `adminSignPub`, `runGuardedAdminOp`); the admin-Domain marker is
  `isAdminDomain`. Signing-bytes are value-positional, so field renames are byte-stable; only a
  changed `*_V1` constant string re-cuts vectors.

**Commit anchors** (local `home-retire-refactor` branch, both repos, nothing pushed):
- Phase 0 admin marker: evie `018b6c8`, sw `4350c7a` (+ `888b5eb`)
- Phase 1 home-retire: evie `019ed18`, sw `316e83d`; Android `cf0731d`
- Phase 2 rename (operatorName->displayName, operator->admin, isPrimary->isAdminDomain): evie
  `b975262`/`be10077`/`5b3e7e8`/`f9f3eea`/`09a6aed`, sw `99bab5f`/`fab3dd7`/`769e034`/`0db29dc`/`0f96c82`
- Phase 3 vector re-cut + smell sweep: sw `aed8407`/`4d670d9`/`39b6e73`, evie `906bb99`
- Phase 4 fail-closed identity: sw `37559fe`
- Audit fixes: sw `c9adb1a`/`8dd4615`/`01741e2`/`ab2d8cd`, evie `dfa1056`/`9d9a529`

**Owner-driven, not done in code** (the Phase 5 deploy tail): the atomic clean-break wipe + rollout
(push evie -> push switchboard -> rebuild gateway -> re-provision -> flash the APK), plus the
semantic acceptance test (empty `displayName` roster row shows "(unnamed)", not the hex id) and the
on-device fresh-provision round-trip. Optionally bump `FEDERATION_PROTOCOL_VERSION` +
`CONSOLE_PROTOCOL_VERSION` so an old runtime fails fast.

**Open question deferred from the refactor**: the Phase-2 "Your Name" PHONE import gate was never built
and appears superseded by the host `provision.ts` "prompts for the display name" model. Confirm whether
the phone-side required-name gate is still wanted.

## Phase 6 - split the host (demote the host-agent; headless multi-session daemon)

**Decisions (owner, via the refinement questionnaire):** the host-agent DEMOTES to a normal peer (not a
privileged "gateway" identity); a headless daemon owns the host plumbing; the tmux layer generalizes to
named multi-sessions. Folds in features-and-fixes Item 11 (CLI teardown), subsumes Item 12
(create-session), tees up Item 13 (Copilot terminal-only).

### The model

- A **target** (the host, or a devcontainer) runs one or more **named tmux sessions**. The PANE is ALWAYS
  `.0` (reserved for the agent / TeamCreate) - only the session name varies.
- The **headless host daemon** owns the privileged host plumbing: container waking, the terminal view
  (peek / tmux_send), `reload_plugins`, and `create_session` (start a named tmux session on a target).
  Authenticated by the existing reserved `host` WS slot + `HOST_WS_TOKEN`.
- The **host-agent demotes to a normal `loose` session**: a Claude on the host, if run, registers like any
  container agent (a `loose` peer named `host-agent`) - no reserved name, no `kind:"gateway"`, no
  special-casing. Reachable by `send` like any peer.
- The Docker **Gateway server keeps its name**; the collision dies because nothing is specially "gateway".

### Part A - the headless daemon (extract + grow)

- New headless entry (e.g. `main-host-daemon.ts`) running ONLY: `startHostWakeListener` (catalog scan +
  on-demand container waking) + the `host_op` handler (`hostOpRunner.ts` + `tmuxCore.ts`) + two NEW ops:
  `reload_plugins` and `create_session`. No Claude, no MCP chat tools.
- `start-host-daemon.sh` -> generic **`start-session.sh <name>`**: starts a tmux session named `<name>`
  (bare `tmux` on the host, `docker exec ... tmux` in a devcontainer). Target-parameterized.
- KEEP the gateway<->daemon RPC: `relayToHost` + `hostOpCoordinator` (`gateway/index.ts`) + the reserved
  `host` WS slot + `HOST_WS_TOKEN`. They serve the DAEMON, not the retired host-agent - confirm survival.

### Part B - demote the host-agent (remove the special-casing)

- `mcp/index.ts` host branch: drop `projectName: "gateway"`, the `initBridge({...})` +
  `setIsMainOrLeadAgent(true)` + `setChannelServer(...)` scaffolding (+ the now-unused `setChannelServer`
  import), and ALL the host-only tool registrations (`registerChannelReply`, `registerBridgeSend`/
  `Discover`, `registerHumanTools`, `registerHostSessionPeek`/`Send`, `registerReloadPlugins`,
  `registerSetEffortLevel`, `registerCompactSession`, `registerSessionAwaitIdle`). The inline
  `startHostWakeListener` moves to Part A. A host Claude loads the plugin in NORMAL (channel) mode.
- `gateway/websocket.ts`: drop `"gateway"` from `RESERVED_TEAM_NAMES` (keep `"host"`); remove the
  host-agent's `from: "gateway"` handshake leg - but KEEP the handshake for container agents
  (`mode==="channel" && team!=="host"`).
- `gateway/routes.ts`: remove all THREE "gateway" spots - the `(localName === "gateway" && !channelOnly)`
  send guard, the wake-exemption comment, AND the `localName !== "gateway"` wake condition. After: send
  guard -> `localName === "host"`; wake -> unconditional.
- `gateway/console/consoleHandler.ts`: drop the `name === "gateway" -> {kind:"gateway"}` resolve + the
  host-agent teams() surfacing.
- `mcp/bridge/helpers.ts`: drop the dead `msg.from === "gateway"` reply-schema gate.
- Folds in **Item 11**: delete `devcontainer/devcontainerCli.ts` (`dispatch_cli`), `mcp/resolve-model.ts`
  + its test, the CLI-only helpers in `devcontainer/helpers.ts`, the dead `InjectPayload`/`EffortEnv`/
  `MODEL_*` types. **Retire `dispatch_exec`** (`devcontainerExec.ts`) per Q2 (the terminal view replaces
  it). **Collapse `ConnectionMode "cli"`** per Q4 (drop `"cli"` from `ConnectionModeSchema` + the reject
  branches in routes/websocket/consoleHandler/index). Delete `skills/orchestrate/SKILL.md` +
  `agents/team-relay.md`. Clean `CLAUDE.md` + `README.md`.

### Part C - generalize the tmux layer to named multi-sessions (NEW; subsumes Item 12)

- Thread a **`sessionName`** through `TmuxTarget` (`shared/host-op.ts`) -> the peek / send / create
  primitives (`tmuxCore.ts`) -> the `create_session` op -> the console session list. The pane is ALWAYS
  `.0`: `TMUX_PANE = "claude.0"` splits into a variable `<sessionName>` + a fixed pane `0`; every op
  targets `<sessionName>.0`. Never vary the pane.
- `create_session` console op (wire: a new `ConsoleOp` member -> codegen) -> the daemon's `create_session`
  (`start-session.sh <name>` on the target). Multi-session per target: the host OR a devcontainer can run
  >1 named session (a second window in a devcontainer just works). Idempotent per `(conversationId, opId)`.
- Registration latency + host-op timeout (Item 12 hard-parts): a created session's Claude self-registers
  async, so `create_session` returns FAST and the UI polls for it; never block the sealed relay on Claude
  booting.
- Sets up Item 13 (Copilot) for free: a created session driven purely via the terminal view, no chat reg.

### Wire + codegen (one atomic pass)

- `shared/schemas.ts`: `TeamKindSchema` drops `"gateway"` (the host session is `loose`);
  `ConnectionModeSchema` drops `"cli"`; add a `create_session` `ConsoleOp` member. Regen `proto/Protocol.kt`
  in ONE pass, then the **Android build gate** (CLAUDE.md: a wire change MUST run the Gradle build).
  Clean-break covers the breaking enum changes; an unknown `kind`/`mode` decodes tolerantly on both sides.
- Android `MainActivity.kt`: drop every `kind == "gateway"` arm (`terminalEligible`, `canRename` ->
  `kind != "devcontainer"`, the host grouping filter, the label guard) + the `GatewayHeader` host section;
  add the create-session button + the multi-session list.

### DO NOT TOUCH

- Federation admission `kind: "gateway" | "console"` (`shared/admission.ts`, read at
  `federation/allowlist.ts` + `federation/bootstrapInstall.ts`) - attests a MACHINE, unrelated, stays.
  A sweep that hits it breaks federation trust.
- `hostOpCoordinator` / `relayToHost` / the `host` WS slot - serve the daemon (Part A).
- `pending-job-store.ts`, `replyTool.ts` - channel/federation load-bearing (Item 11).

### Tests + UNVETTED

Repoint/clean fixtures that register or expect a `"gateway"` team or `mode:"cli"`: `routes.test.ts`,
`console-handler.test.ts`, `websocket.test.ts` (+ `tmux-core.test.ts` for the session-name threading).

UNVETTED: the expanded scope (Part C generalization + Item 12) grew past the first gap-audit (which
covered only the smaller "retire + extract" shape). Re-audit the expanded plan before any code. The grind
STOPS after this ships.

## Minor (separate, low)

evie `CursorMergePullRequestAction.checkGHCLI` (CLASS 2) returns a hardcoded "GitHub CLI not found"
discarding `gh` stderr - unrelated cursor feature; fix the narrow stderr-surfacing if/when that area
is touched.
