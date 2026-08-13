import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPersistRunner,
	DurableStore,
	DurableStoreInstalledError,
	openDurable,
	restoreDurable,
} from "../shared/durable-store.js";

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

describe("createPersistRunner", () => {
	it("runs every step in order even when one throws", () => {
		const runPersistSteps = createPersistRunner();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const ran: string[] = [];

		runPersistSteps([
			{ name: "first", run: () => ran.push("first") },
			{
				name: "failing",
				run: () => {
					throw new Error("disk full");
				},
			},
			{ name: "last", run: () => ran.push("last") },
		]);

		// The real hazard is the steps AFTER the throw never running: a failed jobs save must not
		// cost the session-resume save behind it.
		expect(ran).toEqual(["first", "last"]);
		errors.mockRestore();
	});

	it("reports a repeating failure once, and again only when the error changes or recurs after a success", () => {
		const runPersistSteps = createPersistRunner();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let failWith: string | null = "disk full";
		const steps = [
			{
				name: "flaky",
				run: () => {
					if (failWith) throw new Error(failWith);
				},
			},
		];

		runPersistSteps(steps);
		runPersistSteps(steps);
		expect(errors).toHaveBeenCalledTimes(1);

		failWith = "read-only filesystem";
		runPersistSteps(steps);
		expect(errors).toHaveBeenCalledTimes(2);

		failWith = null;
		runPersistSteps(steps);
		failWith = "read-only filesystem";
		runPersistSteps(steps);
		expect(errors).toHaveBeenCalledTimes(3);
		errors.mockRestore();
	});

	it("contains a thrown value whose own stringification throws", () => {
		const runPersistSteps = createPersistRunner();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const ran: string[] = [];

		runPersistSteps([
			{
				name: "poisoned",
				run: () => {
					throw {
						toString() {
							throw new Error("poisoned");
						},
					};
				},
			},
			{ name: "after", run: () => ran.push("after") },
		]);

		expect(ran).toEqual(["after"]);
		errors.mockRestore();
	});

	it("throttles per step, so one step's noise cannot silence another's first failure", () => {
		const runPersistSteps = createPersistRunner();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const boom = (name: string) => ({
			name,
			run: () => {
				throw new Error("disk full");
			},
		});
		runPersistSteps([boom("jobs")]);
		runPersistSteps([boom("jobs"), boom("mailboxes")]);

		expect(errors).toHaveBeenCalledTimes(2);
		expect(String(errors.mock.calls[1]?.[0])).toContain("mailboxes");
		errors.mockRestore();
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

	it("reports when a checked snapshot was installed before directory sync failed", () => {
		const store = new DurableStore(dir, "installed");
		const fsync = vi
			.spyOn(fs, "fsyncSync")
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {
				throw new Error("directory sync unavailable");
			});

		expect(() => store.saveChecked({ revision: 2 })).toThrow(DurableStoreInstalledError);
		expect(readFileFor("installed")).toEqual({ revision: 2 });
		fsync.mockRestore();
	});

	it("keeps the existing best-effort save contract", () => {
		const store = new DurableStore(dir, "best-effort");
		store.save({ unsupported: 1n });

		expect(store.load()).toBeNull();
	});
});
