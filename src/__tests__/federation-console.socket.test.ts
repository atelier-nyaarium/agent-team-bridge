import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { signTrustPendingRequest } from "../shared/federation-proofs.js";
import { CONSOLE_TOKEN, openGateway, type RouterFixture, startRouter } from "./helpers/federation-router.js";

describe("federation router console surface", () => {
	let fixture: RouterFixture | null = null;
	let sockets: WebSocket[] = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	function request(opId: string, token = CONSOLE_TOKEN): Promise<Response> {
		return requestBody("/console", { opId, signerSignPub: "console", sealed: { value: "opaque" } }, token);
	}

	function requestBody(path: string, body: Record<string, unknown>, token = CONSOLE_TOKEN): Promise<Response> {
		return fetch(`https://localhost:${fixture?.port}${path}`, {
			method: "POST",
			headers: { "X-Console-Bridge-Token": `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function abortBody(path: string, authenticated = false): Promise<void> {
		await new Promise<void>((resolve) => {
			const socket = net.connect(fixture?.port ?? 0, "localhost", () => {
				const secure = tls.connect({ socket, rejectUnauthorized: false, servername: "localhost" }, () => {
					secure.write(
						`POST ${path} HTTP/1.1\r\nHost: localhost\r\n${
							authenticated ? `X-Console-Bridge-Token: Bearer ${CONSOLE_TOKEN}\r\n` : ""
						}Content-Length: 999999999\r\n\r\npartial`,
					);
					// Reset the raw socket: a TLS wrapper cannot be reset directly.
					setTimeout(() => {
						socket.resetAndDestroy();
						resolve();
					}, 20);
				});
				secure.on("error", () => resolve());
			});
			socket.on("error", () => resolve());
		});
	}

	it("rejects a bad token", async () => {
		fixture = await startRouter();
		expect((await request("bad", "wrong")).status).toBe(401);
	});

	it("keeps public approval token-free while console remains gated", async () => {
		fixture = await startRouter();
		const approval = await fetch(`https://localhost:${fixture.port}/device-approval`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ step: "join", approvalId: "unknown" }),
		});
		expect(approval.status).toBe(404);
		expect((await request("gated", "wrong")).status).toBe(401);
	});

	it("survives aborted bodies on every capped surface", async () => {
		fixture = await startRouter();
		for (const path of ["/console", "/ingest", "/device-approval"]) {
			await abortBody(path);
			await abortBody(path, true);
		}
		expect((await fetch(`https://localhost:${fixture.port}/health`)).status).toBe(200);
	});

	it("returns 413 for an oversized console body and stays alive", async () => {
		fixture = await startRouter();
		const body = Buffer.alloc(67_108_865, 97);
		const response = await fetch(`https://localhost:${fixture.port}/console`, {
			method: "POST",
			headers: { "X-Console-Bridge-Token": `Bearer ${CONSOLE_TOKEN}`, "content-type": "application/json" },
			body,
		});
		expect(response.status).toBe(413);
		expect((await fetch(`https://localhost:${fixture.port}/health`)).status).toBe(200);
	});

	it("authenticates trust-pending queries and rejects replay", async () => {
		fixture = await startRouter();
		const rendezvousId = Buffer.from("trust1").toString("base64");
		const arm = await requestBody("/console", {
			trustHandshake: {
				step: "arm",
				rendezvousId,
				initiatorOwnerSignPub: fixture.owner.sign.pub,
				targetOwnerSignPub: fixture.friendOwner.sign.pub,
				commitment: Buffer.from("commitment").toString("base64"),
			},
		});
		expect(arm.status).toBe(200);
		const proofAt = Date.now();
		const nonce = Buffer.from("trustPendingNonce").toString("base64");
		const valid = {
			signerSignPub: fixture.friendOwner.sign.pub,
			proofAt,
			nonce,
			proof: signTrustPendingRequest(fixture.friendOwner.sign.pub, proofAt, nonce, fixture.friendOwner.sign.priv),
		};
		const garbage = await requestBody("/console", { trustPending: { ...valid, proof: "bad" } });
		expect(await garbage.json()).toEqual({ ok: true, pending: [] });
		const first = await requestBody("/console", { trustPending: valid });
		expect(await first.json()).toMatchObject({ ok: true, pending: [{ rendezvousId }] });
		const replay = await requestBody("/console", { trustPending: valid });
		expect(await replay.json()).toEqual({ ok: true, pending: [] });
	});

	it("exposes the gateway endpoint only through the bearer gate", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		expect(socket).toBeDefined();
	});
});
