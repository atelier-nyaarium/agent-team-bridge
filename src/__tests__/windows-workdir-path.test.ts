// Which path shapes a spawn point accepts, and why a Windows path is spelled with forward slashes.
//
// The rule has TWO enforcement points by design - the gateway boundary (fail fast) and the daemon's
// own re-guard - so it is one function both call rather than two spellings that have to agree.

import { describe, expect, it } from "vitest";
import { isSpawnWorkdirPath, isWindowsWorkdirPath, isWorkdirPath, MAX_WORKDIR_PATH_LEN } from "../shared/host-op.js";
import { HOST_SPAWN, WINDOWS_SPAWN } from "../shared/host-spawn.js";

////////////////////////////////
//  Tests

describe("windows workdir paths", () => {
	it("accepts a drive path with forward slashes", () => {
		expect(isWindowsWorkdirPath("C:/Users/me/project")).toBe(true);
		expect(isWindowsWorkdirPath("d:/work")).toBe(true);
	});

	// Backslash is in the shared forbidden set because of shell nesting, and it STAYS there: exempting
	// it for one spawn point would reopen that for every path on this wire. PowerShell takes forward
	// slashes everywhere it takes backslashes, so the wire simply never carries one.
	it("rejects the backslash spelling, which is why the wire uses forward slashes", () => {
		expect(isWindowsWorkdirPath("C:\\Users\\me")).toBe(false);
	});

	it("rejects a bare drive with no separator, and a POSIX path", () => {
		expect(isWindowsWorkdirPath("C:")).toBe(false);
		expect(isWindowsWorkdirPath("/home/me")).toBe(false);
		expect(isWindowsWorkdirPath("")).toBe(false);
	});

	// Shared with isWorkdirPath rather than restated, so the two cannot come to disagree about what a
	// path may contain or how long it may be.
	it("inherits the same forbidden characters and length cap as a POSIX workdir", () => {
		for (const bad of ["C:/a'b", 'C:/a"b', "C:/a`b", "C:/a$b", "C:/a\u0000b"]) {
			expect(isWindowsWorkdirPath(bad)).toBe(false);
		}
		expect(isWindowsWorkdirPath(`C:/${"x".repeat(MAX_WORKDIR_PATH_LEN)}`)).toBe(false);
	});
});

describe("isSpawnWorkdirPath picks the rule from the spawn point", () => {
	it("a windows spawn point takes either shape", () => {
		// The picker walks Windows and yields this.
		expect(isSpawnWorkdirPath(WINDOWS_SPAWN, "C:/Users/me")).toBe(true);
		// A caller may still name a /mnt path, which the daemon translates at launch.
		expect(isSpawnWorkdirPath(WINDOWS_SPAWN, "/mnt/c/Users/me")).toBe(true);
	});

	it("every other spawn point keeps the POSIX rule exactly", () => {
		expect(isSpawnWorkdirPath(HOST_SPAWN, "/home/me")).toBe(true);
		expect(isSpawnWorkdirPath(HOST_SPAWN, "~/projects")).toBe(true);
		expect(isSpawnWorkdirPath(HOST_SPAWN, "C:/Users/me")).toBe(false);
	});

	// An older console does not send the field, and must keep the behaviour it always had.
	it("an absent spawn is the host's own rule", () => {
		expect(isSpawnWorkdirPath(undefined, "/home/me")).toBe(true);
		expect(isSpawnWorkdirPath(undefined, "C:/Users/me")).toBe(false);
	});

	it("never widens what a POSIX path may be", () => {
		for (const bad of ["relative/path", "", "/home/me\u0000"]) {
			expect(isWorkdirPath(bad)).toBe(false);
			expect(isSpawnWorkdirPath(WINDOWS_SPAWN, bad)).toBe(false);
		}
	});
});
