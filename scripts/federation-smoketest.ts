import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import WebSocket from "ws";

const baseUrl = readArg("--url") ?? "https://localhost:20001";
const target = new URL(baseUrl);
const env = readEnv(path.resolve(".env"));
const consoleToken = env.CONSOLE_BRIDGE_TOKEN;
const federationToken = env.FEDERATION_WS_TOKEN;
// The cert is written by the container as root, so read the fingerprint the way an operator
// does: off the boot line, or passed in. Never off the data volume.
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/`;
// Bun's ws reads TLS options under `tls`; node's reads them at the top level. Send both.
const insecureTls = { rejectUnauthorized: false, tls: { rejectUnauthorized: false } };
const expectedFingerprint = readArg("--fingerprint") ?? fingerprintFromLogs();
let failures = 0;

function fingerprintFromLogs(): string {
	const logs = Bun.spawnSync(["docker", "logs", "switchboard-federation"], { stderr: "pipe" });
	const text = `${logs.stdout.toString()}${logs.stderr.toString()}`;
	const match = /TLS fingerprint ([0-9a-f]{64})/.exec(text);
	if (!match) throw new Error("no TLS fingerprint found; pass --fingerprint <hex>");
	return match[1];
}

function readArg(name: string): string | null {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? (Bun.argv[index + 1] ?? null) : null;
}

function readEnv(file: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
		if (match) values[match[1]] = match[2];
	}
	return values;
}

const CHECK_TIMEOUT_MS = 10_000;

// Every check is bounded: a hung socket must report FAIL, not produce no output at all.
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms: ${label}`)), CHECK_TIMEOUT_MS),
		),
	]);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await withTimeout(fn(), name);
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function skip(name: string, why: string): void {
	console.log(`SKIP ${name}: ${why}`);
}

function request(
	pathname: string,
	options: { method?: string; token?: string; body?: Uint8Array } = {},
): Promise<ResponseData> {
	return new Promise((resolve, reject) => {
		const body = options.body;
		const req = https.request(
			{
				host: target.hostname,
				port: Number(target.port || 443),
				path: pathname,
				method: options.method ?? "GET",
				rejectUnauthorized: false,
				headers: {
					...(options.token ? { "X-Console-Bridge-Token": `Bearer ${options.token}` } : {}),
					...(body ? { "content-length": body.byteLength } : {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

async function checkFingerprint(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = tls.connect(
			{
				host: target.hostname,
				port: Number(target.port || 443),
				rejectUnauthorized: false,
				servername: target.hostname,
			},
			() => {
				const raw = socket.getPeerCertificate(true).raw;
				const actual = raw ? createHash("sha256").update(raw).digest("hex") : "";
				if (actual !== expectedFingerprint) reject(new Error(`fingerprint mismatch: ${actual}`));
				else resolve();
				socket.end();
			},
		);
		socket.on("error", reject);
	});
}

async function openGateway(token: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl, {
			...insecureTls,
			headers: { Authorization: `Bearer ${token}` },
		});
		ws.on("error", reject);
		ws.once("open", () => resolve(ws));
	});
}

interface ResponseData {
	status: number;
	body: Buffer;
}

await check("TLS fingerprint", checkFingerprint);
await check("health", async () => {
	const response = await request("/health");
	if (response.status !== 200) throw new Error(`status ${response.status}`);
});
await check("unknown path", async () => {
	const response = await request("/missing");
	if (response.status !== 404) throw new Error(`status ${response.status}`);
});
await check("console rejects missing token", async () => {
	const response = await request("/console", { method: "POST", body: Buffer.from("{}") });
	if (response.status !== 401) throw new Error(`status ${response.status}`);
});
await check("console accepts token", async () => {
	if (!consoleToken) throw new Error("missing console token");
	const response = await request("/console", { method: "POST", token: consoleToken, body: Buffer.from("{}") });
	if (response.status === 401) throw new Error("token rejected");
});
await check("public approval join", async () => {
	const body = Buffer.from(
		JSON.stringify({ step: "join", approvalId: "AA==", nonce: "AA==", newSignPub: "AA==", newBoxPub: "AA==" }),
	);
	const response = await request("/device-approval", { method: "POST", body });
	if (response.status !== 200) throw new Error(`status ${response.status}`);
});
await check("oversize body", async () => {
	const response = await request("/device-approval", { method: "POST", body: new Uint8Array(8193) });
	if (response.status !== 413) throw new Error(`status ${response.status}`);
});
await check("wrong gateway bearer", async () => {
	await new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(wsUrl, {
			...insecureTls,
			headers: { Authorization: "Bearer wrong" },
		});
		// Refusal is the behavior; the message wording differs by runtime. A persistent
		// listener, since a refused socket emits more than one error.
		ws.on("error", () => resolve());
		ws.on("close", () => resolve());
		ws.once("open", () => {
			ws.close();
			reject(new Error("upgrade accepted"));
		});
	});
});
// A thrown handleCall answers tool_error, and a refused socket just closes; settling on
// tool_result alone left this check hanging rather than failing.
function callGateway(ws: WebSocket, callId: string, action: string, params: Record<string, unknown>) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.on("message", (data) => {
			const frame = JSON.parse(String(data)) as Record<string, unknown>;
			if (frame.callId !== callId) return;
			if (frame.type === "tool_result") resolve(frame.result as Record<string, unknown>);
			if (frame.type === "tool_error") reject(new Error(String(frame.error)));
		});
		ws.on("error", reject);
		ws.on("close", () => reject(new Error("socket closed before reply")));
		ws.send(JSON.stringify({ type: "tool_call", callId, action, params }));
	});
}

async function registerGateway(gatewayId: string): Promise<WebSocket> {
	if (!federationToken) throw new Error("missing federation token");
	const ws = await openGateway(federationToken);
	await callGateway(ws, `reg-${gatewayId}`, "gateway_register", {
		domainId: "admin",
		gatewayId,
		protocolVersion: 1,
	});
	return ws;
}

await check("gateway registration", async () => {
	const ws = await registerGateway("smoketest");
	const reply = await callGateway(ws, "list", "list_gateways", {});
	ws.close();
	if (!Array.isArray(reply.gateways)) throw new Error("missing gateways field");
});

await check("gateway relay round trip", async () => {
	const origin = await registerGateway("smoketest-origin");
	const destination = await registerGateway("smoketest-destination");
	const relayId = "smoketest-relay";
	const delivered = new Promise<void>((resolve, reject) => {
		destination.on("message", (data) => {
			const frame = JSON.parse(String(data)) as Record<string, unknown>;
			if (frame.type !== "gateway_relay" || frame.relayId !== relayId) return;
			destination.send(
				JSON.stringify({
					type: "tool_call",
					callId: "relay-reply",
					action: "gateway_relay_reply",
					params: { relayId, ok: true, result: { seen: true } },
				}),
			);
			resolve();
		});
		destination.on("close", () => reject(new Error("destination closed")));
	});
	const replied = callGateway(origin, relayId, "gateway_relay", {
		relayId,
		srcGateway: "smoketest-origin",
		dstGateway: "smoketest-destination",
		payload: { smoketest: true },
	});
	await delivered;
	const reply = await replied;
	origin.close();
	destination.close();
	if (reply.ok !== true) throw new Error("relay not acknowledged");
});

// Every field is a b64Field, and a malformed op 404s before the per-id limiter is reached.
const b64 = (value: string) => Buffer.from(value).toString("base64");

await check("public approval fetch", async () => {
	const response = await request("/device-approval", {
		method: "POST",
		body: new TextEncoder().encode(
			JSON.stringify({ step: "fetch", approvalId: b64("smoketest-unknown"), nonce: b64("nonce") }),
		),
	});
	// An unknown id is an opaque miss, never an enumeration.
	if (response.status !== 200) throw new Error(`status ${response.status}`);
});

await check("public approval rate limit", async () => {
	const body = new TextEncoder().encode(
		JSON.stringify({
			step: "fetch",
			approvalId: b64(`rate-${Date.now()}`),
			nonce: b64("nonce"),
		}),
	);
	let limited = false;
	for (let i = 0; i < 80 && !limited; i++) {
		const response = await request("/device-approval", { method: "POST", body });
		if (response.status === 429) limited = true;
	}
	if (!limited) throw new Error("never rate limited");
});

skip("console send/poll + idempotent replay", "needs a registered gateway serving the console relay");

if (failures) process.exit(1);
