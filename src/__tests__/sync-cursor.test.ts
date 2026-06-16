import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SyncCursor } from "../shared/sync-cursor.js";

////////////////////////////////
//  SyncCursor transition vectors
//
//  vectors.json is read by BOTH this suite and SyncCursorVectorsTest.kt, so the
//  hand-authored Kotlin twin cannot drift from the TS source: a differing transition
//  fails one of the two runtimes.

interface CursorState {
	epoch: number;
	ackedSeq: number;
	droppedBaseline: number;
}
interface Vector {
	name: string;
	start: CursorState;
	pollResult: { entries: { seq: number }[]; cursor: number; epoch: number; dropped: number };
	expect: { next: CursorState; freshSeqs: number[]; gap: boolean };
}

const { vectors } = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/sync-cursor/vectors.json"), "utf8"),
) as { vectors: Vector[] };

describe("sync cursor vectors", () => {
	it.each(vectors.map((v) => [v.name, v] as const))("advance(%s)", (_, v) => {
		const start = SyncCursor.of(v.start.epoch, v.start.ackedSeq, v.start.droppedBaseline);
		const adv = start.advance(v.pollResult);
		expect(adv.next.epoch).toBe(v.expect.next.epoch);
		expect(adv.next.ackedSeq).toBe(v.expect.next.ackedSeq);
		expect(adv.next.droppedBaseline).toBe(v.expect.next.droppedBaseline);
		expect(adv.fresh.map((e) => e.seq)).toEqual(v.expect.freshSeqs);
		expect(adv.gap).toBe(v.expect.gap);
	});

	it("initial is the epoch-0 sentinel", () => {
		const c = SyncCursor.initial();
		expect(c.epoch).toBe(0);
		expect(c.ackedSeq).toBe(0);
		expect(c.droppedBaseline).toBe(0);
		expect(c.pollParams).toEqual({ cursor: 0, epoch: 0 });
	});

	it("pollParams is the cursor's ackedSeq + epoch", () => {
		expect(SyncCursor.of(42, 7, 3).pollParams).toEqual({ cursor: 7, epoch: 42 });
	});

	it("advance is pure: the original cursor is unchanged", () => {
		const c = SyncCursor.of(42, 7, 0);
		c.advance({ entries: [{ seq: 8 }], cursor: 8, epoch: 42, dropped: 0 });
		expect(c.ackedSeq).toBe(7);
	});
});
