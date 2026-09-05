import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { linkedPeer } from "./helpers/cross-domain-link.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CrossDomainPeers", () => {
	it("adds, reloads, resolves, replaces, and removes peers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-"));
		dirs.push(dir);
		const store = new CrossDomainPeers(dir);
		const replacement = linkedPeer("carol", "laptop", "new-sign");
		store.add(linkedPeer("carol", "laptop"));
		store.add(linkedPeer("dave", "laptop"));
		store.add(replacement);
		expect(new CrossDomainPeers(dir).all()).toEqual([linkedPeer("dave", "laptop"), replacement]);
		expect(store.resolveByGateway("carol", "laptop")).toEqual(replacement);
		expect(store.resolveBySignPub("new-sign")).toEqual(replacement);
		expect(store.resolveByGateway("missing", "laptop")).toBeNull();
		expect(store.removeByDomain("carol")).toBe(1);
		expect(store.remove("laptop")).toBe(1);
		expect(store.all()).toEqual([]);
	});

	it("refuses a malformed peer and forgets every Domain of an untrusted owner", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-"));
		dirs.push(dir);
		const store = new CrossDomainPeers(dir);
		expect(store.add({ friendDomainId: "" } as never)).toBe(false);
		const first = linkedPeer("erin-home", "laptop");
		const second = { ...linkedPeer("erin-work", "desk"), friendOwnerSignPub: first.friendOwnerSignPub };
		store.add(first);
		store.add(second);
		store.add(linkedPeer("frank", "laptop"));
		expect(store.removeByOwner(first.friendOwnerSignPub)).toEqual({
			removed: 2,
			domains: ["erin-home", "erin-work"],
		});
		expect(new CrossDomainPeers(dir).all().map((peer) => peer.friendDomainId)).toEqual(["frank"]);
	});
});
