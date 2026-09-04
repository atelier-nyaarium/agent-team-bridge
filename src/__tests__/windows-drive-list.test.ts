import { describe, expect, it } from "vitest";
import { parseWindowsDriveNames, WINDOWS_DRIVE_ROOT } from "../mcp/devcontainer/windowsSpawn.js";

describe("windows drive listing", () => {
	it("names each drive so a tap builds a rooted path", () => {
		expect(parseWindowsDriveNames("C\r\nD\r\n")).toEqual(["C:", "D:"]);
	});

	it("sorts and upper-cases, and drops anything that is not one letter", () => {
		expect(parseWindowsDriveNames("d\nC\n\nTemp\nZ:\n")).toEqual(["C:", "D:"]);
	});

	it("carries the drive list on a path the workdir rule already accepts", () => {
		expect(WINDOWS_DRIVE_ROOT).toBe("/");
	});
});
