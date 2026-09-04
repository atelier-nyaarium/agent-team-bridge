import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listHostDirs } from "../mcp/devcontainer/hostResolve.js";
import { windowsHome } from "../mcp/devcontainer/windowsSpawn.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "list-dirs-"));
fs.mkdirSync(path.join(home, "projects"));
fs.mkdirSync(path.join(home, "notes"));
fs.writeFileSync(path.join(home, "a-file"), "");

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("a blank listing names the directory it resolved", () => {
	it("lists home and says which path that was", () => {
		expect(listHostDirs("", home)).toEqual({ entries: ["notes", "projects"], path: home });
	});

	it("stays silent about the path when the caller named one", () => {
		expect(listHostDirs("~/", home)).toEqual({ entries: ["notes", "projects"] });
	});

	it("spells a Windows home the way the rest of the wire spells a path", () => {
		expect(windowsHome("C:\\Users\\nyaa\\")).toBe("C:/Users/nyaa");
		expect(windowsHome("C:/Users/nyaa")).toBe("C:/Users/nyaa");
	});
});
