import { describe, expect, it } from "vitest";
import { PendingJobStore, type WaitResult } from "../shared/pending-job-store.js";
import { Address, storeKey } from "../shared/session-id.js";

////////////////////////////////
//  Shared addressing helpers
//
//  A conv store key is the fully-qualified `conv.<conv>.<domain>.<gateway>.<spawn>.<session>`
//  (6 dot-segments) built by storeKey({kind:"conv", ...}). For a destination job the address
//  segments are the LOCAL gateway's (domain `bob`, gateway `hostb`); the verified sending friend
//  Domain rides separately as dstDomainId. The share is keyed by the address's canonical
//  `domain.gateway.spawn.session`, which is what expireBySession matches on. The old bare team
//  names become composite (`lib` -> spawn `lib`, session `dev`).

const DOMAIN = "bob";
const GW = "hostb";

/** A fully-qualified conv store key on the local (`bob`/`hostb`) gateway. */
function convKey(conv: string, spawn: string, session = "dev"): string {
	return storeKey({ kind: "conv", conversationId: conv, address: Address.of(DOMAIN, GW, spawn, session) });
}

/** The canonical `domain.gateway.spawn.session` a share/expiry targets. */
function sessionTarget(spawn: string, session = "dev"): string {
	return Address.of(DOMAIN, GW, spawn, session).canonical;
}

////////////////////////////////
//  PendingJobStore.expireByDomain
//
//  When a cross-Domain link is pulled, jobs bound to that remote Domain can no longer
//  receive a reply (the sealer refuses the unlinked peer), so they would stall their
//  waiter until the TTL fires. expireByDomain actively settles them through the same
//  path the TTL timeout uses, removes them, and reports the count - while leaving
//  same-Domain and local jobs alone.

describe("PendingJobStore.expireByDomain", () => {
	it("notifies only for cross-Domain job lifecycle changes", () => {
		let changes = 0;
		const store = new PendingJobStore<string>(600_000, () => changes++);
		const route = { srcGateway: "alice-gw", srcConversationId: "c1", srcSession: "s1" };

		store.create("local", "a", "b", { persistent: true });
		store.create("remote", "a", "b", { persistent: true, returnRoute: route, dstDomainId: "alice" });
		store.create("remote", "a", "b", { persistent: true, returnRoute: route, dstDomainId: "alice" });
		store.remove("remote");

		store.create("expired", "a", "b", { persistent: true, returnRoute: route, dstDomainId: "alice" });
		store.expireByDomain("alice");

		expect(changes).toBe(5);
	});

	it("settles only matching-dstDomainId jobs and returns the count", () => {
		const store = new PendingJobStore<string>();
		const carol1 = convKey("c1", "lib");
		const carol2 = convKey("c2", "docs");
		const dave1 = convKey("c3", "app"); // a DIFFERENT Domain
		const local1 = convKey("c4", "tools"); // local (dstDomainId null)
		store.create(carol1, "a", "b", { dstDomainId: "carol" });
		store.create(carol2, "a", "c", { dstDomainId: "carol" });
		store.create(dave1, "a", "d", { dstDomainId: "dave" });
		store.create(local1, "a", "e");

		expect(store.expireByDomain("carol")).toBe(2);

		// The two Carol jobs are gone; the other-Domain and local jobs survive.
		expect(store.has(carol1)).toBe(false);
		expect(store.has(carol2)).toBe(false);
		expect(store.has(dave1)).toBe(true);
		expect(store.has(local1)).toBe(true);
	});

	it("settles the waiting promise with a clear expiry error", async () => {
		const store = new PendingJobStore<string>();
		const carol = convKey("c1", "lib");
		store.create(carol, "a", "b", { dstDomainId: "carol" });

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(carol, 60_000).then((r) => {
			settled = r;
		});

		const count = store.expireByDomain("carol");
		await waiting;

		expect(count).toBe(1);
		expect(settled).not.toBeNull();
		expect(settled).toEqual({ delivered: false, error: "cross-domain link unlinked" });
	});

	it("uses a caller-supplied error message when given", async () => {
		const store = new PendingJobStore<string>();
		const carol = convKey("c1", "lib");
		store.create(carol, "a", "b", { dstDomainId: "carol" });

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(carol, 60_000).then((r) => {
			settled = r;
		});

		store.expireByDomain("carol", "Carol unlinked");
		await waiting;

		expect(settled).toEqual({ delivered: false, error: "Carol unlinked" });
	});

	it("leaves a same-Domain job's waiter untouched", async () => {
		const store = new PendingJobStore<string>();
		const carol = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		store.create(carol, "a", "b", { dstDomainId: "carol" });
		store.create(dave, "a", "c", { dstDomainId: "dave" });

		// A live waiter on the NON-targeted job must keep waiting (not settle).
		let daveSettled = false;
		store.waitForResult(dave, 60_000).then(() => {
			daveSettled = true;
		});

		store.expireByDomain("carol");
		// Let any erroneous microtask resolution flush.
		await Promise.resolve();

		expect(daveSettled).toBe(false);
		expect(store.has(dave)).toBe(true);
		// The still-waiting job can still be delivered normally.
		expect(store.deliver(dave, "ok")).not.toBe(false);
	});

	it("returns 0 when no job is bound to the Domain", () => {
		const store = new PendingJobStore<string>();
		const local1 = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		store.create(local1, "a", "b"); // local
		store.create(dave, "a", "c", { dstDomainId: "dave" });
		expect(store.expireByDomain("carol")).toBe(0);
		expect(store.has(local1)).toBe(true);
		expect(store.has(dave)).toBe(true);
	});

	it("expires a stored (not-yet-polled) cross-Domain job too", () => {
		const store = new PendingJobStore<string>();
		// A persistent cross-Domain job that already received and stored a reply.
		const carolConv = convKey("c1", "lib");
		store.create(carolConv, "a", "b", { dstDomainId: "carol", persistent: true });
		store.deliver(carolConv, "hello"); // async (channel) delivery -> stored
		expect(store.expireByDomain("carol")).toBe(1);
		expect(store.has(carolConv)).toBe(false);
	});
});

////////////////////////////////
//  PendingJobStore.expireBySession
//
//  When a SINGLE session's share to a friend Domain is withdrawn (not the whole-Domain
//  unlink), only the jobs for that (session, friend) pair must be settled - other sessions
//  shared to the same friend, and the same session shared to another friend, keep waiting.
//  The match is on the job's own conv store key (the canonical domain.gateway.spawn.session
//  the share is keyed by), since a destination job stores `entry.to` as the BARE local name.

describe("PendingJobStore.expireBySession", () => {
	// A destination job mirrors what gatewayRelay.handleOp + routes.send create for a
	// cross-Domain inbound send: the id is the origin-set canonical conv store key
	// (conv.<conv>.<localDomain>.<localGateway>.<spawn>.<session>), `to` is the BARE local
	// name, and dstDomainId is the verified sending friend Domain.
	function destJob(store: PendingJobStore<string>, conv: string, spawn: string, friendDomain: string): string {
		const id = convKey(conv, spawn);
		store.create(id, "alice.app", spawn, { dstDomainId: friendDomain, persistent: true });
		return id;
	}

	it("expires ONLY the matching (session, friend) jobs; other sessions and friends survive", () => {
		const store = new PendingJobStore<string>();
		const libForAlice = destJob(store, "c1", "lib", "alice"); // the un-shared pair
		const docsForAlice = destJob(store, "c2", "docs", "alice"); // same friend, OTHER session
		const libForCarol = destJob(store, "c3", "lib", "carol"); // same session, OTHER friend

		// Un-share lib from alice: the share key is the canonical domain.gateway.spawn.session.
		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(1);

		expect(store.has(libForAlice)).toBe(false); // dropped
		expect(store.has(docsForAlice)).toBe(true); // other session to the same friend - kept
		expect(store.has(libForCarol)).toBe(true); // same session to another friend - kept
	});

	it("settles a waiting reply for the un-shared session with a clear reason", async () => {
		const store = new PendingJobStore<string>();
		const id = destJob(store, "c1", "lib", "alice");

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(id, 60_000).then((r) => {
			settled = r;
		});

		const count = store.expireBySession(sessionTarget("lib"), "alice");
		await waiting;

		expect(count).toBe(1);
		expect(settled).toEqual({ delivered: false, error: "cross-domain session unshared" });
	});

	it("does NOT match a job for the same session bound to a DIFFERENT friend Domain", async () => {
		const store = new PendingJobStore<string>();
		const id = destJob(store, "c1", "lib", "carol"); // lib<->carol still shared

		let settled = false;
		store.waitForResult(id, 60_000).then(() => {
			settled = true;
		});

		// Un-sharing lib from ALICE must not touch the lib<->carol job.
		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(store.has(id)).toBe(true);
		expect(store.deliver(id, "ok")).not.toBe(false); // still deliverable
	});

	it("ignores a local / same-Domain job (dstDomainId null) for the same session name", () => {
		const store = new PendingJobStore<string>();
		// A local channel anchor for the same canonical session, no Domain binding.
		const local = convKey("c1", "lib");
		store.create(local, "x", "lib");
		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		expect(store.has(local)).toBe(true);
	});

	it("returns 0 when no job matches", () => {
		const store = new PendingJobStore<string>();
		destJob(store, "c1", "lib", "alice");
		expect(store.expireBySession(sessionTarget("ghost"), "alice")).toBe(0);
		expect(store.expireBySession(sessionTarget("lib"), "dave")).toBe(0);
	});
});
