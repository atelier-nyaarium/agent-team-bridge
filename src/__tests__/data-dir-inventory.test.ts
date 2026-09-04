import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DATA_DIR_ENTRIES,
	reportUnrecognizedDataEntries,
	unrecognizedDataEntries,
} from "../gateway/dataDirInventory.js";
import { ATOMIC_TEMP_SUFFIX } from "../shared/atomic-write.js";

const GATEWAY_SRC = path.join(import.meta.dirname, "../gateway");

/** Every durable name the gateway opens directly under DATA_DIR, read from source. */
function openedDurableNames(): Set<string> {
	const names = new Set<string>();
	const opener =
		/(?:new DurableStore|openDurable)\(\s*(?:DATA_DIR|dataDir|process\.env\.DATA_DIR[^,]*),\s*"([^"]+)"/g;
	for (const file of walk(GATEWAY_SRC)) {
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(opener)) names.add(`${match[1]}.json`);
	}
	return names;
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.name.endsWith(".ts")) yield full;
	}
}

describe("data directory inventory", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function tempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-dir-"));
		dirs.push(dir);
		return dir;
	}

	it("reports only the entries nothing opens, leaving a writer's temp files alone", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "pending-jobs.json"), "{}");
		fs.writeFileSync(path.join(dir, "mailboxes.json"), "{}");
		fs.writeFileSync(path.join(dir, `pending-jobs.json${ATOMIC_TEMP_SUFFIX}`), "{");
		fs.mkdirSync(path.join(dir, "blobs"));
		fs.mkdirSync(path.join(dir, "task-board-attachments"));

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(reportUnrecognizedDataEntries(dir)).toEqual(["mailboxes.json", "task-board-attachments"]);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(path.join(dir, "mailboxes.json"))).toBe(true);
	});

	it("answers nothing for a directory that does not exist", () => {
		expect(unrecognizedDataEntries(path.join(tempDir(), "absent"))).toEqual([]);
	});

	it("keeps the known set in step with the stores the gateway opens", () => {
		const opened = openedDurableNames();
		expect(opened.size).toBeGreaterThan(5);
		for (const name of opened) expect(DATA_DIR_ENTRIES.has(name), name).toBe(true);
		for (const name of DATA_DIR_ENTRIES) {
			if (name.endsWith(".json")) expect(opened.has(name), `${name} is listed but never opened`).toBe(true);
		}
	});
});
