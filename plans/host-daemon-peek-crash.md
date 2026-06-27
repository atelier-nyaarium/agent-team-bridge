# Painpoints (crust sweep)

The host-daemon peek-crash fix shipped and merged (PR #81). This file is kept only for the
crust the crash sweep turned up. Locations are `file : scope : name` (no line numbers).
Not addressed; logged for future passes.

### The actual incident root cause (still open)
- `src/mcp/devcontainer/hostDaemon.ts : handleWake / buildLaunchCommand : in-container claude launch` — the in-container agent is launched as a single shell string `tmux new-session -d -s claude "source ~/.bashrc && cd /workspace/<proj> && claude ..."`. If that command exits instantly (a `~/.bashrc` error, `claude` not on PATH, a rejected flag, or a wrong cwd), the session's tmux server dies and the next peek finds "no server running" — the exact symptom that started this. This is the real trigger to chase; the crash fix only makes it non-fatal + legible.
- `src/mcp/devcontainer/hostDaemon.ts : handleWake : wake_result success reporting` — after launch, the 10×1s readiness poll swallows every capture error; if the session already died, `lastScreen` stays empty and the handler still sends `wake_result success:true`. A dead launch is reported as success.

### Debug scaffolding shipped to production (the "Hypothesis A–N" hunt)
- `src/shared/debug-log.ts : module : debugLog` — an ungated investigation logger doing **synchronous** `appendFileSync` on hot paths (channel_push, poll, register, wake), with a hardcoded `/home/nyaarium` fallback path, writing into the gateway's **durable** `/app/log` volume. Delete the module + all callers.
- `#region Hypothesis` blocks across `gateway/index.ts` (I), `gateway/websocket.ts` (D/E/F/G/M), `mcp/devcontainer/hostDaemon.ts` (J/K/L/N), `mcp/channel/channelNotify.ts` (A/B), `mcp/bridge/helpers.ts` (F/H), plus the `fs.writeFileSync(LOG_PATH, "")` startup clear in `gateway/index.ts`.
- **LANDMINE:** `src/gateway/websocket.ts : onMessage : Hypothesis M region` wraps load-bearing logic — `if (msg.success === false) wakeCoordinator.notify(team, false)` — not just a log line. A naive region-delete silently removes wake-failure handling. Strip the `debugLog` calls only.
- `src/mcp/bridge/helpers.ts : connectToRouter : previousSubId` — debug-only var whose sole writer lives inside a Hypothesis block; delete with the blocks.

### Wake-stall landmines (a host disconnect mid-wake hangs `/send`)
- `src/gateway/wake.ts : WakeCoordinator : (missing) failAll` — has no failAll, unlike its siblings (`HostOpCoordinator.failAll`, evieClient pendingCalls on disconnect).
- `src/gateway/websocket.ts : createWebSocketHandlers/close : host-disconnect branch` — on host WS drop it calls `hostOpCoordinator.failAll(...)` but never fails the wakeCoordinator; in-flight terminal ops are rescued, in-flight wakes are stranded.
- `src/gateway/index.ts : doWakeTeam : WAKE_TIMEOUT_MS` — defaults to 600000 (10 min) and `routes.send` awaits the wake INLINE, so a host disconnect mid-wake hangs `/send` up to 10 min. The gateway also ignores `wake_result success:true` (relies only on registration), so a woken-but-unregistered container stalls the same 10 min despite a positive ack on the wire.

### Security (overlaps `plans/gateway-auth-surface.md`)
- `src/mcp/devcontainer/reloadPlugins.ts : registerReloadPlugins : args.team` — the **in-session** `reload_plugins` tool interpolates agent-supplied `args.team` into a `docker exec ... "${team}_devcontainer-dev-1" tmux` shell string with **no `assertSlug`** (the host-daemon path validates; this path does not) — shell-injection surface.
- `src/gateway/routes.ts : createRoutes : ingest` — unauthenticated POST /ingest appends the raw body to the durable volume (orphaned debug plumbing).
- `src/gateway/connectorProxy.ts : setupProxy` — unvalidated `{project}` segment dialed as `ws://${project}:20002/ws` with no gateway-side auth (the SSRF noted in gateway-auth-surface).

### Naming / durability landmines
- `src/gateway/index.ts : startGateway : LOG_PATH` — durable state (federation **private keys**, pending-jobs, mailboxes, replay-guard) is rooted at `path.dirname(LOG_PATH)` where `LOG_PATH = /app/log/debug.log`. Naming the data root after a debug log (and mounting at `/app/log`) invites a "clear the logs" action destroying federation identity. Should be a `DATA_DIR` independent of the debug-log filename.
- `src/shared/durable-store.ts : DurableStore : save` — swallows ALL write errors in an empty catch; the class exists to fix the lost-mail-on-restart gap, but a persistent write failure (full/read-only disk) is invisible.

### Duplicated patterns (framework-first)
- Keyed single-flight + map cleanup hand-rolled 4×: `hostOpRunner.ts` (inflightPeeks/inflightSends), `gateway/index.ts` (inflightWakes), `tmuxCore.ts` (serialized/sendChains), `consoleHandler.ts` (opCache). The crash lived in this family — a shared `keyedSingleFlight` helper would prevent it by construction.
- Pending-call/waiter correlation hand-rolled 3×: `hostOpCoordinator.ts` (pending), `wake.ts` (waiters), `evieClient.ts` (pendingCalls).
- `src/gateway/evie/evieClient.ts : startEvieClient : scheduleReconnect` — fixed 5s reconnect, no backoff, instead of the shared `shared/reconnect.ts` `createReconnector` (used by hostDaemon + bridge/helpers).
- `src/gateway/console/consoleHandler.ts : friendlyPeekError : PEEK_ABSENT` — classifies by substring-matching raw tmux/docker stderr; a structured error-kind on the host-op layer (`shared/host-op.ts`) would decouple it (the change this plan just shipped is the string-matching version).
- `src/mcp/devcontainer/setEffortLevel.ts` + `compactSession.ts` — `execSync("bash -c ... base64 -d")` tmux drivers that bypass tmuxCore's safe no-shell `sendText`/`sendKey`.

### Fragile TUI automation
- `src/mcp/devcontainer/reloadPlugins.ts : buildScript` — drives the Claude Code TUI blind: fixed sleeps, greps for the `❯` glyph + menu strings, hardcoded key nav; breaks on any UI change.
- `src/mcp/devcontainer/hostDaemon.ts : handleWake` — screen-scrapes readiness on English UI strings ("Claude Code v", "Choose the text style", "Loading development channels"); same fragility.

### Dead code
- `src/mcp/devcontainer/helpers.ts : ensureContainerUp` (sync) — zero callers; ~45-line near-dup of `ensureContainerUpAsync`.
- `src/mcp/devcontainer/hostDaemon.ts : stopHostWakeListener` — exported, never called.
- `src/gateway/routes.ts : send : channel-mode rejection branches` — `ConnectionModeSchema` is single-value `'channel'`, so the non-channel branches are unreachable.
- `src/gateway/index.ts : RESPONSE_TIMEOUT_MS` — read from env + threaded into config, never consumed by `createRoutes`.

### Stale docs
- `CLAUDE.md : Key Paths : provision.ts` — references a non-existent `scripts/provision.ts`; `scripts/setup.ts` composes the three provisioning modules directly.
