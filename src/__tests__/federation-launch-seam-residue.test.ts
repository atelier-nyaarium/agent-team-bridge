import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "src", "federation-server");

/** The sole owner of the node HTTP types and of the one unobserved launch. */
const ADAPTER = path.join(SERVER_DIR, "routerServer.ts");

/** Spelled out rather than imported: a needle built from the value under test cannot notice it change. */
const NODE_HTTP_TYPES = /\bServerResponse\b|\bIncomingMessage\b|from "node:http"/;
const FLOATING_LAUNCH = /(^|[^\w.])void\s+(this\.|[a-z])/;

////////////////////////////////
//  Functions & Helpers

function serverFiles(): string[] {
	return fs
		.readdirSync(SERVER_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => path.join(SERVER_DIR, name));
}

function offendingLines(file: string, pattern: RegExp): string[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => pattern.test(line) && !line.trimStart().startsWith("//"));
}

////////////////////////////////
//  Tests

describe("federation router launch seam", () => {
	it("keeps the node HTTP types inside the adapter", () => {
		for (const file of serverFiles()) {
			if (file === ADAPTER) continue;
			expect({ file, lines: offendingLines(file, NODE_HTTP_TYPES) }).toEqual({ file, lines: [] });
		}
	});

	it("proves the adapter is the positive control", () => {
		expect(offendingLines(ADAPTER, NODE_HTTP_TYPES).length).toBeGreaterThan(0);
	});

	it("launches unobserved work in exactly one place", () => {
		const launches = serverFiles().flatMap((file) =>
			offendingLines(file, FLOATING_LAUNCH).map((line) => `${path.basename(file)}: ${line.trim()}`),
		);
		expect(launches).toEqual(["routerServer.ts: void this.serve(request, response);"]);
	});
});
