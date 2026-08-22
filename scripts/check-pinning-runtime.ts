// Proves the shipping runtime can pin the Router's certificate.
//
// The vitest suite runs under node, where `ws` is the real package and a peer certificate is always
// readable. The gateway runs under bun, which substitutes its own WebSocket for that import - one
// that exposes no certificate and ignores createConnection. So every pinning assertion passed on
// node while the gateway refused every connection in production, reporting a mismatch against a
// certificate that was correct. Nothing in the TS suite can see that difference; this can, because
// bun runs it.

import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { pinnedDial, realWebSocket } from "../src/gateway/router/pinnedSocket.js";

////////////////////////////////
//  Functions & Helpers

const dir = mkdtempSync(path.join(tmpdir(), "pin-runtime-"));
const runtime = (globalThis as { Bun?: { version: string } }).Bun
	? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
	: `node ${process.version}`;

function mint(cn: string): { certPem: string; keyPem: string; fp: string } {
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
	if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
	const certPem = readFileSync(certFile, "utf8");
	return {
		certPem,
		keyPem: readFileSync(keyFile, "utf8"),
		fp: createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex"),
	};
}

async function main(): Promise<void> {
	const served = mint("served");
	const other = mint("other");
	const sawAuth: string[] = [];

	const wss = new WebSocketServer({ noServer: true });
	const server = https.createServer({ cert: served.certPem, key: served.keyPem }, (_q, r) => r.end("ok"));
	server.on("upgrade", (request, socket, head) => {
		sawAuth.push(String(request.headers.authorization ?? ""));
		wss.handleUpgrade(request, socket, head, () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	const RealWebSocket = realWebSocket();

	const dial = (fp: string): Promise<{ opened: boolean; verdict: string }> =>
		new Promise((resolve) => {
			const pin = pinnedDial("127.0.0.1", port, fp);
			const ws = new RealWebSocket(`wss://127.0.0.1:${port}`, {
				headers: { authorization: "Bearer probe-secret" },
				createConnection: pin.createConnection as never,
			});
			const finish = (opened: boolean) => {
				try {
					ws.terminate();
				} catch {}
				resolve({ opened, verdict: pin.verdict() });
			};
			ws.on("open", () => finish(true));
			ws.on("error", () => finish(false));
			setTimeout(() => finish(false), 8000);
		});

	const good = await dial(served.fp);
	const bad = await dial(other.fp);
	wss.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const failures: string[] = [];
	if (!good.opened || good.verdict !== "match") {
		failures.push(`a matching certificate was refused (opened=${good.opened} verdict=${good.verdict})`);
	}
	if (bad.opened) failures.push("a wrong certificate was accepted");
	if (bad.verdict !== "mismatch") {
		// `pending` here is the real regression: the runtime never handed the socket over, so nothing
		// was checked and the refusal above was luck rather than verification.
		failures.push(`a wrong certificate produced "${bad.verdict}" instead of a mismatch`);
	}
	if (sawAuth.length !== 1) {
		failures.push(`the bearer reached the listener ${sawAuth.length} times, expected only the matching dial`);
	}

	if (failures.length) {
		console.error(`[pinning] FAILED on ${runtime}`);
		for (const failure of failures) console.error(`[pinning]   ${failure}`);
		console.error(
			`[pinning] the gateway cannot authenticate its Router on this runtime; bun 1.4+ or node is required`,
		);
		process.exit(1);
	}
	console.log(`[pinning] ok on ${runtime}: match connects, mismatch refused before the bearer is sent`);
}

try {
	await main();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
