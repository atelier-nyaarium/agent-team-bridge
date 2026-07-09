import { describe, expect, it } from "vitest";
import { createGatewayRelayHandler, type FederationRoutes } from "../gateway/federation/gatewayRelay.js";

function makeHandler(respond: FederationRoutes["respond"]) {
	const routes: FederationRoutes = {
		send: async () => new Response(JSON.stringify({ session_id: "s", status: "running" })),
		respond,
		teams: () => new Response(JSON.stringify([])),
	};
	return createGatewayRelayHandler({
		routes,
		tryWakeTeam: async () => ({ ok: false }),
		localGatewayId: "test-host",
		localDomainId: "alice",
	});
}

describe("gatewayRelay response_push", () => {
	it("forwards title, summary, replyAsJson, question, and reason to routes.respond, trustedInbound", async () => {
		let received: [Request, Record<string, unknown>, { trustedInbound?: boolean } | undefined] | undefined;
		const { handleOp } = makeHandler((req, body, opts) => {
			received = [req, body, opts];
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
		expect(received?.[2]).toEqual({ trustedInbound: true });
	});
});
