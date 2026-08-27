# Questionaire

Native Windows gateway and PowerShell sessions. The first three were decided in conversation before
the questionaire opened and are captured as asked.

## Question 1 - Docker for the gateway, per platform?

Q: Keep the gateway Dockerized everywhere, go Docker-less everywhere, or split by platform?
A: Split. Linux keeps Docker (devcontainers need the `switchboard` hostname). Windows runs the
gateway natively, no Docker.

> "no. we can't do docker less then. But we can compromise. Linux gets the Devcontainer support.
> Windows will launch Gateway on system without the docker."

## Question 2 - Which sessions must the native gateway serve?

Q: Must a hand-started session find the native gateway (a port discovery mechanism), or only
console-started ones (the daemon's launch env)?
A: Console-started only.

> "as long as it only works for console started sessions. that's fine. manually started, we won't
> have Switchboard support anyways. since it requires experimental channels."

## Question 3 - The bun floor on the hosts?

Q: Upgrade both hosts to bun 1.4+, or leave the floor to the Docker image and refuse native below it?
A: Upgrade both hosts. (The gateway refuses to start below the floor regardless; see Plan gap 2.)

> "ok well we will update both hosts to bun 1.4 then."

# Plan

## Native gateway

One gateway, two ways to launch it. Dockerized on Linux, where devcontainers need a hostname on the
`switchboard` network and the base image pins the runtime. Native on Windows, where there are no
devcontainers, Docker is the thing that does not work, and the root-owned volume is pure tax.

Reviewed by Luna before implementation; the corrections are folded in below and marked.

## What is already true

The server does not know which mode it is in, and must never learn. `src/gateway/index.ts` reads
`PORT` (default 20000), `DATA_DIR` (default `/app/data`), `ENROLL_TLS_PORT` (default 20003) and the
rest from the environment; it holds no docker socket, no privilege, and one shell-out (`openssl`, at
enrollment). Docker was only ever the launcher that set those and pinned bun. So "polymorphic" is a
property of the launcher, and the code change is confined to the places that ASSUMED the Docker
defaults.

Containers reach the gateway as a pure star: the only cross-container address in the tree is
`switchboard:20000` (`src/mcp/index.ts:99`), and the host branch beside it already dials
`localhost:20000`. Devcontainers therefore keep Docker on Linux and nothing else changes for them.

**Correction (Luna):** `DATA_DIR` is not the only container path. `LOG_DIR = /app/log`
(`index.ts:103`) is hardcoded for the one-shot schema wipe's legacy cleanup (`:150-156`). Harmless
natively (an `rmSync` with `force` on a path that does not exist), but it is a container assumption
in the process and goes behind the same env as everything else.

## The gaps, ranked

1. **The port is configurable on the server and hardcoded in every client.** `hostDaemon.ts:59`,
   `mcp/index.ts:99`, three URLs in `setup-constants.ts`, `setup-verify.ts:13`. The scripts and the
   daemon read `.env`, so they take `PORT` from there. The plugin runs in the user's process and
   reads no `.env`, so its address arrives ONLY through the launch env the daemon composes
   (`hostResolve.ts:buildLaunchCommand`), which today exports `PROJECT_NAME` and the session token
   and not `BRIDGE_ROUTER_URL`. Export it there, and have `start-host-daemon.ps1` forward it (it
   forwards `HOST_WS_TOKEN` alone). The inline export is the only reliable carrier on Linux too: a
   tmux shell inherits the tmux SERVER's environment from when it started, not the daemon's.
   Hand-started sessions are out of scope by decision: they have no channel hearing anyway.
2. **No bun floor at runtime.** Nothing reads `Bun.version` but the CI pinning check. The base image
   is what holds 1.4+, below which the `ws` substitution makes the Router pin silently do nothing
   (the recorded outage). Native runs the host's bun, and Mikan's is 1.3.14. `assertBunFloor` in
   `main-gateway.ts`, before `startGateway()` constructs or dials anything; one constant `BUN_FLOOR`
   in `shared/bun-floor.ts` that the pinning check and the docs read. Under node there is no `Bun`
   global and the real `ws` is in play, so the guard is a no-op there. **The number is observed on
   both sides, not a bun contract:** `check-pinning-runtime.ts` FAILS on sakura's old 1.3.11 (`the
   bearer reached the listener 0 times`) and PASSES on 1.4.0 (`mismatch refused before the bearer is
   sent`), measured on the same machine either side of its upgrade. Raise it only against that
   script's verdict. **Gateway only, never the shared `process-guards.ts`** (flagged by the Windows
   session): the daemon pins nothing, so a shared guard would refuse daemons for no reason, quietly,
   on the one component whose staleness has no immediate symptom. Every host is now 1.4.0 (sakura,
   Mikan's Windows side, Mikan's WSL, and the image, the last two sharing revision `34cbb9a40`).
3. **`DATA_DIR` defaults to `/app/data`.** The native default is `volumes/gateway-data` **anchored to
   the checkout**, resolved from the module's own location, never from `process.cwd()`. The setup
   scripts already use cwd-relative `volumes/...` (`setup-constants.ts`, `setup-gateway.ts:68`), so
   they must be run from the checkout regardless; a gateway started from anywhere else would split
   its state from what setup reads. The federation dir is then user-owned, which retires the three
   read-through-busybox paths on that machine (`readTransportText`, `routerState.ts`, `wipeState`).
4. **A native launcher, and graceful stop.** `start-gateway.ps1` is compose all the way down. The
   native one copies `start-host-daemon.ps1`'s shape: pid file, `Start-Process`, a supervisor with
   backoff. Lost from Docker: `restart: unless-stopped` and start-on-login, named as a cost.
   **Correction (Luna):** the durable flush at exit rides `SIGTERM`/`SIGINT` (`index.ts:440-446`),
   which write `cleanShutdown` and stop the Router client. `taskkill /F`, which `down.ps1` uses,
   skips both. The next boot then restores as after a crash (the 3s persist tick's snapshot, always
   `cleanShutdown=false`), which is consistent but loses the clean-shutdown facts. The native stop
   needs a graceful path: a loopback-only shutdown endpoint gated by `HOST_WS_TOKEN`, which the
   launcher calls before it falls back to `taskkill`.
5. **Coexistence with the WSL gateway on one machine.** `GATEWAY_ID` derives from the hostname on
   both, and the Router's registration is a `Map.set` keyed by `(domainId, gatewayId)`
   (`gatewayBridge.ts:279-288`): the newer connection takes the routing entry while the older one
   stays OPEN and unaddressable. Not a refusal, a silent hijack. So the native one is set
   explicitly. `PORT` and `ENROLL_TLS_PORT` differ (Docker Desktop publishes the WSL gateway's 20003
   on the Windows host). And the WSL checkout sets `COMPOSE_PROJECT_NAME`, because both directories
   are named `switchboard` and `docker compose` from the Windows one currently resolves to the WSL
   project - `armGateway`'s first action would have taken the live gateway down.
6. **The daemon needs devcontainers OFF by configuration.** The catalog scan is filesystem-based:
   it walks the configured project roots for `.devcontainer/devcontainer.json`
   (`hostResolve.ts:21-43`) and sends every hit (`hostDaemon.ts:146-148`). Docker's presence or
   absence changes nothing, and neither does which gateway a project "belongs" to. On Mikan the
   native daemon would therefore announce the WSL gateway's projects and wake them into the wrong
   world. The switch suppresses the catalog before the scan, read in `startHostDaemon`; disabling
   only docker operations is not enough.

Two smaller: `openssl` for the enrollment cert (Git for Windows provides one; without it, paste-only
enrollment), and 20003 natively binds the LAN interface so Windows Firewall must allow it (paste is
the fallback either way). NTFS ignores the `0o600` the identity and transport writes request; the
files inherit the user profile's ACL, which is the same posture `setup.ts` already documents.

## A PowerShell terminal needs NO new terminal code (proven on Mikan)

The premise that made a native gateway urgent - "Windows means no tmux, so no PowerShell terminal" -
is false, and the Windows session proved it rather than argued it. A tmux session **inside WSL** whose
command is `powershell.exe` satisfies all four primitives, and Windows `claude.exe` 2.1.247 renders
its full TUI in that pane: banner, model line, input box, footer, captured over `capture-pane -e -J -p`
as well-formed 24-bit SGR, driven by `send-keys` into the live input box, surviving a dozen separate
WSL entries, and found by exact-match session lookup.

So the existing WSL daemon can host PowerShell sessions today. What it needs is launch-command shape,
not architecture:

- **`tmux new-session` spawns from the tmux SERVER's environment, not the caller's.** Neither
  `export VAR=x; tmux new-session ...` nor the shell-prefix form `bash -c "VAR=x ... powershell.exe"`
  reaches a Windows child - and the shell-prefix form is exactly what `buildLaunchCommand` composes.
  The working shape is `tmux new-session -e VAR=x -e WSLENV=VAR/w`, with EVERY crossing variable
  needing both a `-e` and a mention in `WSLENV`.
- **`WSLENV` flags have a direction**: `/w` is WSL to Win32 (or no flag for both). `/u` is the reverse
  and silently fails, while `WSLENV` itself still crosses, which is a confusing thing to debug from.
- **Pass `-c` a `/mnt/<drive>/...` path.** A pane started in a Linux-only dir lands PowerShell on a
  `\\wsl.localhost\...` UNC cwd, which PowerShell tolerates and other tools do not.
- Mikan has **Windows PowerShell 5.1 only**, no pwsh 7, which is the shell with the `&&` and `2>&1`
  limitations already documented under Development.

This does not delete the native-gateway case (the root-owned volumes, the compose collision, Docker
Desktop as a dependency), but it removes PowerShell terminals from its justification, and it makes
ConPTY unnecessary for that goal.

## Windows session spawn is on the critical path, and is NOT just a launcher

`create_session` on a host target is tmux-driven and `run-host-daemon.ps1` says so: on Windows it
fails. A native gateway would federate, appear on the phone, carry a board, and spawn nothing. So a
useful Windows gateway needs a Windows spawn, and only console-started sessions matter.

**Correction (Luna):** spawn and terminal view are separable in principle, but the wake PROTOCOL is
not: `hostDaemon.ts:255-306` runs `ensureSession` then `awaitReady`, which captures the pane to
decide `live` before it sends `wake_result`, and `peekWithFallback` only falls back to `docker logs`,
which a native process has none of. So phase one is a second wake path, not a `Start-Process` in
place of `tmux new-session`: start the process with the launch env, track its pid, wait for the MCP
to REGISTER (the gateway already treats a successful wake as "registration still pending" and fails
it if registration never arrives, `websocket.ts:338-350`), and answer `wake_result` success with no
screen. No peek, no key injection; the phone sees a session it can message and cannot watch.

Phase two is ConPTY: a screen buffer readable as ANSI, keystroke injection, named exact-match
lookup, and a process that outlives the daemon. That is a supervisor someone writes, and it is out of
this plan.

## The daemon's PATH is a repo fragility, not a Mikan quirk

Mikan's daemon died on `bun: command not found` and stayed down for ~13 hours while its gateway
stayed up and `router_registered: true` - the CLAUDE.md failure mode verbatim, and invisible to
sakura's `--verify`, which reported `Gateway mikan` healthy throughout.

`start-host-daemon.sh` launches `bash -c 'cd ... && source ~/.bashrc && ... exec ./run-host-daemon.sh'`
and `run-host-daemon.sh` then calls bare `bun`. That works only if `~/.bashrc` puts bun on PATH in a
NON-interactive shell. Sakura's does, because its `.bashrc` exports PATH on line 1 with no guard. The
STOCK Debian/Ubuntu `.bashrc` early-returns for non-interactive shells, so on any machine with the
default file the daemon can never find bun. The launcher must resolve bun itself (an explicit
`~/.bun/bin` fallback, or `command -v` with a clear failure) rather than depend on a login file's
shape. `.ps1` has the same shape and the same exposure.

## Not doing

- **Docker-less devcontainers.** They need the `switchboard` hostname; Linux keeps Docker.
- **A unix socket on sakura.** It would retire the busybox paths there too, but Docker stays for
  devcontainers regardless, so the win is modest and it is a second code path forever. Do it when
  the root-owned-volume tax bites on that machine, not before.
- **ConPTY.** Phase two, above.

## Sequence

1. Gap 2 first: standalone, applies to today's Docker mode too, and is the only piece with a
   security edge.
2. Gaps 1, 3, 6 and the `LOG_DIR` env together: the env plumbing. Pure and unit-testable.
3. Gap 4 with the shutdown endpoint, and the coexistence settings, on Mikan, with the Windows
   session as hands.
4. Windows spawn, phase one: the registration-awaiting wake path.

## Verification

- The floor guard: a pure verdict under vitest; the refusal itself proven under bun by the same
  shape as `check-pinning-runtime.ts`, since node cannot see it.
- Native on Mikan: `--verify` in gateway-only mode (its own fix, pending), the Router's roster showing
  both `mikan` and the native id, and the phone listing both machines.
- The WSL gateway untouched throughout: its container id and uptime before and after.
