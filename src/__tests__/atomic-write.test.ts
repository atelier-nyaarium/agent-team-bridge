import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATOMIC_TEMP_SUFFIX, sweepAtomicTemps, writeFileAtomic } from "../shared/atomic-write.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function tempRoot(): string {
	const root = `${os.tmpdir()}/atomic-write-${crypto.randomUUID()}`;
	mkdirSync(root, { recursive: true });
	roots.push(root);
	return root;
}

describe("writeFileAtomic", () => {
	it("leaves the target whole when the rename fails and sweeps the temp", () => {
		const root = tempRoot();
		const target = path.join(root, "state.json");
		writeFileSync(target, "old");
		let tempHeld = "";
		const rename = vi.spyOn(fs, "renameSync").mockImplementation((from) => {
			// The new bytes were fully in the temp by the time the rename ran.
			tempHeld = readFileSync(from, "utf8");
			throw new Error("simulated rename failure");
		});
		expect(() => writeFileAtomic(target, "new")).toThrow("simulated rename failure");
		expect(rename).toHaveBeenCalledOnce();
		expect(tempHeld).toBe("new");
		expect(readFileSync(target, "utf8")).toBe("old");
		expect(existsSync(`${target}${ATOMIC_TEMP_SUFFIX}`)).toBe(false);
	});

	it("removes the temp when the fill itself throws after creating it", () => {
		const target = path.join(tempRoot(), "landed");
		expect(() =>
			writeFileAtomic(target, (temp) => {
				writeFileSync(temp, "half");
				throw new Error("copy failed");
			}),
		).toThrow("copy failed");
		expect(existsSync(target)).toBe(false);
		expect(existsSync(`${target}${ATOMIC_TEMP_SUFFIX}`)).toBe(false);
	});

	it("applies the requested mode to a temp the fill created", () => {
		const root = tempRoot();
		const target = path.join(root, "secret");
		writeFileAtomic(target, (temp) => writeFileSync(temp, "s"), { mode: 0o600 });
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("applies the requested mode", () => {
		const target = path.join(tempRoot(), "secret");
		writeFileAtomic(target, "secret", { mode: 0o600 });
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("honors file and directory fsync options", () => {
		const target = path.join(tempRoot(), "state");
		const synced: string[] = [];
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
		});
		writeFileAtomic(target, "state", { fsyncFile: true, fsyncDirectory: true });
		// The bytes first, then the name that points at them.
		expect(synced).toEqual(["file", "directory"]);
	});

	it("lets the caller fill the temp itself, and runs afterRename on the final path", () => {
		// A copy from elsewhere has no bytes to hand over, and an mtime cannot ride the temp.
		const root = tempRoot();
		const source = path.join(root, "source");
		writeFileSync(source, "copied");
		const target = path.join(root, "landed");
		const seen: string[] = [];
		writeFileAtomic(target, (temp) => fs.copyFileSync(source, temp), {
			afterRename: (file) => {
				seen.push(file);
				expect(existsSync(file)).toBe(true);
			},
		});
		expect(readFileSync(target, "utf8")).toBe("copied");
		expect(seen).toEqual([target]);
		expect(existsSync(`${target}${ATOMIC_TEMP_SUFFIX}`)).toBe(false);
	});

	it("reports a directory sync failure through the caller's hook, with the file already in place", () => {
		// That is a different failure from a lost write, and a caller that tells them apart needs the hook.
		const target = path.join(tempRoot(), "state");
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			if (fs.fstatSync(fd).isDirectory()) throw new Error("dir sync failed");
		});
		expect(() =>
			writeFileAtomic(target, "state", {
				fsyncDirectory: true,
				onDirectorySyncError: (error) => {
					throw new Error(`installed: ${(error as Error).message}`);
				},
			}),
		).toThrow("installed: dir sync failed");
		expect(readFileSync(target, "utf8")).toBe("state");
	});

	it("sweeps only temps whose writer is gone, and leaves siblings alone", () => {
		const root = tempRoot();
		// No process can have this pid, so these read as a dead writer's leftovers.
		const dead = ".tmp.999999999";
		writeFileSync(path.join(root, `one${dead}`), "temp");
		writeFileSync(path.join(root, `two${dead}`), "temp");
		// Our own pid is alive, which is what another live process mid-write looks like.
		writeFileSync(path.join(root, `live${ATOMIC_TEMP_SUFFIX}`), "temp");
		writeFileSync(path.join(root, "sibling.tmp"), "keep");
		expect(sweepAtomicTemps(root).sort()).toEqual([`one${dead}`, `two${dead}`]);
		expect(existsSync(path.join(root, `live${ATOMIC_TEMP_SUFFIX}`))).toBe(true);
		expect(existsSync(path.join(root, "sibling.tmp"))).toBe(true);
	});
});
