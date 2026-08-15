import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evieWsConnection, loadEvieTransport } from "../gateway/evie/transport.js";

////////////////////////////////
//  Constants

const K8S = { apiUrl: "https://api.example", saToken: "sa", caPem: "pem" };
const DIRECT = {
	transport: "direct",
	routerUrl: "https://federation-router:20001",
	routerCertFp: "AB12",
	bearer: "secret",
};

////////////////////////////////
//  Functions & Helpers

let dir: string;
const savedEnv = process.env.EVIE_API_URL;

function write(value: unknown): void {
	writeFileSync(path.join(dir, "transport.json"), JSON.stringify(value));
}

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "switchboard-transport-"));
	process.env.EVIE_API_URL = undefined as unknown as string;
	delete process.env.EVIE_API_URL;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.EVIE_API_URL;
	else process.env.EVIE_API_URL = savedEnv;
});

////////////////////////////////
//  Tests

describe("loadEvieTransport", () => {
	it("resolves nothing when neither env nor file is present", () => {
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("reads a file with no transport as the k8s branch", () => {
		write(K8S);
		expect(loadEvieTransport(dir)?.transport).toBe("k8s");
	});

	it("reads the direct branch", () => {
		write(DIRECT);
		const loaded = loadEvieTransport(dir);
		expect({ transport: loaded?.transport, url: loaded?.routerUrl }).toEqual({
			transport: "direct",
			url: DIRECT.routerUrl,
		});
	});

	it("refuses a branch missing its own fields", () => {
		write({ transport: "direct", routerUrl: DIRECT.routerUrl });
		expect(loadEvieTransport(dir)).toBeNull();
		write({ apiUrl: K8S.apiUrl });
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("resolves nothing from a malformed file", () => {
		writeFileSync(path.join(dir, "transport.json"), "{not json");
		expect(loadEvieTransport(dir)).toBeNull();
	});

	it("does not let a stale k8s env shadow a direct file", () => {
		process.env.EVIE_API_URL = "https://stale.example";
		write(DIRECT);
		expect(loadEvieTransport(dir)?.transport).toBe("direct");
	});
});

describe("evieWsConnection", () => {
	it("tunnels the k8s branch through the service proxy with the CA pinned", () => {
		write(K8S);
		const conn = evieWsConnection(loadEvieTransport(dir)!);
		expect(conn.url.startsWith("wss://api.example/api/v1/namespaces/")).toBe(true);
		expect(conn.tls).toEqual({ ca: K8S.caPem });
	});

	it("dials the direct branch by URL with the leaf pinned, lowercased", () => {
		write(DIRECT);
		const conn = evieWsConnection(loadEvieTransport(dir)!);
		expect(conn.url).toBe("wss://federation-router:20001");
		expect(conn.tls).toEqual({ certFp: "ab12" });
		expect(conn.headers.Authorization).toBe(`Bearer ${DIRECT.bearer}`);
	});
});
