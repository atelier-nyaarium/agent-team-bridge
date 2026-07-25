import { describe, expect, it } from "vitest";
import { lex, tokensToText } from "../mcp/references/refLexer.js";

////////////////////////////////
//  Functions & Helpers

function kinds(input: string): string[] {
	return lex(input).map((t) => t.kind);
}

/** Every distinct string over the alphabet, up to a length, as an exhaustive small-input sweep. */
function* allStrings(alphabet: string[], maxLength: number): Generator<string> {
	let level = [""];
	for (let n = 0; n < maxLength; n++) {
		const next: string[] = [];
		for (const prefix of level) {
			for (const c of alphabet) {
				const s = prefix + c;
				yield s;
				next.push(s);
			}
		}
		level = next;
	}
}

////////////////////////////////
//  Tests

describe("what carries structure", () => {
	it("reads an encoded separator as a character, so it can never act as one", () => {
		expect(kinds("a%3Ab")).toEqual(["char", "char", "char"]);
		expect(kinds("a:b")).toEqual(["char", "sep", "char"]);
	});

	it("switches to fragment structure at the first hash, and treats a later one as text", () => {
		expect(kinds("a#b#c")).toEqual(["char", "hash", "char", "char", "char"]);
	});

	it("reads an at-sign as structure only in a fragment", () => {
		expect(kinds("a@b")).toEqual(["char", "char", "char"]);
		expect(kinds("#a@b")).toEqual(["hash", "char", "at", "char"]);
	});

	it("reads exactly two dots as a range, and any other run as text", () => {
		expect(kinds("#a..b")).toEqual(["hash", "char", "range", "char"]);
		expect(kinds("#a.b")).toEqual(["hash", "char", "char", "char"]);
		expect(kinds("#a...b")).toEqual(["hash", "char", "char", "char", "char", "char"]);
	});

	it("keeps dots ordinary in a path, where every filename has one", () => {
		expect(kinds("src/app.ts")).toEqual(Array(10).fill("char"));
	});
});

describe("decoding", () => {
	it("decodes a character spelled as several escapes as one character", () => {
		expect(tokensToText(lex("%E6%97%A5"))).toBe("日");
		expect(lex("%E6%97%A5")).toHaveLength(1);
	});

	it("decodes an astral character as one token, matching how a filename counts it", () => {
		expect(lex("%F0%9F%98%80")).toHaveLength(1);
	});

	it("treats an escape that decodes to nothing usable as literal text", () => {
		expect(tokensToText(lex("%ZZ"))).toBe("%ZZ");
		expect(tokensToText(lex("%"))).toBe("%");
		expect(tokensToText(lex("100%"))).toBe("100%");
	});
});

describe("the lexer is total", () => {
	// Totality is the property the parser's guarantees rest on: if lexing could fail, a malformed
	// ref could reach the parser as something other than tokens, and "every input is tokens" is what
	// makes the parser's error the ONLY way an input is rejected.
	const ALPHABET = ["%", "3", "A", ":", "#", ".", "@", "<", ">", " ", "a", "/"];

	it("turns every short input into tokens without throwing", () => {
		for (const input of allStrings(ALPHABET, 3)) {
			expect(() => lex(input), `threw on ${JSON.stringify(input)}`).not.toThrow();
		}
	});

	it("loses nothing: the tokens always spell the input back", () => {
		for (const input of allStrings(ALPHABET, 3)) {
			// An escape is the one lossy case by design, since it decodes; everything else must survive
			// verbatim, or the parser would be reasoning about characters the author did not write.
			if (input.includes("%")) continue;

			expect(tokensToText(lex(input)), `lost text from ${JSON.stringify(input)}`).toBe(input);
		}
	});

	it("gives every token an offset inside the input it came from", () => {
		for (const input of allStrings(ALPHABET, 3)) {
			for (const token of lex(input)) {
				expect(token.offset).toBeGreaterThanOrEqual(0);
				expect(token.offset).toBeLessThan(Math.max(1, input.length));
			}
		}
	});
});
