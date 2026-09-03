import { describe, expect, it } from "vitest";
import {
	createGatewayRelayHandler,
	createGatewayRelayPump,
	type FederationRoutes,
} from "../gateway/federation/gatewayRelay.js";
import type { Sealer } from "../gateway/federation/sealer.js";

function makeHandler(respond: FederationRoutes["respond"]) {
	const routes: FederationRoutes = {
		send: async () => new Response(JSON.stringify({ session_id: "s", status: "running" })),
		respond,
		teams: () => new Response(JSON.stringify([])),
		localSpawnPoints: () => [{ domainId: "alice", gatewayId: "test-host", hostSpawns: [] }],
		landCrossDomainPresence: () => {},
	};
	return createGatewayRelayHandler({
		routes,
		tryWakeTeam: async () => ({ ok: false }),
		localGatewayId: "test-host",
		localDomainId: "alice",
	});
}

describe("gatewayRelay response_push", () => {
	it("forwards title, summary, replyAsJson, question, and reason to routes.respond", async () => {
		let received: [Request, Record<string, unknown>] | undefined;
		const { handleOp } = makeHandler((req, body) => {
			received = [req, body];
			return new Response(JSON.stringify({ ok: true }));
		});

		await handleOp(
			{
				kind: "response_push",
				session_id: "conv.owner-1.alice.test-host.coolapp.dev",
				status: "completed",
				response: "ship it",
				title: "Ready to ship",
				summary: "The build is green and ready to deploy.",
				replyAsJson: { ok: true, count: 3 },
				question: "which env?",
				reason: "waiting on approval",
			},
			"friend-gw",
			null,
		);

		expect(received?.[1]).toMatchObject({
			session_id: "conv.owner-1.alice.test-host.coolapp.dev",
			status: "completed",
			response: "ship it",
			title: "Ready to ship",
			summary: "The build is green and ready to deploy.",
			replyAsJson: { ok: true, count: 3 },
			question: "which env?",
			reason: "waiting on approval",
		});
	});
});

////////////////////////////////
//  Pump error surfaces

function frame() {
	return {
		type: "gateway_relay",
		v: 1,
		relayId: "r-1",
		srcGateway: "friend-gw",
		dstGateway: "test-host",
		payload: { sealed: { ephemeralPub: "ZQ==", nonce: "bg==", ciphertext: "Yw==", signature: "cw==" } },
	};
}

function pumpWith(open: Sealer["openWithSource"]) {
	const replies: Array<{ ok: boolean; error?: string }> = [];
	const sealer = { seal: () => ({}), open: () => ({}), openWithSource: open } as unknown as Sealer;
	const pump = createGatewayRelayPump({
		handleOp: async () => ({ ok: true }),
		sealer,
		sendReply: async (r) => {
			replies.push(r);
			return {};
		},
	});
	pump(frame());
	return replies;
}

describe("gatewayRelay pump error surfaces", () => {
	it("blames the seal when the seal is what failed", async () => {
		const replies = pumpWith(() => {
			throw new Error("not admitted");
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(replies[0]?.ok).toBe(false);
		expect(replies[0]?.error).toContain("unseal failed");
	});

	it("blames the op, not the seal, when a verified peer sends a shape this build rejects", async () => {
		// A peer on an older wire shape verifies its signature perfectly and still fails the inner
		// parse. Reporting that as an unseal failure sends whoever debugs it after the crypto instead
		// of the version skew, which is the whole reason the two are reported apart.
		const replies = pumpWith(() => ({
			body: { kind: "console_push", entry: { files: [{ filename: "a.txt" }] } },
			srcDomainId: null,
		}));
		await new Promise((r) => setTimeout(r, 0));

		expect(replies[0]?.ok).toBe(false);
		expect(replies[0]?.error).toContain("op rejected");
		expect(replies[0]?.error).not.toContain("unseal");
	});
});
