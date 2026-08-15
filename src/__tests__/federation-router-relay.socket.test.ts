import { afterEach, describe, expect, it } from "vitest";
import {
	callTool,
	nextFrame,
	openGateway,
	type RouterFixture,
	registerParams,
	startRouter,
} from "./helpers/federation-router.js";

describe("federation router relay", () => {
	let fixture: RouterFixture | null = null;
	let sockets: WebSocket[] = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	it("routes same-domain relays and accepts only the destination reply", async () => {
		fixture = await startRouter();
		const source = openGateway(fixture.port);
		const destination = openGateway(fixture.port);
		sockets.push(source, destination);
		await Promise.all([
			new Promise<void>((resolve) => source.addEventListener("open", () => resolve(), { once: true })),
			new Promise<void>((resolve) => destination.addEventListener("open", () => resolve(), { once: true })),
		]);
		await callTool(source, "gateway_register", registerParams(fixture, "source"));
		await callTool(destination, "gateway_register", registerParams(fixture, "laptop", "second-proof"));
		const relay = callTool(source, "gateway_relay", {
			relayId: "relay-1",
			srcGateway: "source",
			dstGateway: "laptop",
			payload: { type: "opaque" },
		});
		const forwarded = await nextFrame(destination, (frame) => frame.type === "gateway_relay");
		destination.send(
			JSON.stringify({
				type: "tool_call",
				callId: "reply-1",
				action: "gateway_relay_reply",
				params: { relayId: forwarded.relayId, ok: true, result: { accepted: true } },
			}),
		);
		expect((await relay).result).toMatchObject({ ok: true, result: { accepted: true } });
	});

	it("returns an offline failure when the destination disconnects", async () => {
		fixture = await startRouter();
		const source = openGateway(fixture.port);
		const destination = openGateway(fixture.port);
		sockets.push(source, destination);
		await Promise.all([
			new Promise<void>((resolve) => source.addEventListener("open", () => resolve(), { once: true })),
			new Promise<void>((resolve) => destination.addEventListener("open", () => resolve(), { once: true })),
		]);
		await callTool(source, "gateway_register", registerParams(fixture, "source"));
		await callTool(destination, "gateway_register", registerParams(fixture, "laptop", "second-proof"));
		const relay = callTool(source, "gateway_relay", {
			relayId: "relay-2",
			srcGateway: "source",
			dstGateway: "laptop",
			payload: {},
		});
		destination.close();
		expect((await relay).result).toMatchObject({ ok: false });
	});
});
