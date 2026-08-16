import { describe, expect, it } from "vitest";
import { type DockerFacts, diagnoseDocker } from "../../scripts/lib/docker-preflight.js";

////////////////////////////////
//  Functions & Helpers
//
//  The states worth getting right are the ones no test machine is ever in: rootless, no systemd,
//  a WSL distro Docker Desktop is not integrated with. The decision is pure so all of them are
//  reachable here, which is the whole reason it is split from the probe.

const HEALTHY: DockerFacts = {
	cliPresent: true,
	daemonReachable: true,
	probeError: "",
	systemSocket: true,
	rootlessSocket: false,
	dockerHostSet: false,
	systemdUnit: "active",
	wsl: false,
	composePlugin: true,
};

const facts = (over: Partial<DockerFacts>): DockerFacts => ({ ...HEALTHY, ...over });

describe("docker preflight", () => {
	it("blocks nothing when docker is reachable and compose is present", () => {
		expect(diagnoseDocker(HEALTHY)).toBeNull();
	});

	// The case that sent the owner to a dead end: daemon installed, systemd knows the unit, it is
	// simply not started.
	it("names the start command when the unit is inactive", () => {
		const blocker = diagnoseDocker(facts({ daemonReachable: false, systemdUnit: "inactive", systemSocket: false }));
		expect(blocker?.steps[0]).toBe("sudo systemctl enable --now docker");
	});

	it("treats a failed unit the same as a stopped one", () => {
		expect(diagnoseDocker(facts({ daemonReachable: false, systemdUnit: "failed" }))?.steps[0]).toContain(
			"systemctl",
		);
	});

	// A socket the user cannot open belongs to a daemon that is running fine, and systemd reports it
	// ACTIVE. Reading that as "start docker" sends them to a command that changes nothing.
	it("prefers the group fix over the start command on a permission denial", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, probeError: "dial unix /var/run/docker.sock: connect: permission denied" }),
		);
		expect(blocker?.steps[0]).toContain("usermod -aG docker");
	});

	it("points DOCKER_HOST at a rootless socket rather than telling anyone to start a daemon", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, systemSocket: false, rootlessSocket: true, systemdUnit: "no-systemd" }),
		);
		expect(blocker?.steps[0]).toContain("DOCKER_HOST=unix://");
	});

	// Already exported: repeating the export teaches nothing, so the rootless branch must not fire.
	it("does not repeat the rootless advice once DOCKER_HOST is set", () => {
		const blocker = diagnoseDocker(
			facts({
				daemonReachable: false,
				systemSocket: false,
				rootlessSocket: true,
				dockerHostSet: true,
				systemdUnit: "no-systemd",
				wsl: true,
			}),
		);
		expect(blocker?.steps.join(" ")).not.toContain("DOCKER_HOST=unix://");
		expect(blocker?.title).toContain("WSL");
	});

	it("gives WSL its own two paths when there is no systemd to blame", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, systemSocket: false, systemdUnit: "no-systemd", wsl: true }),
		);
		expect(blocker?.steps.join(" ")).toContain("WSL integration");
		expect(blocker?.steps.join(" ")).toContain("systemd=true");
	});

	// The one that shipped wrong. `systemctl is-active` prints "inactive" for a unit that does not
	// exist, so reading existence from it told a Docker Desktop user to start a service their distro
	// has never had. Absent must never produce the start command.
	it("does not offer a start command for a docker service this machine does not have", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, systemSocket: false, systemdUnit: "absent", wsl: true }),
		);
		expect(blocker?.steps.join(" ")).not.toContain("systemctl enable");
		expect(blocker?.steps.join(" ")).toContain("WSL integration");
	});

	// Same absence off WSL is a different story: no Docker Desktop to integrate, the daemon package
	// is simply not installed.
	it("calls an absent unit a missing daemon package when this is not WSL", () => {
		const blocker = diagnoseDocker(facts({ daemonReachable: false, systemSocket: false, systemdUnit: "absent" }));
		expect(blocker?.steps.join(" ")).not.toContain("systemctl enable");
		expect(blocker?.title).toContain("no docker service");
	});

	// A present-but-stopped unit still gets the start command; that distinction is the whole point.
	it("still offers the start command when the unit genuinely exists on WSL", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, systemSocket: false, systemdUnit: "inactive", wsl: true }),
		);
		expect(blocker?.steps[0]).toBe("sudo systemctl enable --now docker");
	});

	it("unmasks before trying to start a masked unit", () => {
		const blocker = diagnoseDocker(facts({ daemonReachable: false, systemdUnit: "masked" }));
		expect(blocker?.steps[0]).toContain("unmask");
	});

	it("tells a WSL machine with no CLI about both install routes", () => {
		const blocker = diagnoseDocker(facts({ cliPresent: false, daemonReachable: false, wsl: true }));
		expect(blocker?.steps.join(" ")).toContain("WSL integration");
		expect(blocker?.title).toContain("not installed");
	});

	// Compose is a separate package, and every option here shells out to `docker compose` by name.
	// A reachable daemon without it fails later, at the same place a stopped daemon does.
	it("catches a missing compose plugin even though the daemon answers", () => {
		expect(diagnoseDocker(facts({ composePlugin: false }))?.title).toContain("compose plugin");
	});

	// Unreachable, no systemd, not WSL, nothing else to go on: still say something, and carry the
	// probe's own words rather than inventing a cause.
	it("falls back to the probe's own error when nothing else explains it", () => {
		const blocker = diagnoseDocker(
			facts({ daemonReachable: false, systemSocket: false, systemdUnit: "no-systemd", probeError: "boom" }),
		);
		expect(blocker?.steps.join(" ")).toContain("boom");
	});
});
