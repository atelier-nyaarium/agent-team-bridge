import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityStore } from "../gateway/console/capabilityStore.js";
import { DaemonCapabilityStore } from "../gateway/daemonCapabilities.js";
import { capabilityInstructions } from "../mcp/capabilities.js";
import { describeDrift, renderCapabilities } from "../mcp/capabilitiesTool.js";
import {
	type Capability,
	CODEX_AGENT_CAPABILITY_ID,
	COPILOT_AGENT_CAPABILITY_ID,
	daemonCapabilityDeclaration,
	UNREPORTED_CAPABILITIES,
	unionCapabilities,
} from "../shared/capabilities.js";
import type { DurableStore } from "../shared/durable-store.js";
import { CapabilityBundleSchema, WsRegisterSchema } from "../shared/schemas.js";

////////////////////////////////
//  Functions & Helpers

function fakeDurable(seed?: unknown): DurableStore & { written: unknown } {
	let held = seed;
	return {
		get written() {
			return held;
		},
		load: () => held ?? null,
		save: (value: unknown) => {
			held = value;
		},
	} as unknown as DurableStore & { written: unknown };
}

const tempDirs: string[] = [];

function envWithExecutables(...names: string[]): Record<string, string | undefined> {
	const dirs =
		names.length === 0
			? [mkdtempSync(path.join(tmpdir(), "daemon-capabilities-"))]
			: names.map((name) => {
					const dir = mkdtempSync(path.join(tmpdir(), "daemon-capabilities-"));
					writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
					return dir;
				});
	tempDirs.push(...dirs);
	return { PATH: dirs.join(":") };
}

function serve(env: Record<string, string | undefined>, console_: Capability[]) {
	const frame = WsRegisterSchema.parse({
		type: "register",
		team: "host",
		token: "secret",
		daemonCapabilities: daemonCapabilityDeclaration(env),
	});
	const daemon = new DaemonCapabilityStore(fakeDurable());
	daemon.declare(frame.daemonCapabilities ?? []);
	const consoleStore = new CapabilityStore(fakeDurable());
	consoleStore.report("phone-1", console_);
	// Through JSON and the wire schema, because the route serializes before the MCP parses it back.
	const wire = JSON.parse(JSON.stringify({ console: consoleStore.snapshot(), daemon: daemon.snapshot() }));
	return unionCapabilities(CapabilityBundleSchema.parse(wire));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CODEX = { id: CODEX_AGENT_CAPABILITY_ID, instructions: "Delegate like so." };

////////////////////////////////
//  Tests

describe("what the daemon announces", () => {
	it("declares nothing when neither CLI is installed", () => {
		expect(daemonCapabilityDeclaration(envWithExecutables())).toEqual([]);
	});
});

describe("the daemon capability store", () => {
	it("has no opinion until a daemon has actually declared one", () => {
		expect(new DaemonCapabilityStore(fakeDurable()).snapshot()).toEqual(UNREPORTED_CAPABILITIES);
	});

	it("separates an affirmative empty declaration from never having heard one", () => {
		const store = new DaemonCapabilityStore(fakeDurable());
		store.declare([]);

		expect(store.snapshot()).toEqual({ known: true, capabilities: [], clientVersions: [] });
	});

	it("replaces the whole prior declaration rather than merging into it", () => {
		const store = new DaemonCapabilityStore(fakeDurable());
		store.declare([CODEX]);
		store.declare([]);

		expect(store.snapshot().capabilities).toEqual([]);
	});

	it("still answers with the last declaration after a gateway restart", () => {
		const disk = fakeDurable();
		new DaemonCapabilityStore(disk).declare([CODEX]);

		expect(new DaemonCapabilityStore(disk).snapshot()).toEqual({
			known: true,
			capabilities: [CODEX],
			clientVersions: [],
		});
	});

	it("reverts to no-opinion on an unreadable file rather than serving half of it", () => {
		const store = new DaemonCapabilityStore(fakeDurable({ capabilities: [CODEX, { id: "" }] }));

		expect(store.snapshot()).toEqual(UNREPORTED_CAPABILITIES);
	});
});

describe("folding the bundle into one answer", () => {
	const console_ = { known: true, capabilities: [{ id: "designer" }], clientVersions: ["1.2.3"] };
	const daemon = { known: true, capabilities: [CODEX], clientVersions: [] };

	it("is complete only once every source has spoken", () => {
		expect(unionCapabilities({ console: console_, daemon }).known).toBe(true);
		expect(unionCapabilities({ console: UNREPORTED_CAPABILITIES, daemon }).known).toBe(false);
		expect(unionCapabilities({ console: console_, daemon: UNREPORTED_CAPABILITIES }).known).toBe(false);
		expect(unionCapabilities({ console: UNREPORTED_CAPABILITIES, daemon: UNREPORTED_CAPABILITIES })).toEqual(
			UNREPORTED_CAPABILITIES,
		);
	});

	it("does not let one source's empty declaration answer for the other's ids", () => {
		// A purged gateway leaves the console with no opinion while the daemon still declares, and its
		// declaration is empty on every install that has not switched Codex on. Reported as complete,
		// that reads as an authoritative "nothing is enabled" about capabilities it cannot see.
		const daemonSaysNothing = { known: true, capabilities: [], clientVersions: [] };

		expect(unionCapabilities({ console: UNREPORTED_CAPABILITIES, daemon: daemonSaysNothing }).known).toBe(false);
	});

	it("carries both sources and orders them by id", () => {
		expect(unionCapabilities({ console: console_, daemon })).toEqual({
			known: true,
			capabilities: [CODEX, { id: "designer" }],
			clientVersions: ["1.2.3"],
		});
	});

	it("does not let one source's silence take the other's capability away", () => {
		const daemonWentQuiet = { known: true, capabilities: [], clientVersions: [] };

		expect(unionCapabilities({ console: console_, daemon: daemonWentQuiet }).capabilities).toEqual([
			{ id: "designer" },
		]);
	});
});

describe("what switchboard_capabilities reports", () => {
	it("serves each capability's full guidance under its own heading", () => {
		const text = renderCapabilities([CODEX, { id: "designer", instructions: "Dock a card." }], null);

		expect(text).toContain("Delegate like so.");
		expect(text).toContain("Dock a card.");
		expect(text).toContain(`## ${CODEX_AGENT_CAPABILITY_ID}`);
	});

	it("says so plainly when the session has nothing", () => {
		expect(renderCapabilities([], [])).toBe("No Switchboard capabilities are enabled.");
	});

	it("stays quiet when the fresh read agrees", () => {
		expect(describeDrift([CODEX], [CODEX])).toBeNull();
		expect(renderCapabilities([CODEX], [CODEX])).not.toContain("Could not reach");
	});

	it("separates having checked from having been unable to check", () => {
		expect(describeDrift([CODEX], null)).toBeNull();
		expect(renderCapabilities([CODEX], null)).toContain("Could not confirm");
		expect(renderCapabilities([], null)).toContain("Could not confirm");
	});

	it("ignores reworded guidance, since the startup text is what it serves either way", () => {
		expect(describeDrift([CODEX], [{ id: CODEX_AGENT_CAPABILITY_ID, instructions: "Reworded." }])).toBeNull();
	});

	it("warns about a toggle the running session cannot adopt", () => {
		const drift = describeDrift([CODEX], [{ id: "designer" }]);

		expect(drift).toContain("designer is now enabled");
		expect(drift).toContain(`${CODEX_AGENT_CAPABILITY_ID} is no longer enabled`);
		expect(drift).toContain("restart this session");
	});

	it("keeps reporting the startup answer even while warning about drift", () => {
		const text = renderCapabilities([CODEX], []);

		expect(text).toContain("Delegate like so.");
		expect(text).toContain("no longer enabled");
	});
});

describe("a declaration's whole journey to a session", () => {
	// The units above each cover one hop. This covers the joins between them, where a shape agreed
	// at both ends can still be dropped in the middle.
	it("leaves the console's capability alone when the daemon has nothing to declare", () => {
		const served = serve(envWithExecutables(), [{ id: "designer" }]);

		expect(capabilityInstructions(served.capabilities)).toContain("designer");
		expect(capabilityInstructions(served.capabilities)).not.toContain("codex-agent");
	});

	it("tells a session with neither source enabled nothing at all", () => {
		expect(capabilityInstructions(serve(envWithExecutables(), []).capabilities)).toBe("");
	});
});

describe("what the daemon announces", () => {
	it("declares only Codex when its CLI is installed", () => {
		expect(daemonCapabilityDeclaration(envWithExecutables("codex")).map((c) => c.id)).toEqual([
			CODEX_AGENT_CAPABILITY_ID,
		]);
	});
});

describe("a declared capability's whole journey to a session", () => {
	it("reaches a session as a name in the block and guidance in the tool", () => {
		const served = serve(envWithExecutables("codex"), [{ id: "designer", instructions: "Dock a card." }]);

		expect(capabilityInstructions(served.capabilities)).toContain("`codex-agent`, `designer`");
		expect(capabilityInstructions(served.capabilities)).not.toContain("Dock a card.");
		expect(renderCapabilities(served.capabilities, null)).toContain("codexStartAgent");
	});
});

describe("what the daemon announces", () => {
	it("declares both capabilities with guidance when both CLIs are installed", () => {
		const capabilities = daemonCapabilityDeclaration(envWithExecutables("codex", "copilot"));

		expect(capabilities.map((c) => c.id)).toEqual([CODEX_AGENT_CAPABILITY_ID, COPILOT_AGENT_CAPABILITY_ID]);
		expect(capabilities).toEqual([
			expect.objectContaining({ id: CODEX_AGENT_CAPABILITY_ID, instructions: expect.any(String) }),
			expect.objectContaining({ id: COPILOT_AGENT_CAPABILITY_ID, instructions: expect.any(String) }),
		]);
	});
});
