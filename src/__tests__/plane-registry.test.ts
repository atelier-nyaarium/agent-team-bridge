import { describe, expect, it, vi } from "vitest";
import { processAmbient } from "../shared/ambient.js";
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
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const v = reg.version("presence");
		expect(v?.counter).toBe(0);
		expect(v?.epoch).toBeGreaterThan(0);
	});

	it("markDirty bumps the counter only when content actually changed", () => {
		let content = { x: 1 };
		const reg = new PlaneRegistry(processAmbient());
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
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({
			name: "presence",
			// identityOf deliberately ignores `churny` - the ambient-field exclusion, so ambient
			// timestamp-like fields never trigger a version bump (lastActive-class timestamps ride
			// the payload but not the identity).
			snapshot: () => ({ stable: "x", churny }),
			identityOf: (s) => stableHash({ stable: s.stable }),
		});
		const before = reg.version("presence");
		churny = 999;
		reg.markDirty("presence");
		expect(reg.version("presence")).toEqual(before);
	});

	it("changedSince reports behind, ahead, and unknown-epoch alike as changed", () => {
		const reg = new PlaneRegistry(processAmbient());
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
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const woke = await reg.waitForBump(new Map(), 5_000);
		expect(woke).toBe(true);
	});

	it("waitForBump resolves (true) when a later markDirty bumps the plane", async () => {
		let content = { x: 1 };
		const reg = new PlaneRegistry(processAmbient());
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

	it("lock-ordering: a waiter is registered before waitForBump ever yields, so a same-tick bump can never be lost", async () => {
		// The prior test's 10ms gap between registering and bumping would still pass even if a
		// regression inserted a yield point (an await, a setTimeout(0), a .then()) between
		// waitForBump's version-compare and its waiter registration - 10ms is plenty of time for a
		// deferred push to land first. This test instead bumps with ZERO delay, in the exact same
		// synchronous tick as the waitForBump() call itself (no await between them on the caller's
		// side either) - relying on `new Promise(executor)` running its executor synchronously, so
		// the waiter is already in `this.waiters` by the time waitForBump() returns control to this
		// line, before any bump can possibly race it. If a future change made waitForBump genuinely
		// async (or deferred the push via any microtask/macrotask), the waiter would not yet be
		// registered when markDirty runs here, and this test would fail.
		let content = { x: 1 };
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const presented = new Map([["presence", reg.version("presence")!]]);

		const wait = reg.waitForBump(presented, 5_000); // no await here - stays synchronous
		content = { x: 2 };
		reg.markDirty("presence"); // fires in the SAME tick, immediately after registration
		expect(await wait).toBe(true);
	});

	it("waitForBump resolves (false) on timeout when nothing changes", async () => {
		const reg = new PlaneRegistry(processAmbient());
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
		const reg = new PlaneRegistry(processAmbient());
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
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		reg.registerPlane({ name: "domain", snapshot: () => ({ y: 1 }), identityOf: stableHash });
		const changed = reg.changedSince(new Map([["domain", reg.version("domain")!]]));
		expect(changed).toEqual(["presence"]);
	});

	it("scope narrows changedSince/waitForBump to exactly the planes a caller is asking about", async () => {
		// A caller scoped to ONLY "linked-peers" must never see "presence"
		// (a different, ALSO-registered plane) reported as changed just because its own presented map
		// has no key for it - the exact false-positive a naive multi-plane poll handler hits once a
		// second plane joins a shared registry (see consoleHandler.ts's own presence+linked-peers split).
		let linkedPeersContent = { peers: ["alice"] };
		const reg = new PlaneRegistry(processAmbient());
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
		// Deliberate design (see PollWaitHub): "ahead" is never distinguished from
		// "behind" - any difference means "send current truth." A console can present a version
		// ahead of what its new route gateway currently holds after a federation failover.
		let content = { x: 1 };
		const reg = new PlaneRegistry(processAmbient());
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
		const reg = new PlaneRegistry(processAmbient());
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

	it("tripwireTick isolates a throwing plane - it never aborts the tick or escapes to the caller", () => {
		const reg = new PlaneRegistry(processAmbient());
		// Registration itself calls snapshotFn() once (to seed the initial hash), so it must succeed
		// there - only the LATER tripwire recompute should hit the throw, isolating this test to the
		// tripwire's own exception handling rather than construction's.
		let calls = 0;
		reg.registerPlane({
			name: "broken",
			snapshot: () => {
				calls += 1;
				if (calls > 1) throw new Error("boom - a bug in this plane's own derivation logic");
				return { x: 1 };
			},
			identityOf: stableHash,
		});
		let healthyContent = { x: 1 };
		reg.registerPlane({ name: "healthy", snapshot: () => healthyContent, identityOf: stableHash });
		const healthyBefore = reg.version("healthy")!;
		healthyContent = { x: 2 }; // an escaped write on the plane registered AFTER the broken one

		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => reg.tripwireTick()).not.toThrow(); // must never propagate to the setInterval caller
		expect(error).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.anything());
		// The plane registered AFTER the broken one still gets checked this same tick - one plane's
		// bug does not blind the tripwire to every plane that happens to iterate after it.
		expect(reg.version("healthy")?.counter).toBe(healthyBefore.counter + 1);
		error.mockRestore();
	});

	it("persistedState + restore: a clean shutdown preserves epoch and counter", () => {
		const regA = new PlaneRegistry(processAmbient());
		regA.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		regA.markDirty("presence");
		const persisted = regA.persistedState(true);
		expect(persisted.presence.cleanShutdown).toBe(true);

		const regB = new PlaneRegistry(processAmbient());
		regB.registerPlane(
			{ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash },
			persisted.presence,
		);
		expect(regB.version("presence")).toEqual(regA.version("presence"));
	});

	it("restore from a non-clean shutdown mints a fresh epoch, never trusting the counter lineage", () => {
		const regA = new PlaneRegistry(processAmbient());
		regA.registerPlane({ name: "presence", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const dirtyPersisted = regA.persistedState(false); // e.g. a regular 3s tick, not SIGTERM
		expect(dirtyPersisted.presence.cleanShutdown).toBe(false);

		const regB = new PlaneRegistry(processAmbient());
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
		const regBeforeExit = new PlaneRegistry(processAmbient());
		regBeforeExit.registerPlane({
			name: "presence",
			snapshot: () => ({ status: statusAtBoot }),
			identityOf: stableHash,
		});
		const persisted = regBeforeExit.persistedState(true);

		statusAtBoot = "available"; // the fresh process's live-derived truth differs
		const regAfterBoot = new PlaneRegistry(processAmbient());
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
		const regBeforeExit = new PlaneRegistry(processAmbient());
		regBeforeExit.registerPlane({ name: "presence", snapshot: () => content, identityOf: stableHash });
		const persisted = regBeforeExit.persistedState(true);

		const regAfterBoot = new PlaneRegistry(processAmbient());
		regAfterBoot.registerPlane(
			{ name: "presence", snapshot: () => content, identityOf: stableHash },
			persisted.presence,
		);
		const before = regAfterBoot.version("presence");
		regAfterBoot.reconcileOnBoot();
		expect(regAfterBoot.version("presence")).toEqual(before);
	});

	it("throws on a duplicate plane name", () => {
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "presence", snapshot: () => ({}), identityOf: stableHash });
		expect(() => reg.registerPlane({ name: "presence", snapshot: () => ({}), identityOf: stableHash })).toThrow();
	});

	it("onBump fires with the new version exactly when markDirty actually bumps, never on a no-op mark", () => {
		let content = { x: 1 };
		const bumps: Array<{ epoch: number; counter: number }> = [];
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({
			name: "presence",
			snapshot: () => content,
			identityOf: stableHash,
			onBump: (v) => bumps.push({ epoch: v.epoch, counter: v.counter }),
		});

		reg.markDirty("presence"); // dirty, but content unchanged - no bump, no onBump
		expect(bumps).toEqual([]);

		content = { x: 2 };
		reg.markDirty("presence");
		expect(bumps).toEqual([reg.version("presence")]);
	});

	it("onBump also fires from the tripwire's self-heal, not just markDirty", () => {
		let content = { x: 1 };
		const bumps: unknown[] = [];
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({
			name: "presence",
			snapshot: () => content,
			identityOf: stableHash,
			onBump: (v) => bumps.push(v),
		});
		content = { x: 2 }; // escaped write: markDirty never called
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		reg.tripwireTick();
		warn.mockRestore();
		expect(bumps).toEqual([reg.version("presence")]);
	});

	it("unregisterPlane drops the plane so a later operation on its name is a safe no-op", () => {
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "friend-a", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		reg.unregisterPlane("friend-a");
		expect(reg.version("friend-a")).toBeUndefined();
		expect(reg.hasPlane("friend-a")).toBe(false);
		expect(() => reg.markDirty("friend-a")).not.toThrow(); // no-op, not a throw
		expect(() => reg.unregisterPlane("friend-a")).not.toThrow(); // unregistering twice is also safe
	});

	it("unregisterPlane lets the SAME name be registered again afterward (a re-link)", () => {
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "friend-a", snapshot: () => ({ gen: 1 }), identityOf: stableHash });
		reg.unregisterPlane("friend-a");
		expect(() =>
			reg.registerPlane({ name: "friend-a", snapshot: () => ({ gen: 2 }), identityOf: stableHash }),
		).not.toThrow();
		expect(reg.version("friend-a")?.counter).toBe(0); // a genuinely fresh plane, not resurrected state
	});

	it("unregisterPlane settles an in-flight waitForBump waiter tracking the removed plane, as woken", async () => {
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "friend-a", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		const presented = new Map([["friend-a", reg.version("friend-a")!]]);

		let resolved: boolean | undefined;
		const held = reg.waitForBump(presented, 5_000).then((w) => {
			resolved = w;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined(); // still holding before the removal

		reg.unregisterPlane("friend-a");
		await held; // settled promptly, not left to time out
		expect(resolved).toBe(true);
	});

	it("unregisterPlane on an unrelated name never disturbs a waiter tracking a DIFFERENT, still-registered plane", async () => {
		const reg = new PlaneRegistry(processAmbient());
		reg.registerPlane({ name: "friend-a", snapshot: () => ({ x: 1 }), identityOf: stableHash });
		reg.registerPlane({ name: "friend-b", snapshot: () => ({ y: 1 }), identityOf: stableHash });
		const presented = new Map([["friend-b", reg.version("friend-b")!]]);
		// Scoped to ONLY friend-b - without a scope, friend-a's mere absence from `presented` would
		// already read as "changed" per changedSince's own documented no-scope behavior (see the
		// "without scope..." test above), unrelated to unregisterPlane entirely.
		const scope = new Set(["friend-b"]);

		let resolved: boolean | undefined;
		const held = reg.waitForBump(presented, 30, scope).then((w) => {
			resolved = w;
		});
		reg.unregisterPlane("friend-a"); // a different Domain's plane being torn down
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBeUndefined(); // friend-b's waiter must still be holding

		await held; // times out on its own, never falsely woken
		expect(resolved).toBe(false);
	});
});
