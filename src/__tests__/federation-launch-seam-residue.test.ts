import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "src", "federation-server");

/** The sole owner of the node HTTP types: handlers return a Response and never write one. */
const ADAPTER = path.join(SERVER_DIR, "routerServer.ts");

/** Spelled out rather than imported: a needle built from the value under test cannot notice it change. */
const NODE_HTTP_TYPES = /\bServerResponse\b|\bIncomingMessage\b|from "node:http"/;

////////////////////////////////
//  Functions & Helpers

function usesNodeHttp(file: string): boolean {
	return filesUnder(SERVER_DIR).some(
		(candidate) => candidate === file && NODE_HTTP_TYPES.test(readFileSync(file, "utf8")),
	);
}

////////////////////////////////
//  Tests

describe("federation router launch seam", () => {
	it("confines the node HTTP types to the adapter", () => {
		const owners = filesUnder(SERVER_DIR)
			.filter(usesNodeHttp)
			.map((file) => path.basename(file));
		expect(owners).toEqual([path.basename(ADAPTER)]);
	});
});
