import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CrossDomainPeer, CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { generateIdentity } from "../shared/crypto.js";
import { signXDomainLink, type XDomainLink } from "../shared/federation-protocol.js";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-peers-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const friendOwner = generateIdentity();

function peer(over: Partial<CrossDomainPeer> = {}): CrossDomainPeer {
	const gw = generateIdentity();
	const friendDomainId = over.friendDomainId ?? "carol";
	const friendGatewayId = over.friendGatewayId ?? "carol-laptop";
	const link: XDomainLink = {
		myOwnerSignPub: generateIdentity().sign.pub,
		peerOwnerSignPub: friendOwner.sign.pub,
		peerDomainId: friendDomainId,
		peerGatewayId: friendGatewayId,
		peerSignPub: over.friendSignPub ?? gw.sign.pub,
		peerBoxPub: over.friendBoxPub ?? gw.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
	};
	return {
		friendOwnerSignPub: friendOwner.sign.pub,
		friendDomainId,
		friendGatewayId,
		friendSignPub: over.friendSignPub ?? gw.sign.pub,
		friendBoxPub: over.friendBoxPub ?? gw.box.pub,
		link: signXDomainLink(link, friendOwner.sign.priv, friendOwner.sign.pub),
		...over,
	};
}

describe("CrossDomainPeers store", () => {
	it("persists and reloads a peer across instances (round-trip)", () => {
		const dir = tmp();
		const store = new CrossDomainPeers(dir);
		const p = peer();
		expect(store.add(p)).toBe(true);

		// A fresh instance over the same dir reads the persisted file.
		const reloaded = new CrossDomainPeers(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.resolveByGateway(p.friendDomainId, p.friendGatewayId)).toEqual(p);
	});

	it("writes the file with 0600 perms", () => {
		const dir = tmp();
		const store = new CrossDomainPeers(dir);
		store.add(peer());
		const mode = fs.statSync(path.join(dir, "cross-domain-peers.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("resolveByGateway returns null for an unknown pair", () => {
		const store = new CrossDomainPeers(tmp());
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "carol-laptop" }));
		expect(store.resolveByGateway("carol", "other")).toBeNull();
		expect(store.resolveByGateway("dave", "carol-laptop")).toBeNull();
	});

	it("resolveBySignPub finds the peer by its gateway signing key", () => {
		const store = new CrossDomainPeers(tmp());
		const p = peer();
		store.add(p);
		expect(store.resolveBySignPub(p.friendSignPub)).toEqual(p);
		expect(store.resolveBySignPub(generateIdentity().sign.pub)).toBeNull();
	});

	it("replaces by (friendDomainId, friendGatewayId) instead of duplicating", () => {
		const store = new CrossDomainPeers(tmp());
		const gw2 = generateIdentity();
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "carol-laptop" }));
		// Same (domain, gateway) but fresh keys: replaces, not appends.
		const replacement = peer({
			friendDomainId: "carol",
			friendGatewayId: "carol-laptop",
			friendSignPub: gw2.sign.pub,
			friendBoxPub: gw2.box.pub,
		});
		store.add(replacement);
		expect(store.all()).toHaveLength(1);
		expect(store.resolveByGateway("carol", "carol-laptop")?.friendSignPub).toBe(gw2.sign.pub);
	});

	it("keeps the same gateway id in two distinct Domains as separate peers", () => {
		const store = new CrossDomainPeers(tmp());
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "laptop" }));
		store.add(peer({ friendDomainId: "dave", friendGatewayId: "laptop" }));
		expect(store.all()).toHaveLength(2);
		expect(store.resolveByGateway("carol", "laptop")).not.toBeNull();
		expect(store.resolveByGateway("dave", "laptop")).not.toBeNull();
	});

	it("removes by friend gateway id and persists the removal", () => {
		const dir = tmp();
		const store = new CrossDomainPeers(dir);
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "carol-laptop" }));
		store.add(peer({ friendDomainId: "dave", friendGatewayId: "dave-laptop" }));
		expect(store.remove("carol-laptop")).toBe(1);
		expect(store.all()).toHaveLength(1);
		expect(store.remove("nope")).toBe(0);

		const reloaded = new CrossDomainPeers(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.resolveByGateway("dave", "dave-laptop")).not.toBeNull();
	});

	it("removeByDomain drops every gateway of a Domain, leaves others, returns the count, and persists", () => {
		const dir = tmp();
		const store = new CrossDomainPeers(dir);
		// Carol runs two gateways; Dave one.
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "carol-laptop" }));
		store.add(peer({ friendDomainId: "carol", friendGatewayId: "carol-desktop" }));
		store.add(peer({ friendDomainId: "dave", friendGatewayId: "dave-laptop" }));

		// Unlinking Carol drops BOTH her gateways at once and reports the count.
		expect(store.removeByDomain("carol")).toBe(2);
		expect(store.all()).toHaveLength(1);
		expect(store.resolveByGateway("carol", "carol-laptop")).toBeNull();
		expect(store.resolveByGateway("carol", "carol-desktop")).toBeNull();
		// Dave is untouched.
		expect(store.resolveByGateway("dave", "dave-laptop")).not.toBeNull();

		// A second unlink of an already-gone Domain removes nothing.
		expect(store.removeByDomain("carol")).toBe(0);

		// The removal persisted: a fresh instance over the same dir sees only Dave.
		const reloaded = new CrossDomainPeers(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.resolveByGateway("dave", "dave-laptop")).not.toBeNull();
	});

	it("rejects a malformed peer (missing required field)", () => {
		const store = new CrossDomainPeers(tmp());
		const bad = { ...peer(), friendSignPub: "" };
		expect(store.add(bad as CrossDomainPeer)).toBe(false);
		expect(store.all()).toHaveLength(0);
	});

	it("starts empty when the file is absent or corrupt", () => {
		const dir = tmp();
		expect(new CrossDomainPeers(dir).all()).toHaveLength(0);
		fs.writeFileSync(path.join(dir, "cross-domain-peers.json"), "not json");
		expect(new CrossDomainPeers(dir).all()).toHaveLength(0);
	});
});
