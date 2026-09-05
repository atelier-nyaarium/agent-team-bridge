import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_TOKEN, type RouterFixture, startRouter } from "./helpers/federation-router.js";

describe("federation router console surface", () => {
	let fixture: RouterFixture | null = null;
	afterEach(async () => {
		await fixture?.stop();
		fixture = null;
	});

	function request(opId: string, token = CONSOLE_TOKEN): Promise<Response> {
		return fetch(`https://localhost:${fixture?.port}/console`, {
			method: "POST",
			headers: { "X-Console-Bridge-Token": `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ opId, signerSignPub: "console", sealed: { value: "opaque" } }),
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
});
