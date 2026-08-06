import { describe, expect, it } from "vitest";
import { isValidRank, RANK_MAX_LENGTH, rankBetween, rebalanceRanks } from "../shared/board-rank.js";

describe("rankBetween ordering", () => {
	it("a fresh list built by appending sorts in insertion order", () => {
		const ranks: string[] = [];
		for (let i = 0; i < 50; i++) ranks.push(rankBetween(ranks[ranks.length - 1], undefined));
		expect([...ranks].sort()).toEqual(ranks);
		for (const r of ranks) expect(isValidRank(r)).toBe(true);
	});

	it("a list built by prepending sorts in reverse insertion order", () => {
		const ranks: string[] = [];
		for (let i = 0; i < 50; i++) ranks.unshift(rankBetween(undefined, ranks[0]));
		expect([...ranks].sort()).toEqual(ranks);
	});

	it("dropping between any two neighbours lands strictly between them", () => {
		let ranks = rebalanceRanks(10);
		for (let pass = 0; pass < 3; pass++) {
			const next: string[] = [];
			for (let i = 0; i < ranks.length; i++) {
				next.push(ranks[i]);
				if (i + 1 < ranks.length) next.push(rankBetween(ranks[i], ranks[i + 1]));
			}
			expect([...next].sort()).toEqual(next);
			expect(new Set(next).size).toBe(next.length);
			ranks = next;
		}
	});

	it("refuses a gap that does not exist", () => {
		expect(() => rankBetween("m", "m")).toThrow();
		expect(() => rankBetween("n", "m")).toThrow();
	});

	it("same-gap insertion grows the key without bound and a rebalance resets the range", () => {
		let lo = rankBetween(undefined, undefined);
		const hi = rankBetween(lo, undefined);
		let inserts = 0;
		while (lo.length <= RANK_MAX_LENGTH && inserts < 2000) {
			lo = rankBetween(lo, hi);
			inserts++;
		}
		expect(lo.length).toBeGreaterThan(RANK_MAX_LENGTH);

		const rebalanced = rebalanceRanks(inserts + 2);
		for (const r of rebalanced) expect(r.length).toBeLessThanOrEqual(2);
	});
});

describe("rebalanceRanks", () => {
	it("yields sorted, unique, valid ranks at every size that matters", () => {
		// 3843 crosses the two-digit slot space and 5000 is the per-owner board cap: the counts at
		// which a width bug would mint over-long ranks and poison the durable file.
		for (const count of [1, 2, 3, 61, 62, 200, 1000, 3843, 5000]) {
			const ranks = rebalanceRanks(count);
			expect(ranks.length).toBe(count);
			expect([...ranks].sort()).toEqual(ranks);
			expect(new Set(ranks).size).toBe(count);
			for (const r of ranks) expect(isValidRank(r)).toBe(true);
		}
	});

	it("an empty or negative count yields nothing", () => {
		expect(rebalanceRanks(0)).toEqual([]);
		expect(rebalanceRanks(-1)).toEqual([]);
	});
});

describe("isValidRank", () => {
	it("rejects the shapes minting can never produce", () => {
		expect(isValidRank("")).toBe(false);
		expect(isValidRank("a0")).toBe(false);
		expect(isValidRank("m!")).toBe(false);
		expect(isValidRank("V".repeat(RANK_MAX_LENGTH + 1))).toBe(false);
		expect(isValidRank("V".repeat(RANK_MAX_LENGTH))).toBe(true);
	});
});
