# Host daemon cleanup - remaining work

Shipped: Phase 1 dead-code + Phase 2 connector SSRF gate (PR #96); Phase 1b `RESPONSE_TIMEOUT_MS`
removal, Phase 3 wake two-tier timeout + durable-store error log, Phase 4 evieClient reconnector, and
the `wake_result` host-gate (PR #97). Remaining below. Locations are `file : scope : name`.

## Phase 4 (remaining) - Targeted refactors. Deploy: gateway / reload_plugins.

- `src/mcp/devcontainer/setEffortLevel.ts` + `compactSession.ts` - `execSync("bash -c ... base64 -d")` tmux drivers that bypass tmuxCore's safe no-shell `sendText`/`sendKey`. Route through tmuxCore. (reload_plugins). Watch for an impedance mismatch: tmuxCore's `sendText`/`sendKey` take a `TmuxTarget` and run via the host daemon, while these drive the session's OWN pane in-process - confirm the target model fits before routing.
- `src/gateway/console/consoleHandler.ts : friendlyPeekError` - classifies by substring-matching tmux/docker stderr. Add a structured error-kind on the host-op layer (`shared/host-op.ts`) so classification does not depend on stderr wording (also helps the Android twin). Cross-layer (host-op type + tmuxCore classification + consoleHandler consumption). Lowest priority.

## Phase 5 - Fragile TUI automation (mostly upstream; revisit). Deploy: reload_plugins.

- `src/mcp/devcontainer/reloadPlugins.ts : buildScript` - ACTIVELY drives the Claude Code TUI: fixed sleeps, greps for the `❯` glyph + menu strings, hardcoded key nav; breaks on any UI change. Genuinely upstream-fragile; the real fix is a Claude Code `--update-plugins`/`--reconnect-mcp` flag. Until then it is a known-fragility script to hand-update on TUI changes.
- `src/mcp/devcontainer/tmuxCore.ts : awaitReady / STARTUP_PROMPT_RE` - clears startup menus by matching English strings ("I am using this for local development", "Is this a project you created", "trust this folder", "Try the new fullscreen renderer"). NOTE: the core readiness check (`isAgentReady` = `COMPOSER_RE /^❯/`) is glyph-based and column-anchored, so it is STABLE; only the startup-menu clearing is string-fragile. A structured readiness signal from Claude Code would help `awaitReady` but not `buildScript` (which needs active control) - distinct problems.

## Open root cause (track, not yet scheduled). Deploy: reload_plugins.

- `src/mcp/devcontainer/hostDaemon.ts : buildLaunchCommand` - the in-container agent launches as a single `bash -c '...source ~/.bashrc...; exec claude...'`; if any step fails instantly (bashrc error, claude off PATH, bad cwd) the tmux session dies. Dead-launch DETECTION ships (`launchAlive` -> `wake_result success:false`, after ~8 probes / ~8s). Hardening is tractable but partial: pre-flight checks (bashrc readable, `which claude`, devcontainer cwd exists) catch the common static cases early; runtime failures still need the dead-launch fallback. The single `bash -c` is intentional (the env must be shared with `exec claude`; a multi-step spawn breaks env inheritance), so prefer pre-flight + stderr capture over splitting it. Devcontainer launches lack the host's `exec bash` fallback, so a crash leaves no diagnostic pane - consider adding one.

## Painpoints (deferred follow-ups, surfaced by the audits)

### Trusted-vs-untrusted catalog conflation

`isCatalogProject` and its clone union a TRUSTED source (`offlineCatalog`, host-token-gated) with an
UNTRUSTED, durable one (`knownTeamPaths`, written by the unauthenticated `/bridge` register). The
connector now gates on `offlineCatalog` only; these other sites still union, so an unauthenticated
register can influence them:
- `src/gateway/routes.ts : createRoutes : isDevcontainer` - sets `TeamInfo.kind`; an attacker-registered name can make a loose team show as a devcontainer spawn-point (console UI confusion, failed terminal-view). Severity medium.
- `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : isProjectName` - device-name collision gate; an attacker register of a device name blocks that console from registering (transient DoS). Severity low.
- `src/gateway/console/consoleHandler.ts : resolveTmuxTarget` - terminal-view devcontainer resolution; benign today (the `docker exec` on a bogus `<name>_devcontainer-dev-1` fails gracefully) but inconsistent.
- `src/gateway/index.ts : startGateway : isCatalogProject` (+ its `doWakeTeam` use) - the shared union predicate; `doWakeTeam` is currently safe (composites can never be catalog members) but reads on the untrusted half.
- Systemic fix: a named trusted predicate (`isTrustedCatalogProject` = offlineCatalog-only) or a typed `Catalog` value object exposing trusted vs any membership, applied per site. The tradeoff to weigh: `knownTeamPaths` is the durability fallback for a host-daemon outage (offlineCatalog clears on disconnect), so flipping a site to trusted-only degrades it during an outage. Decide per site whether trust or durability wins. ROOT cause (unauthenticated `/bridge` register) is `gateway-auth-surface.md`'s (postponed).

### Outbound-target validation pattern

- `src/gateway/connectorProxy.ts : setupProxy` - dials `ws://<project>:20002` and trusts the caller validated `project` (now documented via JSDoc, gated in index.ts). There is no systematic outbound-target validator (contrast the sealed-frame pumps' schema-then-semantic validation). A `outbound-validators` module with a guard per outbound class would make SSRF prevention systematic rather than per-call. Defer (large).

### Graceful-shutdown reconnector cleanup

The shared `Reconnector` now exposes `cancel()`; evieClient and `closeRouter` use it, but two shutdown paths still leak a pending reconnect timer. Cosmetic on a process that is exiting, but inconsistent.
- `src/mcp/devcontainer/hostDaemon.ts : reconnector` - module-scoped, never cancelled; `main-host-daemon.ts` registers no SIGTERM/SIGINT handler. Needs an exported `stopHostDaemon()` calling `reconnector.cancel()` + signal handlers. Defer (threads cleanup through the module boundary).
- `src/gateway/index.ts : activateFederation` - the SIGTERM handler calls `evieClient.stop()` but SIGINT does not, so a Ctrl-C leaks evieClient's reconnector + heartbeat timers. Small: consolidate SIGTERM/SIGINT into one shutdown handler.
- `src/gateway/evie/evieClient.ts : connect : ws.on("close")` - PRE-EXISTING: a stale socket's close handler unconditionally `ws = null` + `onDisconnect`; if it fired after a new socket connected it could null the new one. Guard the handlers on socket identity. Low risk in practice (the reconnect delay outlasts the close event).

### Coordinator / timeout pattern consolidation (large-defer)

- The four waiter/timeout coordinators (`WakeCoordinator`, `gateway/hostOpCoordinator`, `evie/evieClient` pendingCalls, `shared/pending-job-store`) share a request-wait-resolve-timeout shape; a `TimedWaiter` abstraction could consolidate them. SAME over-abstraction caveat as the dropped Phase 4 keyedSingleFlight: they differ (multi-waiter vs single, the mutable re-arm in `ackReceived`, persistence + TTL in PendingJobStore). Only worth it if a clean shared core emerges; otherwise tailored is clearer.
- Wake timeouts are split: `WAKE_TIMEOUT_MS` (`gateway/index.ts`) and `REGISTER_WINDOW_MS` (`gateway/websocket.ts`). A single timeout-config owner would make them discoverable. Minor.
