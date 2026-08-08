import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { aliceGw, aliceOwner, bobOwner, peersOf, xdPeer } from "./helpers/federation.js";

////////////////////////////////
//  Share auto-forget sweep wiring (the production-shaped sweep + isLive)
//
//  crossDomainShareState.sweep is unit-tested in cross-domain-share-state.test.ts; this
//  proves the GATEWAY wiring: the same isLive predicate the gateway builds (a live
//  persistent cross-Domain pending-job for the session) suppresses a live share's forget
//  while a stale, thread-less share is dropped.

describe("share auto-forget wiring (isLive predicate + sweep)", () => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

	// The exact predicate the gateway wires in startGateway(): a live persistent cross-Domain
	// thread (a pending job with a returnRoute whose origin Gateway is a linked friend peer)
	// for the canonical session target.
	function isLiveFor(store: PendingJobStore<ResponsePayload>, peers: CrossDomainPeers, now: number = Date.now()) {
		return (sessionTarget: string): boolean =>
			store.hasLiveCrossDomainThread(
				sessionTarget,
				(gatewayId) => peers.all().some((p) => p.friendGatewayId === gatewayId),
				THIRTY_DAYS_MS,
				now,
			);
	}

	/** Create a persistent cross-Domain anchor whose createdAt is PINNED to `at` (so a test can
	 * make a thread look recent or long-dead independent of the wall clock). */
	function anchorAt(store: PendingJobStore<ResponsePayload>, id: string, srcGateway: string, at: number): void {
		const realNow = Date.now;
		Date.now = () => at;
		try {
			store.create(id, "alice.alice-gw.app.dev", "lib.dev", {
				persistent: true,
				fromConversationId: "c1",
				returnRoute: { srcGateway, srcConversationId: "c1", srcSession: id },
			});
		} finally {
			Date.now = realNow;
		}
	}

	it("the wired sweep DROPS a stale share but isLive SUPPRESSES a live one", () => {
		const share = new CrossDomainShareState(
			path.join(os.tmpdir(), `fed-sweep-${Math.random().toString(36).slice(2)}`),
		);
		share.share("bob.bob-gw.lib.dev", { kind: "domain", domainId: "alice" }); // will be kept by a RECENTLY-ACTIVE thread
		share.share("bob.bob-gw.old.dev", { kind: "domain", domainId: "alice" }); // stale, thread-less -> dropped

		// Sweep far in the future so BOTH shares are past their absence TTL. The live thread's
		// anchor is pinned recent relative to that sweep instant (ongoing traffic refreshes
		// createdAt), so it counts as live; bob.bob-gw.old.dev has no thread at all.
		const sweepNow = Date.now() + THIRTY_DAYS_MS + 1;
		const store = new PendingJobStore<ResponsePayload>();
		anchorAt(store, "conv.c1.bob.bob-gw.lib.dev", "alice-gw", sweepNow);
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const isLive = isLiveFor(store, peers, sweepNow);

		const dropped = share.sweep(sweepNow, THIRTY_DAYS_MS, isLive);
		expect(dropped).toBe(1); // bob.bob-gw.old.dev only
		expect(share.isSharedTo("bob.bob-gw.lib.dev", "alice", () => true)).toBe(true); // recent thread kept it
		expect(share.isSharedTo("bob.bob-gw.old.dev", "alice", () => true)).toBe(false); // stale, forgotten
	});

	// isLive must mean RECENTLY ACTIVE, not "ever touched": a single long-dead anchor must not
	// pin a share forever. A thread idle past the recency window stops suppressing the forget.
	it("a share whose ONLY cross-Domain anchor is older than the recency window IS swept", () => {
		const base = Date.now();
		// Two full windows past `base`, so both the share's absence TTL and the anchor's recency
		// window are comfortably exceeded (no off-by-ms ambiguity with the live `share()` clock).
		const sweepNow = base + THIRTY_DAYS_MS * 2;
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));

		const share = new CrossDomainShareState(
			path.join(os.tmpdir(), `fed-stale-${Math.random().toString(36).slice(2)}`),
		);
		share.share("bob.bob-gw.lib.dev", { kind: "domain", domainId: "alice" }); // lastSeenAt ~= base, so it is past TTL at sweepNow

		// A persistent cross-Domain anchor that last saw traffic at `base` (its createdAt), so by
		// sweepNow it is older than the recency window: it must NOT suppress the forget.
		const store = new PendingJobStore<ResponsePayload>();
		anchorAt(store, "conv.c1.bob.bob-gw.lib.dev", "alice-gw", base);
		expect(isLiveFor(store, peers, sweepNow)("bob.bob-gw.lib.dev")).toBe(false);
		const dropped = share.sweep(sweepNow, THIRTY_DAYS_MS, isLiveFor(store, peers, sweepNow));
		expect(dropped).toBe(1);
		expect(share.isSharedTo("bob.bob-gw.lib.dev", "alice", () => true)).toBe(false);

		// Contrast: an anchor touched recently (createdAt at sweepNow) still suppresses the forget.
		const live = new PendingJobStore<ResponsePayload>();
		anchorAt(live, "conv.c1.bob.bob-gw.lib.dev", "alice-gw", sweepNow);
		expect(isLiveFor(live, peers, sweepNow)("bob.bob-gw.lib.dev")).toBe(true);
	});

	it("isLive is false for a job whose returnRoute origin is NOT a linked peer (same-Domain federated)", () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A federated job, but its origin Gateway is a SAME-Domain peer (not in the cross set).
		store.create("conv.c1.bob.bob-gw.lib.dev", "x", "lib.dev", {
			persistent: true,
			returnRoute: {
				srcGateway: "local-peer",
				srcConversationId: "c1",
				srcSession: "conv.c1.bob.bob-gw.lib.dev",
			},
		});
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const isLive = isLiveFor(store, peers);
		expect(isLive("bob.bob-gw.lib.dev")).toBe(false);
	});

	it("isLive is false for a local (non-returnRoute) persistent job targeting the session", () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A plain local channel job (no returnRoute) must not count as a cross-Domain thread.
		store.create("conv.c1.bob.bob-gw.lib.dev", "x", "lib.dev", { persistent: true, fromConversationId: "c1" });
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		expect(isLiveFor(store, peers)("bob.bob-gw.lib.dev")).toBe(false);
	});
});
