import { spawn } from "node:child_process";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { parseAgentTargetId } from "../../shared/agent-execution-target.js";
import { type AgentChild, containerEnvArgs, type ExecutionTargetLauncher } from "./codexTargets.js";

export const copilotLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "devcontainer": {
				const parsed = parseAgentTargetId(target.targetId);
				if (parsed?.kind !== "devcontainer")
					throw Object.assign(new Error(`target is not a container id`), { code: "badTarget" });
				return spawnCopilot([
					"docker",
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${parsed.project}`,
					...containerEnvArgs(env, agentEnvPrefix("copilot")),
					`${parsed.project}_devcontainer-dev-1`,
					"copilot",
					"--acp",
					"--stdio",
				]);
			}
			case "host":
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error(`target is not a host id`), { code: "badTarget" });
				}
				return spawnCopilot(["copilot", "--acp", "--stdio"], env);
			default:
				throw Object.assign(new Error(`unknown execution target kind`), { code: "badTarget" });
		}
	},
};

function spawnCopilot(args: string[], env?: Record<string, string>): AgentChild {
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
