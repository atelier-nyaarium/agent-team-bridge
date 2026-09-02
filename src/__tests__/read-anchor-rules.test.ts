import { describe, expect, it } from "vitest";
import { MAX_TEAMS_PER_OWNER, mergeReadAnchor } from "../shared/read-anchor-rules.js";

const entry = (epoch: number, seq: number, at = 1) => ({ epoch, seq, at });

describe("read anchor rules", () => {
	it("accepts a newer sequence in the same epoch", () => {
		const result = mergeReadAnchor({ owner: { team: entry(1, 9) } }, "owner", "team", entry(1, 10));
		expect(result.advanced).toBe(true);
	});

	it("refuses an older sequence in the same epoch", () => {
		const result = mergeReadAnchor({ owner: { team: entry(1, 9) } }, "owner", "team", entry(1, 8));
		expect(result.advanced).toBe(false);
	});

	// mintEpoch draws at random, so a re-minted mailbox is as likely to draw a smaller number as a
	// larger one. Ordering the epochs as magnitudes stalled the anchor permanently for half of them.
	it("accepts a re-minted mailbox whose epoch is numerically smaller", () => {
		const result = mergeReadAnchor({ owner: { team: entry(900, 9, 5) } }, "owner", "team", entry(7, 0, 6));
		expect(result.advanced).toBe(true);
	});

	it("refuses a report older than the stored anchor across a re-mint", () => {
		const result = mergeReadAnchor({ owner: { team: entry(7, 0, 6) } }, "owner", "team", entry(900, 9, 5));
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
