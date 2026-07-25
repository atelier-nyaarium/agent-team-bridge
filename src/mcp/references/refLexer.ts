////////////////////////////////
//  Interfaces & Types

/**
 * What a ref is made of.
 *
 * `char` is the load-bearing one: a percent-escape lexes to a `char` carrying its DECODED value, so
 * an encoded colon is structurally incapable of being a separator. "Split before decode" stops
 * being an ordering rule someone has to remember and becomes a property of the token type.
 */
export type TokenKind = "sep" | "hash" | "range" | "at" | "char";

export interface Token {
	kind: TokenKind;
	/** The decoded character, for `char`. Empty for structural tokens. */
	value: string;
	/** Offset into the lexed input, so a parse error can point at it. */
	offset: number;
}

/** Which characters carry structure. The scope runs up to the first raw `#`; the fragment follows. */
export type LexMode = "scope" | "fragment";

////////////////////////////////
//  Functions & Helpers

const HEX = /^[0-9a-fA-F]{2}$/;

/** The literal text a token stands for, used when a token falls after the structural marker that
 * won and therefore counts as ordinary text. */
export function tokenText(token: Token): string {
	switch (token.kind) {
		case "sep":
			return ":";
		case "hash":
			return "#";
		case "range":
			return "..";
		case "at":
			return "@";
		case "char":
			return token.value;
	}
}

export function tokensToText(tokens: Token[]): string {
	return tokens.map(tokenText).join("");
}

/**
 * Consume a maximal run of `%XX` escapes and decode it as one unit.
 *
 * Decoding escapes one at a time would corrupt every non-ASCII path, because a single character
 * arrives as several escapes (`%E6%97%A5` is one ideograph, and `decodeURIComponent("%E6")` throws).
 * Returns null when the run is not decodable, so the caller can treat the bytes as literal rather
 * than failing: a lexer that throws is not total.
 */
function readEscapeRun(input: string, start: number): { text: string; end: number } | null {
	let end = start;
	while (end + 2 < input.length + 1 && input[end] === "%" && HEX.test(input.slice(end + 1, end + 3))) {
		end += 3;
	}
	if (end === start) return null;

	try {
		return { text: decodeURIComponent(input.slice(start, end)), end };
	} catch {
		return null;
	}
}

/** How many `.` characters run from `start`. */
function dotRun(input: string, start: number): number {
	let end = start;
	while (input[end] === ".") end++;
	return end - start;
}

/**
 * Turn a ref body into tokens. Total: every input lexes, so failure is the parser's job alone.
 *
 * Mode switches to `fragment` on the FIRST raw `#`; a later one is ordinary text, which is what
 * lets a matcher search for a `#`.
 */
export function lex(input: string): Token[] {
	const tokens: Token[] = [];
	let mode: LexMode = "scope";
	let i = 0;

	const push = (kind: TokenKind, value: string, offset: number) => tokens.push({ kind, value, offset });

	while (i < input.length) {
		const c = input[i];

		if (c === "%") {
			const run = readEscapeRun(input, i);
			if (run) {
				// One token per DECODED character, never per escape, so an astral character stays one
				// unit and a multi-escape sequence cannot be mistaken for several.
				for (const decoded of run.text) push("char", decoded, i);
				i = run.end;
				continue;
			}
			// A `%` that introduces nothing decodable is a literal percent.
			push("char", "%", i);
			i++;
			continue;
		}

		if (c === ":") {
			push("sep", "", i);
			i++;
			continue;
		}

		if (c === "#" && mode === "scope") {
			push("hash", "", i);
			mode = "fragment";
			i++;
			continue;
		}

		if (mode === "fragment") {
			if (c === "@") {
				push("at", "", i);
				i++;
				continue;
			}
			if (c === ".") {
				// Exactly two dots is a range. One is ordinary, and three or more is a spread or a
				// variadic, so `#...args` searches for that text instead of parsing as a broken range.
				const run = dotRun(input, i);
				if (run === 2) {
					push("range", "", i);
				} else {
					for (let n = 0; n < run; n++) push("char", ".", i + n);
				}
				i += run;
				continue;
			}
		}

		push("char", c, i);
		i++;
	}

	return tokens;
}
