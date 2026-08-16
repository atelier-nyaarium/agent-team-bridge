import { describe, expect, it } from "vitest";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { createSealer } from "../gateway/federation/sealer.js";
import { createRoutes } from "../gateway/routes.js";
import type { SealedEnvelope } from "../shared/crypto.js";
import { type FederatedOp, FederatedOpSchema } from "../shared/federation-protocol.js";
import {
	aliceGw,
	aliceOwner,
	bobGw,
	bobOwner,
	channelWs,
	fakeRouter,
	gateRoutes,
	lib,
	makeCtx,
	memShareState,
	peersOf,
	registryWith,
	scratch,
	soloAllowlist,
	storeWith,
	type TeamInfoLite,
	unknownKindTeam,
	xdPeer,
} from "./helpers/federation.js";

////////////////////////////////
//  Cross-Domain send flow (real crypto, two Domains)
//
//  alice-gw (Domain "alice") sends to bob.bob-gw.lib.dev (Domain "bob"). The seal MUST be v2
//  (resolved by the (domainId, gatewayId) pair from the disjoint peer set), the Router stays
//  content-blind, and the op lands at bob's destination share gate. The local seal path
//  is untouched (covered by the same-Domain tests).

describe("cross-Domain send flow (E2E sealed v2)", () => {
	it("seals a cross-Domain send v2 to the right peer and lands it at the destination share gate", async () => {
		// bob's peer set knows alice; bob shares lib to alice. bob's relay handler opens the
		// v2 frame, gates it (shared devcontainer), and lands the send.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes, sendCalls } = gateRoutes([lib()]);
		const bobShare = memShareState([["bob.bob-gw.lib.dev", "alice"]]);
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "bob-gw",
			localDomainId: "bob",
			shareState: bobShare,
		});

		let landed: FederatedOp | undefined;
		// The router mock plays bob-gw: it opens the v2 frame with bob's sealer (asserting v2 +
		// the resolved Domain), runs bob's gated handler, and seals the reply back.
		const router = fakeRouter({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				expect(opened.srcDomainId).toBe("alice"); // resolved by the (domain, gateway) pair, not bare id
				const op = FederatedOpSchema.parse(opened.body);
				landed = op;
				// Run it through bob's real gated handler (async), then seal the reply back to alice.
				return (async () => {
					const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
					return { ok: true, result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result) };
				})();
			},
		});

		// alice's side: it knows bob as a cross-Domain peer, so the send resolves v2.
		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			routerClient: router.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "c1",
			to: "bob.bob-gw.lib.dev",
			body: "collab?",
			channelOnly: true,
		});
		const json = await res.json();
		expect(json.session_id).toBe("conv.c1.bob.bob-gw.lib.dev");
		expect(ctx.store.has("conv.c1.bob.bob-gw.lib.dev")).toBe(true);

		// The op crossed sealed (the Router saw only ciphertext, never the body), landed gated.
		const relay = router.calls.find((c) => c.action === "gateway_relay");
		expect(relay?.params.srcDomain).toBe("alice");
		expect(JSON.stringify(relay?.params.payload)).not.toContain("collab");
		expect(landed).toMatchObject({ kind: "send", to: "lib.dev", from: "alice.alice-gw.app.dev" });
		expect(sendCalls).toHaveLength(1); // bob's gate permitted it (lib is shared to alice)
		expect(bobShare.touched).toEqual(["bob.bob-gw.lib.dev"]);
	});

	it("a cross-Domain send to an UNSHARED friend session fails (bob's gate denies, no land)", async () => {
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes, sendCalls } = gateRoutes([lib()]);
		const bobShare = memShareState(); // lib is NOT shared to alice
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "bob-gw",
			localDomainId: "bob",
			shareState: bobShare,
		});

		const router = fakeRouter({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				const op = FederatedOpSchema.parse(opened.body);
				return (async () => {
					try {
						const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
						return {
							ok: true,
							result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result),
						};
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				})();
			},
		});

		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			routerClient: router.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "c1",
			to: "bob.bob-gw.lib.dev",
			body: "collab?",
			channelOnly: true,
		});
		// The destination gate denied it, so the origin gets a 502 and keeps NO dangling anchor.
		expect(res.status).toBe(502);
		expect((await res.json()).error).toMatch(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
		expect(ctx.store.has("conv.c1.bob.bob-gw.lib.dev")).toBe(false);
	});

	it("DISCOVERY merges a linked peer's shared sessions (the peer's gate filters them)", async () => {
		// alice discovers: her local team + bob's shared sessions. The Router's roster (same-Domain)
		// is empty here; the cross-Domain leg queries bob, whose handler returns only shares.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes } = gateRoutes([lib("bob-gw"), scratch("bob-gw"), unknownKindTeam("bob-gw")]);
		const bobShare = memShareState([["bob.bob-gw.lib.dev", "alice"]]); // only lib shared to alice
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "bob-gw",
			localDomainId: "bob",
			shareState: bobShare,
		});

		const router = fakeRouter({
			onCall: (action, params) => {
				if (action === "list_gateways") return { gateways: [] }; // no same-Domain peers
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				const op = FederatedOpSchema.parse(opened.body);
				return (async () => {
					const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
					return { ok: true, result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result) };
				})();
			},
		});

		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			routerClient: router.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
			registry: registryWith({ "app.dev": channelWs([]) }),
			sessionStore: storeWith("app.dev"),
		});
		ctx.config.localDomainId = "alice";
		const { discover } = createRoutes(ctx);

		const teams = (await (await discover()).json()) as TeamInfoLite[];
		// alice's own app (local) + bob's shared lib; bob's scratch + the unknown kind are NOT shared.
		expect(teams.map((t) => t.team).sort()).toEqual(["app.dev", "lib.dev"]);
		const libEntry = teams.find((t) => t.team === "lib.dev");
		expect(libEntry?.gatewayId).toBe("bob-gw");
		// The cross-Domain entry is tagged with the PEER's Domain id (bob), authoritative from
		// alice's own peer set, so the console groups it under bob even if bob's build stamped no
		// domainId. alice's local app carries her own Domain id.
		expect(libEntry?.domainId).toBe("bob");
		expect(teams.find((t) => t.team === "app.dev")?.domainId).toBe("alice");
	});
});
