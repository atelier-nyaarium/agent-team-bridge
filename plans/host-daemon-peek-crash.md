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
