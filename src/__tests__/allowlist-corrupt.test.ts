import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWLIST_FILE, Allowlist, AllowlistCorruptError } from "../gateway/federation/allowlist.js";
import { processAmbient } from "../shared/ambient.js";

describe("corrupt allowlist", () => {
	it("moves the original aside and refuses construction", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-corrupt-"));
		const file = path.join(dir, ALLOWLIST_FILE);
		const contents = "not an allowlist";
		fs.writeFileSync(file, contents);

		let error: unknown;
		try {
			new Allowlist(dir, processAmbient());
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AllowlistCorruptError);
		const asidePath = (error as AllowlistCorruptError).asidePath;
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.readFileSync(asidePath, "utf8")).toBe(contents);
	});
});
