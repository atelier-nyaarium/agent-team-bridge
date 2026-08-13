import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  BoardOps is the only door to BoardManager. A second reacher can hold BoardOps' resolver answer
//  and ask BoardManager the question, observe one's revision while querying the other, or read an
//  entry from one and hand it back to the other's ABSOLUTE setter - a lost update on a write that
//  cannot be merged.

const ANDROID_SRC = path.join(__dirname, "..", "..", "android", "app", "src");
const DOOR = "BoardOps.kt";
// ChatRepository declares the BoardManager instance; the door reaches it through that name.
const DECLARER = "ChatRepository.kt";

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** Kotlin source with comments and string literals stripped, so prose naming the door cannot trip
 * the match and a log line cannot satisfy the guard that the door still reaches. */
function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe("board door residue", () => {
	it("only BoardOps reaches the BoardManager instance", () => {
		const files = kotlinFiles(ANDROID_SRC);
		// Vacuity guard: a moved source root must fail loudly, not pass an empty scan.
		expect(files.length).toBeGreaterThan(50);
		expect(files.some((f) => path.basename(f) === DOOR)).toBe(true);

		const reachers = files.filter((f) => /\brepo\.board\./.test(code(f))).map((f) => path.basename(f));
		expect(new Set(reachers)).toEqual(new Set([DOOR]));
	});

	it("the door actually reaches it, so the rule cannot pass by everyone giving up", () => {
		const door = kotlinFiles(ANDROID_SRC).find((f) => path.basename(f) === DOOR);
		expect(door).toBeDefined();
		expect(code(door as string)).toMatch(/\brepo\.board\./);
	});

	it("ChatRepository still declares the instance the door reaches", () => {
		const declarer = kotlinFiles(ANDROID_SRC).find((f) => path.basename(f) === DECLARER);
		expect(declarer).toBeDefined();
		expect(code(declarer as string)).toMatch(/\bval board\b/);
	});
});
