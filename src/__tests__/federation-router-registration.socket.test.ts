import { afterEach, describe, expect, it } from "vitest";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { FEDERATION_PROTOCOL_FLOOR, FEDERATION_PROTOCOL_VERSION } from "../shared/router-protocol.js";
import { callTool, openGateway, type RouterFixture, registerParams, startRouter } from "./helpers/federation-router.js";

describe("federation router registration", () => {
	let fixture: RouterFixture | null = null;
	let sockets: WebSocket[] = [];
	afterEach(async () => {
		for (const socket of sockets) socket.close();
		sockets = [];
		await fixture?.stop();
		fixture = null;
	});

	it("accepts an admitted gateway and returns the protocol floor and domain sync", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		const result = await callTool(socket, "gateway_register", registerParams(fixture));
		expect(result.result).toMatchObject({
			ok: true,
			protocolFloor: FEDERATION_PROTOCOL_FLOOR,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			domainId: "admin",
		});
	});

	it("refuses forged, corrupted, replayed, old, and pending registrations", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		const params = registerParams(fixture);
		const attacker = generateIdentity();
		const forgedAdmission = signAdmission(
			{
				kind: "gateway",
				signPub: fixture.host.sign.pub,
				boxPub: fixture.host.box.pub,
				gatewayId: params.gatewayId,
				issuedAt: Date.now(),
				nonce: "forged-admission",
			},
			attacker.sign.priv,
			attacker.sign.pub,
		);
		const forged = await callTool(socket, "gateway_register", {
			...params,
			admission: JSON.stringify(forgedAdmission),
		});
		const corrupted = await callTool(socket, "gateway_register", {
			...params,
			admission: JSON.stringify(fixture.admission),
			proof: "corrupted-proof",
			proofNonce: "corrupt-proof-nonce",
		});
		const valid = await callTool(socket, "gateway_register", params);
		const replay = await callTool(socket, "gateway_register", params);
		const old = await callTool(socket, "gateway_register", { ...params, proofNonce: "new", protocolVersion: 0 });
		expect((forged.result as { ok: boolean }).ok).toBe(false);
		expect((corrupted.result as { ok: boolean }).ok).toBe(false);
		expect((valid.result as { ok: boolean }).ok).toBe(true);
		expect((replay.result as { ok: boolean }).ok).toBe(false);
		expect((old.result as { ok: boolean }).ok).toBe(false);

		await fixture.stop();
		fixture = await startRouter({ pendingTenant: true });
		const pendingSocket = openGateway(fixture.port);
		sockets.push(pendingSocket);
		await new Promise<void>((resolve) => pendingSocket.addEventListener("open", () => resolve(), { once: true }));
		const pending = await callTool(
			pendingSocket,
			"gateway_register",
			registerParams(fixture, "pending-gateway", crypto.randomUUID(), "pending"),
		);
		expect(pending.result).toMatchObject({ ok: false, pending: true });
	});

	it("keeps the admin identity-less bootstrap carve-out", async () => {
		fixture = await startRouter();
		const socket = openGateway(fixture.port);
		sockets.push(socket);
		await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		const result = await callTool(socket, "gateway_register", {
			domainId: "admin",
			gatewayId: "bootstrap",
			protocolVersion: 1,
		});
		expect(result.result).toMatchObject({ ok: true, isAdminDomain: true });
	});
});
