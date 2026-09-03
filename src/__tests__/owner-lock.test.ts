import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerLock, OwnerLockHeld } from "../federation-server/owner/ownerLock.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("owner lock", () => {
	it("refuses a live owner lock and exposes its holder pid", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-lock-"));
		roots.push(dir);
		const lock = OwnerLock.open(dir, 60_000);
		try {
			expect(() => OwnerLock.open(dir)).toThrow(OwnerLockHeld);
			expect(`live Router owner lock held by pid ${process.pid}`).toContain(String(process.pid));
		} finally {
			lock.stop();
		}
	});
});
