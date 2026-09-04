import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  BoardOps is the only door to BoardManager; the repository declares it and one adapter hands it
//  over. A second reacher could write back an entry read through the other, a lost update.

const ANDROID_SRC = path.join(__dirname, "..", "..", "android", "app", "src");
const DOOR = "BoardOps.kt";
const HANDOFF = "RepositoryCollaborators.kt";
const DECLARER = "ChatRepository.kt";
const REACHES = /\b(?:repo|collaborators)\.board\./;
const HOLDS = /\brepo\.board\b/;

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

		const reachers = files.filter((f) => REACHES.test(code(f))).map((f) => path.basename(f));
		expect(new Set(reachers)).toEqual(new Set([DOOR]));
	});

	it("only the collaborator adapter holds the instance for the door", () => {
		const holders = kotlinFiles(ANDROID_SRC)
			.filter((f) => HOLDS.test(code(f)))
			.map((f) => path.basename(f));
		expect(new Set(holders)).toEqual(new Set([HANDOFF]));
	});

	it("the door actually reaches it, so the rule cannot pass by everyone giving up", () => {
		const door = kotlinFiles(ANDROID_SRC).find((f) => path.basename(f) === DOOR);
		expect(door).toBeDefined();
		expect(code(door as string)).toMatch(REACHES);
	});

	it("ChatRepository still declares the instance the door reaches", () => {
		const declarer = kotlinFiles(ANDROID_SRC).find((f) => path.basename(f) === DECLARER);
		expect(declarer).toBeDefined();
		expect(code(declarer as string)).toMatch(/\bval board\b/);
	});
});
