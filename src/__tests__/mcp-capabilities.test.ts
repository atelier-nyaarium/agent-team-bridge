import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityInstructions, fetchCapabilities, GATED_CAPABILITY_IDS, hasCapability } from "../mcp/capabilities.js";
import {
	type Capability,
	CODEX_THINKING_CAPABILITY_ID,
	daemonCapabilityDeclaration,
	UNREPORTED_CAPABILITIES,
} from "../shared/capabilities.js";
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

/** The wire shape, one section per source. `null` is a source that has not spoken; `[]` is one that
 * spoke and declared nothing. */
function bundle(sources: { console?: Capability[] | null; daemon?: Capability[] | null }) {
	const section = (caps: Capability[] | null | undefined) =>
		caps == null ? UNREPORTED_CAPABILITIES : { known: true, capabilities: caps, clientVersions: [] };
	return { console: section(sources.console), daemon: section(sources.daemon) };
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
				jsonResponse(bundle({ console: [{ id: "designer", instructions: "Use it." }], daemon: [] })),
			),
		);

		const capabilities = await fetchCapabilities(ROUTER);

		expect(capabilities).toEqual([{ id: "designer", instructions: "Use it." }]);
	});

	it("reports an affirmatively empty answer as empty, removing a tool the owner turned off", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({ console: [], daemon: [] }))),
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

	it("assumes nothing when no source has spoken and nothing was ever cached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({}))),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	// The case a fail-open set was invented for, answered with evidence instead: a blip cannot strip a
	// session's tools, because the last real answer is still on disk.
	it("keeps the tool through an outage when the gateway had already answered once", async () => {
		writeCache(bundle({ console: [{ id: "designer", instructions: "Use it." }], daemon: [] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
	});

	it("falls back to the last answer it actually got, keeping that answer's guidance", async () => {
		writeCache(bundle({ console: [{ id: "designer", instructions: "Prefer Switchboard." }], daemon: [] }));
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
			vi.fn(async () => jsonResponse(bundle({ console: [{ id: "notes" }], daemon: [] }))),
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
		// A fail-open floor must not override a cache that recorded the owner's own last known choice:
		// that recorded choice is the one piece of evidence actually available here.
		writeCache(bundle({ console: [], daemon: [] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({}))),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(false);
	});

	it("carries a cached plugin the core set does not know about through an outage", async () => {
		writeCache(bundle({ console: [{ id: "notes", instructions: "Jot it down." }], daemon: [] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("gateway down");
			}),
		);

		const capabilities = await fetchCapabilities(ROUTER);

		expect(capabilities.map((c) => c.id)).toContain("notes");
		expect(capabilities.find((c) => c.id === "notes")?.instructions).toBe("Jot it down.");
	});

	it("reads a gateway that has not been restarted since the sources were split", async () => {
		// The plugin and the gateway update on separate triggers and the plugin usually leads, so this
		// is the ordinary rollout order rather than an edge case.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					known: true,
					capabilities: [{ id: "designer" }, { id: "references" }],
					clientVersions: [],
				}),
			),
		);

		expect((await fetchCapabilities(ROUTER)).map((c) => c.id)).toEqual(["designer", "references"]);
	});

	it("reads a cache file written before the sources were split", async () => {
		// The old writer persisted two fields, so the legacy shape on disk differs from the legacy shape
		// on the wire and a lift that only handles one of them still loses the fallback.
		fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
		fs.writeFileSync(cachePath(), JSON.stringify({ known: true, capabilities: [{ id: "designer" }] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("gateway down");
			}),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
	});

	it("keeps a silent source's last answer while taking the one that spoke", async () => {
		writeCache(bundle({ console: [{ id: "designer" }, { id: "references" }], daemon: [] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({ console: null, daemon: [{ id: CODEX_THINKING_CAPABILITY_ID }] }))),
		);

		expect((await fetchCapabilities(ROUTER)).map((c) => c.id)).toEqual([
			CODEX_THINKING_CAPABILITY_ID,
			"designer",
			"references",
		]);
	});

	it("lets a source withdraw its own capability while another source is silent", async () => {
		// The one an id-blind merge could never get right: the console dropped designer on purpose, and
		// the daemon being unreachable that round says nothing about a console id.
		writeCache(bundle({ console: [{ id: "designer" }], daemon: [{ id: CODEX_THINKING_CAPABILITY_ID }] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({ console: [], daemon: null }))),
		);

		expect((await fetchCapabilities(ROUTER)).map((c) => c.id)).toEqual([CODEX_THINKING_CAPABILITY_ID]);
	});

	it("keeps a withdrawal after the source that made it goes quiet too", async () => {
		// The withdrawal was recorded as that source's own answer, so staying withdrawn does not depend
		// on every source continuing to speak.
		writeCache(bundle({ console: [{ id: "designer" }], daemon: [] }));
		const fetchMock = vi.fn(async () => jsonResponse(bundle({ console: [], daemon: null })));
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchCapabilities(ROUTER)).toEqual([]);

		fetchMock.mockImplementation(async () => jsonResponse(bundle({})));

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	it("still lets a complete answer take a capability away", async () => {
		writeCache(bundle({ console: [{ id: "designer" }], daemon: [] }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(bundle({ console: [], daemon: [] }))),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([]);
	});

	it("does not let a cached no-opinion answer stand in for a real one", async () => {
		writeCache(bundle({}));
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

		writeCache(bundle({ console: [{ id: "designer", instructions: "Use it." }], daemon: [] }));
		const started = Date.now();
		const capabilities = await fetchCapabilities(ROUTER);

		// The subject here is the deadline, so the cache is seeded: a hung gateway must cost a beat and
		// then hand back the last real answer, rather than holding the session open.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(hasCapability(capabilities, "designer")).toBe(true);
	}, 10_000);
});

describe("capabilityInstructions", () => {
	it("says nothing at all when nothing is enabled", () => {
		expect(capabilityInstructions([])).toBe("");
	});

	it("names a capability that carries no guidance of its own", () => {
		expect(capabilityInstructions([{ id: "designer" }])).toContain("designer");
	});

	it("names what is enabled and leaves the guidance to the tool", () => {
		const text = capabilityInstructions([{ id: "designer", instructions: "Prefer Switchboard." }, { id: "notes" }]);

		expect(text).toContain("`designer`, `notes`");
		expect(text).not.toContain("Prefer Switchboard.");
		expect(text).toContain("switchboard_capabilities");
	});

	it("stays far enough under the harness cap that a new capability cannot overflow it", () => {
		// The block is bounded by id length, not by how much guidance a capability carries, so no
		// capability can push another's text past the harness cap and have it silently cut.
		const many = Array.from({ length: 12 }, (_, i) => ({
			id: `capability-${i}`,
			instructions: "x".repeat(4_000),
		}));

		expect(capabilityInstructions(many).length).toBeLessThan(600);
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
		const consoleGated = GATED_CAPABILITY_IDS.filter((id) => id !== CODEX_THINKING_CAPABILITY_ID);

		expect(shippedPlugins().map((p) => p.id)).toEqual(expect.arrayContaining(consoleGated));
	});

	it("holds the daemon's own capability, which no console manifest can vouch for", () => {
		// Announced by the host daemon's configuration rather than by a device, so the manifest check
		// above cannot see it. Naming it here keeps a rename from silently un-gating the Codex tools.
		expect(GATED_CAPABILITY_IDS).toContain(CODEX_THINKING_CAPABILITY_ID);
		expect(daemonCapabilityDeclaration({ CODEX_THINKING_ENABLED: "true" }).map((c) => c.id)).toEqual([
			CODEX_THINKING_CAPABILITY_ID,
		]);
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
