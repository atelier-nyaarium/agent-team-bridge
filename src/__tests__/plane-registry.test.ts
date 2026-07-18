import { describe, expect, it, vi } from "vitest";
import { PlaneRegistry, stableHash } from "../shared/plane-registry.js";

describe("stableHash", () => {
	it("is independent of plain-object key order", () => {
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
	});

	it("is sensitive to array order (arrays are not reordered)", () => {
		expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
	});

	it("distinguishes genuinely different content", () => {
		expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
	});
});

describe("PlaneRegistry", () => {
	it("starts at counter 0 with a fresh epoch when nothing is restored", () => {
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const v = reg.version("presence");
		expect(v?.counter).toBe(0);
		expect(v?.epoch).toBeGreaterThan(0);
	});

	it("markDirty bumps the counter only when content actually changed", () => {
		let content = { x: 1 };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const before = reg.version("presence");

		reg.markDirty("presence"); // dirty, but content unchanged
		expect(reg.version("presence")).toEqual(before);

		content = { x: 2 };
		reg.markDirty("presence");
		expect(reg.version("presence")?.counter).toBe((before?.counter ?? 0) + 1);
	});

	it("ambient fields excluded from identityOf never cause a bump", () => {
		let churny = 0;
		const reg = new PlaneRegistry();
		reg.registerPlane({
			name: "presence",
			// identityOf deliberately ignores `churny` - the ambient-field exclusion the plan
			// requires (lastActive-class timestamps ride the payload but not the identity).
			snapshot: () => ({ stable: "x", churny }),
			identityOf: (s) => stableHash({ stable: s.stable }),
		});
		const before = reg.version("presence");
		churny = 999;
		reg.markDirty("presence");
		expect(reg.version("presence")).toEqual(before);
	});

	it("changedSince reports behind, ahead, and unknown-epoch alike as changed", () => {
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const cur = reg.version("presence")!;

		expect(reg.changedSince(new Map())).toEqual(["presence"]); // unknown plane
		expect(reg.changedSince(new Map([["presence", cur]]))).toEqual([]); // caught up
		expect(reg.changedSince(new Map([["presence", { epoch: cur.epoch, counter: cur.counter - 1 }]]))).toEqual([
			"presence",
		]); // behind
		expect(reg.changedSince(new Map([["presence", { epoch: cur.epoch, counter: cur.counter + 1 }]]))).toEqual([
			"presence",
		]); // ahead - no special case, see PollWaitHub's "no ahead branch" design
		expect(reg.changedSince(new Map([["presence", { epoch: cur.epoch + 1, counter: cur.counter }]]))).toEqual([
			"presence",
		]); // different epoch
	});

	it("waitForBump resolves immediately (true) when already behind", async () => {
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const woke = await reg.waitForBump(new Map(), 5_000);
		expect(woke).toBe(true);
	});

	it("waitForBump resolves (true) when a later markDirty bumps the plane", async () => {
		let content = { x: 1 };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const presented = new Map([["presence", reg.version("presence")!]]);

		let resolved: boolean | undefined;
		const wait = reg.waitForBump(presented, 5_000).then((w) => {
			resolved = w;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined();

		content = { x: 2 };
		reg.markDirty("presence");
		await wait;
		expect(resolved).toBe(true);
	});

	it("waitForBump resolves (false) on timeout when nothing changes", async () => {
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const presented = new Map([["presence", reg.version("presence")!]]);
		const start = Date.now();
		const woke = await reg.waitForBump(presented, 30);
		expect(Date.now() - start).toBeGreaterThanOrEqual(25);
		expect(woke).toBe(false);
	});

	it("a multi-plane waiter holds only when caught up on every tracked plane, and wakes when any one changes", async () => {
		let presenceContent = { x: 1 };
		const domainContent = { y: 1 };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => presenceContent, identityOf: stableHash });
		reg.registerPlane({ name: "domain", snapshot: () => domainContent, identityOf: stableHash });

		// Presenting only "domain" (omitting the also-registered "presence") is itself already
		// behind, so this resolves at once via the fast path rather than holding.
		const partial = reg.waitForBump(new Map([["domain", reg.version("domain")!]]), 5_000);
		expect(await partial).toBe(true);

		// Fully caught up on both: this one genuinely holds.
		const full = new Map([
			["presence", reg.version("presence")!],
			["domain", reg.version("domain")!],
		]);
		let resolved: boolean | undefined;
		const held = reg.waitForBump(full, 5_000).then((w) => {
			resolved = w;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined();

		presenceContent = { x: 2 };
		reg.markDirty("presence"); // only presence changes; domain is untouched
		await held;
		expect(resolved).toBe(true);
	});

	it("without scope, changedSince/waitForBump treat every OTHER registered plane's absence from the presented map as changed too", () => {
		// Documents the behavior `scope` exists to opt out of (see the next test): a caller with no
		// scope asking about "domain" alone (caught up on it - the exact current version is
		// presented), on a registry that ALSO has "presence" registered, still gets "presence"
		// reported as changed - the bulk check has no way to tell "not tracked" apart from "unknown,
		// ship it" without a scope to say which planes it is even asking about.
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		reg.registerPlane({ name: "domain", snapshot: () => ({ y: 1 }), identityOf: stableHash });
		const changed = reg.changedSince(new Map([["domain", reg.version("domain")!]]));
		expect(changed).toEqual(["presence"]);
	});

	it("scope narrows changedSince/waitForBump to exactly the planes a caller is asking about", async () => {
		// The fix this test locks in: a caller scoped to ONLY "linked-peers" must never see "presence"
		// (a different, ALSO-registered plane) reported as changed just because its own presented map
		// has no key for it - the exact false-positive a naive multi-plane poll handler hits once a
		// second plane joins a shared registry (see consoleHandler.ts's own presence+linked-peers split).
		let linkedPeersContent = { peers: ["alice"] };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		reg.registerPlane({ name: "linked-peers", snapshot: () => linkedPeersContent, identityOf: stableHash });

		const scope = new Set(["linked-peers"]);
		// Caught up on linked-peers, and presenting NOTHING for presence - scoped out, so this must
		// hold rather than resolve immediately on presence's absence.
		const presented = new Map([["linked-peers", reg.version("linked-peers")!]]);
		expect(reg.changedSince(presented, scope)).toEqual([]);

		let resolved: boolean | undefined;
		const held = reg.waitForBump(presented, 5_000, scope).then((w) => {
			resolved = w;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined(); // still holding - presence bumping alone must not wake it

		reg.markDirty("presence"); // out of scope: must NOT wake the linked-peers-scoped waiter
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined();

		linkedPeersContent = { peers: ["alice", "bob"] }; // in scope: must wake it
		reg.markDirty("linked-peers");
		await held;
		expect(resolved).toBe(true);
	});

	it("a waiter presenting a version AHEAD of current still wakes on a bump - no special-casing", async () => {
		// Deliberate design (see PollWaitHub in the plan): "ahead" is never distinguished from
		// "behind" - any difference means "send current truth." A console can present a version
		// ahead of what its new route gateway currently holds after a federation failover.
		let content = { x: 1 };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const cur = reg.version("presence")!;
		const ahead = { epoch: cur.epoch, counter: cur.counter + 5 };

		const aheadWaiter = reg.waitForBump(new Map([["presence", ahead]]), 5_000);
		content = { x: 2 };
		reg.markDirty("presence");
		expect(await aheadWaiter).toBe(true);
	});

	it("tripwireTick catches and self-heals a mutation that never called markDirty", () => {
		let content = { x: 1 };
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const before = reg.version("presence")!;

		content = { x: 2 }; // escaped write: content changed, markDirty never called
		expect(reg.version("presence")).toEqual(before); // not yet caught

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		reg.tripwireTick();
		expect(reg.version("presence")?.counter).toBe(before.counter + 1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("presence"));
		warn.mockRestore();
	});

	it("persistedState + restore: a clean shutdown preserves epoch and counter", () => {
		const regA = new PlaneRegistry();
		regA.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		regA.markDirty("presence");
		const persisted = regA.persistedState(true);
		expect(persisted.presence.cleanShutdown).toBe(true);

		const regB = new PlaneRegistry();
		regB.registerPlane(
			{ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash },
			persisted.presence,
		);
		expect(regB.version("presence")).toEqual(regA.version("presence"));
	});

	it("restore from a non-clean shutdown mints a fresh epoch, never trusting the counter lineage", () => {
		const regA = new PlaneRegistry();
		regA.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const dirtyPersisted = regA.persistedState(false); // e.g. a regular 3s tick, not SIGTERM
		expect(dirtyPersisted.presence.cleanShutdown).toBe(false);

		const regB = new PlaneRegistry();
		regB.registerPlane(
			{ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash },
			dirtyPersisted.presence,
		);
		expect(regB.version("presence")?.counter).toBe(0);
		expect(regB.version("presence")?.epoch).not.toBe(regA.version("presence")?.epoch);
	});

	it("reconcileOnBoot bumps exactly once when live-derived content differs from the persisted hash", () => {
		// Simulates a session that was "online" at a clean SIGTERM (no socket survives the exit) and
		// reads "available" the instant the fresh process boots - a real content change, not a bug.
		let statusAtBoot = "online";
		const regBeforeExit = new PlaneRegistry();
		regBeforeExit.registerPlane({
			name: "presence",
			snapshot: () => ({ status: statusAtBoot }),
			identityOf: stableHash,
		});
		const persisted = regBeforeExit.persistedState(true);

		statusAtBoot = "available"; // the fresh process's live-derived truth differs
		const regAfterBoot = new PlaneRegistry();
		regAfterBoot.registerPlane(
			{ name: "presence", snapshot: () => ({ status: statusAtBoot }), identityOf: stableHash },
			persisted.presence,
		);
		const before = regAfterBoot.version("presence")!;
		regAfterBoot.reconcileOnBoot();
		expect(regAfterBoot.version("presence")?.counter).toBe(before.counter + 1);

		// A second reconcile with nothing further changed must NOT bump again.
		const afterOneBump = regAfterBoot.version("presence");
		regAfterBoot.reconcileOnBoot();
		expect(regAfterBoot.version("presence")).toEqual(afterOneBump);
	});

	it("reconcileOnBoot is a true no-op for a clean shutdown with nothing live (the cheap path stays free)", () => {
		const content = { status: "idle" };
		const regBeforeExit = new PlaneRegistry();
		regBeforeExit.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const persisted = regBeforeExit.persistedState(true);

		const regAfterBoot = new PlaneRegistry();
		regAfterBoot.registerPlane(
			{ name: "presence", snapshot: () => content, identityOf: stableHash },
			persisted.presence,
		);
		const before = regAfterBoot.version("presence");
		regAfterBoot.reconcileOnBoot();
		expect(regAfterBoot.version("presence")).toEqual(before);
	});

	it("throws on a duplicate plane name", () => {
		const reg = new PlaneRegistry();
		reg.registerPlane({ name: "presence", snapshot: () => ({}), identityOf: stableHash });
		expect(() => reg.registerPlane({ name: "presence", snapshot: () => ({}), identityOf: stableHash })).toThrow();
	});
});
