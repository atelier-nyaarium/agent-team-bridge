import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evieWsConnection, loadEvieTransport } from "../gateway/evie/transport.js";

////////////////////////////////
//  Constants

const DIRECT = {
	transport: "direct",
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

describe("loadEvieTransport", () => {
	it("resolves nothing when no file is present", () => {
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("reads the direct branch", () => {
		write(DIRECT);
		const loaded = loadEvieTransport(dir);
		expect({ transport: loaded?.transport, url: loaded?.routerUrl }).toEqual({
			transport: "direct",
			url: DIRECT.routerUrl,
		});
	});

	// A retired-branch file must leave the gateway standalone and armed for enrollment, never
	// half-adopted: its fields describe a relay this build can no longer reach.
	it("refuses a retired k8s file rather than half-reading it", () => {
		write({ apiUrl: "https://api.example", saToken: "sa", caPem: "pem" });
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("refuses a direct branch missing its own fields", () => {
		write({ transport: "direct", routerUrl: DIRECT.routerUrl });
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("resolves nothing from a malformed file", () => {
		writeFileSync(path.join(dir, "transport.json"), "{not json");
		expect(loadEvieTransport(dir)).toBeNull();
	});
});

describe("evieWsConnection", () => {
	it("dials by URL with the leaf pinned, lowercased", () => {
		write(DIRECT);
		const conn = evieWsConnection(loadEvieTransport(dir)!);
		expect(conn.url).toBe("wss://federation-router:20001");
		expect(conn.tls).toEqual({ certFp: "ab12" });
		expect(conn.headers.Authorization).toBe(`Bearer ${DIRECT.bearer}`);
	});
});
