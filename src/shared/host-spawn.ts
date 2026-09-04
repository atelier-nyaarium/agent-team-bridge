// The host spawn points a machine offers, and what each one launches.
//
// A host spawn point is a named SHELL on the host machine. Today there is one, `host`, which is
// bash. It produces an ordinary tmux session on the host, and everything downstream - peek,
// tmux_send, forget, SessionStore, the address grammar - reads that session the same way.
//
// This module exists because the rule "which spawn segment means the host machine" was a bare
// `project === "host"` literal in FOUR files that all had to agree: hostResolve.resolveWatchTarget,
// consoleTargets.tmuxTarget, hostDaemon's wake dispatcher, and wakeService's reservation check. A
// fifth site read the same literal as a VALUE (tmuxCore.selfSessionTarget hardcoded `name: "host"`
// while deriving its sibling field from PROJECT_NAME). Here it is one table, so a second host spawn
// point is one entry rather than an edit in every file that asks the question.
//
// Pure by construction: no node imports, so the gateway and the host MCP can both read it under the
// same rule that keeps `host-op.ts` dependency-free. DETECTION is deliberately absent - only the
// machine running the daemon can probe itself - and so is path translation, which needs `wslpath`.
//
// `windows` is PowerShell over WSL interop, and its daemon-side half lives in `windowsSpawn.ts`.

////////////////////////////////
//  Interfaces & Types

/** Everything a launch command is built from. Each field is already validated by the caller: the
 * token is hex or absent, and the workdir carries no quote that could break out of the nesting. */
export interface HostLaunchContext {
	/** `PROJECT_NAME`, the `spawn.session` composite the launched MCP registers under. */
	composite: string;
	/** The agent invocation WITHOUT its binary name: flags, `--resume`, everything after argv[0].
	 * Split out because the binary differs per spawn point - measured on a WSL box, bare `claude`
	 * and `claude.cmd` do not resolve from Windows PowerShell and only `claude.exe` does. */
	claudeArgs: string;
	/** `export SWITCHBOARD_SESSION_TOKEN=<hex>; ` or empty. Already shell-safe. */
	exportToken: string;
	/** Absolute, quote-free, already resolved. For a spawn point whose shell does not share the
	 * host's filesystem view this is the TRANSLATED path, because only the daemon can translate.
	 * Absent means the spawn point's own default. */
	workdir?: string;
	/** A directory to put ahead of PATH, absolute and shell-safe: the daemon's own bun bin dir, so
	 * the plugin's `bun` resolves under a tmux server whose environment lacks it. */
	pathPrefix?: string;
}

/**
 * What a gateway knows about its machine's detected spawn points.
 *
 * Three-valued by construction rather than two: `known: false` is "no daemon has told us", which is
 * NOT the same answer as `known: true, ids: []` ("the daemon looked and found nothing beyond host").
 * Collapsing them makes an older daemon, and a machine whose daemon is down, both report an
 * affirmative "no Windows here" - the exact absent-means-no mistake the optional wire field exists
 * to avoid.
 */
export interface HostSpawnState {
	known: boolean;
	ids: string[];
}

export interface HostSpawnPoint {
	/** The spawn segment. Doubles as the tmux device name and the address segment, so it must be a
	 * valid tmux slug. */
	readonly id: string;
	/** True when every machine has it. A detected one is announced by the daemon instead. */
	readonly alwaysAvailable: boolean;
	/** Whether the shell shares the host's filesystem view. False means a resolved workdir must be
	 * translated before it can be handed over, and that the spawn point's own default is not the
	 * host's home directory. */
	readonly nativePaths: boolean;
	/** The command tmux runs for a new session. */
	build(ctx: HostLaunchContext): string;
}

////////////////////////////////
//  Registry

export const HOST_SPAWN = "host";
export const WINDOWS_SPAWN = "windows";

/** Windows PowerShell 5.1, which ships with every Windows. `pwsh.exe` (PowerShell 7) is deliberately
 * NOT preferred: it was absent on the only machine available to test on, so a preference branch
 * would ship untested on the launch path, which is worse than not having one. Add it with a machine
 * to exercise it, and parse the detector's OUTPUT when you do - `command -v a b` exits 0 when EITHER
 * resolves, so a status check reports pwsh present on a box that has none and hands back a dead
 * session, which is the exact failure detection exists to prevent. */
const WINDOWS_SHELL = "powershell.exe";

/** A path handed to a `nativePaths: false` spawn point must be a real drive path. `wslpath -w` turns
 * a Linux path into a `\\wsl.localhost\...` UNC, which PowerShell accepts as a provider path but
 * cannot pass to a legacy console app, so subprocesses silently land elsewhere. Callers refuse on
 * this rather than translating and hoping. */
export function isUncPath(path: string): boolean {
	return path.startsWith("\\\\");
}

/** PowerShell's `-EncodedCommand` takes base64 of UTF-16LE, which is why this is not the obvious
 * `from(s).toString("base64")`. */
export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** A built command longer than this is refused rather than handed to tmux, so an unexpectedly grown
 * flag or path fails at construction instead of as a half-created tmux session. */
export const MAX_LAUNCH_COMMAND_LEN = 8192;

const HOST: HostSpawnPoint = {
	id: HOST_SPAWN,
	alwaysAvailable: true,
	nativePaths: true,
	// One `bash -c`: the PROJECT_NAME override must run in the same shell as claude, after ~/.bashrc.
	// `exec bash` rather than `exec claude` so the pane survives the agent exiting and stays peekable.
	build(ctx) {
		const cd = ctx.workdir ? `cd "${ctx.workdir}"; ` : "";
		// ~/.bashrc returns early for a non-interactive shell, so it adds nothing to PATH here.
		const path = ctx.pathPrefix ? `export PATH="${ctx.pathPrefix}:$PATH"; ` : "";
		return `bash -c 'source ~/.bashrc; ${path}export PROJECT_NAME=${ctx.composite}; ${ctx.exportToken}${cd}claude ${ctx.claudeArgs}; exec bash'`;
	},
};

/** PowerShell over WSL interop. Its tmux session still runs in WSL; only the interpreter crosses.
 *
 * Every decision here is measured on a WSL box rather than reasoned:
 *
 * - `WSLENV`, APPENDED not assigned. An exported variable does not reach a Win32 child on its own;
 *   WSL passes only what WSLENV names. Both identity variables are listed with `/w` (cross the
 *   boundary, no path translation). Verified: the probe pane printed its own PROJECT_NAME back.
 *   Assigning would discard whatever else the environment was already propagating.
 * - `-EncodedCommand`, base64 of UTF-16LE. The alternative is hand-nested quoting through four
 *   parsers (tmux, `bash -c '...'`, powershell.exe argv, PowerShell), and base64 has no shell
 *   metacharacter, so the whole class is inexpressible rather than merely handled.
 * - `-NoExit` is the twin of `exec bash`: verified to leave a live prompt, which is what keeps the
 *   pane peekable after the agent exits.
 * - `claude.exe` by full name. Bare `claude` and `claude.cmd` do NOT resolve from Windows PowerShell.
 * - `Set-Location` ALWAYS, never inheriting. The pane inherits WSL's cwd, which puts PowerShell on a
 *   `\\wsl.localhost\...` UNC provider path. Windows PowerShell cannot give a legacy console app a
 *   UNC cwd, so a subprocess can silently land in C:\Windows and cmd.exe refuses UNC outright. It
 *   works in a probe and dies confusingly later, so the daemon resolves a real drive path and this
 *   always sets it. A context reaching here with no workdir is a daemon bug, not a default to guess.
 */
const WINDOWS: HostSpawnPoint = {
	id: WINDOWS_SPAWN,
	alwaysAvailable: false,
	nativePaths: false,
	build(ctx) {
		if (!ctx.workdir) {
			throw new Error("refusing to launch: a windows session needs a resolved Windows working directory");
		}
		const script = `Set-Location -LiteralPath '${ctx.workdir}'\nclaude.exe ${ctx.claudeArgs}\n`;
		const crossed = ctx.exportToken
			? 'export WSLENV="${WSLENV:+$WSLENV:}PROJECT_NAME/w:SWITCHBOARD_SESSION_TOKEN/w"; '
			: 'export WSLENV="${WSLENV:+$WSLENV:}PROJECT_NAME/w"; ';
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${ctx.composite}; ${ctx.exportToken}${crossed}exec ${WINDOWS_SHELL} -NoLogo -NoExit -EncodedCommand ${encodePowerShellCommand(script)}'`;
	},
};

const REGISTRY: readonly HostSpawnPoint[] = [HOST, WINDOWS];

////////////////////////////////
//  Functions & Helpers

/** Whether a spawn segment names a shell on the host machine rather than a devcontainer project.
 * The ONE place that question is answered. */
export function isHostSpawn(id: string): boolean {
	return REGISTRY.some((p) => p.id === id);
}

/** Whether a team name is a SESSION on a host shell, i.e. `<hostSpawn>.<session>`. Answered from the
 * spawn registry rather than a `host.` prefix, so `windows.*` is never missed. A bare spawn name is
 * not a session and answers false. */
export function isHostSpawnSession(team: string): boolean {
	const dot = team.indexOf(".");
	if (dot <= 0 || dot === team.length - 1) return false;
	return isHostSpawn(team.slice(0, dot));
}

export function hostSpawnPoint(id: string): HostSpawnPoint | undefined {
	return REGISTRY.find((p) => p.id === id);
}

/** Every host spawn id, so a catalog scan can refuse a directory that would shadow one. */
export function hostSpawnIds(): string[] {
	return REGISTRY.map((p) => p.id);
}

/** The spawn points every machine has. Everything else must be detected before it is offered. */
export function alwaysAvailableHostSpawns(): string[] {
	return REGISTRY.filter((p) => p.alwaysAvailable).map((p) => p.id);
}

/** The spawn points a machine must probe for. */
export function detectableHostSpawns(): string[] {
	return REGISTRY.filter((p) => !p.alwaysAvailable).map((p) => p.id);
}

/** Build a host spawn point's launch command, refusing an unknown id and an over-long result. */
export function buildHostLaunch(id: string, ctx: HostLaunchContext): string {
	const point = hostSpawnPoint(id);
	if (!point) throw new Error(`"${id}" is not a host spawn point`);
	const command = point.build(ctx);
	if (command.length > MAX_LAUNCH_COMMAND_LEN) {
		throw new Error(`refusing to launch: command is ${command.length} chars (max ${MAX_LAUNCH_COMMAND_LEN})`);
	}
	return command;
}
