import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CrossDomainShareState persistence", () => {
	it("round-trips a share through a fresh store", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-state-"));
		dirs.push(dir);
		const store = new CrossDomainShareState(dir, undefined, { now: () => 10 });
		store.share("alpha/app", { kind: "domain", domainId: "carol" });
		const reloaded = new CrossDomainShareState(dir, undefined, { now: () => 20 });
		expect(reloaded.all()).toEqual([
			{ sessionTarget: "alpha/app", target: { kind: "domain", domainId: "carol" }, lastSeenAt: 10 },
		]);
		expect(reloaded.isSharedTo("alpha/app", "carol", () => true)).toBe(true);
	});
});
