import { type ChildProcess, spawn } from "node:child_process";

////////////////////////////////
//  Interfaces & Types

export interface PortForwardConfig {
	kubeconfig: string;
	namespace: string;
	deploymentLabel: string;
	remotePort: number;
	localPort: number;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Resolves the current pod name for a deployment by label selector.
 */
function resolvePodName({ kubeconfig, namespace, deploymentLabel }: PortForwardConfig): string | null {
	const result = Bun.spawnSync({
		cmd: [
			"kubectl",
			"--kubeconfig",
			kubeconfig,
			"get",
			"pods",
			"-n",
			namespace,
			"-l",
			deploymentLabel,
			"--field-selector",
			"status.phase=Running",
			"-o",
			"jsonpath={.items[0].metadata.name}",
		],
		timeout: 15_000,
	});

	const name = result.stdout.toString().trim();
	if (!name || name === "{}") return null;
	return name;
}

/**
 * Manages a kubectl port-forward child process with auto-restart.
 * Resolves the pod name dynamically on each start so pod restarts are handled.
 */
export function startPortForward(config: PortForwardConfig): { stop: () => void } {
	let proc: ChildProcess | null = null;
	let stopped = false;
	let restartTimer: ReturnType<typeof setTimeout> | null = null;

	function start(): void {
		if (stopped) return;

		const podName = resolvePodName(config);
		if (!podName) {
			console.error(`[port-forward] no running pod found for ${config.deploymentLabel} in ${config.namespace}`);
			scheduleRestart(10_000);
			return;
		}

		console.log(`[port-forward] ${podName} ${config.remotePort} → localhost:${config.localPort}`);

		proc = spawn(
			"kubectl",
			[
				"--kubeconfig",
				config.kubeconfig,
				"port-forward",
				"-n",
				config.namespace,
				`pod/${podName}`,
				`${config.localPort}:${config.remotePort}`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		proc.stdout?.on("data", (data: Buffer) => {
			const line = data.toString().trim();
			if (line) console.log(`[port-forward] ${line}`);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const line = data.toString().trim();
			if (line) console.error(`[port-forward] ${line}`);
		});

		proc.on("exit", (code) => {
			proc = null;
			if (stopped) return;
			console.error(`[port-forward] exited with code ${code}, restarting in 5s...`);
			scheduleRestart(5_000);
		});

		proc.on("error", (err) => {
			console.error(`[port-forward] spawn error: ${err.message}`);
			proc = null;
			if (!stopped) scheduleRestart(5_000);
		});
	}

	function scheduleRestart(delayMs: number): void {
		if (stopped) return;
		if (restartTimer) clearTimeout(restartTimer);
		restartTimer = setTimeout(start, delayMs);
	}

	function stop(): void {
		stopped = true;
		if (restartTimer) clearTimeout(restartTimer);
		if (proc) {
			proc.kill("SIGTERM");
			proc = null;
		}
		console.log(`[port-forward] stopped`);
	}

	start();

	return { stop };
}
