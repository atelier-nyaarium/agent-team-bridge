import { describe, expect, it } from "vitest";
import { scanRefs } from "../mcp/references/refScanner.js";

////////////////////////////////
//  Functions & Helpers

function keys(body: string): string[] {
	return scanRefs(body).map((f) => f.key);
}

////////////////////////////////
//  Tests

describe("finding refs in a message", () => {
	it("finds a linked ref and reports the key it will be filed under", () => {
		const found = scanRefs("See [handleSubmit](ref://src/app.ts:App:handleSubmit) for the guard.");

		expect(found).toHaveLength(1);
		expect(found[0].key).toBe("ref://src/app.ts:App:handleSubmit");
		expect(found[0].ref.segments).toEqual(["App", "handleSubmit"]);
	});

	it("finds the angle-bracket destination form, which is how a path with spaces is written", () => {
		expect(keys("See [it](<ref://src/my file.ts:Foo>).")).toEqual(["ref://src/my%20file.ts:Foo"]);
	});

	it("keeps a link title out of the destination", () => {
		expect(keys('See [it](ref://src/app.ts:Foo "the submit handler").')).toEqual(["ref://src/app.ts:Foo"]);
	});

	it("reads several refs in one message, in the order written", () => {
		const body = "First [a](ref://a.ts:One), then [b](ref://b.ts:Two), then [c](ref://c.ts:Three).";

		expect(keys(body)).toEqual(["ref://a.ts:One", "ref://b.ts:Two", "ref://c.ts:Three"]);
	});

	it("charges nothing for repeating a ref, however it is spelled", () => {
		const body = "See [a](ref://x.cpp:A::B::run) and again [a](ref://x.cpp:A:B:run) and <ref://x.cpp:A::B::run>.";

		expect(keys(body)).toEqual(["ref://x.cpp:A:B:run"]);
	});

	it("ignores a ref that is not a link destination, so prose cannot attach files by accident", () => {
		expect(keys("The scheme looks like ref://src/app.ts:Foo in general.")).toEqual([]);
	});

	it("ignores a non-ref link", () => {
		expect(keys("See [the docs](https://example.com/app.ts) instead.")).toEqual([]);
	});
});

describe("refs written inside code", () => {
	it("ignores one inside a fenced block, so documenting the feature cannot fail a send", () => {
		const body = ["Write it like this:", "", "```md", "[label](ref://src/app.ts:Foo)", "```", ""].join("\n");

		expect(keys(body)).toEqual([]);
	});

	it("ignores one inside a tilde fence", () => {
		const body = ["~~~", "[label](ref://src/app.ts:Foo)", "~~~"].join("\n");

		expect(keys(body)).toEqual([]);
	});

	it("ignores one inside an inline code span", () => {
		expect(keys("Write `[label](ref://src/app.ts:Foo)` to link a symbol.")).toEqual([]);
	});

	it("still finds a real ref written after a fenced example", () => {
		const body = [
			"```md",
			"[label](ref://example.ts:Foo)",
			"```",
			"",
			"The real one is [here](ref://src/app.ts:Bar).",
		].join("\n");

		expect(keys(body)).toEqual(["ref://src/app.ts:Bar"]);
	});

	it("still finds a real ref written between two fenced examples", () => {
		const body = [
			"```",
			"[a](ref://one.ts:A)",
			"```",
			"Real: [b](ref://two.ts:B)",
			"```",
			"[c](ref://three.ts:C)",
			"```",
		].join("\n");

		expect(keys(body)).toEqual(["ref://two.ts:B"]);
	});

	it("treats a backtick run inside a fence as content, not as opening a span", () => {
		const body = ["```", "here is a ` stray backtick", "```", "Real: [b](ref://two.ts:B)"].join("\n");

		expect(keys(body)).toEqual(["ref://two.ts:B"]);
	});

	it("does not let an unclosed backtick swallow the rest of the message", () => {
		expect(keys("An unmatched ` backtick, then [b](ref://two.ts:B).")).toEqual(["ref://two.ts:B"]);
	});

	it("treats a shorter backtick run inside a longer span as content", () => {
		expect(keys("``a ` b [x](ref://one.ts:A)`` then [b](ref://two.ts:B).")).toEqual(["ref://two.ts:B"]);
	});

	it("does not close a fence on a shorter marker than the one that opened it", () => {
		const body = ["````", "```", "[a](ref://one.ts:A)", "````", "Real: [b](ref://two.ts:B)"].join("\n");

		expect(keys(body)).toEqual(["ref://two.ts:B"]);
	});
});

describe("stray backticks in ordinary prose", () => {
	it("does not let two unrelated backticks pair across a blank line and swallow a real ref", () => {
		const body = [
			"Note: this uses `template strings for config.",
			"",
			"See [handler](ref://src/app.ts:handleSubmit) for details, all good` right.",
		].join("\n");

		expect(keys(body)).toEqual(["ref://src/app.ts:handleSubmit"]);
	});

	it("still masks a real code span that opens and closes inside one paragraph", () => {
		expect(keys("Write `[x](ref://a.ts:A)` like so, then [b](ref://b.ts:B).")).toEqual(["ref://b.ts:B"]);
	});
});

describe("destinations with parentheses", () => {
	it("keeps a fragment naming a call, rather than truncating at the paren", () => {
		expect(keys("[r](ref://c.js:tick#reset())")).toEqual(["ref://c.js:tick#reset()"]);
	});

	it("keeps an anchor naming a call", () => {
		const found = scanRefs("[r](ref://c.js:tick#foo@after:reset())");

		expect(found[0].ref.matcher).toEqual({ kind: "after", text: "foo", anchor: "reset()" });
	});
});
