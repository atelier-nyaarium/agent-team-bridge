import { describe, expect, it } from "vitest";
import { ReadAnchors, readAnchorsPlaneName } from "../gateway/readAnchors.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

describe("ReadAnchors", () => {
	it("the first report for a team always advances (nothing stored yet)", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 })).toBe(true);
		expect(anchors.snapshot()).toEqual({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
	});

	it("a higher seq within the same epoch advances", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 20, at: 2000 })).toBe(true);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 1, seq: 20, at: 2000 });
	});

	it("a LOWER seq within the same epoch never regresses the stored anchor", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 5000 });
		// A second, slower device reports its own older position a moment later.
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 30, at: 6000 })).toBe(false);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 1, seq: 50, at: 5000 });
	});

	it("an EQUAL seq within the same epoch is not a genuine advance", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 9000 })).toBe(false);
	});

	it("a newer epoch always wins outright, regardless of seq (the mailbox was reset)", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 999, at: 5000 });
		// A fresh mailbox epoch starts its own seq numbering from scratch - even seq:1 there wins.
		expect(anchors.report("alice", "team-a", { epoch: 2, seq: 1, at: 6000 })).toBe(true);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 2, seq: 1, at: 6000 });
	});

	it("an OLDER epoch never wins, even with a huge seq", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 2, seq: 5, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 999_999, at: 6000 })).toBe(false);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 2, seq: 5, at: 5000 });
	});

	it("different teams and different owners are tracked independently", () => {
		const registry = new PlaneRegistry();
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
		anchors.report("alice", "team-b", { epoch: 1, seq: 5, at: 1000 });
		anchors.report("bob", "team-a", { epoch: 1, seq: 999, at: 1000 });
		expect(anchors.snapshot()).toEqual({
			alice: { "team-a": { epoch: 1, seq: 10, at: 1000 }, "team-b": { epoch: 1, seq: 5, at: 1000 } },
			bob: { "team-a": { epoch: 1, seq: 999, at: 1000 } },
		});
	});

	describe("plane registration (per owner, never a single Gateway-wide plane)", () => {
		it("report() registers the owner's own plane on first use", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			expect(registry.hasPlane(readAnchorsPlaneName("alice"))).toBe(false);
			anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
			expect(registry.hasPlane(readAnchorsPlaneName("alice"))).toBe(true);
			expect(registry.hasPlane(readAnchorsPlaneName("bob"))).toBe(false);
		});

		it("ensureRegistered is idempotent - a second call never throws", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			anchors.ensureRegistered("alice");
			expect(() => anchors.ensureRegistered("alice")).not.toThrow();
		});

		it("a genuine advance bumps the owner's OWN plane, never another owner's", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			anchors.ensureRegistered("alice");
			anchors.ensureRegistered("bob");
			const aliceBefore = registry.version(readAnchorsPlaneName("alice"));
			const bobBefore = registry.version(readAnchorsPlaneName("bob"));

			anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
			registry.markDirty(readAnchorsPlaneName("alice")); // the caller's own responsibility, mirroring consoleHandler.ts

			expect(registry.version(readAnchorsPlaneName("alice"))?.counter).toBe((aliceBefore?.counter ?? 0) + 1);
			expect(registry.version(readAnchorsPlaneName("bob"))).toEqual(bobBefore); // untouched
		});

		it("a snapshot for one owner's plane never includes another owner's data", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
			anchors.report("bob", "team-a", { epoch: 1, seq: 999, at: 1000 });
			expect(registry.snapshot(readAnchorsPlaneName("alice"))).toEqual([
				{ team: "team-a", epoch: 1, seq: 10, at: 1000 },
			]);
			expect(registry.snapshot(readAnchorsPlaneName("bob"))).toEqual([
				{ team: "team-a", epoch: 1, seq: 999, at: 1000 },
			]);
		});
	});

	describe("restore", () => {
		it("restores a well-formed snapshot", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			anchors.restore({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
			expect(anchors.snapshot()).toEqual({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
		});

		it("a malformed snapshot is ignored, starting empty rather than crashing boot", () => {
			const registry = new PlaneRegistry();
			const anchors = new ReadAnchors(registry, undefined);
			anchors.restore({ alice: { "team-a": { epoch: "not-a-number", seq: 10, at: 1000 } } });
			expect(anchors.snapshot()).toEqual({});
		});

		it("restoring a CLEAN-shutdown plane's version resumes its counter lineage on ensureRegistered", () => {
			const registry = new PlaneRegistry();
			const name = readAnchorsPlaneName("alice");
			const restoredPlanes = {
				[name]: { epoch: 777, counter: 3, hash: "irrelevant-for-this-test", cleanShutdown: true },
			};
			const anchors = new ReadAnchors(registry, restoredPlanes);
			anchors.restore({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
			anchors.ensureRegistered("alice");
			// Restored epoch/counter carried through, not reset to a fresh mint.
			expect(registry.version(name)?.epoch).toBe(777);
			expect(registry.version(name)?.counter).toBe(3);
		});
	});
});
