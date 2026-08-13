import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  The foreign-Gateway refusal has exactly one owner (consoleTargets.ts). A second parseTarget
//  call site in console/ is a second chance to fold a foreign address onto a same-named local
//  session, which is what merges two machines' boards under one header.

const CONSOLE_DIR = path.join(__dirname, "..", "gateway", "console");

describe("console target resolution residue", () => {
	it("parseTarget appears in consoleTargets.ts and nowhere else under console/", () => {
		const files = fs.readdirSync(CONSOLE_DIR).filter((f) => f.endsWith(".ts"));
		// Vacuity guard: a moved directory must fail loudly, not pass an empty scan.
		expect(files.length).toBeGreaterThan(3);
		expect(files).toContain("consoleTargets.ts");

		for (const file of files) {
			const content = fs.readFileSync(path.join(CONSOLE_DIR, file), "utf8");
			if (file === "consoleTargets.ts") {
				expect(content).toMatch(/\bparseTarget\b/);
			} else {
				expect(content, `${file} must resolve targets through consoleTargets.ts`).not.toMatch(
					/\bparseTarget\b/,
				);
			}
		}
	});
});
