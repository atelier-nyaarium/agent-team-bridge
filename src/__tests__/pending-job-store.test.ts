import { describe, expect, it } from "vitest";
import { processAmbient } from "../shared/ambient.js";
import { PendingJobStore, type WaitResult } from "../shared/pending-job-store.js";
import { Address, storeKey } from "../shared/session-id.js";

const DOMAIN = "bob";
const GW = "hostb";

function convKey(conv: string, spawn: string, session = "dev"): string {
	return storeKey({ kind: "conv", conversationId: conv, address: Address.of(DOMAIN, GW, spawn, session) });
}

function sessionTarget(spawn: string, session = "dev"): string {
	return Address.of(DOMAIN, GW, spawn, session).canonical;
}

// Domain expiry leaves unrelated jobs untouched.
describe("PendingJobStore.expireByDomain", () => {
	it("notifies only for cross-Domain job lifecycle changes", () => {
		let changes = 0;
		const store = new PendingJobStore<string>(600_000, processAmbient(), () => changes++);
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
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol1 = convKey("c1", "lib");
		const carol2 = convKey("c2", "docs");
		const dave1 = convKey("c3", "app");
		const local1 = convKey("c4", "tools");
		store.create(carol1, "a", "b", { dstDomainId: "carol" });
		store.create(carol2, "a", "c", { dstDomainId: "carol" });
		store.create(dave1, "a", "d", { dstDomainId: "dave" });
		store.create(local1, "a", "e");

		expect(store.expireByDomain("carol")).toBe(2);

		expect(store.has(carol1)).toBe(false);
		expect(store.has(carol2)).toBe(false);
		expect(store.has(dave1)).toBe(true);
		expect(store.has(local1)).toBe(true);
	});

	it("settles the waiting promise with a clear expiry error", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
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
		const store = new PendingJobStore<string>(600_000, processAmbient());
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
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		store.create(carol, "a", "b", { dstDomainId: "carol" });
		store.create(dave, "a", "c", { dstDomainId: "dave" });

		let daveSettled = false;
		store.waitForResult(dave, 60_000).then(() => {
			daveSettled = true;
		});

		store.expireByDomain("carol");
		await Promise.resolve();

		expect(daveSettled).toBe(false);
		expect(store.has(dave)).toBe(true);
		expect(store.deliver(dave, "ok")).not.toBe(false);
	});

	it("returns 0 when no job is bound to the Domain", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const local1 = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		store.create(local1, "a", "b");
		store.create(dave, "a", "c", { dstDomainId: "dave" });
		expect(store.expireByDomain("carol")).toBe(0);
		expect(store.has(local1)).toBe(true);
		expect(store.has(dave)).toBe(true);
	});

	it("expires a stored (not-yet-polled) cross-Domain job too", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carolConv = convKey("c1", "lib");
		store.create(carolConv, "a", "b", { dstDomainId: "carol", persistent: true });
		store.deliver(carolConv, "hello");
		expect(store.expireByDomain("carol")).toBe(1);
		expect(store.has(carolConv)).toBe(false);
	});
});

// Session expiry matches canonical address and friend Domain.
describe("PendingJobStore.expireBySession", () => {
	function destJob(store: PendingJobStore<string>, conv: string, spawn: string, friendDomain: string): string {
		const id = convKey(conv, spawn);
		store.create(id, "alice.app", spawn, { dstDomainId: friendDomain, persistent: true });
		return id;
	}

	it("expires ONLY the matching (session, friend) jobs; other sessions and friends survive", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const libForAlice = destJob(store, "c1", "lib", "alice");
		const docsForAlice = destJob(store, "c2", "docs", "alice");
		const libForCarol = destJob(store, "c3", "lib", "carol");

		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(1);

		expect(store.has(libForAlice)).toBe(false);
		expect(store.has(docsForAlice)).toBe(true);
		expect(store.has(libForCarol)).toBe(true);
	});

	it("settles a waiting reply for the un-shared session with a clear reason", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
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
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = destJob(store, "c1", "lib", "carol");

		let settled = false;
		store.waitForResult(id, 60_000).then(() => {
			settled = true;
		});

		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(store.has(id)).toBe(true);
		expect(store.deliver(id, "ok")).not.toBe(false);
	});

	it("ignores a local / same-Domain job (dstDomainId null) for the same session name", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const local = convKey("c1", "lib");
		store.create(local, "x", "lib");
		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		expect(store.has(local)).toBe(true);
	});

	it("returns 0 when no job matches", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		destJob(store, "c1", "lib", "alice");
		expect(store.expireBySession(sessionTarget("ghost"), "alice")).toBe(0);
		expect(store.expireBySession(sessionTarget("lib"), "dave")).toBe(0);
	});
});
