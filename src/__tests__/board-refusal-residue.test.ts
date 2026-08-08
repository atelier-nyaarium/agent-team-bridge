import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOARD_REFUSED_PREFIX, refusalError } from "../gateway/boardStore.js";

////////////////////////////////
//  Constants

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

/** Every gateway module that can throw on a board write path. */
const THROWING_SOURCES = [
	path.join(REPO_ROOT, "src", "gateway", "console", "consoleHandler.ts"),
	path.join(REPO_ROOT, "src", "gateway", "routes.ts"),
];

/** The wire marker itself, spelled out rather than imported: a test that builds its needle from the
 * value under test cannot notice that value changing. */
const MARKER = /["'`]refused:\s/;

function read(file: string): string {
	return fs.readFileSync(file, "utf8");
}

/** Source with comments removed. The marker must be nameable in prose - these modules explain the
 * contract at length - so only what the runtime sees is what the guard may judge. */
function code(file: string): string {
	return read(file)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

////////////////////////////////
//  Tests

describe("the refusal marker has exactly one producer", () => {
	// A refusal is the only signal that retires a queued console action, which permanently discards
	// the owner's edit. Any other throw whose message happens to start with the marker would do the
	// same, silently.
	it.each(THROWING_SOURCES)("%s writes no refusal marker of its own", (file) => {
		expect(MARKER.test(code(file))).toBe(false);
	});

	it("boardStore.ts owns it, so the guard above is proving something", () => {
		expect(MARKER.test(code(path.join(REPO_ROOT, "src", "gateway", "boardStore.ts")))).toBe(true);
	});

	it("the console reads the same marker the gateway writes", () => {
		// The two halves ship on separate triggers, so a drift here is a silent capability outage:
		// every refusal would read as a retryable error and no queued action would ever retire.
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
