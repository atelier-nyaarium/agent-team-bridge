import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../gateway/federation/allowlist.js";
import { type CrossDomainPeer, CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { ReplayGuard } from "../gateway/federation/replayGuard.js";
import { createSealer, type Sealer } from "../gateway/federation/sealer.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
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

function allowlistWithBoth(): Allowlist {
	const a = new Allowlist(tmp(), processAmbient());
	a.setOwner(owner.sign.pub);
	a.addAdmission(signAdmission(hostAdmission("A", A), owner.sign.priv, owner.sign.pub));
	a.addAdmission(signAdmission(hostAdmission("B", B), owner.sign.priv, owner.sign.pub));
	return a;
}

function noPeers(): CrossDomainPeers {
	return new CrossDomainPeers(tmp());
}

describe("sealer (local v1)", () => {
	it("round-trips a sealed object between two admitted Gateways", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { hello: "world", n: 7 });
		expect(bSealer.open("A", env)).toEqual({ hello: "world", n: 7 });
	});

	it("emits a v1 sealed body for a local peer (byte shape unchanged: v/src/dst/at/body, no domains)", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { hello: "world" });
		const inner = JSON.parse(unseal(env, B.box.priv, A.sign.pub).toString("utf8"));
		expect(inner).toEqual({ v: 1, src: "A", dst: "B", at: inner.at, body: { hello: "world" } });
		expect(typeof inner.at).toBe("number");
		expect(inner).not.toHaveProperty("srcDomain");
		expect(inner).not.toHaveProperty("dstDomain");
	});

	it("rejects a replayed envelope (same nonce opened twice)", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { n: 1 });
		expect(bSealer.open("A", env)).toEqual({ n: 1 });
		expect(() => bSealer.open("A", env)).toThrow(/replay/);
	});

	it("rejects an envelope naming an unadmitted source Gateway", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { x: 1 });
		expect(() => bSealer.open("C", env)).toThrow(/not admitted/);
	});

	it("fails to open a tampered envelope", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { ok: true });
		const tampered = { ...env, ciphertext: Buffer.from("evil").toString("base64") };
		expect(() => bSealer.open("A", tampered)).toThrow();
	});

	it("rejects a relabeled source (signed-in src must match the claimed srcGateway)", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { x: 1 });
		expect(() => bSealer.open("B", env)).toThrow();
	});

	it("rejects a frame addressed to a different Gateway", () => {
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const cSealer = createSealer(
			B,
			allowlistWithBoth(),
			"C",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = aSealer.seal("B", { x: 1 });
		expect(() => cSealer.open("A", env)).toThrow(/not addressed to this Gateway/);
	});

	it("rejects a stale envelope past the freshness window", () => {
		let clock = 1_000_000;
		const aSealer = createSealer(
			A,
			allowlistWithBoth(),
			"A",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			{ now: () => clock },
		);
		const bSealer = createSealer(
			B,
			allowlistWithBoth(),
			"B",
			noPeers(),
			"alice",
			new ReplayGuard(processAmbient()),
			{ now: () => clock },
		);
		const env = aSealer.seal("B", { x: 1 });
		// Past SEAL_MAX_AGE_MS.
		clock += 120_001;
		expect(() => bSealer.open("A", env)).toThrow(/stale/);
	});
});

// Cross-Domain peers require v2 with domain binding. Domain localx.
const ownerX = generateIdentity();
// Domain carol.
const ownerY = generateIdentity();
// Gateway gw-x.
const X = generateIdentity();
// Gateway gw-y.
const Y = generateIdentity();

function soloAllowlist(o: Identity, gwId: string, id: Identity): Allowlist {
	const a = new Allowlist(tmp(), processAmbient());
	a.setOwner(o.sign.pub);
	a.addAdmission(signAdmission(hostAdmission(gwId, id), o.sign.priv, o.sign.pub));
	return a;
}

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

function xPeers(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerY, "carol", "gw-y", Y, ownerX));
	return s;
}
function yPeers(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerX, "localx", "gw-x", X, ownerY));
	return s;
}

describe("sealer (cross-Domain v2)", () => {
	it("round-trips a sealed object between two Gateways in different Domains", () => {
		const xSealer = createSealer(
			X,
			soloAllowlist(ownerX, "gw-x", X),
			"gw-x",
			xPeers(),
			"localx",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const ySealer = createSealer(
			Y,
			soloAllowlist(ownerY, "gw-y", Y),
			"gw-y",
			yPeers(),
			"carol",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { ping: 42 });
		expect(ySealer.open("gw-x", env)).toEqual({ ping: 42 });
	});

	it("emits a v2 sealed body carrying srcDomain/dstDomain", () => {
		const xSealer = createSealer(
			X,
			soloAllowlist(ownerX, "gw-x", X),
			"gw-x",
			xPeers(),
			"localx",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { ping: 42 });
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
		const xSealer = createSealer(
			X,
			soloAllowlist(ownerX, "gw-x", X),
			"gw-x",
			xPeers(),
			"localx",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		expect(() => xSealer.seal({ domainId: "dave", gatewayId: "gw-y" }, { x: 1 })).toThrow(/not admitted/);
	});

	it("rejects a v2 frame whose dstDomain is not this Gateway's Domain", () => {
		const xSealer = createSealer(
			X,
			soloAllowlist(ownerX, "gw-x", X),
			"gw-x",
			xPeers(),
			"localx",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const yWrongDomain = createSealer(
			Y,
			soloAllowlist(ownerY, "gw-y", Y),
			"gw-y",
			yPeers(),
			"elsewhere",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = xSealer.seal({ domainId: "carol", gatewayId: "gw-y" }, { x: 1 });
		expect(() => yWrongDomain.open("gw-x", env)).toThrow(/not addressed to this Domain/);
	});

	it("rejects a v2 frame whose signed-in srcDomain disagrees with the resolved peer", () => {
		const xLies = createSealer(
			X,
			soloAllowlist(ownerX, "gw-x", X),
			"gw-x",
			xPeers(),
			"spoofed",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const ySealer = createSealer(
			Y,
			soloAllowlist(ownerY, "gw-y", Y),
			"gw-y",
			yPeers(),
			"carol",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = xLies.seal({ domainId: "carol", gatewayId: "gw-y" }, { x: 1 });
		expect(() => ySealer.open("gw-x", env)).toThrow(/srcDomain mismatch/);
	});

	it("rejects an unknown sealed body version", () => {
		const ySealer = createSealer(
			Y,
			soloAllowlist(ownerY, "gw-y", Y),
			"gw-y",
			yPeers(),
			"carol",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const inner = {
			v: 99,
			src: "gw-x",
			dst: "gw-y",
			srcDomain: "localx",
			dstDomain: "carol",
			at: Date.now(),
			body: {},
		};
		const env = seal(Buffer.from(JSON.stringify(inner)), Y.box.pub, X.sign.priv);
		expect(() => ySealer.open("gw-x", env)).toThrow(/unknown sealed body version/);
	});

	it("rejects a v1 frame from a cross-Domain Gateway (v1 must be a local peer)", () => {
		const ySealer = createSealer(
			Y,
			soloAllowlist(ownerY, "gw-y", Y),
			"gw-y",
			yPeers(),
			"carol",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const inner = { v: 1, src: "gw-x", dst: "gw-y", at: Date.now(), body: { evil: true } };
		const env = seal(Buffer.from(JSON.stringify(inner)), Y.box.pub, X.sign.priv);
		expect(() => ySealer.open("gw-x", env)).toThrow(/v1 frame from a cross-Domain Gateway/);
	});
});

// srcDomain disambiguates duplicate gateway ids. Domain pat.
const ownerP = generateIdentity();
// Domain quinn.
const ownerQ = generateIdentity();
// Receiving Domain rcv.
const recvOwner = generateIdentity();
// Gateway shared in pat.
const P = generateIdentity();
// Gateway shared in quinn.
const Q = generateIdentity();
// Receiving gateway gw-r.
const R = generateIdentity();

function recvPeersWithCollision(): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(ownerP, "pat", "shared", P, recvOwner));
	s.add(crossPeer(ownerQ, "quinn", "shared", Q, recvOwner));
	return s;
}

function friendPeersKnowingReceiver(friendOwner: Identity): CrossDomainPeers {
	const s = new CrossDomainPeers(tmp());
	s.add(crossPeer(recvOwner, "rcv", "gw-r", R, friendOwner));
	return s;
}

describe("sealer (cross-Domain srcDomain disambiguation)", () => {
	function receiverSealer(): Sealer {
		return createSealer(
			R,
			soloAllowlist(recvOwner, "gw-r", R),
			"gw-r",
			recvPeersWithCollision(),
			"rcv",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
	}

	it("resolves a same-id-two-Domains peer when srcDomain names the sender's Domain", () => {
		const pSealer = createSealer(
			P,
			soloAllowlist(ownerP, "shared", P),
			"shared",
			friendPeersKnowingReceiver(ownerP),
			"pat",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(receiverSealer().open("shared", env, "pat")).toEqual({ who: "pat" });
	});

	it("resolves the OTHER same-id peer when srcDomain names the other Domain", () => {
		const qSealer = createSealer(
			Q,
			soloAllowlist(ownerQ, "shared", Q),
			"shared",
			friendPeersKnowingReceiver(ownerQ),
			"quinn",
			new ReplayGuard(processAmbient()),
			processAmbient(),
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
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(() => receiverSealer().open("shared", env, "nobody")).toThrow(/not admitted/);
	});

	it("without srcDomain, a colliding gateway id stays ambiguous (back-compat null)", () => {
		const pSealer = createSealer(
			P,
			soloAllowlist(ownerP, "shared", P),
			"shared",
			friendPeersKnowingReceiver(ownerP),
			"pat",
			new ReplayGuard(processAmbient()),
			processAmbient(),
		);
		const env = pSealer.seal({ domainId: "rcv", gatewayId: "gw-r" }, { who: "pat" });
		expect(() => receiverSealer().open("shared", env)).toThrow(/not admitted/);
	});
});
