import fs from "node:fs";
import { $ } from "bun";
import { blockerMessage, type DockerFacts, diagnoseDocker, isWsl, rootlessSocketPath } from "./docker-preflight.js";

////////////////////////////////
//  Probe
//
//  The bun-only half of the preflight: it gathers facts and nothing else, so the rules that read
//  them stay importable from the node-run test suite. Kept apart for that reason alone.

/**
 * Whether this machine has a docker service, and what it is doing.
 *
 * LoadState FIRST, and `is-active` only once the unit is known to exist. `systemctl is-active` on a
 * unit that was never installed also prints "inactive", so reading existence from it produces
 * "installed but not running" on a machine with no docker service at all - and sends the operator to
 * `systemctl enable --now docker`, which simply errors. That is exactly what happened on a WSL box
 * running Docker Desktop, where the daemon lives on Windows and the distro holds only the CLI.
 */
async function systemdUnitState(): Promise<DockerFacts["systemdUnit"]> {
	const load = await $`systemctl show -p LoadState --value docker.service`.quiet().nothrow();
	const err = load.stderr.toString().toLowerCase();
	// A distro with no systemd says so on stderr; a missing systemctl is the same answer for our
	// purposes, since both mean "this machine does not start docker that way".
	if (err.includes("not been booted with systemd") || err.includes("command not found")) return "no-systemd";
	const state = load.stdout.toString().trim();
	if (state === "masked") return "masked";
	if (state !== "loaded") return load.exitCode === 0 ? "absent" : "no-systemd";

	const active = (await $`systemctl is-active docker`.quiet().nothrow()).stdout.toString().trim();
	if (active === "active") return "active";
	if (active === "failed") return "failed";
	return "inactive";
}

export async function readDockerFacts(): Promise<DockerFacts> {
	// `docker --version` is client-only and answers with no daemon; `docker version` (no dashes)
	// contacts one, which is the distinction the whole diagnosis rests on.
	const [cli, daemon, compose, systemdUnit] = await Promise.all([
		$`docker --version`.quiet().nothrow(),
		$`docker version --format ${"{{.Server.Version}}"}`.quiet().nothrow(),
		$`docker compose version`.quiet().nothrow(),
		systemdUnitState(),
	]);
	return {
		cliPresent: cli.exitCode === 0,
		daemonReachable: daemon.exitCode === 0,
		probeError: daemon.stderr.toString().toLowerCase(),
		systemSocket: fs.existsSync("/var/run/docker.sock"),
		rootlessSocket: fs.existsSync(rootlessSocketPath()),
		dockerHostSet: !!(process.env.DOCKER_HOST ?? "").trim(),
		systemdUnit,
		wsl: isWsl(),
		composePlugin: compose.exitCode === 0,
	};
}

/** The one-line summary the setup header shows, or null when docker is fine. */
export async function dockerBlockerTitle(): Promise<string | null> {
	return diagnoseDocker(await readDockerFacts())?.title ?? null;
}

/** Probe, and throw a "do this first" error when something is in the way. Called at the TOP of any
 * option that ends in docker, so nothing is asked that cannot be used. */
export async function requireDocker(): Promise<void> {
	const blocker = diagnoseDocker(await readDockerFacts());
	if (blocker) throw new Error(blockerMessage(blocker));
}
