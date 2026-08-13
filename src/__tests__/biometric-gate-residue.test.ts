import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  The owner-present rule has exactly one home (Biometric.kt's requireOwnerPresent). A second
//  prompt call site is a second place to decide the null-activity posture, which is how the gate
//  became copy-paste maintained. In the TS suite on purpose: the Kotlin tests run post-merge and
//  could not block a PR.

const KOTLIN_DIR = path.join(
	__dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

function kotlinFiles(dir: string): string[] {
	return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".kt"));
}

describe("biometric gate residue", () => {
	it("the prompt machinery lives in Biometric.kt and nowhere else", () => {
		const files = kotlinFiles(KOTLIN_DIR);
		// Vacuity guard: a moved tree must fail loudly, not pass an empty scan.
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain("Biometric.kt");

		for (const file of files) {
			const content = fs.readFileSync(path.join(KOTLIN_DIR, file), "utf8");
			if (file === "Biometric.kt") {
				expect(content).toMatch(/\brequireOwnerPresent\b/);
				expect(content).toMatch(/private suspend fun promptBiometric\b/);
			} else {
				expect(content, `${file} must gate through requireOwnerPresent`).not.toMatch(/\bpromptBiometric\b/);
				expect(content, `${file} must not hand-roll a BiometricPrompt`).not.toMatch(/\bBiometricPrompt\b/);
			}
		}
	});
});
