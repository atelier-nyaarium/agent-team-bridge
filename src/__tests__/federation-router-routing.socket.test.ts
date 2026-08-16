import { afterEach, describe, expect, it } from "vitest";
import { GatewayRelayFrameSchema } from "../shared/federation-protocol.js";
import {
	callTool,
	type Frame,
	nextFrame,
	openGateway,
	type RouterFixture,
	registerParams,
	startRouter,
} from "./helpers/federation-router.js";

describe("federation router routing", () => {
	let fixture: RouterFixture | null = null;
	let sockets: WebSocket[] = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	it("returns 404 for paths outside the three surfaces", async () => {
		fixture = await startRouter();
		const response = await fetch(`https://localhost:${fixture.port}/missing`);
		expect(response.status).toBe(404);
	});

	it("lists only gateways in the registered domain", async () => {
		fixture = await startRouter();
		const gateway = openGateway(fixture.port);
		sockets.push(gateway);
		await new Promise<void>((resolve) => gateway.addEventListener("open", () => resolve(), { once: true }));
		await callTool(gateway, "gateway_register", registerParams(fixture));
		const other = openGateway(fixture.port);
		sockets.push(other);
		await new Promise<void>((resolve) => other.addEventListener("open", () => resolve(), { once: true }));
		await callTool(other, "gateway_register", registerParams(fixture, "other", "other-proof"));
		const result = await callTool(gateway, "list_gateways", {});
		expect(result.result).toEqual({ gateways: [{ gatewayId: "other", online: true }] });
		const unregistered = openGateway(fixture.port);
		sockets.push(unregistered);
		await new Promise<void>((resolve) => unregistered.addEventListener("open", () => resolve(), { once: true }));
		const empty = await callTool(unregistered, "list_gateways", {});
		expect(empty.result).toEqual({ gateways: [] });
	});

	it("forwards a relay frame the destination's own schema accepts", async () => {
		// Parsed with the SCHEMA THE DESTINATION USES, not a hand-written shape. The Router omitted the
		// required `v`, so every gateway-to-gateway relay was rejected at the far end and `discover()`
		// turned that into an empty list with no log. A Domain with one Gateway never relays, so this
		// only surfaced when a second machine was enrolled and contributed nothing.
		fixture = await startRouter();
		const src = openGateway(fixture.port);
		sockets.push(src);
		await new Promise<void>((resolve) => src.addEventListener("open", () => resolve(), { once: true }));
		await callTool(src, "gateway_register", registerParams(fixture));
		const dst = openGateway(fixture.port);
		sockets.push(dst);
		await new Promise<void>((resolve) => dst.addEventListener("open", () => resolve(), { once: true }));
		await callTool(dst, "gateway_register", registerParams(fixture, "other", "other-proof"));

		const arriving: Promise<Frame> = nextFrame(dst, (frame) => frame.type === "gateway_relay");
		void callTool(src, "gateway_relay", {
			relayId: "r1",
			srcGateway: "laptop",
			dstGateway: "other",
			payload: { sealed: { ephemeralPub: "e", nonce: "n", ciphertext: "c", signature: "s" } },
		});
		const parsed = GatewayRelayFrameSchema.safeParse(await arriving);
		expect(parsed.success, parsed.error?.issues[0]?.message).toBe(true);
	});
});
