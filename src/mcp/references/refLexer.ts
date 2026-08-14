////////////////////////////////
//  Interfaces & Types

/** A percent-escape lexes to a `char` holding its DECODED value, so an encoded colon is
 * structurally incapable of being a separator. Split-before-decode is a property of the type. */
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

/** For a token falling after the structural marker that won, which is ordinary text. */
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
 * A maximal run of `%XX`, decoded as one unit: one character can be several escapes, and
 * `decodeURIComponent("%E6")` throws.
 *
 * Null when undecodable, so the caller treats the bytes as literal. A lexer that throws is not total.
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

/** Total: every input lexes, so failure is the parser's job. Mode switches on the FIRST raw `#`, so
 * a matcher can search for a later one. */
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
				// Per DECODED character, so an astral character stays one unit.
				for (const decoded of run.text) push("char", decoded, i);
				i = run.end;
				continue;
			}
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
				// Exactly two is a range, so `#...args` searches for its own text.
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
