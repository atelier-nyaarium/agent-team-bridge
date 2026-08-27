# Windows spawn point

A second host spawn point, `windows`, so a WSL machine can run agents on its Windows side. Its tmux
session still runs in WSL; only the interpreter crosses, through WSL interop (`powershell.exe` is
directly runnable from a WSL shell).

`mikan-windows` as a separate native Gateway was cancelled: if WSL can host Windows-side sessions,
a whole second Gateway is not worth building. That decision is what this replaces.

## Not renaming `host` to `wsl`

Decided and closed. `host` is an address segment (`domain.gateway.spawn.session`) keying
`SessionStore` records, `session-resume.json`, phone thread identity and board `sessionId`. Live
evidence at the time: `["evie-bot.0713b7","nyaakube.f01569","host.9282c1","host.889873"]`. Renaming
strands every one. The console RELABELS it as "WSL" when a `windows` spawn point is present on the
same Gateway; the wire word never changes.

## Done: the registry (shipped separately)

`src/shared/host-spawn.ts` owns "which spawn segment means a shell on the host machine". It exists
because that rule was a bare `project === "host"` literal in **eight** sites that all had to agree:

- `hostResolve.resolveWatchTarget`
- `consoleTargets.tmuxTarget`
- `hostDaemon`'s wake dispatcher (missed by the first design pass; a `windows` wake would have
  fallen through to the devcontainer path and looked for a container named after a shell)
- `wakeService`'s reservation check
- `codexAgentService.resolveExecutionTarget` / `copilotAgentService.resolveExecutionTarget`
- `codexRoute` / `copilotRoute` cwd gates, which must agree with the two resolvers above or a `cwd`
  is silently ignored on one path and rejected on the other

Plus `tmuxCore.selfSessionTarget`, which held the literal as a VALUE (`name: "host"` while its
sibling came from `PROJECT_NAME`), so a devcontainer session reported itself as the host spawn point.
Inert, because the host argv branch never reads `name` - but a test pinned it, which is how a lie
outlives the reason it was written.

`host-spawn-residue.test.ts` fails the build if a new site re-derives the rule. It found the four
Codex/Copilot sites on its first run, after a careful audit had already named four.

## The `windows` entry

Not registered yet. Registering it makes `isHostSpawn("windows")` true at every resolver, which
resolves `windows.<session>` to a host target and hands its daemon-side half a Linux path it cannot
use. It lands with that half, in one commit.

The block below does NOT compile against the landed registry, deliberately: `HostLaunchContext` has
no `shellExe` and there is no `DEFAULT_WINDOWS_SHELL`, because both exist only to serve a detected
spawn point and speculative fields on a one-entry registry are just unread code. They land with this
entry. It is a design record, not a paste-ready patch.

```ts
const WINDOWS: HostSpawnPoint = {
	id: WINDOWS_SPAWN,
	alwaysAvailable: false,
	nativePaths: false,
	build(ctx) {
		const exe = ctx.shellExe || DEFAULT_WINDOWS_SHELL;
		const script = ctx.workdir ? `Set-Location -LiteralPath '${ctx.workdir}'\n${ctx.claude}\n` : `${ctx.claude}\n`;
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const crossed = ctx.exportToken
			? 'export WSLENV="${WSLENV:+$WSLENV:}PROJECT_NAME/w:SWITCHBOARD_SESSION_TOKEN/w"; '
			: 'export WSLENV="${WSLENV:+$WSLENV:}PROJECT_NAME/w"; ';
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${ctx.composite}; ${ctx.exportToken}${crossed}exec ${exe} -NoLogo -NoExit -EncodedCommand ${encoded}'`;
	},
};
```

Three things in there are load-bearing:

- **`WSLENV`, appended rather than assigned.** An exported variable does NOT reach a Win32 child on
  its own; WSL passes only what `WSLENV` names. Both identity variables are listed with `/w` (cross
  WSL->Win32, no path translation; a path would want `/p`). Without it the launched agent registers
  under a derived name and cannot claim its binding. Assigning would discard whatever else the
  user's environment was already propagating.
- **`-EncodedCommand`, not nested quoting.** The alternative escapes through four parsers
  (tmux -> `bash -c '...'` -> `powershell.exe` argv -> PowerShell -> claude argv). Base64 contains no
  shell metacharacter, so the whole class is inexpressible rather than merely handled. The encoding
  is base64 of **UTF-16LE**, which is why it is not the obvious `from(s).toString("base64")`.
- **`-NoExit`** is the PowerShell twin of `exec bash`: the pane outlives the agent and stays
  peekable. A pane that dies with the agent breaks reattach and the terminal view.

## Measured on mikan (WSL Ubuntu-24.04 on Windows, Windows PowerShell 5.1.26100)

Everything below was executed, not reasoned. It replaces the assumption list that used to be here.

**Confirmed working, no change needed:**

- `WSLENV` carries the variable across. The probe pane printed `PN=[windows.probe]`, so the identity
  mechanism holds and a launched agent can be told its own name.
- `-EncodedCommand` (base64 of UTF-16LE) is accepted.
- `-NoExit` leaves a live interactive prompt under the script's output, so the pane outlives the
  agent and stays peekable, which is what reattach and the console terminal view need.
- Speed is not a design constraint: ~0.36s to an interactive prompt, and `claude.exe --version`
  returns in ~0.2s. A 2s grace in the wake path is generous.

**Three findings that CHANGED the design:**

1. **It is `claude.exe`, not `claude`.** `Get-Command claude,claude.cmd,claude.exe` returned only
   `claude.exe` (at `C:\Users\<user>\.local\bin\claude.exe`); the bare name and the `.cmd` do not
   resolve. So the binary name is per-spawn-point and cannot stay baked into the one `claude ...`
   string `buildLaunchCommand` composes for bash. A detector probing for bare `claude` would also
   have reported the feature impossible on a machine where it works.

2. **No `pwsh.exe` here, and the obvious detection is a trap.** `command -v pwsh.exe powershell.exe`
   exits **0** because *any* argument resolved, so a detector branching on the exit status concludes
   pwsh exists and hands back a dead session - precisely the failure this detection exists to
   prevent. The output must be parsed, never the status. Consequently the "prefer pwsh" branch is
   DROPPED for now rather than shipped untested: there is no machine to exercise it on, and an
   untested preference branch on the launch path is worse than not having one.

3. **A WSL path translates to a UNC path, and a UNC cwd is not sound.** `wslpath -w ~` gives
   `\\wsl.localhost\Ubuntu-24.04\home\nyaarium`, and the probe pane inherited WSL's cwd, landing
   PowerShell on the `Microsoft.PowerShell.Core\FileSystem::` provider form rather than a real Win32
   working directory. `claude.exe` tolerated it, so it is not fatal - but Windows PowerShell cannot
   give a legacy console app a UNC cwd, so a subprocess can silently get `C:\Windows` instead, and
   `cmd.exe` refuses UNC outright. Inheriting therefore works in a probe and produces a confusing
   dead session later, which is the worst shape a bug can have.

   So the Windows spawn point must `Set-Location` to a DRIVE path explicitly and never inherit. A
   hint that translates to a `\\` UNC is on the Linux side and is a category error for a Windows
   session: refuse it, naming `/mnt/c/...` as the shape that works. With no hint at all the default
   must also be Windows-side, so detection should capture `$env:USERPROFILE` in the same probe that
   looks for `claude.exe` rather than falling back to the WSL home.

## Still not proven

Whether a Windows-launched agent's MCP registers back to the Gateway across the WSL network
boundary. That needs a real launch and is the one unknown the probe could not reach.

## Superseded assumption list, kept for the record

None of the Windows half has been executed. No Windows machine was reachable in the session that
designed it: `mikan` (the WSL box) was asleep and the Windows Switchboard session was gone from the
roster. Every item below is a reasoned assumption, not a measurement, and each one silently produces
a session that dies at launch if it is wrong.

1. **Is `claude` callable from Windows PowerShell at all**, and under what name (`claude`,
   `claude.cmd`)? The whole feature is void if it is not installed on the Windows side.
2. **Does `-NoExit -EncodedCommand` leave an interactive prompt** after the encoded script finishes,
   or does the script need to end differently?
3. **Does `WSLENV=PROJECT_NAME/w` actually arrive** in the PowerShell child's environment?
4. **Does the launched agent's own MCP register correctly** from the Windows side, i.e. does it
   reach the Gateway at all across the WSL network boundary?
5. **`wslpath -w` round trip:** does `Set-Location -LiteralPath 'C:\...'` land where expected, and
   what does a WSL-only path (`\\wsl.localhost\...`) do to startup time?

Probe first, build second. One tmux session on the WSL box answers 1 through 4:

```bash
tmux new-session -d -s wintest "bash -c 'export PROJECT_NAME=windows.probe; export WSLENV=\"\${WSLENV:+\$WSLENV:}PROJECT_NAME/w\"; exec powershell.exe -NoLogo -NoExit -Command \"echo \$env:PROJECT_NAME; Get-Command claude\"'"
tmux capture-pane -e -J -p -t =wintest.0
```

## Built (daemon and gateway halves)

`windows` is registered, and a machine that cannot run one refuses a wake with a reason rather than
producing a dead pane. `src/mcp/devcontainer/windowsSpawn.ts` owns the daemon side.

- **Detection probes for the AGENT.** One `powershell.exe -NoProfile` call gets both `claude.exe` and
  `$env:USERPROFILE`, cached per daemon process. `command -v pwsh.exe powershell.exe` is NOT how to
  do this: it exits 0 when EITHER resolves, so a status check reports pwsh present on a machine with
  none. The pwsh preference is dropped entirely rather than shipped untested.
- **`resolveSpawnWorkdir` is the one resolver** the wake path and the console's `create_session` both
  use, because they were two sites answering the same question.
- **Browsing is NATIVE**, through `Get-ChildItem`. Browsing `/mnt/c` from the Linux side was the
  cheap alternative and is wrong: the picker would offer `/home/you/...`, which the launch then
  refuses, so it presents choices that cannot work, and it cannot see a network drive. The `list_dirs`
  op carries an optional `spawn` naming which filesystem to browse; absent keeps the old behaviour.
  Claiming this needed no wire change was wrong on its own terms - stopping the dead end requires the
  op to know the target either way.
- **Windows paths travel with FORWARD slashes.** Backslash is in `WORKDIR_PATH_FORBIDDEN` because of
  shell nesting and stays there; PowerShell takes `C:/Users/me` everywhere it takes the backslash
  form. `isSpawnWorkdirPath` picks the rule from the spawn point and is shared by the boundary and
  the daemon's re-guard.
- The daemon announces detected spawn points on its catalog frame. Nothing consumes that yet.

Known limit: a drive WSL has not mounted is unreachable from the `/mnt` side, but native browsing
does not care, so this only affects a caller that hand-writes a `/mnt` path.

## Still to do

**The wire.** The gateway stores the daemon's announced `hostSpawns` and serves them as discovery
metadata on `list_teams`, per the section below. Until then a Windows session is reachable only by
typing its address.

**The console.** Show it, label `host` as "WSL" only when a `windows` spawn point exists on that
Gateway, sort Windows first, and start the directory picker on the Windows side.

**Unproven:** whether a Windows-launched agent's MCP registers back across the WSL network boundary.
One real wake settles it.

## Original notes on the daemon-side half

- **Detection.** `powershell.exe` on PATH proves a shell, not a working agent. Probe Windows-side
  `claude` through the same boundary (`Get-Command claude`), since offering the spawn point without
  it produces a guaranteed failed wake AFTER tmux state exists. Cache per daemon process, both
  outcomes, invalidated on daemon start and a bounded TTL. ~1s per probe is fine at catalog refresh,
  not per console render. Prefer `pwsh.exe` over `powershell.exe` when both are present, and pass
  what was found as `shellExe` rather than re-deciding at build time.
- **Workdir.** `hostDaemon.ts:381` resolves a workdir only for `target.kind === "host"` and produces
  a Linux path. `/mnt/c/foo` is not a usable PowerShell cwd; it must become `C:\foo` via
  `wslpath -w`. The translation belongs in the daemon, after resolution and before the launch build,
  gated on `nativePaths: false`. A path that cannot translate should be reported, not silently
  swapped for the WSL home, which would open the session in the wrong tree.
- **Directory browser.** `onListDirs` lists Linux directories through `listHostDirs`. A Windows spawn
  point must browse what Windows can see. The op carries only `{ path }` today, so it cannot tell the
  two apart and needs the target.

## The wire: how the console learns a Gateway offers it

The console hardcodes `listOf("host")` (`SessionsScreen.kt:363`) and has no channel for "this
Gateway also offers windows". Both obvious answers are wrong:

- **A presence row with `kind: "devcontainer"`** is a lie consumed by policy, not just UI.
  `gatewayRelay.ts:119` makes `devcontainer` and `loose` shareable to linked friend Domains. It
  would not auto-expose anything (`gateCrossDomainTarget` also requires an explicit
  `shareState.isSharedTo`), but it would make a Windows shell shareABLE, which `host` is not: `host`
  has no presence row at all, so `localKind` returns undefined and it can never be shared.
- **A new `TeamKind` variant** is not merely invisible on old consoles. `federation-protocol.ts:52`
  narrows cross-Domain presence to a strict `["devcontainer","loose"]`, so an old Gateway's
  validation of a relayed list fails and can drop the whole discovery answer.

So `windows` gets **no presence row**, mirroring `host` exactly. The fact travels as discovery
metadata on the `list_teams` result instead - a Gateway-scoped field, not a team row, which also
survives a Gateway with zero sessions (the console still renders a section for it via the `empties`
path at `SessionsScreen.kt:88-92`):

```ts
gatewaySpawnPoints?: Array<{ domainId?: string; gatewayId: string; hostSpawns: string[] }>;
```

Touching `schemasConsoleResults.ts` (`ConsoleListTeamsResultSchema`), `schemasPresence.ts` for the
shared shape, and the federated `list_teams` path: `federation-protocol.ts`,
`presenceExchange.ts`'s `ListTeamsRelayResultSchema`, `gatewayRelay.ts`'s `list_teams` response,
`routes.discoverFull()`, and the console handler. The console merges by `(domainId, gatewayId)`.

Old console, new field: unknown optional, ignored, shows only `host`. New console, old Gateway:
field absent, shows only `host`. New Gateway reached through an OLD route Gateway: the old relay
schema strips it, so absence must read as "not advertised", never as "Windows unavailable" phrased
as an error.

Rejected: putting it in the daemon capability union (`daemonCapabilities.ts`). That union is local to
one Gateway and keyed by MCP tool-gating capability ids; it cannot say WHICH of several Gateways owns
the spawn point, and it would make a machine's shell look like a plugin capability.

## Console

`windows` arrives as an ordinary extra spawn point. Label `host` as "WSL" only when a `windows`
spawn point is present on that Gateway, so a Linux machine is unaffected. Sort Windows first.

## Open, deliberately

`hostSpawnIds()` is excluded from the catalog scan, so a directory named `windows` cannot become a
devcontainer project and make `windows.<session>` mean two things. A pre-existing project by that
name on someone's machine silently disappears from their catalog. Acceptable: the ambiguity is worse,
and the collision is rare enough that it has not been observed.
