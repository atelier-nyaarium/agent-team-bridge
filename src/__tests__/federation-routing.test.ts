import { describe, expect, it, vi } from "vitest";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import type { SealedEnvelope } from "../shared/crypto.js";
import { generateIdentity } from "../shared/crypto.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { FederatedOp } from "../shared/federation-protocol.js";
import { channelWs, fakeRouter, makeCtx, registryWith, sealerA, sealerB, storeWith } from "./helpers/federation.js";

describe("federation routing (E2E sealed)", () => {
	it("ORIGIN: seals a cross-Gateway send with the return-route and keeps a local anchor", async () => {
		let seen: FederatedOp | undefined;
		const router = fakeRouter({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				seen = op;
				return { session_id: "conv.conv-1.alice.hostb.api.dev", status: "running" };
			},
		});
		const ctx = makeCtx("hosta", { routerClient: router.client, sealer: sealerA });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "recipe-app.dev",
			fromConversationId: "conv-1",
			to: "alice.hostb.api.dev",
			body: "status?",
			channelOnly: true,
		});
		const json = await res.json();
		expect(json.session_id).toBe("conv.conv-1.alice.hostb.api.dev");
		// The destination decrypted exactly the op we sealed (proves the E2E seal).
		expect(seen).toMatchObject({
			kind: "send",
			to: "api.dev",
			from: "alice.hosta.recipe-app.dev",
			returnRoute: { srcGateway: "hosta", srcSession: "conv.conv-1.alice.hostb.api.dev" },
		});
		// The Router only ever saw an opaque sealed envelope, never the op.
		const relay = router.calls.find((c) => c.action === "gateway_relay");
		expect((relay?.params.payload as { sealed: SealedEnvelope }).sealed.ciphertext).toBeTruthy();
		expect(JSON.stringify(relay?.params.payload)).not.toContain("recipe-app");
		expect(ctx.store.has("conv.conv-1.alice.hostb.api.dev")).toBe(true);
	});

	it("ORIGIN: a console cross-Gateway send builds an owner-id sender address, never throwing on a non-slug Device Name", async () => {
		let seen: FederatedOp | undefined;
		const router = fakeRouter({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				seen = op;
				return { session_id: "conv.owner-1.alice.hostb.api.dev", status: "running" };
			},
		});
		const ctx = makeCtx("hosta", { routerClient: router.client, sealer: sealerA });
		const { send } = createRoutes(ctx);

		// A console's `from` is a free-form Device Name (not a slug); fromConversationId is the 64-hex
		// owner id. consoleSender makes the sealed sender address come from the owner id, so the send
		// never assertSlug-throws on the device name.
		const ownerId = "a".repeat(64);
		await send(
			new Request("http://gateway/send", { method: "POST" }),
			{
				from: "Pixel 10 Pro XL",
				fromConversationId: ownerId,
				to: "alice.hostb.api.dev",
				body: "hi",
				channelOnly: true,
			},
			{ consoleSender: true },
		);
		expect(seen).toMatchObject({ kind: "send", from: `alice.hosta.${ownerId}.claude` });
	});

	it("ORIGIN: 503 when the Router is unavailable", async () => {
		const router = fakeRouter({});
		(router.client as { isConnected: () => boolean }).isConnected = () => false;
		const { send } = createRoutes(makeCtx("hosta", { routerClient: router.client, sealer: sealerA }));
		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "x",
			fromConversationId: "conv-1",
			to: "alice.hostb.api.dev",
			body: "hi",
			channelOnly: true,
		});
		expect(res.status).toBe(503);
	});

	it("DESTINATION: an inbound federated send lands locally and seals its reply back to the origin", async () => {
		let pinned: FederatedOp | undefined;
		const router = fakeRouter({
			destSealer: sealerA,
			srcGateway: "hostb",
			handle: (op) => {
				pinned = op;
				return { ok: true };
			},
		});
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("hostb", {
			routerClient: router.client,
			sealer: sealerB,
			registry: registryWith({ "api.dev": channelWs(pushed) }),
		});
		const routes = createRoutes(ctx);
		const handler = createGatewayRelayHandler({
			routes,
			tryWakeTeam: ctx.tryWakeTeam,
			localGatewayId: "hostb",
			localDomainId: "alice",
		});

		const srcSession = "conv.conv-1.alice.hostb.api.dev";
		// A same-Domain relay (srcDomainId null): the share gate is not consulted.
		const result = (await handler.handleOp(
			{
				kind: "send",
				from: "alice.hosta.recipe-app.dev",
				to: "api.dev",
				body: "status?",
				disposition: "closing",
				returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
			},
			"hosta",
			null,
		)) as { session_id: string };
		expect(result.session_id).toBe(srcSession);
		expect(pushed[0]).toMatchObject({
			type: "channel_push",
			from: "alice.hosta.recipe-app.dev",
			session_id: srcSession,
			disposition: "closing",
		});

		const respondRes = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: srcSession,
			status: "completed",
			response: "all good",
			title: "t",
			summary: "s",
			fullSpoken: "All good, spoken.",
		});
		expect((await respondRes.json()).federated).toBe(true);
		// The reply-pin was sealed back to hosta and decrypts to the response_push. The spoken
		// tiers survive the FederatedOpSchema parse (a schema that stripped them would lose the
		// field silently between Gateways forever).
		expect(pinned).toMatchObject({
			kind: "response_push",
			session_id: srcSession,
			response: "all good",
			title: "t",
			summary: "s",
			fullSpoken: "All good, spoken.",
		});
	});

	it("DESTINATION: a response_push pinned to the origin delivers to the origin conversation", async () => {
		const senderPushes: Record<string, unknown>[] = [];
		const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
		conversationRegistry.set("conv-1", channelWs(senderPushes) as never);
		const ctx = makeCtx("hosta", { conversationRegistry });
		const srcSession = "conv.conv-1.alice.hostb.api.dev";
		ctx.store.create(srcSession, "recipe-app.dev", "alice.hostb.api.dev", {
			persistent: true,
			fromConversationId: "conv-1",
		});
		const routes = createRoutes(ctx);
		const handler = createGatewayRelayHandler({
			routes,
			tryWakeTeam: ctx.tryWakeTeam,
			localGatewayId: "hosta",
			localDomainId: "alice",
		});

		const result = (await handler.handleOp(
			{ kind: "response_push", session_id: srcSession, status: "completed", response: "all good" },
			"hostb",
			null,
		)) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(senderPushes[0]).toMatchObject({ type: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DESTINATION: a response_push with spoken tiers lands them on a console origin's mailbox", async () => {
		const mailboxStore = new DeviceMailboxStore();
		mailboxStore.ensure("owner-1");
		const ctx = makeCtx("hosta", { mailboxStore });
		const srcSession = "conv.owner-1.alice.hostb.api.dev";
		ctx.store.create(srcSession, "recipe-app.dev", "alice.hostb.api.dev", {
			persistent: true,
			fromConversationId: "owner-1",
		});
		const routes = createRoutes(ctx);
		const handler = createGatewayRelayHandler({
			routes,
			tryWakeTeam: ctx.tryWakeTeam,
			localGatewayId: "hosta",
			localDomainId: "alice",
		});

		await handler.handleOp(
			{
				kind: "response_push",
				session_id: srcSession,
				status: "completed",
				response: "# report",
				title: "t",
				summary: "s",
				fullSpoken: "The report, spoken.",
			},
			"hostb",
			null,
		);
		expect(mailboxStore.get("owner-1")?.drain().entries[0]).toMatchObject({
			kind: "reply",
			body: "# report",
			title: "t",
			summary: "s",
			fullSpoken: "The report, spoken.",
		});
	});

	it("DESTINATION: a send to a not-yet-existing target relays displayLabel through to the local mint rule", async () => {
		vi.useFakeTimers();
		try {
			const pushed: Record<string, unknown>[] = [];
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({ ok: true, resolvedTeam: "api.minted1" });
			};
			const ctx = makeCtx("hostb", {
				registry: registryWith({ "api.minted1": channelWs(pushed) }),
				tryWakeTeam,
			});
			const routes = createRoutes(ctx);
			const handler = createGatewayRelayHandler({
				routes,
				tryWakeTeam: ctx.tryWakeTeam,
				localGatewayId: "hostb",
				localDomainId: "alice",
			});

			const srcSession = "conv.conv-1.alice.hostb.api.newsession";
			const resultPromise = handler.handleOp(
				{
					kind: "send",
					from: "alice.hosta.recipe-app.dev",
					to: "api.newsession",
					body: "start please",
					displayLabel: "Bug Hunt",
					returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
				},
				"hosta",
				null,
			);
			await vi.advanceTimersByTimeAsync(3000);
			const result = (await resultPromise) as { session_id: string };

			// The wake carries the relayed displayLabel, and derives its provenance from the origin's
			// own channel job key (inboundSessionId) rather than recomposing one locally - so a retry
			// of the same origin request reattaches instead of minting again.
			expect(wakeCalls).toEqual([
				{ team: "api.newsession", createOpts: { displayLabel: "Bug Hunt", mintedFrom: srcSession } },
			]);
			// The reply is still pinned to the ORIGIN's own session id (its return-route), regardless of
			// which local address the destination actually minted.
			expect(result.session_id).toBe(srcSession);
			expect(pushed.length).toBe(1);
			expect(pushed[0]).toMatchObject({ type: "channel_push", session_id: srcSession });
		} finally {
			vi.useRealTimers();
		}
	});

	it("DISCOVERY: folds Router rows and linked sessions into one team list", async () => {
		const router = fakeRouter({
			onCall: (action) =>
				action === "presence_read"
					? {
							plane: { epoch: 1, version: 1 },
							rows: [
								{
									team: "api.dev",
									gatewayId: "hostb",
									status: "online",
									kind: "devcontainer",
									queue_depth: 0,
								},
							],
							linked: [
								{
									domainId: "bob",
									version: { epoch: 1, version: 1 },
									lastRefreshedAt: 1,
									sessions: [
										{
											team: "lib.dev",
											gatewayId: "bob-gw",
											status: "available",
											kind: "loose",
											queueDepth: 1,
										},
									],
								},
							],
							roster: [],
							coverage: { rosterKnown: true, asked: 1, answered: 1 },
							spawnPoints: [],
						}
					: { ok: true },
		});
		router.client.callInboxTool = router.client.callTool;
		const ctx = makeCtx("hosta", {
			routerClient: router.client,
		});
		const { teams } = await createRoutes(ctx).discoverFull();
		expect(teams.map((team) => team.team)).toEqual(["api.dev", "lib.dev"]);
		expect(teams.find((team) => team.team === "lib.dev")).toMatchObject({
			gatewayId: "bob-gw",
			domainId: "bob",
			queue_depth: 1,
		});
	});

	it("DISCOVERY: rejects a malformed projection and falls back to local teams", async () => {
		const router = fakeRouter({
			onCall: (action) =>
				action === "presence_read"
					? {
							plane: { epoch: 1, version: 1 },
							rows: [{ team: "api.dev", gatewayId: "hostb", status: "online", queue_depth: 0 }],
							linked: [],
							roster: [],
							coverage: { rosterKnown: true, asked: 1, answered: 1 },
							spawnPoints: [],
						}
					: { ok: true },
		});
		router.client.callInboxTool = router.client.callTool;
		const ctx = makeCtx("hosta", {
			routerClient: router.client,
			registry: registryWith({ "recipe-app.dev": channelWs([]) }),
			sessionStore: storeWith("recipe-app.dev"),
		});
		const { teams, coverage } = await createRoutes(ctx).discoverFull();
		expect(teams.find((t) => t.team === "api.dev")).toBeUndefined();
		expect(teams.find((t) => t.team === "recipe-app.dev")).toBeDefined();
		expect(coverage).toEqual({ rosterKnown: false, asked: 0, answered: 0 });
	});

	it("DISCOVERY: passes Router coverage through unchanged", async () => {
		const router = fakeRouter({
			onCall: (action) => {
				if (action !== "presence_read") return { ok: true };
				return {
					plane: { epoch: 1, version: 1 },
					rows: [],
					linked: [],
					roster: [],
					coverage: { rosterKnown: true, asked: 1, answered: 0, unreachable: ["hostb"] },
					spawnPoints: [],
				};
			},
		});
		router.client.callInboxTool = router.client.callTool;
		const { coverage } = await createRoutes(makeCtx("hosta", { routerClient: router.client })).discoverFull();
		expect(coverage).toEqual({ rosterKnown: true, asked: 1, answered: 0, unreachable: ["hostb"] });
	});

	it("DISCOVERY: an unreadable projection keeps local teams and unknown coverage", async () => {
		const router = fakeRouter({
			onCall: () => ({ ok: false, error: "offline" }),
		});
		router.client.callInboxTool = router.client.callTool;
		const ctx = makeCtx("hosta", {
			routerClient: router.client,
			registry: registryWith({ "recipe-app.dev": channelWs([]) }),
			sessionStore: storeWith("recipe-app.dev"),
		});
		const { teams, coverage } = await createRoutes(ctx).discoverFull();
		expect(teams.some((team) => team.team === "recipe-app.dev")).toBe(true);
		expect(coverage).toEqual({ rosterKnown: false, asked: 0, answered: 0 });
	});
});

describe("respond()'s onFederatedSettled (the real relayWithRetry, not a mocked ConsoleRoutes.respond)", () => {
	it("fires true once the relay-pin actually succeeds", async () => {
		let pinned: FederatedOp | undefined;
		const router = fakeRouter({
			destSealer: sealerA,
			srcGateway: "hostb",
			handle: (op) => {
				pinned = op;
				return { ok: true };
			},
		});
		const ctx = makeCtx("hostb", { routerClient: router.client, sealer: sealerB });
		const srcSession = "conv.conv-1.alice.hostb.api.dev";
		ctx.store.create(srcSession, "recipe-app.dev", "api.dev", {
			persistent: true,
			fromConversationId: "conv-1",
			returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
		});
		const routes = createRoutes(ctx);

		let settled: boolean | undefined;
		const respondRes = routes.respond(
			new Request("http://gateway/respond", { method: "POST" }),
			{
				session_id: srcSession,
				status: "completed",
				response: "all good",
				title: "t",
				summary: "s",
				fullSpoken: "spoken",
			},
			{
				onFederatedSettled: (ok) => {
					settled = ok;
				},
			},
		);
		expect((await respondRes.json()).federated).toBe(true);
		for (let i = 0; i < 10 && settled === undefined; i++) await Promise.resolve();
		expect(settled).toBe(true);
		expect(pinned).toMatchObject({ kind: "response_push", session_id: srcSession, response: "all good" });
		expect(router.calls.filter((c) => c.action === "gateway_relay").length).toBe(1);
	});

	it("fires false only after relayWithRetry exhausts every attempt, driven by the real exponential backoff", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const client = {
				isConnected: () => true,
				stop: () => {},
				callTool: async () => {
					calls++;
					return { callId: "fake", error: "router unavailable" };
				},
			} as unknown as NonNullable<RoutesDeps["routerClient"]>;
			const ctx = makeCtx("hostb", { routerClient: client, sealer: sealerB });
			const srcSession = "conv.conv-1.alice.hostb.api.dev";
			ctx.store.create(srcSession, "recipe-app.dev", "api.dev", {
				persistent: true,
				fromConversationId: "conv-1",
				returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
			});
			const routes = createRoutes(ctx);

			let settled: boolean | undefined;
			const respondRes = routes.respond(
				new Request("http://gateway/respond", { method: "POST" }),
				{ session_id: srcSession, status: "completed", response: "all good" },
				{
					onFederatedSettled: (ok) => {
						settled = ok;
					},
				},
			);
			expect((await respondRes.json()).federated).toBe(true);
			await vi.advanceTimersByTimeAsync(31_000);
			expect(settled).toBe(false);
			// 5 attempts total: the initial try plus 4 retries, backing off 2s/4s/8s/16s between them.
			expect(calls).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps one opId across failed relay retries", async () => {
		vi.useFakeTimers();
		try {
			const calls: string[] = [];
			let failures = 0;
			const identity = generateIdentity();
			const client = {
				isConnected: () => true,
				stop: () => {},
				callInboxTool: async (_action: string, params: Record<string, unknown>) => {
					calls.push((params.row as { envelope: { opKey: { opId: string } } }).envelope.opKey.opId);
					if (failures++ < 2) return { callId: "fake", error: "router unavailable" };
					return { callId: "fake", result: { outcome: "accepted" } };
				},
			} as unknown as NonNullable<RoutesDeps["routerClient"]>;
			const ctx = makeCtx("hostb", {
				routerClient: client,
				sealer: {
					seal: () => ({ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" }),
				} as never,
				producerSignPriv: identity.sign.priv,
				crossDomainPeers: {
					resolveByGateway: () => ({ friendDomainId: "beta" }),
					all: () => [{ friendDomainId: "beta", friendGatewayId: "hosta" }],
				} as never,
				isSharedToForReply: () => true,
			});
			const srcSession = "conv.conv-1.alice.hostb.api.dev";
			ctx.store.create(srcSession, "recipe-app.dev", "api.dev", {
				persistent: true,
				fromConversationId: "conv-1",
				dstDomainId: "beta",
				returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
			});
			const routes = createRoutes(ctx);
			const respond = (opId?: string) =>
				routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
					session_id: srcSession,
					status: "completed",
					response: "all good",
					...(opId ? { opId } : {}),
				});
			await respond();
			for (let i = 0; i < 10; i++) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(6_000);
			expect(calls).toHaveLength(3);
			expect(new Set(calls).size).toBe(1);

			calls.length = 0;
			failures = 0;
			ctx.store.create(`${srcSession}-2`, "recipe-app.dev", "api.dev", {
				persistent: true,
				fromConversationId: "conv-1",
				dstDomainId: "beta",
				returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession: `${srcSession}-2` },
			});
			await routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
				session_id: `${srcSession}-2`,
				status: "completed",
				response: "all good",
				opId: "producer-op",
			});
			for (let i = 0; i < 10; i++) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(6_000);
			expect(calls).toEqual(["producer-op", "producer-op", "producer-op"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
