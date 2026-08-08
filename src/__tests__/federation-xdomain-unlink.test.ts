import { describe, expect, it } from "vitest";
import type { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import type { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { createSealer } from "../gateway/federation/sealer.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import {
	aliceGw,
	aliceOwner,
	bobGw,
	bobOwner,
	memShareStateStore,
	peersOf,
	soloAllowlist,
	xdPeer,
} from "./helpers/federation.js";

////////////////////////////////
//  Cross-Domain unlink: the gateway-local cleanup (the cross_domain_unlink op's dep)
//
//  The unlink dep wires the three local primitives - CrossDomainPeers.removeByDomain,
//  CrossDomainShareState.dropDomain, PendingJobStore.expireByDomain - over the REAL stores.
//  After it runs, the sealer can no longer resolve the unlinked peer, so an inbound open
//  (and a would-be outbound seal) to that Domain fails closed with no sealer change.

describe("cross-Domain unlink local cleanup (the dep over the real stores)", () => {
	// The dep exactly as index.ts composes it: drop the peers, shares, and in-flight jobs of a
	// friend Domain and report the counts.
	function unlinkDep(
		peers: CrossDomainPeers,
		shares: CrossDomainShareState,
		store: PendingJobStore<ResponsePayload>,
	) {
		return (domainId: string) => ({
			peersRemoved: peers.removeByDomain(domainId),
			sharesDropped: shares.dropDomain(domainId),
			jobsExpired: store.expireByDomain(domainId),
		});
	}

	it("drops the peers, shares, and in-flight jobs of the Domain and returns the counts", () => {
		// bob has alice as a cross-Domain peer, two shares offered to alice, and two in-flight
		// jobs bound to alice (created with dstDomainId "alice").
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const shares = memShareStateStore([
			["bob.bob-gw.lib.dev", "alice"],
			["bob.bob-gw.api.dev", "alice"],
		]);
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv.c1.alice.alice-gw.lib.dev", "alice.alice-gw.lib.dev", "alice-gw", {
			persistent: true,
			dstDomainId: "alice",
		});
		store.create("conv.c2.alice.alice-gw.api.dev", "alice.alice-gw.api.dev", "alice-gw", {
			persistent: true,
			dstDomainId: "alice",
		});
		// A DIFFERENT Domain's job must survive the alice unlink.
		store.create("conv.c3.carol.carol-gw.docs.dev", "carol.carol-gw.docs.dev", "carol-gw", {
			persistent: true,
			dstDomainId: "carol",
		});

		const counts = unlinkDep(peers, shares, store)("alice");
		expect(counts).toEqual({ peersRemoved: 1, sharesDropped: 2, jobsExpired: 2 });
		// The peer set, the shares to alice, and alice's jobs are gone; carol's job is untouched.
		expect(peers.all()).toHaveLength(0);
		expect(shares.all()).toHaveLength(0);
		expect(store.has("conv.c1.alice.alice-gw.lib.dev")).toBe(false);
		expect(store.has("conv.c3.carol.carol-gw.docs.dev")).toBe(true);
	});

	it("unlinking an unknown / already-unlinked Domain is a clean zero-count no-op", () => {
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const shares = memShareStateStore([["bob.bob-gw.lib.dev", "alice"]]);
		const store = new PendingJobStore<ResponsePayload>();
		const dep = unlinkDep(peers, shares, store);

		// A Domain that was never linked.
		expect(dep("ghost")).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
		// And a SECOND unlink of alice (idempotent: the first already forgot everything).
		expect(dep("alice")).toEqual({ peersRemoved: 1, sharesDropped: 1, jobsExpired: 0 });
		expect(dep("alice")).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
	});

	it("after unlink the sealer no longer resolves the peer: an inbound open fails closed", () => {
		// bob's peer set knows alice; bob's sealer resolves alice's frames against it.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		// alice's sealer knows bob, so she can seal a v2 frame addressed to bob's Domain.
		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const sealed = aliceSealer.seal({ domainId: "bob", gatewayId: "bob-gw" }, { hello: "world" });

		// Before unlink: bob opens alice's frame, resolving the peer by the (domain, gateway) pair.
		const opened = bobSealer.openWithSource("alice-gw", sealed, "alice");
		expect(opened.srcDomainId).toBe("alice");

		// The unlink cleanup forgets alice on bob's side (the gateway-local effect).
		const shares = memShareStateStore();
		const store = new PendingJobStore<ResponsePayload>();
		unlinkDep(bobPeers, shares, store)("alice");

		// After unlink: the verify-key resolution finds no peer, so the open throws BEFORE unseal -
		// in-flight frames from the unlinked Domain drop at key resolution (fail closed). A fresh
		// frame (re-sealed by alice) is rejected the same way; the captured one above is too.
		const fresh = aliceSealer.seal({ domainId: "bob", gatewayId: "bob-gw" }, { hello: "again" });
		expect(() => bobSealer.openWithSource("alice-gw", fresh, "alice")).toThrow(/not admitted/);
		expect(() => bobSealer.openWithSource("alice-gw", sealed, "alice")).toThrow(/not admitted/);
	});
});
