import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

// Duplicate definitions permit inconsistent fields.
const SRC = path.join(import.meta.dirname, "..");
const DEFINITION = /\b(?:const|let|var)\s+SealedEnvelopeSchema\b/;
const SHAPE = /\bephemeralPub\s*:/;
const OWNER = path.join("src", "shared", "crypto.ts");

function sources(): string[] {
	return filesUnder(SRC).filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));
}

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("sealed envelope schema ownership", () => {
	it("defines SealedEnvelopeSchema and its shape in one file", () => {
		const definitions: string[] = [];
		const shapes: string[] = [];
		for (const file of sources()) {
			const code = stripComments(readFileSync(file, "utf8"));
			if (DEFINITION.test(code)) definitions.push(file);
			if (SHAPE.test(code)) shapes.push(file);
		}
		expect(definitions.map((file) => path.relative(SRC, file))).toEqual([path.relative("src", OWNER)]);
		expect(shapes.map((file) => path.relative(SRC, file))).toEqual([path.relative("src", OWNER)]);
	});

	it("still recognizes the removed duplicate", () => {
		const planted = "export const SealedEnvelopeSchema = z.object({ ephemeralPub: z.string() });";
		expect(DEFINITION.test(planted)).toBe(true);
		expect(SHAPE.test(planted)).toBe(true);
	});
});
