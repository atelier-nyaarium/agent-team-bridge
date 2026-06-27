# Host daemon crash on peek failure (unhandled rejection)

## Symptom

The host daemon crashed mid-wake. Boot log:

```
[host-daemon] started
[host-wake] connected to gateway
[host-wake] sent catalog with 5 projects
[host-wake] starting evie-bot at /home/nyaarium/projects/evie-bot
[host-wake] evie-bot container is up, starting Claude
[host-wake] evie-bot Claude session started
...
error: no server running on /tmp/tmux-1000/default
      at <anonymous> (/home/nyaarium/projects/switchboard/src/mcp/devcontainer/tmuxCore.ts:76:20)
Bun v1.3.11 (Linux x64)
```

The `Bun v1.3.11` footer means the **process died** on an uncaught error. A single failed tmux capture took down the entire daemon: the wake in flight, all console host_ops, and the catalog.

## Root cause (audit-confirmed)

1. **Trigger (expected, recoverable):** a tmux `capture-pane` exited non-zero with `no server running on /tmp/tmux-1000/default`. The error text is the *raw* tmux stderr with no `Exit N:` prefix, so it came from `tmuxCore.run()` (tmuxCore.ts:73-76, which rejects with raw stderr), **not** `execInContainer` (helpers.ts:321, which prefixes `Exit N:`). `run()`'s only unguarded consumer is the peek single-flight, so the failing op was a **peek host_op** — the console peeking a session whose tmux server was momentarily gone (a still-booting / just-exited `claude` pane in the container; vscode is uid 1000 in-container, hence the same socket path). A peek failing is normal.

2. **Crash mechanism (the bug):** `hostOpRunner.runPeek` leaks an unhandled rejection.

   ```ts
   // src/mcp/devcontainer/hostOpRunner.ts:63-69
   let capture = inflightPeeks.get(key);
   if (!capture) {
       capture = withPeekSlot(() => ops.peekPane(target));
       inflightPeeks.set(key, capture);
       void capture.finally(() => inflightPeeks.delete(key)); // <-- LEAK
   }
   const result = await capture;
   ```

   `capture.finally(cb)` returns a **new** promise (P2) that re-throws `capture`'s rejection. `void`-ing P2 leaves it with no handler. `await capture` (line 69) attaches its own reactions to `capture` (routing the error into `handleHostOp`'s try/catch → `ok:false`), which handles `capture` but **not** the independent P2. When `peekPane` rejects, P2 is an unhandled rejection and Bun terminates. Both attachments are registered synchronously, so this is deterministic, not a race. The sibling at hostOpRunner.ts:98 does it correctly: `void inflight.catch(() => {}).finally(...)`.

## Scope of the leak (the fix list under-covered this; audit found more)

`void <promise>.finally/.then(...)` with no `.catch` is one bug class. Confirmed sites:

| # | File:line | Process | Trigger likelihood |
|---|-----------|---------|--------------------|
| F1 | hostOpRunner.ts:67 `void capture.finally(...)` | daemon | **HIGH — the observed crash** |
| F1b-a | hostDaemon.ts:81 `void handleHostOp(...)` | daemon | medium — `handleHostOp` calls `ws?.send` in its catch (no readyState guard at :324/:326); a send on a closing socket throws → fresh unhandled rejection |
| F1b-b | hostDaemon.ts:77 `handleWake(msg)` (not awaited, not void-caught) | daemon | low — `handleWake` catch guards `ws.send` with readyState (:286), but a throw before/around it still escapes |
| F2 | index.ts:137 `void wake.finally(...)` | gateway | low — `WakeCoordinator.waitFor` only ever resolves; sole rejection is a TOCTOU `hostWs.send` throw |
| F2b | evieClient.ts:234 `void callTool("gateway_register",...).then(...)` (no `.catch`) | gateway | low/medium — executor `ws.send` throw, or the `.then` body throwing |
| (safe) | hostOpRunner.ts:98 `void inflight.catch(()=>{}).finally(...)` | daemon | already correct — the pattern to copy |

F1 is the emergency. F1b/F2/F2b are the same one-line class and must be fixed together, otherwise the process-level guard (F3) is the only thing standing between them and another crash.

## Fix

### Layer 1 - eliminate every unhandled rejection (the emergency)
- **F1.** hostOpRunner.ts:67 → `void capture.catch(() => {}).finally(() => inflightPeeks.delete(key))`. The `.catch` makes the derived promise resolve; the `await capture` below still surfaces the real rejection to `handleHostOp` (→ `ok:false`). Mirrors the proven sibling at :98.
- **F1b.** hostDaemon.ts dispatch (lines 76-95): make the fire-and-forget calls non-throwing. Change `:81` to `void handleHostOp(...).catch((e) => console.error("[host-op] dispatch error:", e))` and `:77` to `void handleWake(...).catch((e) => console.error("[host-wake] dispatch error:", e))`. Additionally wrap the `ws?.send(...)` calls inside `handleHostOp` (:324, :326) in try/catch so a send on a closing socket can never re-reject. (`handleWake`'s sends are already readyState-guarded.)
- **F2.** index.ts:137 → `void wake.catch(() => {}).finally(() => inflightWakes.delete(team))`. `.catch` is on a derived promise; `inflightWakes` stores and both return paths hand callers the *original* `wake`, so consumer error reporting (routes.ts:594, gatewayRelay.ts:168) is byte-for-byte unchanged.
- **F2b.** evieClient.ts:234 → append `.catch((e) => console.error("[evie-client] gateway_register chain error:", e))` to the `callTool(...).then(...)` chain.

### Layer 2 - a daemon must never die on a stray rejection (defense in depth + recovery)
The bug is an unhandled **rejection**, so `unhandledRejection` keep-running is the correct, sufficient backstop. `uncaughtException` is treated separately (keep-running after it is unsafe on the stateful gateway).
- **F3 (daemon).** Top of `src/main-host-daemon.ts`, before `startHostDaemon`:
  - `process.on("unhandledRejection", (reason) => console.error("[host-daemon] unhandledRejection:", reason))` — **log + keep running**. The daemon is stateless (no DurableStore); this alone makes the reported crash non-fatal even past F1.
  - `process.on("uncaughtException", (err) => { console.error("[host-daemon] uncaughtException:", err); process.exit(1); })` — **log + exit**, paired with the F6 respawn loop so it recovers from a genuinely corrupt state. Handler body stays trivial/synchronous (a throw inside the handler bypasses it and kills the process anyway).
- **F4 (gateway).** Top of `src/main-gateway.ts` (the entry; today it only `.catch`es the bootstrap promise):
  - `process.on("unhandledRejection", ...)` — log + keep running.
  - `process.on("uncaughtException", ...)` — **log + exit(1), NO flush** (placed beside the signal handlers in `src/gateway/index.ts` where the durable state is in scope). REVISED from "flush + exit": an uncaughtException can fire mid-mutation, so the crash-moment in-memory store may be inconsistent; flushing it would overwrite the last *good* snapshot with corrupt state. The last quiescent persist-timer / SIGTERM snapshot is consistent, and the docker restart policy restores from it (losing at most ~3s). Boot restore (`jobsDurable/mailboxDurable` load+restore) is wrapped in try/catch so a corrupt or partial snapshot can never crash-loop boot.
- **F6 (supervisor) — required if F3/F4 exit on uncaughtException.** Without a supervisor, "log + exit" recreates the outage.
  - `docker-compose.yml`: add `restart: unless-stopped` to the `gateway` service (currently no `restart:` key → default `no`).
  - Respawn loop: extracted to a dedicated supervisor `run-host-daemon.sh` (cleaner than cramming a loop into the `tmux "bash -c '...'"` quoting). `start-host-daemon.sh:25` now does `... && export HOST_WS_TOKEN=${HOST_WS_TOKEN} && exec ./run-host-daemon.sh`. REVISED from a flat 2s loop to **bounded exponential backoff** (2→60s, reset after a healthy ≥10s run) that **drops to `exec bash` after 5 fast crashes** — a deterministic startup crash stays inspectable instead of hot-looping forever (mirrors the asymmetry the WS reconnector already has).

### Framework refinement (as-built)
- The `unhandledRejection` handler (identical across entrypoints) was extracted to `src/shared/process-guards.ts` as `installRejectionGuard(name)`, called by `main-host-daemon.ts`, `main-gateway.ts`, **and `main-mcp.ts`** (the MCP process previously had no guard at all). `uncaughtException` stays per-entrypoint (recovery policy differs per process). Committed separately from the crash fix.

### Layer 4 - residual crash/leak paths the red-team surfaced
- **F7a.** `src/mcp/devcontainer/reloadPlugins.ts` `writeAndSpawn`: add `child.on("error", ...)` before `child.unref()`. A spawn `error` (resource exhaustion) on a listener-less child throws as an uncaughtException → daemon exit; logging it keeps the daemon up.
- **F7b.** `src/gateway/routes.ts` `relayWithRetry.tryOnce`: wrap the `await relayToGateway(...)` in try/catch so a relay throw (evie disconnect / call timeout) folds into the existing retry path instead of escaping the two `void tryOnce()` sites as an unhandled rejection. Makes the V3 sweep actually clean.

### Layer 3 - graceful peek legibility (handler-scoped only)
- **F5.** A "still booting / just exited" peek should read as *absent*, not a raw tmux error. Constraints from the audit:
  - **Do NOT touch `tmuxCore.run()`** — it is shared by `sendText`/`sendKey`/`createSession`; swallowing errors there would make a failed keystroke or session-create report success.
  - **Do NOT put it in `peekPane`/`runPeek`** — that would stop `capture` from rejecting and mask F1's crash path (and couple the two fixes / break V2's repro).
  - Implement in the **console peek handler** (`src/gateway/console/consoleHandler.ts`, `friendlyPeekError` + peek case): on `!r.ok`, if the error matches a case-insensitive **absent allowlist** — `no server running`, `can't find session`, `can't find pane`, `no such container`, `is not running` — return `"No session running - it may be starting or has stopped: ${raw}"`. REVISED to **append the raw cause** rather than drop it: some "absent" strings are permanent (dead agent, removed/crash-looped container, PROJECT_NAME mismatch), so a bare "still starting" would mask a real fault forever; appending the cause keeps it diagnosable while still leading calm. **Exclude** the synthetic transient strings `tmux command timed out` and `tmux command exited N` (tmuxCore.ts:56,76) so a real hang still surfaces as an error.
  - Keep `ok:false` (the Android `TerminalView.kt:315` error box already renders the message text). Do **not** return `ok:true` + empty `ansi` — that paints a blank black pane and, once a frame shows, suppresses later genuine failures (`ansi.isEmpty()` gate). No Kotlin changes: the friendly text is server-side.

## Verification
- **V1.** `bun run lint` (= `biome ci . && bunx tsc --noEmit`) **and** `bun run test` (= `vitest run`) both pass. (There is no `bun build` script.)
- **V2 (deterministic unit test).** `createHostOpRunner` is dependency-injected; `src/__tests__/host-op-runner.test.ts` already has a `makeOps()` vi.fn harness. Add a case injecting `peekPane: vi.fn(async () => { throw new Error("no server running on /tmp/tmux-1000/default"); })` and assert: (a) `await expect(runner.run({kind:"peek",target:T})).rejects.toThrow(/no server running/)` (the caller still sees the failure → `handleHostOp` returns `ok:false`); and (b) **no unhandled rejection escapes** — register a `process.once("unhandledRejection", ...)` spy / fail the test if it fires across a `setImmediate`/microtask drain. This is the regression lock for the leak.
- **V3 (leak sweep, regression guard).** `grep -rn "void .*\.\(finally\|then\)" src/` returns only guarded chains (`.catch(()=>{})` present). Also assert no mutating-op path (`sendText`/`sendKey`/`createSession`) treats a tmux error as success (the F5 classification must not have leaked into `run()`).
- **V4 (per-process boundary).** F1/F1b/F3 keep the **host daemon** up (it keeps serving catalog + host_ops + `wake_result`) when a peek/dispatch fails. F2/F2b/F4 keep the **gateway** up (it keeps serving `/send`, `/teams`, relay-to-host) when a wake or register chain rejects. Instrument the correct process per fix; do not conflate them.

## Out of scope (note as follow-ups)
- *Why* the evie-bot `claude` session may have exited immediately in-container (bashrc / claude launch) — separate investigation. This plan only ensures a peek/wake failure can never crash a process and is legible.

## Notes
- Branch: `biometric-toggle-gate`. Pre-existing dirty state: `plans/gateway-members-ux.md` is **deleted-but-unstaged** (not staged), `plans/gateway-auth-surface.md` is untracked. So **do not use `git commit -a/-am`** for fix commits — it would sweep the deletion + untracked plans in. `git add` the specific `src/` (and `docker-compose.yml`, `start-host-daemon.sh`) files explicitly. The fix files do not overlap the dirty plan files, so it is cleanly separable.
- Implementation cycle step selection (pre-approved by the human): run all `audited-implementation` steps **except** `compliance-fan-out`, `compliance-fix`, `compliance-commit`.

## Painpoints (crust sweep — NOT fixed in this change)

Found while fixing the crash. Locations are `file : scope : name` (no line numbers). Not addressed here; logged for a future pass.

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
