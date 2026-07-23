import { describe, expect, it } from "vitest";
// markdown-lazy-blockquote.js is a plain classic <script> in the browser (thread.html loads it
// before thread.js - see its own header comment for why it cannot use ESM export syntax there), but
// it also assigns to `module.exports` under Bun/Node, so the default import works here same as any
// other CommonJS module.
// @ts-expect-error - plain JS, no .d.ts
import breakLazyBlockquoteContinuations from "../../android/app/src/main/assets/thread/markdown-lazy-blockquote.js";

describe("breakLazyBlockquoteContinuations", () => {
	it("separates a plain line that immediately follows a quoted line with no blank line", () => {
		const input = "> Quoted sentence\nNon quoted sentence that gets quoted";
		expect(breakLazyBlockquoteContinuations(input)).toBe(
			"> Quoted sentence\n\nNon quoted sentence that gets quoted",
		);
	});

	it("leaves an already blank-line-separated quote and paragraph untouched", () => {
		const input = "> Quoted sentence\n\nNon quoted sentence";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});

	it("leaves consecutive quoted lines untouched (both start with >)", () => {
		const input = "> Line one\n> Line two";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});

	it("does not touch a plain paragraph with no blockquote involved", () => {
		const input = "Line one\nLine two\nLine three";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});

	it("never inserts a blank line inside a fenced code block, even if a line starts with >", () => {
		const input = "```\n> not a real quote, just diff-looking text\nplain line\n```";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});

	it("still fixes a real lazy continuation that follows a closed fence", () => {
		const input = "```\n> inside fence\n```\n> Quoted\nfollowing line";
		expect(breakLazyBlockquoteContinuations(input)).toBe("```\n> inside fence\n```\n> Quoted\n\nfollowing line");
	});

	it("handles a ~~~ fence the same as a ``` fence", () => {
		const input = "~~~\n> not a real quote\n~~~";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});

	it("does not insert a blank line before another blank line or end of input", () => {
		const input = "> Quoted\n";
		expect(breakLazyBlockquoteContinuations(input)).toBe(input);
	});
});
