import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityInstructions, fetchCapabilities, hasCapability } from "../mcp/capabilities.js";

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

	it("keeps the tool when the gateway is unreachable, rather than silently dropping it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
	});

	it("keeps the tool when the gateway has no opinion yet, since no device has ever reported", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: false, capabilities: [] })),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
	});

	it("falls back to the last answer it actually got, keeping that answer's guidance", async () => {
		writeCache({ known: true, capabilities: [{ id: "designer", instructions: "Prefer Switchboard." }] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ oops: true })),
		);

		expect(await fetchCapabilities(ROUTER)).toEqual([{ id: "designer", instructions: "Prefer Switchboard." }]);
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

	it("never lets a stale cache take away a tool the gateway did not speak to", async () => {
		// The owner had everything off when this was cached; since then the gateway lost its records.
		writeCache({ known: true, capabilities: [] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ known: false, capabilities: [] })),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
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

		expect(capabilities.map((c) => c.id).sort()).toEqual(["designer", "notes"]);
		expect(capabilityInstructions(capabilities)).toContain("Jot it down.");
	});

	it("does not let a cached no-opinion answer stand in for a real one", async () => {
		writeCache({ known: false, capabilities: [] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);

		expect(hasCapability(await fetchCapabilities(ROUTER), "designer")).toBe(true);
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

		const started = Date.now();
		const capabilities = await fetchCapabilities(ROUTER);

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
