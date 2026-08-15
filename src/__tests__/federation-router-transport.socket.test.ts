import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openGateway, type RouterFixture, startRouter } from "./helpers/federation-router.js";

describe("federation router transport", () => {
	let fixture: RouterFixture | null = null;
	let sockets: Array<{ close(): void }> = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	it("refuses a bearer mismatch at upgrade", async () => {
		fixture = await startRouter();
		const socket = new WebSocket(`wss://localhost:${fixture.port}/gateway`, {
			rejectUnauthorized: false,
			headers: { Authorization: "Bearer wrong" },
		});
		sockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("error", (error) => {
				expect(String(error)).toContain("Unexpected server response: 401");
				resolve();
			});
			socket.once("open", () => reject(new Error("unauthorized socket opened")));
		});
	});

	it("accepts a bearer-authenticated WebSocket", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await expect(
			new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
			}),
		).resolves.toBeUndefined();
	});

	it("returns transport errors for malformed JSON and unsupported tools", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		const messages: Record<string, unknown>[] = [];
		const next = new Promise<Record<string, unknown>>((resolve) => {
			const onMessage = (event: MessageEvent) => {
				const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
				messages.push(frame);
				if (messages.length === 2) {
					socket.removeEventListener("message", onMessage);
					resolve(frame);
				}
			};
			socket.addEventListener("message", onMessage);
		});
		socket.send("not-json");
		socket.send(JSON.stringify({ type: "tool_call", callId: "unknown", action: "unknown_tool", params: {} }));
		const last = await next;
		expect(messages[0]).toMatchObject({ type: "tool_error", error: "Invalid JSON" });
		expect(last).toMatchObject({ type: "tool_error", callId: "unknown" });
	});

	it("closes an oversized WebSocket frame", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
		);
		socket.send("x".repeat(67_108_865));
		expect(await closed).toBe(1009);
	});
});
