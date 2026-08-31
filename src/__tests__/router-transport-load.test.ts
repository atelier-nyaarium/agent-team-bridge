import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRouterReach,
	loadRouterTransport,
	routerWsConnection,
	saveRouterReach,
} from "../gateway/router/transport.js";

////////////////////////////////
//  Constants

const DIRECT = {
	routerUrl: "https://federation-router:20001",
	routerCertFp: "AB12",
	bearer: "secret",
};

////////////////////////////////
//  Functions & Helpers

let dir: string;

function write(value: unknown): void {
	writeFileSync(path.join(dir, "transport.json"), JSON.stringify(value));
}

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "switchboard-transport-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("loadRouterTransport", () => {
	it("resolves nothing when no file is present", () => {
		expect(loadRouterTransport(dir)).toBeNull();
	});

	it("reads a complete file", () => {
		write(DIRECT);
		expect(loadRouterTransport(dir)?.routerUrl).toBe(DIRECT.routerUrl);
	});

	// A file in a retired shape must leave the gateway standalone and armed for enrollment, never
	// half-adopted: its fields describe a relay this build cannot reach.
	it("refuses a file in a retired shape rather than half-reading it", () => {
		write({ apiUrl: "https://api.example", saToken: "sa", caPem: "pem" });
		expect(loadRouterTransport(dir)).toBeNull();
	});

	it("refuses a file missing any of its three fields", () => {
		write({ routerUrl: DIRECT.routerUrl });
		expect(loadRouterTransport(dir)).toBeNull();
	});

	it("resolves nothing from a malformed file", () => {
		writeFileSync(path.join(dir, "transport.json"), "{not json");
		expect(loadRouterTransport(dir)).toBeNull();
	});
});

describe("routerWsConnection", () => {
	// The stored scheme survives: this url is the BOOTSTRAP candidate, and the client rewrites
	// http->ws per candidate as it dials. Rewriting here instead would feed a ws:// address into the
	// reach ring, where it is indistinguishable from an advertised one.
	it("carries the bootstrap URL with the leaf pinned, lowercased", () => {
		write(DIRECT);
		const conn = routerWsConnection(loadRouterTransport(dir)!);
		expect(conn.url).toBe("https://federation-router:20001");
		expect(conn.tls).toEqual({ certFp: "ab12" });
		expect(conn.headers.Authorization).toBe(`Bearer ${DIRECT.bearer}`);
	});
});

describe("loadRouterReach", () => {
	it("resolves empty when nothing has been learned, and round-trips what has", () => {
		expect(loadRouterReach(dir)).toEqual({});
		saveRouterReach(dir, { publicHost: "r.example.com", publicPort: 8443, lanAddresses: ["192.168.1.238"] });
		expect(loadRouterReach(dir)).toEqual({
			publicHost: "r.example.com",
			publicPort: 8443,
			lanAddresses: ["192.168.1.238"],
		});
	});

	// A corrupt cache must not stop the Gateway connecting: the bootstrap alone still dials, and the
	// next register reply refills it.
	it("resolves empty from a malformed cache rather than throwing", () => {
		writeFileSync(path.join(dir, "reach.json"), "{not json");
		expect(loadRouterReach(dir)).toEqual({});
	});
});
