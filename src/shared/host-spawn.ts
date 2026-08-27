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
// `windows` (PowerShell over WSL interop) is designed but not registered; see
// `plans/windows-spawn-point.md` for the entry and the daemon-side half it lands with.

////////////////////////////////
//  Interfaces & Types

/** Everything a launch command is built from. Each field is already validated by the caller: the
 * token is hex or absent, and the workdir carries no quote that could break out of the nesting. */
export interface HostLaunchContext {
	/** `PROJECT_NAME`, the `spawn.session` composite the launched MCP registers under. */
	composite: string;
	/** The full `claude ...` invocation, flags and `--resume` included. */
	claude: string;
	/** `export SWITCHBOARD_SESSION_TOKEN=<hex>; ` or empty. Already shell-safe. */
	exportToken: string;
	/** Absolute, quote-free, already resolved. Absent means the shell's own default. */
	workdir?: string;
}

export interface HostSpawnPoint {
	/** The spawn segment. Doubles as the tmux device name and the address segment, so it must be a
	 * valid tmux slug. */
	readonly id: string;
	/** The command tmux runs for a new session. */
	build(ctx: HostLaunchContext): string;
}

////////////////////////////////
//  Registry

export const HOST_SPAWN = "host";

/** A built command longer than this is refused rather than handed to tmux, so an unexpectedly grown
 * flag or path fails at construction instead of as a half-created tmux session. */
export const MAX_LAUNCH_COMMAND_LEN = 8192;

const HOST: HostSpawnPoint = {
	id: HOST_SPAWN,
	// One `bash -c`: the PROJECT_NAME override must run in the same shell as claude, after ~/.bashrc.
	// `exec bash` rather than `exec claude` so the pane survives the agent exiting and stays peekable.
	build(ctx) {
		const cd = ctx.workdir ? `cd "${ctx.workdir}"; ` : "";
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${ctx.composite}; ${ctx.exportToken}${cd}${ctx.claude}; exec bash'`;
	},
};

const REGISTRY: readonly HostSpawnPoint[] = [HOST];

////////////////////////////////
//  Functions & Helpers

/** Whether a spawn segment names a shell on the host machine rather than a devcontainer project.
 * The ONE place that question is answered. */
export function isHostSpawn(id: string): boolean {
	return REGISTRY.some((p) => p.id === id);
}

export function hostSpawnPoint(id: string): HostSpawnPoint | undefined {
	return REGISTRY.find((p) => p.id === id);
}

/** Every host spawn id, so a catalog scan can refuse a directory that would shadow one. */
export function hostSpawnIds(): string[] {
	return REGISTRY.map((p) => p.id);
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
