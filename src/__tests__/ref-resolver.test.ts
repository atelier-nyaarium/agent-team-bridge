import { describe, expect, it } from "vitest";
import { parseRef } from "../mcp/references/refGrammar.js";
import { resolveRef } from "../mcp/references/refResolver.js";

////////////////////////////////
//  Functions & Helpers

async function resolve(filePath: string, text: string, uri: string) {
	const ref = parseRef(uri);
	if (!ref) throw new Error(`not a ref: ${uri}`);
	return resolveRef(filePath, text, ref);
}

/** The lines a resolution covers, so an assertion reads as the code the reader would see. */
function linesOf(text: string, r: { startLine: number; endLine: number }): string {
	return text
		.split("\n")
		.slice(r.startLine - 1, r.endLine)
		.join("\n");
}

////////////////////////////////
//  Tests

describe("resolving a scope chain", () => {
	it("opens a whole file for a bare path", async () => {
		const text = "const a = 1;\nconst b = 2;\n";

		expect(await resolve("a.ts", text, "ref://a.ts")).toMatchObject({ startLine: 1, endLine: 3, quality: "exact" });
	});

	it("finds a method through its class", async () => {
		const text = ["class Cart {", "\tadd(item) {", "\t\treturn item;", "\t}", "}", ""].join("\n");

		const r = await resolve("cart.js", text, "ref://cart.js:Cart:add");

		expect(linesOf(text, r)).toBe(["\tadd(item) {", "\t\treturn item;", "\t}"].join("\n"));
		expect(r.quality).toBe("exact");
	});

	it("reaches through anonymous nesting, so deep JavaScript needs no naming", async () => {
		const text = [
			"const MyComponent = () => {",
			"\tuseEffect(() => {",
			"\t\tconst handleSubmit = () => {",
			"\t\t\treturn 1;",
			"\t\t};",
			"\t});",
			"};",
			"",
		].join("\n");

		const r = await resolve("app.js", text, "ref://app.js:MyComponent:handleSubmit");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("const handleSubmit");
	});

	it("resolves the natural C++ spelling with double colons", async () => {
		const text = ["namespace A {", "namespace B {", "void method() {}", "}", "}", ""].join("\n");

		const r = await resolve("e.cpp", text, "ref://e.cpp:A::B::method");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toBe("void method() {}");
	});

	it("resolves a C++ out-of-line definition, which has no nested scopes to walk", async () => {
		const text = ["#include <a.h>", "", "void A::B::method() {", "\treturn;", "}", ""].join("\n");

		const r = await resolve("e.cpp", text, "ref://e.cpp:A::B::method");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("void A::B::method()");
	});

	it("resolves a C++17 compound namespace, one node answering a run of segments", async () => {
		const text = ["namespace A::B {", "void method() {}", "}", ""].join("\n");

		const r = await resolve("e.cpp", text, "ref://e.cpp:A::B::method");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toBe("void method() {}");
	});

	it("resolves a C# qualified namespace the same way", async () => {
		const text = ["namespace A.B {", "\tclass C {", "\t\tvoid Method() {}", "\t}", "}", ""].join("\n");

		const r = await resolve("e.cs", text, "ref://e.cs:A:B:C:Method");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toBe("\t\tvoid Method() {}");
	});

	it("resolves inside a C# file-scoped namespace, which has no body node", async () => {
		const text = ["namespace Foo;", "", "class Bar {", "\tvoid Baz() {}", "}", ""].join("\n");

		const r = await resolve("e.cs", text, "ref://e.cs:Foo:Bar:Baz");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toBe("\tvoid Baz() {}");
	});

	it("resolves a Python method", async () => {
		const text = ["class Cart:", "\tdef add(self, item):", "\t\treturn item", ""].join("\n");

		const r = await resolve("cart.py", text, "ref://cart.py:Cart:add");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("def add(self, item):");
	});

	it("resolves a GDScript inner class", async () => {
		const text = ["class Inner:", "\tfunc tick():", "\t\treturn 1", ""].join("\n");

		const r = await resolve("node.gd", text, "ref://node.gd:Inner:tick");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("func tick():");
	});

	it("resolves in a .tsx file, which the plain TypeScript grammar cannot parse", async () => {
		const text = [
			"export const App = () => {",
			"\tconst render = () => <div>{x}</div>;",
			"\treturn render();",
			"};",
			"",
		].join("\n");

		const r = await resolve("App.tsx", text, "ref://App.tsx:App:render");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("const render");
	});
});

describe("when several declarations answer", () => {
	it("continues through a re-opened namespace instead of failing", async () => {
		const text = ["namespace A { void first() {} }", "namespace A { void second() {} }", ""].join("\n");

		const r = await resolve("e.cpp", text, "ref://e.cpp:A:second");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("void second() {}");
	});

	it("continues through a C# partial class", async () => {
		const text = ["partial class C { void First() {} }", "partial class C { void Second() {} }", ""].join("\n");

		const r = await resolve("e.cs", text, "ref://e.cs:C:Second");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("void Second() {}");
	});

	it("takes the first in document order and says how many answered", async () => {
		const text = ["class C { void M() {} }", "class C { void M() {} }", ""].join("\n");

		const r = await resolve("e.cs", text, "ref://e.cs:C:M");

		expect(r.ambiguous).toBe(true);
		expect(r.matchCount).toBe(2);
		expect(r.startLine).toBe(1);
	});

	it("lets a compound-name branch finish even while a sibling branch consumed fewer segments", async () => {
		const text = [
			"namespace A::B { void method() {} }",
			"namespace A { namespace B { void other() {} } }",
			"",
		].join("\n");

		const r = await resolve("e.cpp", text, "ref://e.cpp:A::B::method");

		expect(r.quality).toBe("exact");
		expect(linesOf(text, r)).toContain("void method() {}");
	});
});

describe("the arguments pseudo-segment", () => {
	it("selects the parameter list of a function", async () => {
		const text = ["function fetchUser(url, retries) {", "\treturn url;", "}", ""].join("\n");

		const r = await resolve("api.js", text, "ref://api.js:fetchUser:arguments");

		expect(r.quality).toBe("exact");
		expect(r.startLine).toBe(1);
	});

	it("narrows to one named parameter", async () => {
		const text = ["function fetchUser(url, retries) {", "\treturn url;", "}", ""].join("\n");

		const r = await resolve("api.js", text, "ref://api.js:fetchUser:arguments:retries");

		expect(r.quality).toBe("exact");
		expect(r.startLine).toBe(1);
	});
});

describe("fragments", () => {
	const counter = ["function tick() {", "\tlet foo = 0;", "\tfoo += 1;", "\treset();", "\tfoo += 1;", "}", ""].join(
		"\n",
	);

	it("highlights the first match of a plain matcher", async () => {
		const r = await resolve("c.js", counter, "ref://c.js:tick#foo %2B= 1");

		expect(r.quality).toBe("exact");
		expect(r.span?.startLine).toBe(3);
	});

	it("picks the occurrence nearest before an anchor", async () => {
		const r = await resolve("c.js", counter, "ref://c.js:tick#foo %2B= 1@before:reset()");

		expect(r.quality).toBe("exact");
		expect(r.span?.startLine).toBe(3);
	});

	it("picks the occurrence nearest after an anchor", async () => {
		const r = await resolve("c.js", counter, "ref://c.js:tick#foo %2B= 1@after:reset()");

		expect(r.quality).toBe("exact");
		expect(r.span?.startLine).toBe(5);
	});

	it("spans a range from its first bound to its second", async () => {
		const r = await resolve("c.js", counter, "ref://c.js:tick#let foo..reset()");

		expect(r.quality).toBe("exact");
		expect(r.startLine).toBe(2);
		expect(r.endLine).toBe(4);
	});
});

describe("degrading instead of failing", () => {
	it("keeps the scope and says so when a matcher finds nothing", async () => {
		const text = ["function tick() {", "\treturn 1;", "}", ""].join("\n");

		const r = await resolve("c.js", text, "ref://c.js:tick#foo %2B= 1");

		expect(r.quality).toBe("fuzzy");
		expect(r.reason).toContain("foo += 1");
		expect(r.startLine).toBe(1);
		expect(r.span).toBeUndefined();
	});

	it("keeps the scope and names the anchor when the anchor is gone", async () => {
		const text = ["function tick() {", "\tfoo += 1;", "}", ""].join("\n");

		const r = await resolve("c.js", text, "ref://c.js:tick#foo %2B= 1@before:reset()");

		expect(r.quality).toBe("fuzzy");
		expect(r.reason).toContain("reset()");
	});

	it("opens at the range start when only the range end is gone", async () => {
		const text = ["function tick() {", "\tlet foo = 0;", "\treturn foo;", "}", ""].join("\n");

		const r = await resolve("c.js", text, "ref://c.js:tick#let foo..reset()");

		expect(r.quality).toBe("fuzzy");
		expect(r.startLine).toBe(2);
		expect(r.reason).toContain("reset()");
	});

	it("falls back to a text match when the enclosing scope was renamed", async () => {
		const text = ["class Basket {", "\tadd(item) {", "\t\treturn item;", "\t}", "}", ""].join("\n");

		const r = await resolve("cart.js", text, "ref://cart.js:Cart:add");

		expect(r.quality).toBe("fuzzy");
		expect(r.startLine).toBe(2);
		expect(r.reason).toContain("add");
	});

	it("opens the whole file when nothing in the chain survives", async () => {
		const text = ["class Basket {", "\tremove(item) {}", "}", ""].join("\n");

		const r = await resolve("cart.js", text, "ref://cart.js:Cart:add");

		expect(r.quality).toBe("unresolved");
		expect(r.startLine).toBe(1);
	});

	it("resolves a scope chain in a file no grammar parses, by text, rather than refusing", async () => {
		const text = ["# Notes", "", "## Deployment", "steps here", ""].join("\n");

		const r = await resolve("NOTES.md", text, "ref://NOTES.md:Deployment");

		expect(r.quality).toBe("fuzzy");
		expect(r.startLine).toBe(3);
	});
});
