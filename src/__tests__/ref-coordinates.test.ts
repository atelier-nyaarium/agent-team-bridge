import { describe, expect, it } from "vitest";
import { linesOf, offsetOf, offsetsOf, spanAt, spanOf } from "../mcp/references/refCoordinates.js";

////////////////////////////////
//  Tests

const range = (sl: number, sc: number, el: number, ec: number) => ({
	start: { line: sl, character: sc },
	end: { line: el, character: ec },
});

describe("index ranges to console lines", () => {
	it("turns 0-based half-open lines into 1-based inclusive ones", () => {
		expect(linesOf(range(1, 0, 3, 5))).toEqual({ startLine: 2, endLine: 4 });
		expect(linesOf(range(0, 2, 0, 9))).toEqual({ startLine: 1, endLine: 1 });
	});

	it("closes on the previous line when the end sits at a line start", () => {
		expect(linesOf(range(1, 0, 4, 0))).toEqual({ startLine: 2, endLine: 4 });
		// A range that starts and ends at one line start still covers that line.
		expect(linesOf(range(2, 0, 2, 0))).toEqual({ startLine: 3, endLine: 3 });
	});

	it("keeps a span's columns 0-based and its lines 1-based", () => {
		expect(spanOf(range(4, 8, 4, 12))).toEqual({ startLine: 5, startColumn: 8, endLine: 5, endColumn: 12 });
	});
});

describe("positions to offsets in the decoded text", () => {
	it("counts a leading newline, a file without a trailing newline, offset 0 and the last line", () => {
		const text = "\nab\ncd";
		expect(offsetOf(text, { line: 0, character: 0 })).toBe(0);
		expect(offsetOf(text, { line: 1, character: 1 })).toBe(2);
		expect(offsetOf(text, { line: 2, character: 2 })).toBe(6);
		expect(offsetOf(text, { line: 9, character: 0 })).toBe(text.length);
		expect(offsetsOf(text, range(1, 0, 2, 2))).toEqual({ start: 1, end: 6 });
	});

	it("keeps CRLF inside the line, where the index counted it", () => {
		const text = "ab\r\ncd\r\n";
		expect(offsetOf(text, { line: 1, character: 0 })).toBe(4);
		expect(spanAt(text, 4, 2)).toEqual({ startLine: 2, startColumn: 0, endLine: 2, endColumn: 2 });
	});

	it("measures a span from an offset with 1-based lines and 0-based columns", () => {
		expect(spanAt("ab\ncd", 0, 2)).toEqual({ startLine: 1, startColumn: 0, endLine: 1, endColumn: 2 });
		expect(spanAt("ab\ncd", 3, 2)).toEqual({ startLine: 2, startColumn: 0, endLine: 2, endColumn: 2 });
	});

	it("reports column 0 at index 0 even when the file opens with a newline", () => {
		// lastIndexOf clamps a negative fromIndex to 0, so the leading newline used to be found as
		// though it preceded index 0, reporting column -1.
		expect(spanAt("\nab", 0, 1)).toEqual({ startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 });
	});
});
