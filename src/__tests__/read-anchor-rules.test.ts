import { describe, expect, it } from "vitest";
import { MAX_TEAMS_PER_OWNER, mergeReadAnchor } from "../shared/read-anchor-rules.js";

const entry = (epoch: number, seq: number) => ({ epoch, seq, at: 1 });

describe("read anchor rules", () => {
	it("accepts a newer epoch", () => {
		const result = mergeReadAnchor({ owner: { team: entry(1, 9) } }, "owner", "team", entry(2, 0));
		expect(result.advanced).toBe(true);
	});

	it("accepts a newer sequence in the same epoch", () => {
		const result = mergeReadAnchor({ owner: { team: entry(1, 9) } }, "owner", "team", entry(1, 10));
		expect(result.advanced).toBe(true);
	});

	it("refuses an older position", () => {
		const result = mergeReadAnchor({ owner: { team: entry(2, 0) } }, "owner", "team", entry(1, 9));
		expect(result.advanced).toBe(false);
	});

	it("caps only a new team", () => {
		const shares = Object.fromEntries(
			Array.from({ length: MAX_TEAMS_PER_OWNER }, (_, i) => [`team-${i}`, entry(1, 0)]),
		);
		const existing = mergeReadAnchor({ owner: shares }, "owner", "team-0", entry(1, 1));
		const added = mergeReadAnchor(existing.state, "owner", "new-team", entry(1, 0));
		expect(existing.advanced).toBe(true);
		expect(added.advanced).toBe(false);
	});
});
