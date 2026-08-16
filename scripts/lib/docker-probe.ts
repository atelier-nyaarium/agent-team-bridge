import fs from "node:fs";
import { $ } from "bun";
import { blockerMessage, type DockerFacts, diagnoseDocker, isWsl, rootlessSocketPath } from "./docker-preflight.js";

////////////////////////////////
//  Probe
//
//  The bun-only half of the preflight: it gathers facts and nothing else, so the rules that read
//  them stay importable from the node-run test suite. Kept apart for that reason alone.

async function systemdUnitState(): Promise<DockerFacts["systemdUnit"]> {
	const res = await $`systemctl is-active docker`.quiet().nothrow();
	const out = res.stdout.toString().trim();
	const err = res.stderr.toString().toLowerCase();
	// A distro with no systemd says so on stderr; a missing systemctl is the same answer for our
	// purposes, since both mean "this machine does not start docker that way".
	if (err.includes("not been booted with systemd") || err.includes("command not found")) return "no-systemd";
	if (out === "active") return "active";
	if (out === "failed") return "failed";
	if (out === "inactive") return "inactive";
	return "no-systemd";
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
