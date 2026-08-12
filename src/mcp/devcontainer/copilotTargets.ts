import { spawn } from "node:child_process";
import { type CodexResolvedTarget, parseCodexTargetId } from "../../shared/codex-thinking.js";
import {
	type CodexChild,
	type ExecutionTargetLauncher,
	ExecutionTargetManager,
	scrubChildEnv,
} from "./codexTargets.js";

export type CopilotChild = CodexChild;
export type CopilotResolvedTarget = CodexResolvedTarget;

function copilotContainerEnvArgs(source: Record<string, string | undefined>): string[] {
	return Object.entries(scrubChildEnv(source))
		.filter(([key]) => key.startsWith("COPILOT_"))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export const copilotLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "devcontainer": {
				const parsed = parseCodexTargetId(target.targetId);
				if (parsed?.kind !== "devcontainer")
					throw Object.assign(new Error("target is not a container id"), { code: "badTarget" });
				return spawnCopilot([
					"docker",
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${parsed.project}`,
					...copilotContainerEnvArgs(env),
					`${parsed.project}_devcontainer-dev-1`,
					"copilot",
					"--acp",
					"--stdio",
				]);
			}
			case "host":
				if (parseCodexTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error("target is not a host id"), { code: "badTarget" });
				}
				return spawnCopilot(["copilot", "--acp", "--stdio"], env);
			default:
				throw Object.assign(new Error("unknown execution target kind"), { code: "badTarget" });
		}
	},
};

function spawnCopilot(args: string[], env?: Record<string, string>): CopilotChild {
	const [command, ...argv] = args;
	const proc = spawn(command!, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2_000);
	});
	proc.stdin?.on("error", () => {});
	proc.stdout?.on("error", () => {});
	proc.stderr?.on("error", () => {});
	return {
		stdin: proc.stdin!,
		stdout: proc.stdout!,
		kill: () => proc.kill(),
		onExit(listener) {
			const fire = (code: number | null, signal: string | null) => {
				const reason = /authentication|required|login/i.test(stderr) ? "authFailed" : undefined;
				listener({ code, signal, reason });
			};
			proc.once("exit", (code, signal) => fire(code, signal));
			proc.once("error", () => fire(null, null));
		},
	};
}

export class CopilotTargetManager extends ExecutionTargetManager {
	constructor(
		launcher: ExecutionTargetLauncher = copilotLauncher,
		now: () => number = () => Date.now(),
		log?: (event: {
			targetId: string;
			generation: number;
			state: "launching" | "running" | "recovering" | "unavailable" | "reaped";
			errorClass?: string;
		}) => void,
		baseEnv: Record<string, string | undefined> = process.env,
	) {
		super(
			launcher,
			now,
			log ?? ((event) => console.error(`[copilot-target] ${event.targetId} ${event.state}`)),
			baseEnv,
		);
	}
}
