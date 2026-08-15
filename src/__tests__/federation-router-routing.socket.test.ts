import { afterEach, describe, expect, it } from "vitest";
import { callTool, openGateway, type RouterFixture, registerParams, startRouter } from "./helpers/federation-router.js";

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
});
