import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { type AgentResolvedTarget, parseAgentTargetId } from "../../shared/agent-execution-target.js";

////////////////////////////////
//  Interfaces & Types

/** One live `codex app-server` process. The manager owns its lifetime and knows nothing of the
 * protocol spoken over these streams. */
export interface AgentChild {
	readonly stdin: Writable;
	readonly stdout: Readable;
	kill(): void;
	/** `reason` is a class derived from the child's stderr, never its text. */
	onExit(listener: (info: { code: number | null; signal: string | null; reason?: string }) => void): void;
}

export type CodexChild = AgentChild;

export interface ExecutionTargetLauncher {
	launch(target: AgentResolvedTarget, env: Record<string, string>): AgentChild;
}

/** A running child plus the fence that tells a late event which child it came from. */
export interface TargetLease {
	generation: number;
	child: AgentChild;
}

/** What a consumer of supervised children actually needs. Narrower than the manager on purpose: the
 * daemon service must not be able to reach backoff or generation counters it does not own. */
export interface TargetSupervisor {
	acquire(target: AgentResolvedTarget): TargetAvailability;
	release(targetId: string): void;
}

export type TargetAvailability =
	| { state: "running"; lease: TargetLease }
	| { state: "recovering"; retryInMs: number; errorClass: string }
	| { state: "unavailable"; errorClass: string };

export interface TargetLogEvent {
	targetId: string;
	generation: number;
	state: "launching" | "running" | "recovering" | "unavailable" | "reaped";
	errorClass?: string;
}

////////////////////////////////
//  Functions & Helpers

const BACKOFF_START_MS = 1_000;
const BACKOFF_CEILING_MS = 60_000;
// A child surviving this long counts as healthy, so a crash after real work does not accumulate
// toward the give-up count the way a startup crash loop does.
const HEALTHY_MS = 30_000;
const MAX_FAST_FAILS = 5;
// A given-up target tries once more after this long. Without it, installing the missing binary or
// repairing auth would need a daemon restart, which would take every healthy target down with it.
const GIVE_UP_COOLDOWN_MS = 5 * 60_000;

// Switchboard's own secrets, which an agent child has no business seeing. Agent backends authenticate
// from their own config files (Codex from ~/.codex/auth.json), so their prefixed vars are toolchain
// settings, not Switchboard secrets.
const SCRUBBED_EXACT = new Set([
	"HOST_WS_TOKEN",
	"BRIDGE_ROUTER_URL",
	"CONSOLE_BRIDGE_TOKEN",
	"FEDERATION_DOMAIN_ID",
	"GATEWAY_ID",
	"MCP_CONNECTOR_PORT",
	"PROJECT_NAME",
	"PROJECT_HOST_PATH",
	"AGENT_TYPE",
]);
const SCRUBBED_PATTERN = /token|secret|password|credential|api[_-]?key/i;

/**
 * The child's environment: the target's own, minus anything of Switchboard's. A deny list rather
 * than an allow list, so a variable a backend needs for its toolchain is never stripped by surprise.
 * Only the LAUNCHING backend's prefix is exempt from the secret pattern: exempting every backend's
 * prefix handed one backend's operator-provided credentials to the other's host child.
 */
export function scrubChildEnv(
	source: Record<string, string | undefined>,
	exemptPrefix: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (SCRUBBED_EXACT.has(key)) continue;
		if (SCRUBBED_PATTERN.test(key) && !key.startsWith(exemptPrefix)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * What to carry INTO a container, as `docker exec -e` pairs.
 *
 * A container child inherits the container's own environment, not this process's, so the host's
 * variables are both unreachable and meaningless there. Only the selected agent's own settings are worth
 * forwarding, and scrubbing them first keeps the deny list authoritative for both launch paths.
 */
export function containerEnvArgs(source: Record<string, string | undefined>, envPrefix: string): string[] {
	return Object.entries(scrubChildEnv(source, envPrefix))
		.filter(([key]) => key.startsWith(envPrefix))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

// The project comes from the shared targetId grammar rather than from reading the field directly, so
// this cannot drift from whatever else builds one. The name is an argv element, never a shell string.
function containerProject(targetId: string): string {
	const parsed = parseAgentTargetId(targetId);
	if (parsed?.kind !== "devcontainer") {
		throw Object.assign(new Error("target is not a container id"), { code: "badTarget" });
	}
	return parsed.project;
}

// Enough of the child's stderr to tell one failure apart from another. Never logged raw, since it
// can name a path; it is only read to derive a class.
const STDERR_KEEP_BYTES = 2_000;

const STDERR_CLASSES: Array<[RegExp, string]> = [
	[/no such container/i, "noSuchContainer"],
	[/is not running/i, "containerStopped"],
	[/permission denied|cannot connect to the docker daemon/i, "dockerDenied"],
	[/not found|no such file/i, "binaryMissing"],
	[/unauthor|not logged in|auth/i, "authFailed"],
];

function adoptProcess(proc: ReturnType<typeof spawn>): AgentChild {
	let stderrTail = "";
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEEP_BYTES);
	});

	// A stream error with no listener is thrown, and an unhandled throw here would take the daemon
	// down over one target's broken pipe. Every failure has to arrive through onExit instead.
	proc.stdin?.on("error", () => {});
	proc.stderr?.on("error", () => {});
	proc.stdout?.on("error", () => {});

	return {
		stdin: proc.stdin as Writable,
		stdout: proc.stdout as Readable,
		kill: () => {
			proc.kill();
		},
		onExit: (listener) => {
			const fire = (info: { code: number | null; signal: string | null }) => {
				const matched = STDERR_CLASSES.find(([pattern]) => pattern.test(stderrTail));
				listener({ ...info, reason: matched?.[1] });
			};
			proc.once("exit", (code, signal) => fire({ code, signal }));
			proc.once("error", () => fire({ code: null, signal: null }));
		},
	};
}

/**
 * A container child goes through `docker exec -i`, the boundary the terminal ops already use,
 * because `devcontainer exec` buffers to completion and cannot carry a long-lived conversation.
 *
 * Neither branch takes a working directory from the caller. A thread carries its own cwd, so the
 * process only needs a sane one for its target, and accepting a per-session path here would both
 * split one target across several children and hand an arbitrary absolute path to `-w`.
 */
export const realLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "devcontainer": {
				const project = containerProject(target.targetId);
				const args = [
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${project}`,
					...containerEnvArgs(env, agentEnvPrefix("codex")),
					`${project}_devcontainer-dev-1`,
					"codex",
					"app-server",
				];
				return adoptProcess(spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] }));
			}
			case "host": {
				// The id has to agree with the kind in both directions. Without this, a container-shaped
				// id paired with kind "host" runs on the host under the daemon's own user, which is the
				// one direction the container branch already refuses.
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error("target is not a host id"), { code: "badTarget" });
				}
				return adoptProcess(spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] }));
			}
			default:
				// Never fall through to the host branch. An unrecognized kind reaching an unsandboxed
				// spawn is the one mistake here that runs code somewhere it was never meant to.
				throw Object.assign(new Error("unknown execution target kind"), { code: "badTarget" });
		}
	},
};

/** An error reduced to a class name. A message may carry a path or child output, neither of which
 * belongs in a log that ships. */
function classify(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "launchFailed";
}

function describeExit(info: { code: number | null; signal: string | null; reason?: string }): string {
	if (info.reason) return info.reason;
	if (info.signal) return `signal:${info.signal}`;
	return info.code === null ? "spawnError" : `exit:${info.code}`;
}

export function targetLogger(tag: string): (event: TargetLogEvent) => void {
	return (event) => {
		const suffix = event.errorClass ? ` error=${event.errorClass}` : "";
		console.error(`[${tag}] ${event.targetId} gen=${event.generation} ${event.state}${suffix}`);
	};
}

const defaultLog = targetLogger("codex-target");

////////////////////////////////
//  Class

/**
 * One `codex app-server` per execution target, started on first use.
 *
 * Every thread for a target multiplexes through that target's single child, so the process count
 * tracks targets rather than conversations. A child that dies takes only its own target with it.
 */
export class ExecutionTargetManager implements TargetSupervisor {
	private readonly targets = new Map<
		string,
		{
			lease?: TargetLease;
			launchedFor?: AgentResolvedTarget;
			generation: number;
			fastFails: number;
			backoffMs: number;
			retryAt: number;
			startedAt: number;
			errorClass?: string;
			gaveUpAt?: number;
		}
	>();

	constructor(
		private readonly launcher: ExecutionTargetLauncher = realLauncher,
		private readonly now: () => number = () => Date.now(),
		private readonly log: (event: TargetLogEvent) => void = defaultLog,
		private readonly baseEnv: Record<string, string | undefined> = process.env,
		/** The one prefix the secret scrub exempts for this manager's children. */
		private readonly envPrefix: string = agentEnvPrefix("codex"),
	) {}

	/** The target's child, started if this is its first use. Never throws: a target that cannot run
	 * reports why, so the caller answers `unavailable` rather than failing the whole daemon. */
	acquire(target: AgentResolvedTarget): TargetAvailability {
		const entry = this.targets.get(target.targetId) ?? {
			generation: 0,
			fastFails: 0,
			backoffMs: BACKOFF_START_MS,
			retryAt: 0,
			startedAt: 0,
		};
		this.targets.set(target.targetId, entry);

		// Every host session shares one targetId while carrying its own workdir, so cwd deliberately
		// does NOT take part: a thread supplies its own, and comparing it here would let the first
		// session lock out every later one. Only the launch mechanism has to match.
		if (entry.launchedFor && entry.launchedFor.kind !== target.kind) {
			return { state: "unavailable", errorClass: "targetIdCollision" };
		}
		if (entry.lease) return { state: "running", lease: entry.lease };

		if (entry.gaveUpAt !== undefined) {
			if (this.now() - entry.gaveUpAt < GIVE_UP_COOLDOWN_MS) {
				return { state: "unavailable", errorClass: entry.errorClass ?? "launchFailed" };
			}
			// One more attempt, from a clean count, so a repaired target recovers on its own.
			entry.gaveUpAt = undefined;
			entry.fastFails = 0;
			entry.backoffMs = BACKOFF_START_MS;
		}

		if (this.now() < entry.retryAt) {
			return {
				state: "recovering",
				retryInMs: entry.retryAt - this.now(),
				errorClass: entry.errorClass ?? "exited",
			};
		}

		entry.generation += 1;
		entry.startedAt = this.now();
		this.log({ targetId: target.targetId, generation: entry.generation, state: "launching" });

		let child: AgentChild;
		try {
			child = this.launcher.launch(target, scrubChildEnv(this.baseEnv, this.envPrefix));
		} catch (err) {
			return this.recordFailure(target.targetId, classify(err));
		}

		const lease: TargetLease = { generation: entry.generation, child };
		entry.lease = lease;
		entry.launchedFor = target;
		child.onExit((info) => {
			// Only the CURRENT generation's exit retires the lease. A late exit from a replaced child
			// would otherwise tear down its successor.
			const live = this.targets.get(target.targetId);
			if (live?.lease?.generation !== lease.generation) return;
			live.lease = undefined;
			this.recordFailure(target.targetId, describeExit(info));
		});

		this.log({ targetId: target.targetId, generation: entry.generation, state: "running" });
		return { state: "running", lease };
	}

	/** Stop a target's child, if it has one. A deliberate stop is not a failure, so it costs the
	 * target no backoff, and the next acquire starts a fresh generation immediately. */
	release(targetId: string): void {
		const entry = this.targets.get(targetId);
		if (!entry?.lease) return;
		this.log({ targetId, generation: entry.lease.generation, state: "reaped" });
		entry.lease.child.kill();
		entry.lease = undefined;
	}

	/** Reap every child, so none outlives the daemon. Generation counters deliberately survive: a
	 * reused manager must never hand out a generation a late exit could still be carrying. */
	shutdown(): void {
		for (const targetId of [...this.targets.keys()]) this.release(targetId);
	}

	private recordFailure(targetId: string, errorClass: string): TargetAvailability {
		const entry = this.targets.get(targetId);
		if (!entry) return { state: "unavailable", errorClass };

		if (this.now() - entry.startedAt >= HEALTHY_MS) {
			entry.fastFails = 0;
			entry.backoffMs = BACKOFF_START_MS;
		} else {
			entry.fastFails += 1;
		}
		entry.errorClass = errorClass;

		if (entry.fastFails >= MAX_FAST_FAILS) {
			entry.gaveUpAt = this.now();
			this.log({ targetId, generation: entry.generation, state: "unavailable", errorClass });
			return { state: "unavailable", errorClass };
		}

		entry.retryAt = this.now() + entry.backoffMs;
		const retryInMs = entry.backoffMs;
		entry.backoffMs = Math.min(entry.backoffMs * 2, BACKOFF_CEILING_MS);
		this.log({ targetId, generation: entry.generation, state: "recovering", errorClass });
		return { state: "recovering", retryInMs, errorClass };
	}
}
