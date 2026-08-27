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

## What is NOT proven

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

## The rest of the daemon-side half

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
