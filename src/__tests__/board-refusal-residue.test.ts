import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOARD_REFUSED_PREFIX, refusalError } from "../shared/board-authority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ANDROID_SRC = path.join(
	REPO_ROOT,
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

/** Sanctioned marker location. */
const OWNER = path.join(REPO_ROOT, "src", "shared", "board-authority.ts");

/** Keep the marker independent from the value under test. */
const MARKER = /["'`]refused:\s/;

function read(file: string): string {
	return fs.readFileSync(file, "utf8");
}

/** Remove comments before scanning runtime source. */
function code(file: string): string {
	return read(file)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Scan every TypeScript source except the marker owner. */
function sweptSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && full !== OWNER) out.push(full);
		}
	};
	walk(path.join(REPO_ROOT, "src"));
	return out;
}

describe("the refusal marker has exactly one producer", () => {
	// Only the refusal marker retires a queued console action.
	it("no module under src/ writes a refusal marker of its own", () => {
		const offenders = sweptSources().filter((file) => MARKER.test(code(file)));
		expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
	});

	it("boardAuthority.ts owns it, so the guard above is proving something", () => {
		expect(MARKER.test(code(OWNER))).toBe(true);
	});

	it("the console reads the same marker the gateway writes", () => {
		// Keep the marker in sync with the console's refusal classifier.
		const kotlin = read(path.join(ANDROID_SRC, "ConsoleClientTypes.kt"));
		const declared = /BOARD_REFUSED_PREFIX\s*=\s*"([^"]+)"/.exec(kotlin);

		expect(declared).not.toBeNull();
		expect(BOARD_REFUSED_PREFIX.trim()).toBe(declared?.[1].trim());
	});

	it("refusalError produces exactly what the console strips", () => {
		const err = refusalError("session_missing");

		expect(err.message.startsWith(BOARD_REFUSED_PREFIX)).toBe(true);
		expect(err.message.slice(BOARD_REFUSED_PREFIX.length)).toBe("session_missing");
	});
});
