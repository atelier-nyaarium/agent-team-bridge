import { describe, expect, it } from "vitest";
import { PendingJobStore, type WaitResult } from "../shared/pending-job-store.js";

////////////////////////////////
//  PendingJobStore.expireByDomain
//
//  When a cross-Domain link is pulled, jobs bound to that remote Domain can no longer
//  receive a reply (the sealer refuses the unlinked peer), so they would stall their
//  waiter until the TTL fires. expireByDomain actively settles them through the same
//  path the TTL timeout uses, removes them, and reports the count - while leaving
//  same-Domain and local jobs alone.

describe("PendingJobStore.expireByDomain", () => {
	it("settles only matching-dstDomainId jobs and returns the count", () => {
		const store = new PendingJobStore<string>();
		store.create("carol-job-1", "a", "b", { dstDomainId: "carol" });
		store.create("carol-job-2", "a", "c", { dstDomainId: "carol" });
		store.create("dave-job", "a", "d", { dstDomainId: "dave" }); // a DIFFERENT Domain
		store.create("local-job", "a", "e"); // local (dstDomainId null)

		expect(store.expireByDomain("carol")).toBe(2);

		// The two Carol jobs are gone; the other-Domain and local jobs survive.
		expect(store.has("carol-job-1")).toBe(false);
		expect(store.has("carol-job-2")).toBe(false);
		expect(store.has("dave-job")).toBe(true);
		expect(store.has("local-job")).toBe(true);
	});

	it("settles the waiting promise with a clear expiry error", async () => {
		const store = new PendingJobStore<string>();
		store.create("carol-job", "a", "b", { dstDomainId: "carol" });

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult("carol-job", 60_000).then((r) => {
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
		store.create("carol-job", "a", "b", { dstDomainId: "carol" });

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult("carol-job", 60_000).then((r) => {
			settled = r;
		});

		store.expireByDomain("carol", "Carol unlinked");
		await waiting;

		expect(settled).toEqual({ delivered: false, error: "Carol unlinked" });
	});

	it("leaves a same-Domain job's waiter untouched", async () => {
		const store = new PendingJobStore<string>();
		store.create("carol-job", "a", "b", { dstDomainId: "carol" });
		store.create("dave-job", "a", "c", { dstDomainId: "dave" });

		// A live waiter on the NON-targeted job must keep waiting (not settle).
		let daveSettled = false;
		store.waitForResult("dave-job", 60_000).then(() => {
			daveSettled = true;
		});

		store.expireByDomain("carol");
		// Let any erroneous microtask resolution flush.
		await Promise.resolve();

		expect(daveSettled).toBe(false);
		expect(store.has("dave-job")).toBe(true);
		// The still-waiting job can still be delivered normally.
		expect(store.deliver("dave-job", "ok")).not.toBe(false);
	});

	it("returns 0 when no job is bound to the Domain", () => {
		const store = new PendingJobStore<string>();
		store.create("local-job", "a", "b"); // local
		store.create("dave-job", "a", "c", { dstDomainId: "dave" });
		expect(store.expireByDomain("carol")).toBe(0);
		expect(store.has("local-job")).toBe(true);
		expect(store.has("dave-job")).toBe(true);
	});

	it("expires a stored (not-yet-polled) cross-Domain job too", () => {
		const store = new PendingJobStore<string>();
		// A persistent cross-Domain job that already received and stored a reply.
		store.create("carol-conv", "a", "b", { dstDomainId: "carol", persistent: true });
		store.deliver("carol-conv", "hello"); // async (channel) delivery -> stored
		expect(store.expireByDomain("carol")).toBe(1);
		expect(store.has("carol-conv")).toBe(false);
	});
});

////////////////////////////////
//  PendingJobStore.expireBySession
//
//  When a SINGLE session's share to a friend Domain is withdrawn (not the whole-Domain
//  unlink), only the jobs for that (session, friend) pair must be settled - other sessions
//  shared to the same friend, and the same session shared to another friend, keep waiting.
//  The match is on the job's own session-id target (the canonical gateway/name the share is
//  keyed by), since a destination job stores `entry.to` as the BARE local name.

describe("PendingJobStore.expireBySession", () => {
	// A destination job mirrors what gatewayRelay.handleOp + routes.send create for a
	// cross-Domain inbound send: the id is the origin-set canonical session key
	// (conv:<conv>:<thisGateway>/<name>), `to` is the BARE local name, and dstDomainId is the
	// verified sending friend Domain.
	const GW = "hostb";
	function destJob(store: PendingJobStore<string>, conv: string, name: string, friendDomain: string): string {
		const id = `conv:${conv}:${GW}/${name}`;
		store.create(id, "alice/app", name, { dstDomainId: friendDomain, persistent: true });
		return id;
	}

	it("expires ONLY the matching (session, friend) jobs; other sessions and friends survive", () => {
		const store = new PendingJobStore<string>();
		const libForAlice = destJob(store, "c1", "lib", "alice"); // the un-shared pair
		const docsForAlice = destJob(store, "c2", "docs", "alice"); // same friend, OTHER session
		const libForCarol = destJob(store, "c3", "lib", "carol"); // same session, OTHER friend

		// Un-share lib from alice: the share key is the canonical gateway/name.
		expect(store.expireBySession(`${GW}/lib`, "alice", GW)).toBe(1);

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

		const count = store.expireBySession(`${GW}/lib`, "alice", GW);
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
		expect(store.expireBySession(`${GW}/lib`, "alice", GW)).toBe(0);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(store.has(id)).toBe(true);
		expect(store.deliver(id, "ok")).not.toBe(false); // still deliverable
	});

	it("ignores a local / same-Domain job (dstDomainId null) for the same session name", () => {
		const store = new PendingJobStore<string>();
		// A local channel anchor for the same canonical session, no Domain binding.
		store.create(`conv:c1:${GW}/lib`, "x", "lib");
		expect(store.expireBySession(`${GW}/lib`, "alice", GW)).toBe(0);
		expect(store.has(`conv:c1:${GW}/lib`)).toBe(true);
	});

	it("returns 0 when no job matches", () => {
		const store = new PendingJobStore<string>();
		destJob(store, "c1", "lib", "alice");
		expect(store.expireBySession(`${GW}/ghost`, "alice", GW)).toBe(0);
		expect(store.expireBySession(`${GW}/lib`, "dave", GW)).toBe(0);
	});
});
