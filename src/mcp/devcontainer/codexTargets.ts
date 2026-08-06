import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { type CodexResolvedTarget, parseCodexTargetId } from "../../shared/codex-thinking.js";

////////////////////////////////
//  Interfaces & Types

/** One live `codex app-server` process. The manager owns its lifetime and knows nothing of the
 * protocol spoken over these streams. */
export interface CodexChild {
	readonly stdin: Writable;
	readonly stdout: Readable;
	kill(): void;
	onExit(listener: (info: { code: number | null; signal: string | null }) => void): void;
}

export interface ExecutionTargetLauncher {
	launch(target: CodexResolvedTarget, env: Record<string, string>): CodexChild;
}

/** A running child plus the fence that tells a late event which child it came from. */
export interface TargetLease {
	generation: number;
	child: CodexChild;
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

// Switchboard's own secrets, which a Codex child has no business seeing. Codex authenticates from
// ~/.codex/auth.json rather than the environment, so nothing it needs is in here.
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

/** The child's environment: the target's own, minus anything of Switchboard's. A deny list rather
 * than an allow list, so a variable Codex needs for its toolchain is never stripped by surprise. */
export function scrubChildEnv(source: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (SCRUBBED_EXACT.has(key)) continue;
		if (SCRUBBED_PATTERN.test(key) && !key.startsWith("CODEX_")) continue;
		out[key] = value;
	}
	return out;
}

/**
 * What to carry INTO a container, as `docker exec -e` pairs.
 *
 * A container child inherits the container's own environment, not this process's, so the host's
 * variables are both unreachable and meaningless there. Only Codex's own settings are worth
 * forwarding, and scrubbing them first keeps the deny list authoritative for both launch paths.
 */
export function containerEnvArgs(source: Record<string, string | undefined>): string[] {
	return Object.entries(scrubChildEnv(source))
		.filter(([key]) => key.startsWith("CODEX_"))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

// The project comes from the shared targetId grammar rather than from reading the field directly, so
// this cannot drift from whatever else builds one. The name is an argv element, never a shell string.
function containerName(targetId: string): string {
	const parsed = parseCodexTargetId(targetId);
	if (parsed?.kind !== "devcontainer") {
		throw Object.assign(new Error("target is not a container id"), { code: "badTarget" });
	}
	return `${parsed.project}_devcontainer-dev-1`;
}

function adoptProcess(proc: ReturnType<typeof spawn>): CodexChild {
	return {
		stdin: proc.stdin as Writable,
		stdout: proc.stdout as Readable,
		kill: () => {
			proc.kill();
		},
		onExit: (listener) => {
			proc.once("exit", (code, signal) => listener({ code, signal }));
			proc.once("error", () => listener({ code: null, signal: null }));
		},
	};
}

// A container child goes through `docker exec -i`, the boundary the terminal ops already use,
// because `devcontainer exec` buffers to completion and cannot carry a long-lived conversation.
export const realLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		if (target.kind === "devcontainer") {
			const args = [
				"exec",
				"-i",
				"-u",
				"vscode",
				"-w",
				target.cwd,
				...containerEnvArgs(env),
				containerName(target.targetId),
				"codex",
				"app-server",
			];
			return adoptProcess(spawn("docker", args, { stdio: ["pipe", "pipe", "ignore"] }));
		}
		return adoptProcess(
			spawn("codex", ["app-server"], { cwd: target.cwd, env, stdio: ["pipe", "pipe", "ignore"] }),
		);
	},
};

/** An error reduced to a class name. A message may carry a path or child output, neither of which
 * belongs in a log that ships. */
function classify(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "launchFailed";
}

function sameTarget(left: CodexResolvedTarget | undefined, right: CodexResolvedTarget): boolean {
	return left?.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

function describeExit(info: { code: number | null; signal: string | null }): string {
	if (info.signal) return `signal:${info.signal}`;
	return info.code === null ? "spawnError" : `exit:${info.code}`;
}

function defaultLog(event: TargetLogEvent): void {
	const suffix = event.errorClass ? ` error=${event.errorClass}` : "";
	console.error(`[codex-target] ${event.targetId} gen=${event.generation} ${event.state}${suffix}`);
}

////////////////////////////////
//  Class

/**
 * One `codex app-server` per execution target, started on first use.
 *
 * Every thread for a target multiplexes through that target's single child, so the process count
 * tracks targets rather than conversations. A child that dies takes only its own target with it.
 */
export class ExecutionTargetManager {
	private readonly targets = new Map<
		string,
		{
			lease?: TargetLease;
			launchedFor?: CodexResolvedTarget;
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
	) {}

	/** The target's child, started if this is its first use. Never throws: a target that cannot run
	 * reports why, so the caller answers `unavailable` rather than failing the whole daemon. */
	acquire(target: CodexResolvedTarget): TargetAvailability {
		const entry = this.targets.get(target.targetId) ?? {
			generation: 0,
			fastFails: 0,
			backoffMs: BACKOFF_START_MS,
			retryAt: 0,
			startedAt: 0,
		};
		this.targets.set(target.targetId, entry);

		// A child's cwd and launch mechanism are fixed for its whole life, so serving one to a caller
		// asking for a different kind or cwd would hand back a process pointed somewhere else. Target
		// sameness is kind + id + cwd here, matching what the gateway's own comparison already requires.
		if (entry.lease && !sameTarget(entry.launchedFor, target)) {
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

		let child: CodexChild;
		try {
			child = this.launcher.launch(target, scrubChildEnv(this.baseEnv));
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
