import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined, OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import * as atomicWrite from "../shared/atomic-write.js";
import { fingerprint } from "../shared/crypto.js";

const roots: string[] = [];
const key = { domainId: "domain", ownerSignPub: Buffer.alloc(32, 7).toString("base64") };
const root = () => {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "owner-state-"));
	roots.push(value);
	return value;
};
const open = (
	dir: string,
	quota = new DomainQuota({ dir, limitBytes: 10_000_000, statfs: () => ({ available: 100_000_000 }) }),
) => OwnerStateStore.open({ dataDir: dir, key, quota, heartbeatMs: 10, staleMs: 100 });
const ownerDir = (dir: string) => path.join(dir, "owner", key.domainId, fingerprint(key.ownerSignPub));
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OwnerStateStore", () => {
	it("puts and gets records with monotonic versions", () => {
		const store = open(root());
		expect(store.put("board.meta", "a", null, { clear: { x: 1 } })).toMatchObject({ kind: "ok", version: 1 });
		expect(store.put("board.meta", "a", 1, { clear: { x: 2 } })).toMatchObject({ kind: "ok", version: 2 });
		expect(store.get("board.meta", "a")).toMatchObject({ version: 2, clear: { x: 2 } });
		store.close();
	});

	it("returns the live record for conflicts, including stale deletes", () => {
		const store = open(root());
		store.put("share", "s", null, { clear: { live: true } });
		store.put("share", "s", 1, { clear: { newer: true } });
		const conflict = store.put("share", "s", 1, { clear: {} });
		expect(conflict).toMatchObject({ kind: "conflict", current: { version: 2 } });
		expect(store.del("share", "s", 1)).toMatchObject({ kind: "conflict", current: { version: 2 } });
		store.close();
	});

	it("keeps independent address sequences and filters rows", () => {
		const store = open(root());
		expect(store.append("a", { n: 1 })).toMatchObject({ seq: 1 });
		expect(store.append("a", { n: 2 })).toMatchObject({ seq: 2 });
		expect(store.append("b", { n: 1 })).toMatchObject({ seq: 1 });
		expect(store.rows("a", 2, 1)).toEqual([{ seq: 2, row: { n: 2 } }]);
		expect(store.retire("a", 1)).toMatchObject({ kind: "ok" });
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 2, row: { n: 2 } }]);
		store.close();
	});

	it("applies a batch atomically", () => {
		const store = open(root());
		store.put("share", "live", null, { clear: { x: 1 } });
		expect(
			store.batch((tx) => {
				tx.put("share", "new", null, { clear: { x: 2 } });
				tx.put("share", "live", 0, { clear: {} });
			}),
		).toMatchObject({ kind: "conflict" });
		expect(store.get("share", "new")).toBeNull();
		expect(store.get("share", "live")).toMatchObject({ clear: { x: 1 } });
		store.close();
	});

	it("replays writes and removes older segments after compaction", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "s", null, { clear: { ok: true } });
		store.append("a", { n: 1 });
		store.close();
		store = open(dir);
		expect(store.get("share", "s")).toMatchObject({ clear: { ok: true } });
		store.compact();
		store.close();
		expect(fs.readdirSync(ownerDir(dir)).filter((name) => name.startsWith("snapshot-")).length).toBe(1);
		store = open(dir);
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 1, row: { n: 1 } }]);
		store.close();
	});

	it("truncates a torn last line and continues sequences", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		fs.appendFileSync(journal, '{"seq":2');
		store = open(dir);
		expect(store.append("a", { n: 2 })).toMatchObject({ kind: "ok", seq: 2 });
		store.close();
	});

	it("treats one journal line as one batch", () => {
		const dir = root();
		const store = open(dir);
		store.batch((tx) => {
			tx.put("share", "a", null, { clear: { value: 1 } });
			tx.append("rows", { value: 2 });
		});
		const journal = fs.readFileSync(path.join(ownerDir(dir), "journal-0.log"), "utf8").trim();
		expect(JSON.parse(journal).ops).toHaveLength(2);
		store.close();
	});

	it("quarantines an earlier torn line and remains quarantined after reopen", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.append("a", { n: 2 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
		lines[0] = lines[0].slice(0, 8);
		fs.writeFileSync(journal, `${lines.join("\n")}\n`);
		store = open(dir);
		expect(() => store.rows("a", 1, 10)).toThrow(OwnerQuarantined);
		store.close();
		store = open(dir);
		expect(() => store.rows("a", 1, 10)).toThrow(OwnerQuarantined);
		expect(store.append("a", {})).toMatchObject({ kind: "quarantined" });
		store.close();
	});

	it("persists a manifest quarantine without renaming a corrupt manifest", () => {
		const dir = root();
		const store = open(dir);
		store.close();
		const manifest = path.join(ownerDir(dir), "MANIFEST.json");
		fs.writeFileSync(manifest, "{");
		const reopened = open(dir);
		expect(() => reopened.list("share")).toThrow(OwnerQuarantined);
		expect(fs.existsSync(manifest)).toBe(true);
		expect(fs.readdirSync(ownerDir(dir)).some((name) => name.includes("quarantine-"))).toBe(false);
		reopened.close();
	});

	it("reopens the pre-crash state after compact manifest failure", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "before", null, { clear: { value: 1 } });
		const original = atomicWrite.writeFileAtomic;
		vi.spyOn(atomicWrite, "writeFileAtomic").mockImplementation((file, ...args) => {
			if (path.basename(file) === "MANIFEST.json") throw new Error("manifest write");
			return original(file, ...args);
		});
		expect(() => store.compact()).toThrow("manifest write");
		store.close();
		vi.restoreAllMocks();
		store = open(dir);
		expect(store.get("share", "before")).toMatchObject({ clear: { value: 1 } });
		expect(fs.readdirSync(ownerDir(dir)).some((name) => name === "snapshot-1.json")).toBe(false);
		store.close();
	});

	it("quarantines corrupt segments and refuses reads and writes", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.append("a", { n: 2 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").split("\n");
		lines[0] = "{";
		fs.writeFileSync(journal, lines.join("\n"));
		const corrupted = fs.readFileSync(journal);
		store = open(dir);
		expect(() => store.get("presence.row", "x")).toThrow(OwnerQuarantined);
		expect(store.append("a", {})).toMatchObject({ kind: "quarantined", missing: { from: 1, to: 2 } });
		const quarantined = fs.readdirSync(ownerDir(dir)).find((name) => name.includes("journal-0.log.quarantine-"));
		expect(quarantined).toBeDefined();
		expect(fs.readFileSync(path.join(ownerDir(dir), quarantined as string))).toEqual(corrupted);
		store.close();
	});

	it("quarantines a corrupt snapshot and preserves its bytes", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "s", null, { clear: { x: 1 } });
		store.compact();
		store.close();
		const snapshot = path.join(ownerDir(dir), "snapshot-1.json");
		fs.writeFileSync(snapshot, "{");
		const corrupted = fs.readFileSync(snapshot);
		store = open(dir);
		expect(() => store.list("share")).toThrow(OwnerQuarantined);
		expect(store.put("share", "s", null, { clear: {} })).toMatchObject({ kind: "quarantined" });
		const quarantined = fs.readdirSync(ownerDir(dir)).find((name) => name.includes("snapshot-1.json.quarantine-"));
		expect(quarantined).toBeDefined();
		expect(fs.readFileSync(path.join(ownerDir(dir), quarantined as string))).toEqual(corrupted);
		store.close();
	});

	it("rejects a second live open and takes over stale ownership", () => {
		const dir = root();
		const first = open(dir);
		expect(() => open(dir)).toThrow();
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as {
			pid: number;
			generation: number;
			heartbeatAt: number;
		};
		fs.writeFileSync(lock, JSON.stringify({ ...value, heartbeatAt: Date.now() - 1000 }));
		const second = open(dir);
		expect(first.put("share", "old", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		second.close();
		first.close();
	});

	it("refuses quota writes without changing prior state", () => {
		const dir = root();
		const store = open(
			dir,
			new DomainQuota({ dir, limitBytes: 1, reserveBytes: 0, statfs: () => ({ available: 100 }) }),
		);
		expect(store.put("share", "s", null, { clear: { x: 1 } })).toMatchObject({ kind: "durability_failure" });
		expect(store.get("share", "s")).toBeNull();
		store.close();
	});

	it("reports uncertain fsync and remains usable", () => {
		const dir = root();
		const store = open(dir);
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("sync");
		});
		expect(store.put("share", "a", null, { clear: {} })).toMatchObject({ kind: "durability_uncertain" });
		expect(store.health().degraded).toBe(true);
		fsync.mockRestore();
		expect(store.put("share", "b", null, { clear: {} })).toMatchObject({ kind: "ok", seq: 2 });
		store.close();
	});

	it("truncates a short write and reopens clean", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		const original = fs.writeSync as unknown as (
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position?: number | null,
		) => number;
		let writes = 0;
		vi.spyOn(fs, "writeSync").mockImplementation((...args: unknown[]) => {
			const [fd, buffer, offset, length, position] = args as [
				number,
				NodeJS.ArrayBufferView,
				number,
				number,
				number | null | undefined,
			];
			if (writes++ === 0) return original(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
			throw new Error("write");
		});
		expect(store.put("share", "failed", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		store.close();
		vi.restoreAllMocks();
		store = open(dir);
		expect(store.get("share", "failed")).toBeNull();
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 1, row: { n: 1 } }]);
		store.close();
	});

	it("settles quota on open and compact", () => {
		const dir = root();
		const quota = new DomainQuota({ dir, limitBytes: 10_000_000, statfs: () => ({ available: 100_000_000 }) });
		const settle = vi.spyOn(quota, "settle");
		const store = open(dir, quota);
		store.compact();
		expect(settle).toHaveBeenCalledTimes(2);
		store.close();
	});

	it("takes over a dead lock with a fresh heartbeat", () => {
		const dir = root();
		const first = open(dir);
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as Record<string, number>;
		fs.writeFileSync(lock, JSON.stringify({ ...value, pid: 999999, heartbeatAt: Date.now() }));
		const second = open(dir);
		expect(first.put("share", "old", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		second.close();
		first.close();
	});

	it("stops heartbeating after another holder rewrites the lock", async () => {
		const dir = root();
		const store = open(dir);
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as Record<string, number>;
		const before = new Map(
			fs
				.readdirSync(ownerDir(dir))
				.filter(
					(name) =>
						name === "MANIFEST.json" ||
						/^snapshot-\d+\.json$/.test(name) ||
						/^journal-\d+\.log$/.test(name),
				)
				.map((name) => [name, fs.readFileSync(path.join(ownerDir(dir), name))]),
		);
		fs.writeFileSync(lock, JSON.stringify({ ...value, generation: value.generation + 1 }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		store.compact();
		const after = new Map(
			fs
				.readdirSync(ownerDir(dir))
				.filter(
					(name) =>
						name === "MANIFEST.json" ||
						/^snapshot-\d+\.json$/.test(name) ||
						/^journal-\d+\.log$/.test(name),
				)
				.map((name) => [name, fs.readFileSync(path.join(ownerDir(dir), name))]),
		);
		expect([...after.entries()]).toEqual([...before.entries()]);
		expect(store.put("share", "lost", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		expect(JSON.parse(fs.readFileSync(lock, "utf8")).generation).toBe(value.generation + 1);
		store.close();
	});
});
