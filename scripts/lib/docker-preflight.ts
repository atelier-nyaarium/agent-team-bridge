import fs from "node:fs";

////////////////////////////////
//  Interfaces & Types
//
//  Why setup checks docker before it asks anything: every option here ends in `docker compose up`,
//  and a stopped daemon fails at the LAST step, after the operator has already typed a Router
//  address and watched a gateway try to arm. The failure is also indistinguishable from a
//  Switchboard problem at a glance ("could not start the gateway") when it is nothing of the sort.
//
//  This file is the DECISION and is pure, so every rule is testable without a machine in that
//  state - which matters because the interesting states (rootless, no systemd, a WSL distro Docker
//  Desktop is not integrated with) are exactly the ones no test machine happens to be in. The probe
//  that gathers the facts lives in docker-probe.ts, which is bun-only and therefore unimportable
//  from the node-run test suite.

export interface DockerFacts {
	/** The CLI is on PATH. `docker --version` answers this without a daemon. */
	cliPresent: boolean;
	/** `docker version` reached a server. Everything below only matters when this is false. */
	daemonReachable: boolean;
	/** Lowercased stderr from the daemon probe, which is what separates "refused" from "absent". */
	probeError: string;
	systemSocket: boolean;
	rootlessSocket: boolean;
	dockerHostSet: boolean;
	systemdUnit: "active" | "inactive" | "failed" | "no-systemd";
	wsl: boolean;
	/** `docker compose` exists. A separate package from the CLI, and setup calls it by name. */
	composePlugin: boolean;
}

export interface DockerBlocker {
	title: string;
	steps: string[];
}

////////////////////////////////
//  Decision (pure)

/** What is standing between this machine and `docker compose up`, or null when nothing is.
 *
 * Ordered most-specific first. Permission denial is checked BEFORE the unit state, because a socket
 * the user cannot open belongs to a daemon that is running perfectly and systemd would report it as
 * active - reading that as "start docker" sends the operator to a command that changes nothing. */
export function diagnoseDocker(f: DockerFacts): DockerBlocker | null {
	if (!f.cliPresent) {
		return {
			title: "Docker is not installed on this machine.",
			steps: f.wsl
				? [
						"Install Docker Engine in this distro (docs.docker.com/engine/install), including docker-compose-plugin.",
						"Or install Docker Desktop on Windows and tick this distro under Settings, Resources, WSL integration.",
					]
				: ["Install Docker Engine and the compose plugin: docs.docker.com/engine/install"],
		};
	}

	if (f.daemonReachable) {
		if (!f.composePlugin) {
			return {
				title: "The docker compose plugin is missing.",
				steps: [
					"It is a separate package from the CLI, and every option here calls `docker compose`.",
					"sudo apt install docker-compose-plugin",
				],
			};
		}
		return null;
	}

	if (f.probeError.includes("permission denied")) {
		return {
			title: "Docker is running, but this user cannot reach its socket.",
			steps: ["sudo usermod -aG docker $USER", "Then open a NEW shell, or run: newgrp docker"],
		};
	}

	if (f.rootlessSocket && !f.dockerHostSet) {
		return {
			title: "Rootless docker is installed, but DOCKER_HOST does not point at it.",
			steps: [
				`export DOCKER_HOST=unix://${rootlessSocketPath()}`,
				"Add that to your shell profile so it survives a new terminal.",
			],
		};
	}

	if (f.systemdUnit === "inactive" || f.systemdUnit === "failed") {
		return {
			title: "The docker daemon is installed but not running.",
			steps: [
				"sudo systemctl enable --now docker",
				"sudo usermod -aG docker $USER   # if you have not already",
				"Then open a NEW shell.",
			],
		};
	}

	if (f.wsl) {
		return {
			title: "Docker is not reachable from this WSL distro.",
			steps: [
				"Docker Desktop: tick this distro under Settings, Resources, WSL integration.",
				"Native install: enable systemd (systemd=true under [boot] in /etc/wsl.conf), run `wsl --shutdown` from Windows, then `sudo systemctl enable --now docker`.",
			],
		};
	}

	return {
		title: "The docker daemon is not reachable.",
		steps: ["Start it, then re-run this.", `Probe said: ${f.probeError.slice(0, 160) || "(no detail)"}`],
	};
}

/** Render a blocker as the message setup bails with. */
export function blockerMessage(blocker: DockerBlocker): string {
	return [blocker.title, "", "Do this first:", ...blocker.steps.map((s) => `  ${s}`), "", "Then re-run this."].join(
		"\n",
	);
}

////////////////////////////////
//  Functions & Helpers

/** Where a rootless daemon puts its socket for THIS user. */
export function rootlessSocketPath(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return `${process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`}/docker.sock`;
}

export function isWsl(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}
