import { describe, expect, it } from "vitest";
import { ReadAnchors, readAnchorsPlaneName } from "../gateway/readAnchors.js";
import { processAmbient } from "../shared/ambient.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { ReportReadSchema } from "../shared/schemasTier1.js";

describe("ReadAnchors", () => {
	it("the first report for a team always advances (nothing stored yet)", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 })).toBe(true);
		expect(anchors.snapshot()).toEqual({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
	});

	it("a higher seq within the same epoch advances", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 20, at: 2000 })).toBe(true);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 1, seq: 20, at: 2000 });
	});

	it("a LOWER seq within the same epoch never regresses the stored anchor", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 30, at: 6000 })).toBe(false);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 1, seq: 50, at: 5000 });
	});

	it("an EQUAL seq within the same epoch is not a genuine advance", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 50, at: 9000 })).toBe(false);
	});

	it("a re-minted mailbox wins with a low seq against a huge one", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 1, seq: 999, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 2, seq: 1, at: 6000 })).toBe(true);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 2, seq: 1, at: 6000 });
	});

	it("a numerically smaller epoch wins when its report is later", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 2, seq: 5, at: 5000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 999_999, at: 6000 })).toBe(true);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 1, seq: 999_999, at: 6000 });
	});

	it("a stale report loses across a re-mint whatever its epoch and seq", () => {
		const registry = new PlaneRegistry(processAmbient());
		const anchors = new ReadAnchors(registry, undefined);
		anchors.report("alice", "team-a", { epoch: 2, seq: 5, at: 6000 });
		expect(anchors.report("alice", "team-a", { epoch: 1, seq: 999_999, at: 5000 })).toBe(false);
		expect(anchors.snapshot().alice["team-a"]).toEqual({ epoch: 2, seq: 5, at: 6000 });
	});

	it("different teams and different owners are tracked independently", () => {
		const registry = new PlaneRegistry(processAmbient());
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
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			expect(registry.hasPlane(readAnchorsPlaneName("alice"))).toBe(false);
			anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
			expect(registry.hasPlane(readAnchorsPlaneName("alice"))).toBe(true);
			expect(registry.hasPlane(readAnchorsPlaneName("bob"))).toBe(false);
		});

		it("ensureRegistered is idempotent - a second call never throws", () => {
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			anchors.ensureRegistered("alice");
			expect(() => anchors.ensureRegistered("alice")).not.toThrow();
		});

		it("a genuine advance bumps the owner's OWN plane, never another owner's", () => {
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			anchors.ensureRegistered("alice");
			anchors.ensureRegistered("bob");
			const aliceBefore = registry.version(readAnchorsPlaneName("alice"));
			const bobBefore = registry.version(readAnchorsPlaneName("bob"));

			anchors.report("alice", "team-a", { epoch: 1, seq: 10, at: 1000 });
			registry.markDirty(readAnchorsPlaneName("alice"));

			expect(registry.version(readAnchorsPlaneName("alice"))?.counter).toBe((aliceBefore?.counter ?? 0) + 1);
			expect(registry.version(readAnchorsPlaneName("bob"))).toEqual(bobBefore);
		});

		it("a snapshot for one owner's plane never includes another owner's data", () => {
			const registry = new PlaneRegistry(processAmbient());
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
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			anchors.restore({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
			expect(anchors.snapshot()).toEqual({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
		});

		it("a malformed snapshot is ignored, starting empty rather than crashing boot", () => {
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			anchors.restore({ alice: { "team-a": { epoch: "not-a-number", seq: 10, at: 1000 } } });
			expect(anchors.snapshot()).toEqual({});
		});

		it("restoring a CLEAN-shutdown plane's version resumes its counter lineage on ensureRegistered", () => {
			const registry = new PlaneRegistry(processAmbient());
			const name = readAnchorsPlaneName("alice");
			const restoredPlanes = {
				[name]: { epoch: 777, counter: 3, hash: "irrelevant-for-this-test", cleanShutdown: true },
			};
			const anchors = new ReadAnchors(registry, restoredPlanes);
			anchors.restore({ alice: { "team-a": { epoch: 1, seq: 10, at: 1000 } } });
			anchors.ensureRegistered("alice");
			expect(registry.version(name)?.epoch).toBe(777);
			expect(registry.version(name)?.counter).toBe(3);
		});
	});

	describe("abuse hardening", () => {
		it("report_read's wire schema rejects an epoch outside the range a real device could ever mint", () => {
			const report = (epoch: number) => ({ kind: "report_read", team: "team-a", epoch, seq: 0, at: 0 });
			expect(ReportReadSchema.safeParse(report(0x7fffffff + 1)).success).toBe(false);
			expect(ReportReadSchema.safeParse(report(-1)).success).toBe(false);
			expect(ReportReadSchema.safeParse(report(0x7fffffff)).success).toBe(true);
		});

		it("report() refuses a genuinely NEW team beyond the per-owner cap, without disturbing already-tracked teams", () => {
			const registry = new PlaneRegistry(processAmbient());
			const anchors = new ReadAnchors(registry, undefined);
			for (let i = 0; i < 500; i++) {
				expect(anchors.report("alice", `team-${i}`, { epoch: 1, seq: 1, at: 1000 })).toBe(true);
			}
			expect(anchors.report("alice", "team-500", { epoch: 1, seq: 1, at: 1000 })).toBe(false);
			expect(anchors.snapshot().alice["team-500"]).toBeUndefined();
			expect(Object.keys(anchors.snapshot().alice)).toHaveLength(500);
			expect(anchors.report("alice", "team-0", { epoch: 1, seq: 2, at: 2000 })).toBe(true);
			expect(anchors.report("bob", "team-a", { epoch: 1, seq: 1, at: 1000 })).toBe(true);
		});
	});
});
