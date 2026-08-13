import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Allowlist } from "../gateway/federation/allowlist.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { createSealer } from "../gateway/federation/sealer.js";
import { sealTargetFor } from "../gateway/federation/sealTarget.js";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity, type SealedEnvelope } from "../shared/crypto.js";
import { fakeEvie, makeCtx, peersOf, soloAllowlist, xdPeer } from "./helpers/federation.js";

////////////////////////////////
//  sealTargetFor is local-first (a local/friend gateway-id collision)
//
//  sealer.open resolves a peer local-first; the SEND side (sealTargetFor) must match, or a
//  cross-gateway send to your OWN local Gateway whose id COLLIDES with a friend's gateway id
//  is sealed v2 to the FRIEND. sealTargetFor consults `resolvesLocalGateway` before scanning the
//  cross-Domain peer set, so a local target always seals v1 to the local Domain.

const localOwner = generateIdentity();
const senderGw = generateIdentity(); // the sending Gateway, in Domain "alice"
const localGw1 = generateIdentity(); // a SECOND local Gateway, id "gw1"
const friendOwner = generateIdentity();
const friendGw1 = generateIdentity(); // a FRIEND Gateway, ALSO id "gw1", in Domain "friend"

/** A local allowlist that admits BOTH the sender and a second local gateway "gw1", so the
 * sender can seal local-to-local. */
function localAllowlistWithGw1(): Allowlist {
	const a = new Allowlist(path.join(os.tmpdir(), `fed-local-${Math.random().toString(36).slice(2)}`));
	a.setOwner(localOwner.sign.pub);
	a.addAdmission(
		signAdmission(
			{
				kind: "gateway",
				signPub: senderGw.sign.pub,
				boxPub: senderGw.box.pub,
				gatewayId: "sender-gw",
				issuedAt: 1,
				nonce: "c2VuZA==",
			},
			localOwner.sign.priv,
			localOwner.sign.pub,
		),
	);
	a.addAdmission(
		signAdmission(
			{
				kind: "gateway",
				signPub: localGw1.sign.pub,
				boxPub: localGw1.box.pub,
				gatewayId: "gw1",
				issuedAt: 1,
				nonce: "Z3cx",
			},
			localOwner.sign.priv,
			localOwner.sign.pub,
		),
	);
	return a;
}

describe("sealTargetFor local-first (gateway-id collision)", () => {
	it("a send to the LOCAL gw1 seals v1 to the local Domain, NOT v2 to the friend that also runs gw1", async () => {
		const localAllowlist = localAllowlistWithGw1();
		// The sender ALSO has a linked friend Domain whose gateway id collides ("gw1").
		const senderPeers = peersOf(xdPeer(friendOwner, "friend", "gw1", friendGw1, localOwner));
		const senderSealer = createSealer(senderGw, localAllowlist, "sender-gw", senderPeers, "alice");

		// Capture the sealed payload + the srcDomain evie was handed. The local gw1 opens it; the
		// friend's gw1 must NOT be able to (proving it was sealed to the local Domain, not the friend).
		let sealedToOpen: SealedEnvelope | undefined;
		let srcDomainSent: unknown;
		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				sealedToOpen = (params.payload as { sealed: SealedEnvelope }).sealed;
				srcDomainSent = params.srcDomain;
				// The local gw1 opens the v1 frame (local path -> srcDomainId null), runs nothing,
				// and seals an empty reply back so the origin's open succeeds.
				const localGw1Sealer = createSealer(
					localGw1,
					// gw1's view: the same local Domain, admitting the sender so it can verify it.
					(() => {
						const a = new Allowlist(
							path.join(os.tmpdir(), `fed-gw1-${Math.random().toString(36).slice(2)}`),
						);
						a.setOwner(localOwner.sign.pub);
						a.addAdmission(
							signAdmission(
								{
									kind: "gateway",
									signPub: senderGw.sign.pub,
									boxPub: senderGw.box.pub,
									gatewayId: "sender-gw",
									issuedAt: 1,
									nonce: "c2VuZA==",
								},
								localOwner.sign.priv,
								localOwner.sign.pub,
							),
						);
						return a;
					})(),
					"gw1",
					new CrossDomainPeers(
						path.join(os.tmpdir(), `fed-gw1-nopeers-${Math.random().toString(36).slice(2)}`),
					),
					"alice",
				);
				const opened = localGw1Sealer.openWithSource("sender-gw", sealedToOpen);
				// v1 / local: the destination resolved the sender as a LOCAL peer, not cross-Domain.
				expect(opened.srcDomainId).toBeNull();
				return { ok: true, result: localGw1Sealer.seal("sender-gw", { ok: true }) };
			},
		});

		const ctx = makeCtx("sender-gw", {
			evieClient: evie.client,
			sealer: senderSealer,
			crossDomainPeers: senderPeers,
			resolvesLocalGateway: (gatewayId) => localAllowlist.resolveGateway(gatewayId) !== null,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "c1",
			to: "alice.gw1.team.dev",
			body: "local please",
			channelOnly: true,
		});
		expect(res.status).toBe(200);
		// The v1 local path sends NO srcDomain-keyed cross routing (the relay still stamps
		// localDomainId, but the SEAL is v1: the friend's gw1 cannot open it).
		expect(srcDomainSent).toBe("alice");
		expect(sealedToOpen).toBeDefined();

		// Hard proof it went to the LOCAL Domain, not to the friend: the friend's gw1 sealer (the colliding
		// peer) cannot open the envelope - the local target sealed to the LOCAL gw1's box key.
		const friendGw1Sealer = createSealer(
			friendGw1,
			(() => {
				const a = new Allowlist(path.join(os.tmpdir(), `fed-friend-${Math.random().toString(36).slice(2)}`));
				a.setOwner(friendOwner.sign.pub);
				return a;
			})(),
			"gw1",
			peersOf(xdPeer(localOwner, "alice", "sender-gw", senderGw, friendOwner)),
			"friend",
		);
		expect(() => friendGw1Sealer.openWithSource("sender-gw", sealedToOpen as SealedEnvelope, "alice")).toThrow();
	});
});

////////////////////////////////
//  sealTargetFor (domainId, gatewayId): the same-id-two-Domains disambiguation
//
//  Two LINKED friend Domains may run an identically-named gateway. A bare-gatewayId send is
//  ambiguous (the sealer refuses rather than guess); a send carrying the selected session's
//  Domain resolves the right peer by the full (domainId, gatewayId) pair and seals v2 to it.

describe("sealTargetFor (domainId, gatewayId) disambiguation", () => {
	const senderOwner = generateIdentity();
	const senderGw = generateIdentity();
	const friend1Owner = generateIdentity();
	const friend1Gw = generateIdentity(); // gateway id "shared-gw" in Domain "friend1"
	const friend2Owner = generateIdentity();
	const friend2Gw = generateIdentity(); // gateway id "shared-gw" in Domain "friend2"

	// The sender links BOTH friends, whose gateway ids collide ("shared-gw").
	function senderCtx(over: Partial<RoutesDeps> = {}) {
		const senderPeers = peersOf(
			xdPeer(friend1Owner, "friend1", "shared-gw", friend1Gw, senderOwner),
			xdPeer(friend2Owner, "friend2", "shared-gw", friend2Gw, senderOwner),
		);
		const senderSealer = createSealer(
			senderGw,
			soloAllowlist(senderOwner, "sender-gw", senderGw),
			"sender-gw",
			senderPeers,
			"alice",
		);
		const ctx = makeCtx("sender-gw", { sealer: senderSealer, crossDomainPeers: senderPeers, ...over });
		ctx.config.localDomainId = "alice";
		return { ctx, senderPeers };
	}

	it("a bare cross-Domain send to a gateway id shared by two linked Domains is ambiguous (no seal)", async () => {
		const { ctx } = senderCtx({ evieClient: fakeEvie({}).client });
		const { send } = createRoutes(ctx);
		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "c1",
			to: "local.shared-gw.lib.dev",
			body: "collab?",
			channelOnly: true,
		});
		expect(res.status).toBe(502);
		expect((await res.json()).error).toMatch(/ambiguous across linked Domains/);
		expect(ctx.store.has("conv.c1.alice.shared-gw.lib.dev")).toBe(false);
	});

	it("a send carrying targetDomainId resolves the right peer and seals v2 to that Domain", async () => {
		// friend2's gateway opens the frame; only friend2's box key can, proving the send went
		// to friend2 (not friend1, which shares the gateway id) once the Domain disambiguated it.
		let openedByFriend2: { srcDomainId: string | null } | undefined;
		const friend2Sealer = createSealer(
			friend2Gw,
			soloAllowlist(friend2Owner, "shared-gw", friend2Gw),
			"shared-gw",
			peersOf(xdPeer(senderOwner, "alice", "sender-gw", senderGw, friend2Owner)),
			"friend2",
		);
		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				expect(params.srcDomain).toBe("alice");
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				openedByFriend2 = friend2Sealer.openWithSource("sender-gw", sealed, "alice");
				expect(openedByFriend2.srcDomainId).toBe("alice");
				return {
					ok: true,
					result: friend2Sealer.seal({ domainId: "alice", gatewayId: "sender-gw" }, { ok: true }),
				};
			},
		});
		const { ctx } = senderCtx({ evieClient: evie.client });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app.dev",
			fromConversationId: "c1",
			to: "local.shared-gw.lib.dev",
			targetDomainId: "friend2",
			body: "collab?",
			channelOnly: true,
		});
		expect(res.status).toBe(200);
		expect((await res.json()).session_id).toBe("conv.c1.friend2.shared-gw.lib.dev");
		expect(openedByFriend2).toBeDefined();
		// The anchor records the resolved target Domain so a reply is bound to friend2.
		expect(ctx.store.crossDomainBinding("conv.c1.friend2.shared-gw.lib.dev")?.dstDomainId).toBe("friend2");
	});
});

////////////////////////////////
//  The pure decision, called directly (no Sealer, no evie, no route table)

describe("sealTargetFor decision", () => {
	const friendA = generateIdentity();
	const friendB = generateIdentity();
	const twoFriendsOnDesktop = () =>
		peersOf(
			xdPeer(friendOwner, "aria", "desktop", friendA, localOwner),
			xdPeer(friendOwner, "briar", "desktop", friendB, localOwner),
		);

	it("a locally-admitted id wins over a colliding friend, even with the friend's Domain named", () => {
		const deps = {
			resolvesLocalGateway: (id: string) => id === "desktop",
			crossDomainPeers: peersOf(xdPeer(friendOwner, "aria", "desktop", friendA, localOwner)),
		};
		expect(sealTargetFor(deps, "desktop")).toBe("desktop");
		// Local-first is what makes the collision un-hijackable; the explicit Domain never runs.
		expect(sealTargetFor(deps, "desktop", "aria")).toBe("desktop");
	});

	it("an explicit Domain resolves the pair a bare scan would refuse as ambiguous", () => {
		const deps = { crossDomainPeers: twoFriendsOnDesktop() };
		expect(sealTargetFor(deps, "desktop", "briar")).toEqual({ domainId: "briar", gatewayId: "desktop" });
		expect(() => sealTargetFor(deps, "desktop")).toThrow(/ambiguous across linked Domains/);
	});

	it("a named Domain that is not linked falls through instead of silently misrouting", () => {
		const deps = { crossDomainPeers: peersOf(xdPeer(friendOwner, "aria", "desktop", friendA, localOwner)) };
		// The bare scan finds the one real peer, so the wrong hint surfaces as aria, not stranger.
		expect(sealTargetFor(deps, "desktop", "stranger")).toEqual({ domainId: "aria", gatewayId: "desktop" });
	});

	it("an unknown id passes through bare for the sealer to admit or reject", () => {
		expect(sealTargetFor({}, "nowhere")).toBe("nowhere");
	});
});
