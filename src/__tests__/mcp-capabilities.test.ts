import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityInstructions, fetchCapabilities, GATED_CAPABILITY_IDS, hasCapability } from "../mcp/capabilities.js";
import { EnabledPluginSchema } from "../shared/schemas.js";

////////////////////////////////
//  Functions & Helpers

const ROUTER = "http://gateway.test";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function cachePath(): string {
	return path.join(os.homedir(), ".config", "switchboard", "capabilities-cache.json");
}

function writeCache(body: unknown): void {
	fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
	fs.writeFileSync(cachePath(), JSON.stringify(body));
}

////////////////////////////////
//  Tests

describe("fetchCapabilities", () => {
	let home: string;
	let priorHome: string | undefined;

	beforeEach(() => {
		priorHome = process.env.HOME;
		home = fs.mkdtempSync(path.join(os.tmpdir(), "cap-test-"));
		process.env.HOME = home;
	});

	afterEach(() => {
		if (priorHome === undefined) delete process.env.HOME;
		else process.env.HOME = priorHome;
		fs.rmSync(home, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	it("reports what the gateway affirmatively knows", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ known: true, capabilities: [{ id: "designer", instructions: "Use it." }] }),
			),
		);

		const capabilities = await fetchCapabilities(ROUTER);

		expect(capabilities).toEqual([{ id: "designer", instructions: "Use it." }]);
	});

	it("reports an affirmatively empty union as empty, removing a tool the owner turned off", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: true, capabilities: [] })),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(false);
	});

	// Nothing is assumed. Every gated id is a plugin the owner opts into, so a hardcoded set would be
	// the code guessing on the owner's behalf with the least evidence it will ever have.
	it("assumes nothing on a cold start that has never reached the gateway", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	it("assumes nothing when the gateway has no opinion and nothing was ever cached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: false, capabilities: [] })),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	// The case a fail-open set was invented for, answered with evidence instead: a blip cannot strip a
	// session's tools, because the last real answer is still on disk.
	it("keeps the tool through an outage when the gateway had already answered once", async () => {
		writeCache({ known: true, capabilities: [{ id: "designer", instructions: "Use it." }] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
	});

	it("falls back to the last answer it actually got, keeping that answer's guidance", async () => {
		writeCache({ known: true, capabilities: [{ id: "designer", instructions: "Prefer Switchboard." }] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ oops: true })),
		);

		// The cached entry's own guidance must survive; the rest of the core set rides along and grows
		// as plugins ship, which the manifest fixture pins separately.
		expect(await fetchCapabilities(ROUTER)).toContainEqual({ id: "designer", instructions: "Prefer Switchboard." });
	});

	it("remembers a fresh answer for the next start that cannot reach the gateway", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: true, capabilities: [{ id: "notes" }] })),
		);
		await fetchCapabilities(ROUTER);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("gateway down");
			}),
		);

		expect((await fetchCapabilities(ROUTER)).map((c) => c.id)).toContain("notes");
	});

	it("trusts a cache that recorded the owner turning everything off", async () => {
		// This used to be floored back on by the fail-open set, which meant a guess overriding the one
		// piece of evidence available: the owner's own last known choice.
		writeCache({ known: true, capabilities: [] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: false, capabilities: [] })),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(false);
	});

	it("carries a cached plugin the core set does not know about through an outage", async () => {
		writeCache({ known: true, capabilities: [{ id: "notes", instructions: "Jot it down." }] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("gateway down");
			}),
		);

		const capabilities = await fetchCapabilities(ROUTER);

		expect(capabilities.map((c) => c.id)).toContain("notes");
		expect(capabilityInstructions(capabilities)).toContain("Jot it down.");
	});

	it("does not let a cached no-opinion answer stand in for a real one", async () => {
		writeCache({ known: false, capabilities: [] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	it("gives up rather than hanging the session behind an unresponsive gateway", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			),
		);

		writeCache({ known: true, capabilities: [{ id: "designer", instructions: "Use it." }] });
		const started = Date.now();
		const capabilities = await fetchCapabilities(ROUTER);

		// The subject here is the deadline, so the cache is seeded: a hung gateway must cost a beat and
		// then hand back the last real answer, rather than holding the session open.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(hasCapability(capabilities, "designer")).toBe(true);
	}, 10_000);
});

describe("capabilityInstructions", () => {
	it("says nothing when nothing enabled has guidance to give", () => {
		expect(capabilityInstructions([{ id: "designer" }])).toBe("");
	});

	it("carries each plugin's own guidance through to the session", () => {
		const text = capabilityInstructions([{ id: "designer", instructions: "Prefer Switchboard." }, { id: "notes" }]);

		expect(text).toContain("Prefer Switchboard.");
		expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
	});
});

/** Every plugin manifest the console app actually ships, as the entry a device reports from it. */
function shippedPlugins(): { id: string; instructions?: string }[] {
	const pluginsDir = path.join(import.meta.dirname, "..", "..", "android", "app", "src", "main", "assets", "plugins");
	return fs
		.readdirSync(pluginsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			const manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, e.name, "manifest.json"), "utf8"));
			return {
				id: manifest.author ? `${manifest.author}.${manifest.content_id}` : manifest.content_id,
				instructions: manifest.agent_instructions || undefined,
			};
		});
}

describe("the gated capability ids", () => {
	it("each name a plugin the console actually ships, so a renamed manifest fails here", () => {
		// A plugin id is documented to become `<author>.<content_id>` on a per-repo split, so this
		// rename is planned work. Without this check it lands silently: the gateway stops reporting
		// the old id, the gate stops matching, and the surface vanishes from every session while the
		// gate still holds the old name, so the outage looks intermittent.
		expect(shippedPlugins().map((p) => p.id)).toEqual(expect.arrayContaining([...GATED_CAPABILITY_IDS]));
	});
});

describe("the guidance a shipped plugin carries", () => {
	// The id check above passed while References was invisible to every session for hours. Its
	// manifest was fine and the phone reported it correctly; the entry was refused at this schema
	// for a 2304-character instructions string against a 2000 cap, and refusal here used to mean the
	// whole capability was discarded. Nothing logged it, on the device or the gateway. Checking ids
	// alone cannot see that, because the id was never the part that failed.
	it.each(shippedPlugins().map((p) => [p.id, p] as const))("survives the wire schema whole for %s", (_id, plugin) => {
		const parsed = EnabledPluginSchema.safeParse(plugin);

		expect(parsed.success ? null : parsed.error.issues[0]?.message).toBeNull();
		expect(parsed.success && parsed.data.instructions).toBe(plugin.instructions);
	});
});
