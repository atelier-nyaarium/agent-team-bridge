import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { type AgentResolvedTarget, parseAgentTargetId } from "../../shared/agent-execution-target.js";

////////////////////////////////
//  Interfaces & Types

/** One live child. Knows nothing of the protocol spoken over these streams. */
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

/** Narrower than the manager: a consumer cannot reach backoff or generation counters. */
export interface TargetSupervisor {
	acquire(target: AgentResolvedTarget): TargetAvailability;
	/** The generation names the lease being given up, so a late release cannot take its successor. */
	release(targetId: string, generation: number): void;
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
// Surviving this long separates a crash loop from a crash after real work.
const HEALTHY_MS = 30_000;
const MAX_FAST_FAILS = 5;
// Without a retry, repairing auth would need a daemon restart.
const GIVE_UP_COOLDOWN_MS = 5 * 60_000;

// Switchboard's own secrets. Backends authenticate from their own config files.
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
 * A deny list, so a variable a backend needs is never stripped by surprise.
 *
 * Only the LAUNCHING backend's prefix is exempt: exempting every prefix handed one backend's
 * credentials to the other's child. An absent prefix exempts nothing.
 */
export function scrubChildEnv(
	source: Record<string, string | undefined>,
	exemptPrefix?: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (SCRUBBED_EXACT.has(key)) continue;
		if (SCRUBBED_PATTERN.test(key) && !(exemptPrefix && key.startsWith(exemptPrefix))) continue;
		out[key] = value;
	}
	return out;
}

/** `docker exec -e` pairs. A container child inherits the container's environment, so only the
 * agent's own settings are worth forwarding. Scrubbed first, keeping the deny list authoritative. */
export function containerEnvArgs(source: Record<string, string | undefined>, envPrefix: string): string[] {
	return Object.entries(scrubChildEnv(source, envPrefix))
		.filter(([key]) => key.startsWith(envPrefix))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

// Parsed through the shared grammar, so it cannot drift.
function containerProject(targetId: string): string {
	const parsed = parseAgentTargetId(targetId);
	if (parsed?.kind !== "devcontainer") {
		throw Object.assign(new Error(`target is not a container id`), { code: "badTarget" });
	}
	return parsed.project;
}

// Never logged raw: it can name a path.
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

	// An unlistened stream error throws and takes the daemon down. Failures arrive through onExit.
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
 * `docker exec -i`, not `devcontainer exec`, which buffers to completion.
 *
 * Neither branch takes a caller's working directory: a thread carries its own, and a per-session
 * path here would split one target across several children.
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
				// A container-shaped id with kind "host" would run under the daemon's own user.
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error(`target is not a host id`), { code: "badTarget" });
				}
				return adoptProcess(spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] }));
			}
			default:
				// Never fall through to the unsandboxed host spawn.
				throw Object.assign(new Error(`unknown execution target kind`), { code: "badTarget" });
		}
	},
};

/** A class name, since a message may carry a path or child output. */
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
 * One child per execution target, started on first use.
 *
 * Every thread multiplexes through it, so the process count tracks targets, not conversations.
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

	/** Never throws: a target that cannot run reports why. */
	acquire(target: AgentResolvedTarget): TargetAvailability {
		const entry = this.targets.get(target.targetId) ?? {
			generation: 0,
			fastFails: 0,
			backoffMs: BACKOFF_START_MS,
			retryAt: 0,
			startedAt: 0,
		};
		this.targets.set(target.targetId, entry);

		// cwd does not take part: comparing it would let the first session lock out every later one.
		if (entry.launchedFor && entry.launchedFor.kind !== target.kind) {
			return { state: "unavailable", errorClass: "targetIdCollision" };
		}
		if (entry.lease) return { state: "running", lease: entry.lease };

		if (entry.gaveUpAt !== undefined) {
			if (this.now() - entry.gaveUpAt < GIVE_UP_COOLDOWN_MS) {
				return { state: "unavailable", errorClass: entry.errorClass ?? "launchFailed" };
			}
			// A repaired target recovers on its own.
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
			// A late exit must not tear down its successor.
			const live = this.targets.get(target.targetId);
			if (live?.lease?.generation !== lease.generation) return;
			live.lease = undefined;
			this.recordFailure(target.targetId, describeExit(info));
		});

		this.log({ targetId: target.targetId, generation: entry.generation, state: "running" });
		return { state: "running", lease };
	}

	/** A deliberate stop is not a failure, so it costs no backoff. */
	release(targetId: string, generation: number): void {
		const entry = this.targets.get(targetId);
		// A late release must not tear down its successor.
		if (entry?.lease?.generation !== generation) return;
		this.log({ targetId, generation, state: "reaped" });
		entry.lease.child.kill();
		entry.lease = undefined;
	}

	/** Generation counters survive, so no generation a late exit carries is handed out again. */
	shutdown(): void {
		for (const [targetId, entry] of [...this.targets]) {
			if (entry.lease) this.release(targetId, entry.lease.generation);
		}
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
