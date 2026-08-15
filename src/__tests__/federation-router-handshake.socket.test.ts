import { afterEach, describe, expect, it } from "vitest";
import {
	callTool,
	nextFrame,
	openGateway,
	type RouterFixture,
	registerParams,
	startRouter,
} from "./helpers/federation-router.js";

describe("federation router handshake", () => {
	let fixture: RouterFixture | null = null;
	let sockets: WebSocket[] = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	it("forwards a cross-domain handshake only to a registered foreign gateway", async () => {
		fixture = await startRouter();
		const source = openGateway(fixture.port);
		const destination = openGateway(fixture.port);
		sockets.push(source, destination);
		await Promise.all([
			new Promise<void>((resolve) => source.addEventListener("open", () => resolve(), { once: true })),
			new Promise<void>((resolve) => destination.addEventListener("open", () => resolve(), { once: true })),
		]);
		await callTool(source, "gateway_register", registerParams(fixture, "source"));
		await callTool(destination, "gateway_register", registerParams(fixture, "laptop", "second-proof", "friend"));
		const resultPromise = callTool(source, "cross_domain_handshake", {
			handshakeId: "hs-1",
			srcDomain: "admin",
			srcGateway: "source",
			dstGateway: "laptop",
			payload: {},
		});
		const forwarded = await nextFrame(destination, (frame) => frame.type === "cross_domain_handshake");
		destination.send(
			JSON.stringify({
				type: "tool_call",
				callId: "handshake-reply",
				action: "cross_domain_handshake_reply",
				params: { handshakeId: forwarded.handshakeId, ok: true, result: { accepted: true } },
			}),
		);
		expect((await resultPromise).result).toMatchObject({ ok: true, result: { accepted: true } });
	});
});
