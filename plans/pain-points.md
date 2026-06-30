# Pain points

Residual painpoints from shipped work, collected by crust scouts (record only, not fixed). Refs are
`file : scope : name`; severity in brackets.

## Host session resume (PR #100, 2026-06-29)

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

### Trust surface - all chain off the unauthenticated `/bridge` register + `/send`

Owner-deferred (decision A); the root fix is `plans/gateway-auth-surface.md`. The host-resume lift
widens the blast radius of the pre-existing hole, it does not create it.

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
- [low] `tmuxCore.ts : STARTUP_PROMPT_RE` / `isAgentReady` / `isAgentWorking` / `isLoggedOut` and
  `host-op.ts : classifyPeekError` - wake/chip/logout detection is coupled to Claude-Code TUI strings +
  glyphs and docker/tmux stderr text; already tracked as fragility in `plans/host-daemon-cleanup.md`.

## Console device-name address (PR #99)

### init-order `_state`-access NPE class
`loadPersisted*` run during `_state` construction (before `_state` is assigned), so anything they
reach that reads `_state.value` NPEs and a surrounding `runCatching` swallows it silently (exactly the
`isAddressKey` bug, now fixed by passing `""`). These siblings read `_state.value` via `localDomain()`
-> `confirmedDomainId()` and are SAFE today only because nothing calls them during construction - each
breaks the moment it becomes init-reachable:
- `ChatRepository.kt : canonicalTarget`
- `ChatRepository.kt : fromCanonical`
- `ChatRepository.kt : thisDeviceAddress`
- `ChatRepository.kt : forget` (also reads `_state.value.localGatewayId` directly)
Durable fix (deferred): make `confirmedDomainId()` / `localDomain()` null-safe (return `""` when
`_state` is not yet initialized), retiring the class.

### `PROJECT_NAME` / `from` not slug-validated -> `localAddress` throws
`PROJECT_NAME` is read from env and propagated as the sender `from` with no slug check, so a non-slug
value (spaces/caps) makes `localAddress(from)` throw uncaught:
- `src/mcp/index.ts : startMcp` - the root: `PROJECT_NAME` is never asserted to be a slug
- `src/gateway/routes.ts : humanNotify` - `localAddress(from)` (the schema validates length, not slug); a non-slug `PROJECT_NAME` crashes `/human/notify`
- `src/gateway/routes.ts : sendCrossGateway` - `localAddress(from)` on an agent cross-Gateway send throws on a non-slug team field

### non-address fallback leaks
- `ChatRepository.kt : canonicalTarget` - `runCatching { parseTarget(...).canonical }.getOrDefault(team)` returns the raw `team` on failure, then used as a thread-lookup key + openTabs membership; the same class fixed in `fromCanonical` (which now returns null). A malformed team silently misses rather than corrupts, so lower severity.
