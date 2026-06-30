# Host session resume - lift the devcontainer-only restriction

Make a host-launched Claude session (`host.<session>`) survive a reboot the same way a devcontainer
session does: record its Claude harness id, list it as available while asleep, and `claude --resume`
it on the next message. Today this works for `project.session` devcontainer sessions but is
deliberately gated OFF for host sessions at three sites, and the wake handler can only launch
devcontainers. A lot of real work (switchboard itself, host-side dev) runs on the host, not in
Docker, so host sessions deserve the same durability.

Locations are `file : scope : name`. Refined 2026-06-29 by the `plan-refinement` cycle (10-lens
adversarial audit; 8 real findings folded in below).

**Scope caveat (audit: exhaustive-sites).** The host exclusion CANNOT be narrowed to console-created
`host.<session>` names. A manual `claude` on the host with `PROJECT_NAME` unset registers as
`host.<6hex>` (`mcp/index.ts:43-45` -> `stableTeamName(CLAUDE_CODE_SESSION_ID)`, a sha256 hex slice =
a valid slug), indistinguishable from a console-named `host.<name>` at the record gate. So lifting the
exclusion ALSO makes every ad-hoc host dev Claude recordable, listable-when-asleep, and wakeable.
This is intended (consistent durability), not a defect, but asleep `host.<6hex>` cards will appear
under the console host header for ordinary host dev sessions until the 30-day resume TTL evicts them.
Accept and document; do not add suppression logic.

## Security decision - OWNER CALL REQUIRED (audit: security-trust, BLOCKER)

Lifting the host exclusion changes the host wake from **fail-closed** to **fail-open**, and that
crosses a boundary the "Claude can do anything" risk acceptance does NOT cover, because the actor here
is a network peer, not a driving agent.

- Chain (every hop grounded): gateway port 20000 binds `0.0.0.0` (docker-compose `20000:20000`), so
  any LAN peer reaches it. `POST /send` has no auth gate (`index.ts:847` -> `routes.send` with no
  `opts`, so `trustedInbound`/`consoleSender` are false). `routes.send`'s only host guard is
  `if (localName === "host")` - an exact BARE-name match, so a composite `host.pwn` sails past. With
  no live socket it calls `tryWakeTeam`, and once Phase 2's host branch exists, `handleWake` LAUNCHES
  an unsandboxed host Claude with `--dangerously-skip-permissions`, prompted by the attacker's message
  body.
- **Today this fails closed**: `findProjectPath("host")`/`ensureContainerUpAsync` errors, nothing
  spawns. Phase 2 is what opens it.
- **Practical truth (your filter applied):** the unauthenticated `/send` surface is PRE-EXISTING and
  already spawns devcontainer Claudes (that is how wake works) - tracked separately in
  `gateway-auth-surface.md` (postponed). The genuine DELTA this plan introduces is sandbox loss:
  container -> bare host. On a trusted home LAN the realistic exposure is low; the root fix is the
  tracked auth surface, not a host-branch special case.

**DECISION (owner, 2026-06-29): (A) Accept + defer.** Proceed with the host branch as-is; the
unauthenticated `/send` host-spawn exposure is accepted for now and folded into the tracked
`gateway-auth-surface.md` work (the proper fix - it leaves the pre-existing devcontainer spawn open
too, so a host-only patch would be partial). No stopgap gate in this plan. Rationale: home-LAN, same
root cause as the tracked painpoint, container->host sandbox-loss delta only.

Rejected alternative (B): a host-only stopgap gate requiring a console-sealed/`trustedInbound` op.
Not taken - partial patch, adds a host-only auth notion ahead of the general fix.

## Behavior analysis - does a rename miss the resume? (answer: no)

Grounded in a direct read of the console source (the audit's rename lens was the one agent that
rate-limited out, so this rests on the primary-source read, not a sub-agent):

- **The resume map is keyed by the session ADDRESS, with the Claude id as the VALUE.**
  `gateway/index.ts : sessionResume` is `Map<team, {claudeSessionId, lastSeen}>`. NOT keyed by a
  stable Claude Session ID.
- **The console "rename" is a local display label keyed by the same address.**
  `android/.../ChatRepository.kt : setLabel(team, name)` writes `labels[team] = name`; `label(team)`
  returns `labels[team] ?: sessionLeaf(team)`. No session-rename op exists in the console protocol
  (only Domain `set_display_name`, unrelated).
- **Sends always target the address, never the label.** `ChatRepository.kt : send(team, ...)` uses
  `team` (the canonical address). Confirmed live: renaming `nyaadot` -> `nyaadot-stuff` still routed
  to `host.nyaadot`.

Therefore: **rename then resume HITS** (the address is unchanged; the `SessionB` label still carries
`host.SessionA`). The ONLY miss is creating a genuinely NEW session name (new address `host.SessionB`,
no resume record); the `SessionA` transcript stays parked under its tab. No re-keying work needed.

## Phase 1 - Lift the host exclusion (3 sites). Deploy: start-gateway.sh + start-host-daemon.sh.

The host exclusion lives at three mirrored sites, all justified by the now-stale comment "the host
spawn is not devcontainer-wakeable". Phase 2 makes it wakeable, so all three drop the host guard.

- `src/gateway/websocket.ts : register handler : recordSessionResume gate` (~L232-239) - the gate is
  `claudeSessionId present && isComposite(team) && parseSessionName(team).project !== "host"`. Drop
  the `&& parseSessionName(team).project !== "host"` clause. Keep `isComposite` (excludes the bare
  `host` spawn-point and bare loose peers) and the `claudeSessionId` presence check. Rewrite the
  comment to state that ALL composite host sessions are now recorded - BOTH console-named
  `host.<name>` AND ad-hoc `host.<6hex>` (PROJECT_NAME unset) - because Phase 2 makes the host spawn
  wakeable and the two are indistinguishable here; the old rationale (ad-hoc `host.<hex>` excluded
  because un-wakeable) no longer holds.
- `src/gateway/routes.ts : teams() : asleep-session listing guard` (~L533) - the guard is
  `!isComposite(name) || parts.project === "host" || !isSlug(parts.project) || !isSlug(parts.session)`.
  Drop the `parts.project === "host"` disjunct; keep the rest. Now an asleep `host.<session>` surfaces
  as `status:"available" kind:"loose"`, reappearing under the console's host header after reboot.
- `src/mcp/bridge/helpers.ts : register payload` - NO CHANGE NEEDED. Already sends
  `claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID` whenever set, and that var IS populated in
  host sessions (verified live: `CLAUDE_CODE_SESSION_ID=16aa1d0d-...`).

The audit confirmed this enumeration is COMPLETE - no 4th hiding site (`routes.ts:477`/`:685`,
`websocket.ts:163` RESERVED_TEAM_NAMES, `websocket.ts:245` handshake skip, `bridgeDiscover.ts:65` are
all bare-`host`-only and never match a composite; the Android board renders asleep host composites
under the injected host header with no filter).

## Phase 2 - Host branch in the wake handler. Deploy: start-host-daemon.sh.

- `src/mcp/devcontainer/hostDaemon.ts : handleWake` - currently always does container bring-up +
  `kind:"devcontainer"`. For `project === "host"` that is wrong (`findProjectPath("host")` is bogus,
  bring-up fails; observed live: `host.switchboard failed to come online`). Add an early branch after
  the `isTmuxName` validation: if `project === "host"`, skip container bring-up; build
  `target = { kind:"host", name:"host", sessionName: session }` and
  `ensureSession(target, buildLaunchCommand(target, { resumeSessionId: msg.resumeSessionId, workdir }))`
  (workdir from Phase 2b). The primitives already dispatch on `kind:"host"` (bare tmux) and
  `composeSessionName("host", session)` => `PROJECT_NAME=host.<session>` completes the wake.
- **CORRECTION (audit: handlewake-branch + test-soundness) - tmuxCore/handleWake DO need changes; the
  earlier "NO CHANGE NEEDED" was wrong.** Two host-specific hazards come from the launch tail
  `${claude}; exec bash` (hostDaemon.ts:257, shared with create_session), which keeps the pane ALIVE
  after claude exits:
  1. **Dead-launch masking.** `awaitReady`'s dead-launch bail keys on the tmux session vanishing, but
     `exec bash` keeps it alive, so a dead claude (off PATH, bad `~/.bashrc`, exit 127, rejected
     `--resume` id) is NOT detected; the wake stalls ~90s then falsely reports success. FIX: for the
     host branch, key `wake_result.success` on `res.ready` (REPL actually reached), NOT on
     `res.alive`.
  2. **Reattach-to-dead-shell.** `ensureSession` returns `{created:false}` (skips the launch, so NO
     `--resume`) whenever `hasSession` is true. After claude exits, the surviving `exec bash` pane
     means `hasSession` is true but the pane is a dead shell. FIX: on the host wake path when
     `created===false`, peek and check `isAgentReady(screen)`; if it is NOT the claude composer (a
     surviving `exec bash`), `killSession` + relaunch with `--resume` instead of binding to the dead
     shell.
- `src/mcp/devcontainer/hostDaemon.ts : buildLaunchCommand` - NO code change for resume itself
  (already handles `kind:"host"` + bakes `--resume` from `opts.resumeSessionId`); Phase 2b adds the
  `workdir` arg.

## Phase 2b - Host working directory + reserved-name guard. Deploy: start-host-daemon.sh.

### Working directory (audit: as-built confirmed)

Observed (screenshot 2026-06-29): `host.nyaadot` started in `/home/nyaarium/projects/switchboard` -
the daemon's OWN cwd - because the host launch form has no `cd` (devcontainer does `cd /workspace/
<name>`) and `createSession` issues `new-session` with no `-c`, so a host session inherits the tmux
server cwd (where start-host-daemon.sh launched it).

- `src/mcp/devcontainer/hostDaemon.ts : resolveHostWorkdir(session)` - NEW helper. Iterate
  `projectDirs` (default `[~/projects]`, env-overridable), return the first existing `<dir>/<session>`
  that is a directory - a PLAIN dir, NOT requiring `.devcontainer` (contrast `findProjectPath`); else
  fall back to `HOME`. Verified `~/projects/nyaadot` exists, so `host.nyaadot` resolves there.
- `src/mcp/devcontainer/hostDaemon.ts : buildLaunchCommand` - add `opts.workdir?: string`; the host
  branch emits `cd "<workdir>";` before `${claude}`. Double-quoted, not single: the whole launch is
  one `bash -c '...'`, so a single-quoted inner `cd` would terminate the outer quote; double quotes
  are space-safe and the workdir is a resolved fs path. Devcontainer branch unchanged.
- Thread `resolveHostWorkdir(session)` through BOTH host launch callers: the Phase-2 `handleWake` host
  branch and the `hostOpRunner.createSession` host-op path.
- CAVEAT (audit: exhaustive-sites): an ad-hoc `host.<6hex>` has no `~/projects/<hex>` match, so a
  resumed ad-hoc dev session lands in `$HOME`, not its original cwd. Acceptable (`claude --resume`
  restores the transcript regardless of cwd); note it so it is not a surprise.

Decision surfaced: name->`~/projects/<name>` is a convention (mirrors the devcontainer project
segment). An explicit working-dir picker in the console `create_session` dialog is the alternative but
needs an Android/protocol change (out of this gateway+host-daemon scope). Default to the name mapping.

### Reserved host-session-name guard (audit: tmux-name-collision, 2x HIGH)

Host sessions share the bare host tmux server with the daemon's own supervisor session and any
interactive sessions, so a console op on a reserved name is destructive:

- `forget(host.host-daemon)` -> `killSession` kills the DAEMON'S OWN supervisor pane, bricking wake +
  the terminal view (the only path the console has to the host).
- `create_session`/`peek`/`tmux_send` on `host-daemon` (or any existing non-chat pane) goes through
  `ensureSession`, which REATTACHES on an existing name (returns `{created:false}`) instead of
  erroring - silently binding the console chat tab to that non-chat pane and letting peek/tmux_send
  drive it.

FIX (gateway-side, in the host-launch scope this plan already edits):
- `src/gateway/console/consoleHandler.ts : resolveTmuxTarget` - in the `project === "host"` branch,
  after building the target, reject a reserved `sessionName` with a clear error. Maintain
  `RESERVED_HOST_SESSIONS = new Set(["host-daemon"])` (the daemon's supervisor; extend if other
  non-agent host tmux sessions are introduced). This gates ALL host ops that resolve through it
  (forget/create_session/peek/tmux_send), so the daemon pane can never be killed or hijacked.
- Note: reattaching to the conventional host agent session (`claude` = DEFAULT_SESSION) is INTENDED
  (it is an agent), so it is not reserved; only non-agent infrastructure sessions are. A user's own
  arbitrary interactive session (e.g. `switchboard`) reattaching is a softer surprise, not a brick;
  out of scope for the hard guard, mention in the comment.

## Phase 3 - Tests + verification. Deploy: n/a.

- `src/__tests__/build-launch-command.test.ts` - assert the host form with a resume id contains
  `--resume <uuid>` AND `cd '<workdir>'`, and that the devcontainer form is unchanged.
- Gate: `bun run lint && bun run test`. No shared schema / codegen / Android change, so the Android +
  evie gates are not required (confirm no synced leaf was touched).
- **Live verification (audit: test-soundness, 3 findings - the kill-session shortcut gives false
  passes; split into real legs):**
  1. **Gateway-up leg (exercises the wake/resume wiring):** create `host.SessionA` from the console,
     chat to seed a transcript, confirm `volumes/gateway-data/session-resume.json` now has
     `host.SessionA -> {claudeSessionId}`. `tmux kill-session -t SessionA`, confirm it still lists as
     available, send a message. PROOF OF RESUME IS NOT "is now online" - that log fires on ANY
     registration, fresh or resumed. Instead assert the resumed pane RENDERS THE PRIOR TRANSCRIPT
     (peek shows the earlier exchange) and the launch command carried `--resume`. Also confirm the
     reattach-liveness fix: if the `exec bash` pane survived the claude exit, the wake kills + relaunches
     with `--resume` rather than binding the dead shell.
  2. **Durability leg (exercises the disk reload a real reboot triggers):** `tmux kill-session` leaves
     the gateway process up, so it resumes from the in-memory map and never re-reads
     `session-resume.json`. Add a real `./down.sh && ./start-gateway.sh` (or container restart) between
     seeding and waking, so the resume id is restored from disk - this is the leg a reboot actually
     exercises.
  3. **Ad-hoc case:** start a manual `claude` on the host with `PROJECT_NAME` unset, confirm it
     registers as `host.<6hex>`, lands in the resume map, and lists as an available asleep card after
     its socket drops (documents the indiscriminate-capture scope note).
  4. **Reserved-name guard:** confirm `forget(host.host-daemon)` and `create_session host-daemon` are
     refused with a clear error and the daemon pane is untouched.

## Deploy

Gateway + host-daemon code only (no evie, no Android, no shared schema). Per the deploy sequence:
`./down.sh && ./start-gateway.sh && ./start-host-daemon.sh` on the host. The resume map is durable
(`session-resume.json` in DATA_DIR), so existing entries survive; host sessions start getting recorded
once the rebuilt gateway is live. Security decision resolved: (A) accept + defer (see above).

## Painpoints (crust scout, 2026-06-29; collected not fixed)

Refs are `file : scope : name`. Grouped by theme; severity in brackets.

### In the shipped code - worth a near-term follow-up

- [high] `hostDaemon.ts : handleWake : host branch` - the host reattach runs `awaitReady` (a full
  ~90s poll budget) BEFORE the dead-shell check, then on a dead shell kills and runs `awaitReady`
  again - up to ~180s before `wake_result`. The devcontainer branch avoids this by peeking once for a
  reattach and only `awaitReady`ing a fresh `created` launch. Fix: peek-first in the host reattach
  (return immediately if ready/working), reserve `awaitReady` for the post-relaunch path.
- [medium] `hostDaemon.ts : buildLaunchCommand : effort` - `--effort low` is hardcoded for every host
  session including resumes, so a host agent silently drops to low on each wake with no signal. The
  resume record carries no effort. Consider persisting/restoring effort or surfacing the downgrade.
- [medium] `shared/host-op.ts : HostOp : createSession` (+ `hostDaemon.ts : hostOpRunner.createSession`)
  - the `create_session` op carries no `resumeSessionId`, so tapping "New Session" on a host name the
  gateway already has a resume id for starts fresh and abandons the saved transcript. Only the wake
  path resumes. Decide whether create_session should offer resume.
- [medium] `hostDaemon.ts : hostOpRunner.createSession` - returns `{created:true}` as soon as the tmux
  exists (fire-and-forget `awaitReady`), while `handleWake` blocks on readiness; the asymmetry means a
  console create_session reports success before the REPL is up.

### tmuxCore robustness

- [medium] `tmuxCore.ts : killSession : catch` - the bare `catch {}` swallows ALL kill errors (docker
  timeout, container-not-running, perms), not just the idempotent "can't find session". A `forget`
  whose kill silently failed still calls `dropSessionResume`, orphaning a live tmux. Apply
  `classifyPeekError`-style discrimination.
- [low] `tmuxCore.ts : serialized : sendChains` - the per-target promise-chain map is never pruned
  (not on `killSession`), so it grows by every session that ever received a keystroke.
- [low] `tmuxCore.ts : assertNotReservedHostSink` - the name implies it guards all destructive sinks,
  but it only checks `kind === "host"` (a devcontainer reserved name passes) and `sendText`/`sendKey`
  are not guarded at all. Rename or broaden.

### Trust surface - all chain off the unauthenticated `/bridge` register + `/send`

Owner-deferred (decision A above); the root fix is `plans/gateway-auth-surface.md`. The host-resume
lift widens the blast radius of the pre-existing hole, it does not create it.

- [high] `websocket.ts : createWebSocketHandlers : message` - the host-token gate + `RESERVED_TEAM_NAMES`
  match the bare `host` exactly, so a composite `host.foo` bypasses both and `recordSessionResume`
  writes an attacker-controlled `claudeSessionId` into the durable map.
- [medium] `routes.ts : teams` - an attacker-seeded `host.foo` passes the asleep-listing guards
  (`host` is a valid slug) and surfaces as a phantom available card.
- [medium] `index.ts : doWakeTeam` - the reserved guard only blocks `host-daemon`; any other `host.*`
  is woken with the attacker's `resumeSessionId` forwarded.
- [medium] `index.ts : sessionResume` - no entry-count ceiling (only the 30-day TTL), so unauthenticated
  composite registers can grow the map and `session-resume.json` unboundedly.
- [medium] `routes.ts : isDevcontainer` - unions trusted `offlineCatalog` with untrusted
  `knownTeamPaths` (also tracked in `plans/host-daemon-cleanup.md`).
- [low] `schemas.ts : WsRegisterSchema : claudeSessionId` - `z.string().optional()` with no format
  constraint at the wire boundary; the only defense is `buildLaunchCommand`'s regex in another module.

### Naming / dead code (mostly pre-existing)

- [medium] `host-op.ts : TMUX_NAME_RE` + `session-id.ts : SLUG_RE` + `host-op.ts : CONVERSATION_ID_RE`
  - the same `/^[a-z0-9][a-z0-9-]*$/` defined in three places (differing only in length caps).
- [medium] `host-op.ts : TmuxTarget : kind` - the string `"host"` carries five roles (address spawn
  segment, reserved WS slot, `TmuxTarget.kind`, the reserved-session host, the daemon register name);
  easy to conflate.
- [low] `hostDaemon.ts : findProjectPath` vs `resolveHostWorkdir` - parallel projectDirs walkers with
  divergent fallbacks (`findProjectPath` falls back to `projectDirs[0]` only; `resolveHostWorkdir`
  tries all then HOME).
- [low] `routes.ts : getTeamMode` - its own docstring says it is effectively always `"channel"` (the
  CLI dispatch path was retired); the non-channel branch is dead.
- [medium] `websocket.ts : handshakePending` - a socket that closes before `resolveHandshake` leaves
  its entry in the map forever (the `close` handler does not clear it).
- [low] `tmuxCore.ts : STARTUP_PROMPT_RE` / `isAgentReady` / `isAgentWorking` / `isLoggedOut` and
  `host-op.ts : classifyPeekError` - wake/chip/logout detection is coupled to Claude-Code TUI strings +
  glyphs and docker/tmux stderr text; already tracked as fragility in `plans/host-daemon-cleanup.md`.
