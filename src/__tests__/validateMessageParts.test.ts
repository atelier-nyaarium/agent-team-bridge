import { describe, expect, it } from "vitest";
import { validateMessageParts } from "../gateway/discord/validateMessageParts.js";

describe(`validateMessageParts`, () => {
	describe(`valid cases`, () => {
		it(`accepts a single short message`, () => {
			const result = validateMessageParts({ parts: ["Hello world"] });
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.parts).toEqual(["Hello world"]);
			}
		});

		it(`accepts multiple parts all under limit`, () => {
			const result = validateMessageParts({ parts: ["Part one content", "Part two content"] });
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.parts).toEqual(["Part one content", "Part two content"]);
			}
		});

		it(`accepts an empty array`, () => {
			const result = validateMessageParts({ parts: [] });
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.parts).toEqual([]);
			}
		});

		it(`accepts a message exactly at maxLength - 1`, () => {
			const result = validateMessageParts({ parts: ["x".repeat(1999)] });
			expect(result.valid).toBe(true);
		});
	});

	describe(`invalid cases`, () => {
		it(`rejects a single long message with correct suggestedParts`, () => {
			const result = validateMessageParts({ parts: ["x".repeat(2500)], safeLength: 1800, retryCount: 0 });
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.totalLength).toBe(2500);
				expect(result.suggestedParts).toBe(Math.ceil(2500 / 1800) + 0 + 1);
				expect(result.violations).toEqual([{ index: 0, length: 2500 }]);
				expect(result.guidelines.length).toBeGreaterThan(0);
			}
		});

		it(`identifies the correct violating index among multiple parts`, () => {
			const result = validateMessageParts({ parts: ["short", "x".repeat(2100), "also short"] });
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.violations).toHaveLength(1);
				expect(result.violations[0].index).toBe(1);
				expect(result.violations[0].length).toBe(2100);
			}
		});

		it(`rejects a message exactly at maxLength`, () => {
			const result = validateMessageParts({ parts: ["x".repeat(2000)], maxLength: 2000 });
			expect(result.valid).toBe(false);
		});
	});

	describe(`suggestedParts calculation`, () => {
		it(`increments suggestedParts with retryCount`, () => {
			const text = "x".repeat(3600);
			const r0 = validateMessageParts({ parts: [text], retryCount: 0 });
			const r3 = validateMessageParts({ parts: [text], retryCount: 3 });

			expect(r0.valid).toBe(false);
			expect(r3.valid).toBe(false);
			if (!r0.valid && !r3.valid) {
				expect(r0.suggestedParts).toBe(Math.ceil(3600 / 1800) + 0 + 1);
				expect(r3.suggestedParts).toBe(Math.ceil(3600 / 1800) + 3 + 1);
				expect(r3.suggestedParts).toBe(r0.suggestedParts + 3);
			}
		});

		it(`respects custom safeLength in calculation`, () => {
			const result = validateMessageParts({ parts: ["x".repeat(2500)], safeLength: 500, retryCount: 0 });
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.suggestedParts).toBe(Math.ceil(2500 / 500) + 0 + 1);
			}
		});
	});

	describe(`custom limits`, () => {
		it(`respects custom maxLength`, () => {
			const result = validateMessageParts({ parts: ["x".repeat(100)], maxLength: 50 });
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.violations).toEqual([{ index: 0, length: 100 }]);
			}
		});
	});
});
