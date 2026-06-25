import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../gateway/federation/allowlist.js";
import { type CrossDomainPeer, CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { ReplayGuard } from "../gateway/federation/replayGuard.js";
import { createSealer, type Sealer } from "../gateway/federation/sealer.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { generateIdentity, type Identity, seal, unseal } from "../shared/crypto.js";
import { signXDomainLink, type XDomainLink } from "../shared/federation-protocol.js";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "sealer-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const owner = generateIdentity();
const A = generateIdentity();
const B = generateIdentity();

function hostAdmission(gatewayId: string, id: { sign: { pub: string }; box: { pub: string } }): Admission {
	return { kind: "gateway", signPub: id.sign.pub, boxPub: id.box.pub, gatewayId, issuedAt: 1, nonce: "bg==" };
}

/** An allowlist rooted at `owner` admitting both Gateway A and Gateway B. */
function allowlistWithBoth(): Allowlist {
	const a = new Allowlist(tmp());
	a.setOwner(owner.sign.pub);
	a.addAdmission(signAdmission(hostAdmission("A", A), owner.sign.priv, owner.sign.pub));
	a.addAdmission(signAdmission(hostAdmission("B", B), owner.sign.priv, owner.sign.pub));
	return a;
}

/** An empty cross-Domain peer set, so the local seal path is exercised. */
function noPeers(): CrossDomainPeers {
	return new CrossDomainPeers(tmp());
}

describe("sealer (local v1)", () => {
	it("round-trips a sealed object between two admitted Gateways", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice");
		const env = aSealer.seal("B", { hello: "world", n: 7 });
		expect(bSealer.open("A", env)).toEqual({ hello: "world", n: 7 });
	});

	it("emits a v1 sealed body for a local peer (byte shape unchanged: v/src/dst/at/body, no domains)", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const env = aSealer.seal("B", { hello: "world" });
		// Decrypt directly to inspect the inner wrapper B would parse.
		const inner = JSON.parse(unseal(env, B.box.priv, A.sign.pub).toString("utf8"));
		expect(inner).toEqual({ v: 1, src: "A", dst: "B", at: inner.at, body: { hello: "world" } });
		expect(typeof inner.at).toBe("number");
		// No Domain fields leak into the local v1 body.
		expect(inner).not.toHaveProperty("srcDomain");
		expect(inner).not.toHaveProperty("dstDomain");
	});

	it("rejects a replayed envelope (same nonce opened twice)", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice");
		const env = aSealer.seal("B", { n: 1 });
		expect(bSealer.open("A", env)).toEqual({ n: 1 });
		expect(() => bSealer.open("A", env)).toThrow(/replay/);
	});

	it("rejects an envelope naming an unadmitted source Gateway", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice");
		const env = aSealer.seal("B", { x: 1 });
		expect(() => bSealer.open("C", env)).toThrow(/not admitted/);
	});

	it("fails to open a tampered envelope", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice");
		const env = aSealer.seal("B", { ok: true });
		const tampered = { ...env, ciphertext: Buffer.from("evil").toString("base64") };
		expect(() => bSealer.open("A", tampered)).toThrow();
	});

	it("rejects a relabeled source (signed-in src must match the claimed srcGateway)", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice");
		const env = aSealer.seal("B", { x: 1 });
		// B is also admitted; opening A's frame under label "B" must not verify/attribute.
		expect(() => bSealer.open("B", env)).toThrow();
	});

	it("rejects a frame addressed to a different Gateway", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		// A seals to B, but a Gateway that believes itself "C" opens it.
		const cSealer = createSealer(B, allowlistWithBoth(), "C", noPeers(), "alice");
		const env = aSealer.seal("B", { x: 1 });
		expect(() => cSealer.open("A", env)).toThrow(/not addressed to this Gateway/);
	});

	it("rejects a stale envelope past the freshness window", () => {
		let clock = 1_000_000;
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice", new ReplayGuard(), () => clock);
		const bSealer = createSealer(B, allowlistWithBoth(), "B", noPeers(), "alice", new ReplayGuard(), () => clock);
		const env = aSealer.seal("B", { x: 1 });
		clock += 120_001; // past SEAL_MAX_AGE_MS
		expect(() => bSealer.open("A", env)).toThrow(/stale/);
	});
});

////////////////////////////////
//  Cross-Domain (v2)
//
//  Two gateways owned by DIFFERENT owners (two Domains), each holding the other in
//  its disjoint cross-Domain peer set. Each Domain's allowlist roots at its OWN owner
//  and does NOT admit the friend gateway, so the seal MUST resolve via crossDomainPeers
//  and emit v2.

const ownerX = generateIdentity(); // Domain "localx"
const ownerY = generateIdentity(); // Domain "carol"
const X = generateIdentity(); // gateway in localx, id "gw-x"
const Y = generateIdentity(); // gateway in carol, id "gw-y"

/** A local allowlist rooted at `o` admitting only its own gateway `(gwId, id)`. */
function soloAllowlist(o: Identity, gwId: string, id: Identity): Allowlist {
	const a = new Allowlist(tmp());
	a.setOwner(o.sign.pub);
	a.addAdmission(signAdmission(hostAdmission(gwId, id), o.sign.priv, o.sign.pub));
	return a;
}

/** A cross-Domain peer record for `friend` in `(friendDomainId, friendGatewayId)`,
 * with the link side owner-signed by `friendOwner`. */
function crossPeer(
	friendOwner: Identity,
	friendDomainId: string,
	friendGatewayId: string,
	friend: Identity,
	myOwner: Identity,
): CrossDomainPeer {
	const link: XDomainLink = {
		myOwnerSignPub: friendOwner.sign.pub,
		peerOwnerSignPub: myOwner.sign.pub,
		peerDomainId: friendDomainId,
		peerGatewayId: friendGatewayId,
		peerSignPub: friend.sign.pub,
		peerBoxPub: friend.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
	};
	return {
		friendOwnerSignPub: friendOwner.sign.pub,
		friendDomainId,
		friendGatewayId,
		friendSignPub: friend.sign.pub,
		friendBoxPub: friend.box.pub,
		link: signXDomainLink(link, friendOwner.sign.priv, friendOwner.sign.pub),
	};
}

/** X's peers: it knows Y (Domain "carol", id "gw-y"). */
function xPeers(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerY, "carol", "gw-y", Y, ownerX));
	return s;
}
/** Y's peers: it knows X (Domain "localx", id "gw-x"). */
function yPeers(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerX, "localx", "gw-x", X, ownerY));
	return s;
}

describe("sealer (cross-Domain v2)", () => {
	it("round-trips a sealed object between two Gateways in different Domains", () => {
		const xSealer = createSealer(X, soloAllowlist(ownerX, "gw-x", X), "gw-x", xPeers(), "localx");
		const ySealer = createSealer(Y, soloAllowlist(ownerY, "gw-y", Y), "gw-y", yPeers(), "carol");
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { ping: 42 });
		expect(ySealer.open("gw-x", env)).toEqual({ ping: 42 });
	});

	it("emits a v2 sealed body carrying srcDomain/dstDomain", () => {
		const xSealer = createSealer(X, soloAllowlist(ownerX, "gw-x", X), "gw-x", xPeers(), "localx");
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { ping: 42 });
		// Decrypt with Y's box key (the recipient) to inspect the inner wrapper.
		const inner = JSON.parse(unseal(env, Y.box.priv, X.sign.pub).toString("utf8"));
		expect(inner).toMatchObject({
			v: 2,
			src: "gw-x",
			dst: "gw-y",
			srcDomain: "localx",
			dstDomain: "carol",
			body: { ping: 42 },
		});
	});

	it("rejects an unadmitted cross-Domain destination (no matching peer)", () => {
		const xSealer = createSealer(X, soloAllowlist(ownerX, "gw-x", X), "gw-x", xPeers(), "localx");
		expect(() => xSealer.seal({ domainId: "dave", gatewayId: "gw-y" }, { x: 1 })).toThrow(/not admitted/);
	});

	it("rejects a v2 frame whose dstDomain is not this Gateway's Domain", () => {
		// X seals to Y, but Y believes it lives in a DIFFERENT Domain than the link says.
		const xSealer = createSealer(X, soloAllowlist(ownerX, "gw-x", X), "gw-x", xPeers(), "localx");
		const yWrongDomain = createSealer(Y, soloAllowlist(ownerY, "gw-y", Y), "gw-y", yPeers(), "elsewhere");
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { x: 1 });
		expect(() => yWrongDomain.open("gw-x", env)).toThrow(/not addressed to this Domain/);
	});

	it("rejects a v2 frame whose signed-in srcDomain disagrees with the resolved peer", () => {
		// Y's peer record for X claims X lives in "localx". A sealer that signs in a
		// different srcDomain trips the srcDomain cross-check.
		const xLies = createSealer(X, soloAllowlist(ownerX, "gw-x", X), "gw-x", xPeers(), "spoofed");
		const ySealer = createSealer(Y, soloAllowlist(ownerY, "gw-y", Y), "gw-y", yPeers(), "carol");
		const env = xLies.seal({ domainId: "carol", gatewayId: "gw-y" }, { x: 1 });
		expect(() => ySealer.open("gw-x", env)).toThrow(/srcDomain mismatch/);
	});

	it("rejects an unknown sealed body version", () => {
		// Craft a v:99 inner body sealed to Y and signed by X (a known peer), so the
		// version branch - not the resolve / unseal - is what rejects it.
		const ySealer = createSealer(Y, soloAllowlist(ownerY, "gw-y", Y), "gw-y", yPeers(), "carol");
		const inner = {
			v: 99,
			src: "gw-x",
			dst: "gw-y",
			srcDomain: "localx",
			dstDomain: "carol",
			at: Date.now(),
			body: {},
		};
		// Seal it ourselves with crypto.seal so we control the version byte.
		const env = seal(Buffer.from(JSON.stringify(inner)), Y.box.pub, X.sign.priv);
		expect(() => ySealer.open("gw-x", env)).toThrow(/unknown sealed body version/);
	});

	it("rejects a v1 frame from a cross-Domain Gateway (v1 must be a local peer)", () => {
		// A cross-Domain peer crafts a v1 body (no srcDomain/dstDomain) to skip the v2
		// (srcDomain, dstDomain) binding. open() must reject it: v1 resolves only to a local peer.
		// X is a cross peer in Y's yPeers() (localx/gw-x), so open resolves crossPeer, not local.
		const ySealer = createSealer(Y, soloAllowlist(ownerY, "gw-y", Y), "gw-y", yPeers(), "carol");
		const inner = { v: 1, src: "gw-x", dst: "gw-y", at: Date.now(), body: { evil: true } };
		const env = seal(Buffer.from(JSON.stringify(inner)), Y.box.pub, X.sign.priv);
		expect(() => ySealer.open("gw-x", env)).toThrow(/v1 frame from a cross-Domain Gateway/);
	});

	it("a local gateway is unaffected by an empty cross-Domain set (no v2 ever)", () => {
		// Sanity: with no peers, a local seal stays v1 even though the cross path exists.
		const aSealer = createSealer(A, allowlistWithBoth(), "A", noPeers(), "alice");
		const env = aSealer.seal("B", { ok: true });
		const inner = JSON.parse(unseal(env, B.box.priv, A.sign.pub).toString("utf8"));
		expect(inner.v).toBe(1);
	});
});

////////////////////////////////
//  Cross-Domain srcDomain disambiguation
//
//  Two friend Domains share the SAME gateway id ("shared"). The receiver holds both as
//  cross-Domain peers. Pre-unseal, the cleartext frame names only the gateway id, so
//  without the Router-stamped srcDomain the receiver cannot tell the two peers apart.
//  The srcDomain on the relay frame resolves the right peer by the full (domain, gateway)
//  pair.

const ownerP = generateIdentity(); // Domain "pat"
const ownerQ = generateIdentity(); // Domain "quinn"
const recvOwner = generateIdentity(); // the receiving Domain "rcv"
const P = generateIdentity(); // gateway "shared" in Domain "pat"
const Q = generateIdentity(); // gateway "shared" in Domain "quinn" (same id!)
const R = generateIdentity(); // the receiving gateway "gw-r" in Domain "rcv"

/** The receiver's peers: BOTH friend Domains run a gateway whose id is "shared". */
function recvPeersWithCollision(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerP, "pat", "shared", P, recvOwner));
	s.add(crossPeer(ownerQ, "quinn", "shared", Q, recvOwner));
	return s;
}

/** A friend's OWN peer set: it knows the receiver (Domain "rcv", gateway "gw-r"), so its
 * seal to the receiver resolves the receiver's keys + emits v2. */
function friendPeersKnowingReceiver(friendOwner: Identity): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(recvOwner, "rcv", "gw-r", R, friendOwner));
	return s;
}

describe("sealer (cross-Domain srcDomain disambiguation)", () => {
	function receiverSealer(): Sealer {
		return createSealer(R, soloAllowlist(recvOwner, "gw-r", R), "gw-r", recvPeersWithCollision(), "rcv");
	}

	it("resolves a same-id-two-Domains peer when srcDomain names the sender's Domain", () => {
		// P (Domain "pat", gateway "shared") seals to the receiver. The receiver opens
		// with srcDomain="pat" and resolves P's peer despite "quinn" also running "shared".
		const pSealer = createSealer(
			P,
			soloAllowlist(ownerP, "shared", P),
			"shared",
			friendPeersKnowingReceiver(ownerP),
			"pat",
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(receiverSealer().open("shared", env, "pat")).toEqual({ who: "pat" });
	});

	it("resolves the OTHER same-id peer when srcDomain names the other Domain", () => {
		// Q (Domain "quinn", same gateway id "shared") seals to the receiver; srcDomain="quinn"
		// must select Q's peer, proving the pair - not the bare id - drives resolution.
		const qSealer = createSealer(
			Q,
			soloAllowlist(ownerQ, "shared", Q),
			"shared",
			friendPeersKnowingReceiver(ownerQ),
			"quinn",
		);
		const env = qSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "quinn" });
		expect(receiverSealer().open("shared", env, "quinn")).toEqual({ who: "quinn" });
	});

	it("rejects a srcDomain that does not match any peer for the gateway id", () => {
		const pSealer = createSealer(
			P,
			soloAllowlist(ownerP, "shared", P),
			"shared",
			friendPeersKnowingReceiver(ownerP),
			"pat",
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(() => receiverSealer().open("shared", env, "nobody")).toThrow(/not admitted/);
	});

	it("without srcDomain, a colliding gateway id stays ambiguous (back-compat null)", () => {
		// No srcDomain plus two peers sharing the id: the scan refuses, so the authentic
		// frame fails to open rather than being attributed to the wrong peer.
		const pSealer = createSealer(
			P,
			soloAllowlist(ownerP, "shared", P),
			"shared",
			friendPeersKnowingReceiver(ownerP),
			"pat",
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(() => receiverSealer().open("shared", env)).toThrow(/not admitted/);
	});
});
