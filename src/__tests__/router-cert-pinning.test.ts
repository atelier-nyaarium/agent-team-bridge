import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { classifyLeaf, pinnedDial, pinRefusal } from "../gateway/router/pinnedSocket.js";
import { startRouterClient } from "../gateway/router/routerClient.js";
import { processAmbient } from "../shared/ambient.js";

interface Pair {
	certPem: string;
	keyPem: string;
	fp: string;
}

let dir = "";

function mint(cn: string): Pair {
	const certFile = path.join(dir, `${cn}.pem`);
	const keyFile = path.join(dir, `${cn}.key`);
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyFile,
			"-out",
			certFile,
			"-days",
			"2",
			"-subj",
			`/CN=${cn}`,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`mint failed: ${result.stderr}`);
	const certPem = readFileSync(certFile, "utf8");
	return {
		certPem,
		keyPem: readFileSync(keyFile, "utf8"),
		fp: createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex"),
	};
}

interface FakeRouter {
	url: string;
	sawAuth: string[];
	stop: () => Promise<void>;
}

function startTlsRouter(pair: Pair): Promise<FakeRouter> {
	const sawAuth: string[] = [];
	const wss = new WebSocketServer({ noServer: true });
	const server = https.createServer({ cert: pair.certPem, key: pair.keyPem }, (_request, response) =>
		response.end("ok"),
	);
	server.on("upgrade", (request, socket, head) => {
		sawAuth.push(String(request.headers.authorization ?? ""));
		wss.handleUpgrade(request, socket, head, () => {});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
				sawAuth,
				stop: () =>
					new Promise<void>((done) => {
						wss.close();
						server.close(() => done());
					}),
			});
		});
	});
}

describe("router cert pinning", () => {
	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), "pin-test-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	let client: ReturnType<typeof startRouterClient> | null = null;
	let router: FakeRouter | null = null;
	afterEach(async () => {
		client?.stop();
		client = null;
		await router?.stop();
		router = null;
	});

	it("reads a certificate as matching, wrong, or unreadable, and never folds the third into the second", () => {
		const good = mint("good-leaf");
		const other = mint("other-leaf");
		const raw = new X509Certificate(good.certPem).raw;

		expect(classifyLeaf(raw, good.fp)).toBe("match");
		expect(classifyLeaf(raw, good.fp.toUpperCase())).toBe("match");
		expect(classifyLeaf(raw, other.fp)).toBe("mismatch");
		expect(classifyLeaf(undefined, good.fp)).toBe("unreadable");
		expect(classifyLeaf(Buffer.alloc(0), good.fp)).toBe("unreadable");

		const reasons = new Set([pinRefusal("mismatch"), pinRefusal("unreadable"), pinRefusal("pending")]);
		expect(reasons.size).toBe(3);
	});

	it("starts out having verified nothing, rather than assuming a pass", () => {
		expect(pinnedDial("127.0.0.1", 1, mint("unused").fp).verdict()).toBe("pending");
	});

	it("never sends the bearer to a router whose certificate does not match the pin", async () => {
		const served = mint("served-leaf");
		const expected = mint("expected-leaf");
		router = await startTlsRouter(served);

		client = startRouterClient({
			ambient: processAmbient(),
			url: router.url,
			headers: { authorization: "Bearer super-secret" },
			tls: { certFp: expected.fp },
			gatewayId: "g1",
			domainId: "d1",
			reconnectInitialDelayMs: 50,
		});

		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(client.isConnected()).toBe(false);
		// Pin refusal precedes any bearer-bearing write.
		expect(router.sawAuth).toEqual([]);
	});

	it("connects when the certificate matches the pin", async () => {
		const served = mint("matching-leaf");
		router = await startTlsRouter(served);

		client = startRouterClient({
			ambient: processAmbient(),
			url: router.url,
			headers: { authorization: "Bearer super-secret" },
			tls: { certFp: served.fp },
			gatewayId: "g1",
			domainId: "d1",
			reconnectInitialDelayMs: 50,
		});

		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(client.isConnected()).toBe(true);
		expect(router.sawAuth).toEqual(["Bearer super-secret"]);
	});
});
