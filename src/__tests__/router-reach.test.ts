import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivateHost, reachCandidates, reachHost, reachPort } from "../shared/router-reach.js";

////////////////////////////////
//  Vectors
//
//  The same file android/.../RouterReachVectorsTest.kt reads. Both runtimes iterate it, so a rule
//  changed on one side and not the other fails here or there rather than shipping as an outage in
//  exactly one physical location.

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/router-reach/vectors.json"), "utf8"),
) as {
	routerPort: number;
	candidates: { name: string; reach: Record<string, unknown>; bootstrapUrl: string; expected: string[] }[];
	privateHosts: { host: string; private: boolean }[];
};

describe("router reach", () => {
	it("orders every vector's candidates identically to the Kotlin twin", () => {
		for (const v of vectors.candidates) {
			expect(reachCandidates(v.reach, v.bootstrapUrl, vectors.routerPort), v.name).toEqual(v.expected);
		}
	});

	it("classifies every vector's host the same way", () => {
		for (const v of vectors.privateHosts) {
			expect(isPrivateHost(v.host), v.host).toBe(v.private);
		}
	});

	// The whole reason LAN-first is affordable: an unroutable private address must be recognised so
	// it gets seconds rather than a full connect timeout. Getting this wrong does not fail a test
	// anywhere else, it just makes every launch away from home slow.
	it("recognises a private address inside a full base URL, not just a bare host", () => {
		expect(isPrivateHost(reachHost("https://192.168.1.238:20001"))).toBe(true);
		expect(isPrivateHost(reachHost("https://switchboard.example.com:20001"))).toBe(false);
	});

	it("reads the port a base URL names and falls back when it names none", () => {
		expect(reachPort("https://router.example.com:8443", 20001)).toBe(8443);
		expect(reachPort("https://router.example.com", 20001)).toBe(20001);
		expect(reachPort("not a url", 20001)).toBe(20001);
	});
});
