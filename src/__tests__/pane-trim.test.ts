import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { trimPaneRowPadding } from "../shared/pane-trim.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

interface Vector {
	name: string;
	input: string;
	expectText: string;
}

const vectors: Vector[] = JSON.parse(
	readFileSync(new URL("../../tests/fixtures/pane-trim/vectors.json", import.meta.url), "utf8"),
).vectors;

/** Every escape removed, which is what the Kotlin twin's runs concatenate to. CSI and OSC both go:
 * the console's parser skips an OSC whole, so its payload is not text on either side. */
function textOf(ansi: string): string {
	let out = "";
	let i = 0;
	while (i < ansi.length) {
		if (ansi[i] === ESC && ansi[i + 1] === "[") {
			let j = i + 2;
			while (j < ansi.length && ansi[j] < "@") j++;
			i = j + 1;
			continue;
		}
		if (ansi[i] === ESC && ansi[i + 1] === "]") {
			let j = i + 2;
			while (j < ansi.length) {
				if (ansi[j] === BEL) {
					j++;
					break;
				}
				if (ansi[j] === ESC && ansi[j + 1] === "\\") {
					j += 2;
					break;
				}
				j++;
			}
			i = j;
			continue;
		}
		if (ansi[i] === ESC) {
			i++;
			continue;
		}
		out += ansi[i];
		i++;
	}
	return out;
}

// The corpus is the shared half: PaneTrimVectorsTest.kt drives the console's trimLineEnds through
// the same rows, so the two implementations of this rule cannot drift apart unnoticed.
describe("trimPaneRowPadding: the cross-runtime corpus", () => {
	it("has vectors to run", () => {
		expect(vectors.length).toBeGreaterThan(0);
	});

	for (const v of vectors) {
		it(v.name, () => {
			expect(textOf(trimPaneRowPadding(v.input))).toBe(v.expectText);
		});
	}
});

// The byte-level half, which is TS-only: the Kotlin twin returns styled runs and has no equivalent
// promise to make about escapes.
describe("trimPaneRowPadding: what only the capture side promises", () => {
	it("removes space bytes and never an escape", () => {
		// The escapes among the dropped spaces stay put, so the colour state the next row inherits is
		// byte-identical to what tmux emitted.
		expect(trimPaneRowPadding(`x${ESC}[31m   ${ESC}[0m\n`)).toBe(`x${ESC}[31m${ESC}[0m\n`);
	});

	it("is idempotent, which is what lets the console run the same rule again", () => {
		const once = trimPaneRowPadding(`a   \n${ESC}[44mb   ${ESC}[0m\nc   \n`);
		expect(trimPaneRowPadding(once)).toBe(once);
	});

	it("returns the very same string when there is nothing to drop, so a hash does not churn", () => {
		const frame = `${ESC}[32m❯${ESC}[0m ready\n${ESC}[7m footer ${ESC}[0m\n`;
		expect(trimPaneRowPadding(frame)).toBe(frame);
	});

	it("handles an empty capture", () => {
		expect(trimPaneRowPadding("")).toBe("");
	});
});
