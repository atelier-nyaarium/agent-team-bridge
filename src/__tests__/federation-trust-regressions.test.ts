import { describe, expect, it } from "vitest";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { createRoutes } from "../gateway/routes.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { Address, storeKey } from "../shared/session-id.js";
import type { ResponsePayload } from "../shared/types.js";
import { channelWs, gateRoutes, lib, makeCtx, memShareState, registryWith } from "./helpers/federation.js";

////////////////////////////////
//  Multi-owner cross-Domain trust regressions (the reply + return-route attacks)
//
//  These drive the relay handler against a REAL PendingJobStore (its crossDomainBinding is
//  the production lookup), so the gates are exercised exactly as wired. Replies and
//  return-routes must key on the cryptographically-VERIFIED sending Domain, never the bare,
//  collidable, friend-controlled gateway id.

describe("Fix 1: response_push reply gate binds to the job's verified target Domain", () => {
	// Two linked friends, bob and carol, who happen to run the SAME bare gateway id "dev"
	// (gateway ids are not unique across Domains). alice sent a job to bob's dev; carol must
	// NOT be able to forge a reply into it just because her gateway id also matches.
	function aliceHandler(store: PendingJobStore<ResponsePayload>) {
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "alice-gw",
			localDomainId: "alice",
			shareState: memShareState(),
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId),
		});
		return { handleOp, respondCalls };
	}

	it("a friend sharing the target's bare gateway id CANNOT deliver into another friend's job", async () => {
		// alice's origin anchor: a send routed to bob (Domain "bob", gateway "dev"). The store
		// records dstDomainId "bob" and the key gateway "dev".
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv.c1.bob.dev.lib.dev", "alice.alice-gw.app.dev", "bob.dev.lib.dev", {
			persistent: true,
			fromConversationId: "c1",
			dstDomainId: "bob",
		});
		const { handleOp, respondCalls } = aliceHandler(store);

		// carol (Domain "carol", gateway "dev") forges a reply into alice's bob-bound job. Her
		// verified srcGateway "dev" MATCHES the key gateway, but her Domain does not.
		await expect(
			handleOp(
				{
					kind: "response_push",
					session_id: "conv.c1.bob.dev.lib.dev",
					status: "completed",
					response: "pwned",
				},
				"dev",
				"carol",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);

		// The legitimate friend bob (Domain "bob", gateway "dev") still delivers.
		const ok = (await handleOp(
			{ kind: "response_push", session_id: "conv.c1.bob.dev.lib.dev", status: "completed", response: "real" },
			"dev",
			"bob",
		)) as { ok: boolean };
		expect(ok.ok).toBe(true);
		expect(respondCalls[0]).toMatchObject({ session_id: "conv.c1.bob.dev.lib.dev", response: "real" });
	});

	it("a friend whose GATEWAY_ID equals the local gateway id CANNOT deliver into a LOCAL job", async () => {
		// A purely LOCAL channel job (no dstDomainId, no returnRoute), keyed under the local
		// gateway id "alice-gw". A friend who named its own gateway "alice-gw" must not reach it.
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv.owner1.alice.alice-gw.secret.dev", "alice.alice-gw.app.dev", "secret.dev", {
			persistent: true,
			fromConversationId: "owner1",
		});
		const { handleOp, respondCalls } = aliceHandler(store);

		await expect(
			handleOp(
				{
					kind: "response_push",
					session_id: "conv.owner1.alice.alice-gw.secret.dev",
					status: "completed",
					response: "pwned",
				},
				"alice-gw",
				"mallory",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("a LOCAL /send cannot stamp a Domain binding from the request body (local-job hard-deny holds)", async () => {
		// A local container POSTs /send for a local channel team but tries to smuggle a
		// dstDomainId in the body, hoping to make the resulting local job accept a cross-Domain
		// reply. The route must ignore it (only an inbound federated send stamps the binding), so
		// the local job's binding stays null and the response_push gate hard-denies any friend.
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("alice-gw", { registry: registryWith({ "app.dev": channelWs(pushed) }) });
		const { send } = createRoutes(ctx);
		await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "owner1",
			to: "app.dev",
			body: "local",
			channelOnly: true,
			dstDomainId: "carol", // spoof attempt
		});
		const jobKey = storeKey({
			kind: "conv",
			conversationId: "owner1",
			address: Address.local("alice", "alice-gw", "app", "dev"),
		});
		expect(ctx.store.crossDomainBinding(jobKey)?.dstDomainId).toBeNull();
	});

	it("a LOCAL /send cannot pin the job key or binding via a crafted sessionId (inbound fields are trusted-only)", async () => {
		// The structural hardening: sessionId/returnRoute/dstDomainId are honored ONLY on the trusted
		// internal gateway-relay path (opts.trustedInbound). An external /send that smuggles a crafted
		// sessionId (to choose the job key + its forged domain segment) plus a binding + return-route
		// must have ALL THREE ignored: the job lands at the DERIVED local key, binding null, no
		// return-route - so a colluding friend can neither target a chosen key nor get the reply gate
		// to accept a forged reply.
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("alice-gw", { registry: registryWith({ "app.dev": channelWs(pushed) }) });
		const { send } = createRoutes(ctx);
		const craftedKey = storeKey({
			kind: "conv",
			conversationId: "owner1",
			address: Address.of("mallory", "alice-gw", "app", "dev"),
		});
		await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "owner1",
			to: "app.dev",
			body: "local",
			channelOnly: true,
			sessionId: craftedKey, // attempt to pin the job key (and its forged "mallory" domain)
			dstDomainId: "mallory",
			returnRoute: { srcGateway: "alice-gw", srcConversationId: "owner1", srcSession: craftedKey },
		});
		// The crafted key was ignored - no job created there.
		expect(ctx.store.crossDomainBinding(craftedKey)).toBeUndefined();
		// The job landed at the DERIVED local key, with no binding and no return-route.
		const derivedKey = storeKey({
			kind: "conv",
			conversationId: "owner1",
			address: Address.local("alice", "alice-gw", "app", "dev"),
		});
		const binding = ctx.store.crossDomainBinding(derivedKey);
		expect(binding?.dstDomainId).toBeNull();
		expect(binding?.returnGateway).toBeNull();
	});
});

describe("Fix 2: inbound cross-Domain send validates the attacker-controlled returnRoute", () => {
	// bob (the verified sender, Domain "bob", gateway "bob-gw") sends to alice's shared lib.
	// alice is the destination here; lib is shared to bob.
	function destHandler(store: PendingJobStore<ResponsePayload>, sharedTo: string[] = ["bob"]) {
		const sendCalls: Record<string, unknown>[] = [];
		const routes = {
			teams: () =>
				new Response(JSON.stringify([lib("alice-gw")]), { headers: { "content-type": "application/json" } }),
			// A faithful-enough send: it lands the job in the REAL store with the returnRoute +
			// dstDomainId the handler passes, so a follow-up collision check sees a real entry.
			send: async (_req: Request, body: Record<string, unknown>) => {
				sendCalls.push(body);
				store.create(body.sessionId as string, body.from as string, "lib.dev", {
					persistent: true,
					returnRoute: body.returnRoute as never,
					dstDomainId: body.dstDomainId as string | undefined,
				});
				return new Response(JSON.stringify({ session_id: body.sessionId, status: "running" }), {
					headers: { "content-type": "application/json" },
				});
			},
			respond: (_req: Request, _body: Record<string, unknown>) =>
				new Response(JSON.stringify({ delivered: true }), { headers: { "content-type": "application/json" } }),
		};
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "alice-gw",
			localDomainId: "alice",
			shareState: memShareState(sharedTo.map((d) => ["alice.alice-gw.lib.dev", d] as [string, string])),
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId),
		});
		return { handleOp, sendCalls };
	}

	it("REJECTS a send whose returnRoute.srcGateway is not the verified sender (no exfil to a third friend)", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store);
		// bob is verified (srcGateway "bob-gw", Domain "bob"), but he points the return-route at
		// a THIRD friend's gateway "carol-gw" so the reply would seal + relay to carol.
		await expect(
			handleOp(
				{
					kind: "send",
					from: "bob.bob-gw.app.dev",
					to: "lib.dev",
					body: "collab?",
					returnRoute: {
						srcGateway: "carol-gw",
						srcConversationId: "c1",
						srcSession: "conv.c1.alice.alice-gw.lib.dev",
					},
				},
				"bob-gw",
				"bob",
			),
		).rejects.toThrow(/return-route does not point back to the sending Gateway/);
		expect(sendCalls).toHaveLength(0); // never landed, never relayed
		expect(store.has("conv.c1.alice.alice-gw.lib.dev")).toBe(false);
	});

	it("a send whose returnRoute.srcSession collides with an UNRELATED job does NOT overwrite it", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A pre-existing, unrelated job: a LOCAL channel job at this key (returnRoute null). Its
		// reply must keep routing locally; a friend must not be able to repoint it.
		store.create("conv.victim.alice.alice-gw.lib.dev", "alice.alice-gw.app.dev", "lib.dev", {
			persistent: true,
			fromConversationId: "victim",
		});
		const { handleOp, sendCalls } = destHandler(store);

		// bob (verified) crafts a send whose srcSession is the victim job's key, trying to make
		// create() overwrite its returnRoute with his (hijacking the victim's reply route).
		await expect(
			handleOp(
				{
					kind: "send",
					from: "bob.bob-gw.app.dev",
					to: "lib.dev",
					body: "hijack",
					returnRoute: {
						srcGateway: "bob-gw",
						srcConversationId: "victim",
						srcSession: "conv.victim.alice.alice-gw.lib.dev",
					},
				},
				"bob-gw",
				"bob",
			),
		).rejects.toThrow(/session collides with an unrelated job/);
		expect(sendCalls).toHaveLength(0);
		// The victim job is untouched: still a local job, no returnRoute grafted on.
		const binding = store.crossDomainBinding("conv.victim.alice.alice-gw.lib.dev");
		expect(binding?.dstDomainId).toBeNull();
		expect(binding?.returnGateway).toBeNull();
	});

	it("ALLOWS a legitimate cross-Domain send + an idempotent re-send from the SAME friend", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store);
		const send = {
			kind: "send" as const,
			from: "bob.bob-gw.app.dev",
			to: "lib.dev",
			body: "collab?",
			returnRoute: {
				srcGateway: "bob-gw",
				srcConversationId: "c1",
				srcSession: "conv.c1.alice.alice-gw.lib.dev",
			},
		};
		await handleOp(send, "bob-gw", "bob");
		// A re-send from the same verified friend reuses its own job (idempotent), not a hijack.
		await handleOp(send, "bob-gw", "bob");
		expect(sendCalls).toHaveLength(2);
		const binding = store.crossDomainBinding("conv.c1.alice.alice-gw.lib.dev");
		expect(binding?.dstDomainId).toBe("bob");
		expect(binding?.returnGateway).toBe("bob-gw");
	});

	it("a DIFFERENT friend sharing bob's bare gateway id still cannot hijack bob's job (Domain-qualified)", async () => {
		// lib is shared to BOTH bob and carol, so carol clears the share gate and the collision
		// guard is what must stop her (this isolates the Domain-qualified collision check).
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store, ["bob", "carol"]);
		// bob lands his job first.
		await handleOp(
			{
				kind: "send",
				from: "bob.bob-gw.app.dev",
				to: "lib.dev",
				body: "collab?",
				returnRoute: {
					srcGateway: "bob-gw",
					srcConversationId: "c1",
					srcSession: "conv.c1.alice.alice-gw.lib.dev",
				},
			},
			"bob-gw",
			"bob",
		);
		expect(sendCalls).toHaveLength(1);

		// carol runs a gateway whose bare id is ALSO "bob-gw" (collision), is linked + shares the
		// same lib, and reuses bob's session key. The return-route srcGateway matches by string,
		// but her VERIFIED Domain "carol" differs from bob's recorded binding, so it is refused.
		await expect(
			handleOp(
				{
					kind: "send",
					from: "carol.bob-gw.app.dev",
					to: "lib.dev",
					body: "hijack",
					returnRoute: {
						srcGateway: "bob-gw",
						srcConversationId: "c1",
						srcSession: "conv.c1.alice.alice-gw.lib.dev",
					},
				},
				"bob-gw",
				"carol",
			),
		).rejects.toThrow(/session collides with an unrelated job/);
		expect(sendCalls).toHaveLength(1); // carol's send never landed
		// bob's binding is intact.
		const binding = store.crossDomainBinding("conv.c1.alice.alice-gw.lib.dev");
		expect(binding?.dstDomainId).toBe("bob");
	});
});
