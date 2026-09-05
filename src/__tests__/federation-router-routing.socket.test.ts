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
		// Refused, not answered empty.
		const refused = await callTool(unregistered, "list_gateways", {});
		expect(refused.error).toBeDefined();
		expect(refused.result).toBeUndefined();
	});

	it("forwards a relay frame the destination's own schema accepts", async () => {
		// Parsed with the destination's schema.
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
			payload: { sealed: { ephemeralPub: "ZQ==", nonce: "bg==", ciphertext: "Yw==", signature: "cw==" } },
		});
		const parsed = GatewayRelayFrameSchema.safeParse(await arriving);
		expect(parsed.success, parsed.error?.issues[0]?.message).toBe(true);
	});
});
