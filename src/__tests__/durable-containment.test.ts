import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableStore, openDurable, restoreDurable } from "../shared/durable-store.js";

////////////////////////////////
//  Functions & Helpers

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-containment-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeFileFor(name: string, contents: unknown): void {
	fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(contents));
}

function readFileFor(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

////////////////////////////////
//  Tests

describe("openDurable", () => {
	it("hands a healthy file straight to its consumer", () => {
		writeFileFor("thing", { count: 7 });

		const restored = openDurable(dir, "thing", (store) => (store.load() as { count: number }).count);

		expect(restored).toBe(7);
	});

	it("starts a consumer fresh when the file's contents poison it", () => {
		writeFileFor("thing", { bad: true });

		const restored = openDurable(dir, "thing", (store) => {
			const raw = store.load() as { good?: number } | null;
			if (raw && raw.good === undefined) throw new Error("unusable snapshot");
			return raw?.good ?? 0;
		});

		expect(restored).toBe(0);
	});

	it("keeps writing through after a poisoned start, so the next save heals the file", () => {
		writeFileFor("thing", { bad: true });

		const store = openDurable(dir, "thing", (s) => {
			if (s.load() !== null) throw new Error("unusable snapshot");
			return s;
		});
		store.save({ good: 1 });

		expect(readFileFor("thing")).toEqual({ good: 1 });
	});
});

describe("restoreDurable", () => {
	it("leaves a neighbour's state intact when one file's restore throws", () => {
		const sessions = new Map<string, string>();
		const mailboxes = new Map<string, string>();

		restoreDurable("mailboxes", () => {
			mailboxes.set("phone", "restored");
			throw new Error("snapshot missing entries");
		});
		restoreDurable("session-resume", () => sessions.set("host.abc", "restored"));

		// The real hazard is not the throw, it is the restore AFTER it never running: the persist
		// tick writes every store back unconditionally, so a skipped restore overwrites a good file.
		expect(sessions.get("host.abc")).toBe("restored");
	});
});

describe("DurableStore checked saves", () => {
	it("crosses the filesystem durability barrier only for checked saves", () => {
		const fsync = vi.spyOn(fs, "fsyncSync");
		const store = new DurableStore(dir, "checked");

		store.saveChecked({ revision: 1 });
		expect(fsync).toHaveBeenCalled();
		fsync.mockClear();
		store.save({ revision: 2 });
		expect(fsync).not.toHaveBeenCalled();
		fsync.mockRestore();
	});

	it("throws a checked serialization failure without replacing the last good snapshot", () => {
		const store = new DurableStore(dir, "checked");
		store.saveChecked({ revision: 1 });

		expect(() => store.saveChecked({ revision: 2, unsupported: 1n })).toThrow();
		expect(readFileFor("checked")).toEqual({ revision: 1 });
	});

	it("keeps the existing best-effort save contract", () => {
		const store = new DurableStore(dir, "best-effort");
		store.save({ unsupported: 1n });

		expect(store.load()).toBeNull();
	});
});
