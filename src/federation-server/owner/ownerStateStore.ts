import fs from "node:fs";
import path from "node:path";
import { renameFileSync, sweepAtomicTemps, writeFileAtomic } from "../../shared/atomic-write.js";
import { fingerprint } from "../../shared/crypto.js";
import type { DomainQuota } from "./domainQuota.js";
import type { JournalLine, JournalOp } from "./journal.js";
import { OwnerLock, OwnerLockHeld } from "./ownerLock.js";

export interface OwnerKey {
	domainId: string;
	ownerSignPub: string;
}
export type RecordKind =
	| "board.entry"
	| "board.meta"
	| "board.op"
	| "scheduled"
	| "share"
	| "readAnchor"
	| "capabilities"
	| "presence.row"
	| "consumer"
	| "session"
	| "op"
	| "inbox.row"
	| "inbox.address"
	| "migration"
	| "keyReceipt"
	| "nonce"
	| "gateway";
export interface StateRecord {
	kind: RecordKind;
	id: string;
	version: number;
	clear: Record<string, unknown>;
	sealed?: Record<string, unknown>;
}
export type WriteResult =
	| { kind: "ok"; version: number; seq: number }
	| { kind: "conflict"; current: StateRecord | null }
	| { kind: "durability_failure"; reason: string }
	| { kind: "durability_uncertain"; reason: string }
	| { kind: "quarantined"; missing: { from: number; to: number } };
type Missing = { from: number; to: number };
type Snapshot = {
	records: Record<string, Record<string, StateRecord>>;
	rows: Record<string, { seq: number; row: Record<string, unknown> }[]>;
	nextSeq: Record<string, number>;
	seq: number;
};
type Quarantine = { segment: string; missing: Missing; at: number };
type Manifest = { v: 1; snapshot: string; journal: string; seq: number; quarantine?: Quarantine };
type Tx = {
	put: (
		kind: RecordKind,
		id: string,
		expectedVersion: number | null,
		record: { clear: Record<string, unknown>; sealed?: Record<string, unknown> },
	) => void;
	del: (kind: RecordKind, id: string, expectedVersion: number) => void;
	append: (address: string, row: Record<string, unknown>) => void;
	remove: (address: string, seq: number) => void;
};

const MANIFEST = "MANIFEST.json";
const SEGMENT_RE = /^(snapshot-\d+\.json|journal-\d+\.log)$/;
const empty = (): Snapshot => ({ records: {}, rows: {}, nextSeq: {}, seq: 0 });
const clone = <T>(value: T): T => structuredClone(value);
const fileSize = (file: string): number => {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
};

export class OwnerQuarantined extends Error {
	readonly missing: Missing;
	readonly from: number;
	readonly to: number;
	constructor(missing: Missing) {
		super("owner state quarantined");
		this.name = "OwnerQuarantined";
		this.missing = missing;
		this.from = missing.from;
		this.to = missing.to;
	}
}

export class OwnerStateStore {
	private readonly dir: string;
	private readonly quota: DomainQuota;
	private readonly lock: OwnerLock;
	private readonly now: () => number;
	private journalFd: number | undefined;
	private journalBytesState = 0;
	private state: Snapshot;
	private manifest: Manifest;
	private quarantinedState: Missing | undefined;
	private degradedState = false;
	private closed = false;

	private constructor(
		dir: string,
		quota: DomainQuota,
		lock: OwnerLock,
		now: () => number,
		state: Snapshot,
		manifest: Manifest,
		journalFd?: number,
	) {
		this.dir = dir;
		this.quota = quota;
		this.lock = lock;
		this.now = now;
		this.state = state;
		this.manifest = manifest;
		this.journalFd = journalFd;
	}

	static open(opts: {
		dataDir: string;
		key: OwnerKey;
		quota: DomainQuota;
		now?: () => number;
		heartbeatMs?: number;
		staleMs?: number;
	}): OwnerStateStore {
		const dir = path.join(opts.dataDir, "owner", opts.key.domainId, fingerprint(opts.key.ownerSignPub));
		fs.mkdirSync(dir, { recursive: true });
		sweepAtomicTemps(dir);
		const lock = OwnerLock.open(dir, opts.heartbeatMs, opts.staleMs);
		const now = opts.now ?? Date.now;
		try {
			const manifestPath = path.join(dir, MANIFEST);
			const fresh = !fs.existsSync(manifestPath);
			let manifest: Manifest = { v: 1, snapshot: "snapshot-0.json", journal: "journal-0.log", seq: 0 };
			if (!fresh) {
				try {
					manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
				} catch {
					// Quarantine persists until restoration.
					const to = OwnerStateStore.highestSeq(dir);
					return new OwnerStateStore(dir, opts.quota, lock, now, empty(), manifest).quarantine({
						from: 1,
						to,
					});
				}
			}
			if (manifest.quarantine) {
				return new OwnerStateStore(dir, opts.quota, lock, now, empty(), manifest).quarantine(
					manifest.quarantine.missing,
				);
			}
			let state = empty();
			const snapshotPath = path.join(dir, manifest.snapshot);
			if (fs.existsSync(snapshotPath)) {
				try {
					state = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Snapshot;
				} catch {
					return OwnerStateStore.quarantineSegment(dir, opts.quota, lock, now, manifest, manifest.snapshot, {
						from: manifest.seq + 1,
						to: manifest.seq,
					});
				}
			} else if (!fresh) {
				return OwnerStateStore.quarantineSegment(dir, opts.quota, lock, now, manifest, manifest.snapshot, {
					from: 1,
					to: manifest.seq,
				});
			}
			const journal = path.join(dir, manifest.journal);
			if (fs.existsSync(journal)) {
				const text = fs.readFileSync(journal, "utf8");
				const lines = text.split("\n");
				if (lines.at(-1) === "") lines.pop();
				for (let i = 0; i < lines.length; i++) {
					let line: JournalLine;
					try {
						line = JSON.parse(lines[i]) as JournalLine;
					} catch {
						if (i === lines.length - 1) {
							const end = lines.slice(0, -1).join("\n").length + (lines.length > 1 ? 1 : 0);
							console.warn(`[owner-state] truncating a torn journal line in ${journal} at byte ${end}`);
							const fd = fs.openSync(journal, "r+");
							try {
								fs.ftruncateSync(fd, end);
							} finally {
								fs.closeSync(fd);
							}
							break;
						}
						return OwnerStateStore.quarantineSegment(
							dir,
							opts.quota,
							lock,
							now,
							manifest,
							manifest.journal,
							{
								from: state.seq + 1,
								to: Math.max(manifest.seq, OwnerStateStore.highestSeq(dir)),
							},
						);
					}
					if (line.seq <= state.seq) continue;
					OwnerStateStore.apply(state, line);
					state.seq = line.seq;
				}
			}
			if (fresh) {
				writeFileAtomic(snapshotPath, JSON.stringify(state), { fsyncFile: true, fsyncDirectory: true });
				writeFileAtomic(journal, "", { fsyncFile: true, fsyncDirectory: true });
				writeFileAtomic(manifestPath, JSON.stringify(manifest), { fsyncFile: true, fsyncDirectory: true });
			}
			OwnerStateStore.removeUnnamedSegments(dir, manifest);
			const journalFd = fs.openSync(journal, "a");
			const store = new OwnerStateStore(dir, opts.quota, lock, now, state, manifest, journalFd);
			store.journalBytesState = fileSize(journal);
			opts.quota.settle(dir, fileSize(snapshotPath) + store.journalBytesState);
			return store;
		} catch (error) {
			lock.stop();
			throw error;
		}
	}

	private static highestSeq(dir: string): number {
		let highest = 0;
		for (const name of fs.readdirSync(dir)) {
			if (!name.startsWith("journal-")) continue;
			for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
				const seq = Number(/"seq"\s*:\s*(\d+)/.exec(line)?.[1] ?? 0);
				if (seq > highest) highest = seq;
			}
		}
		return highest;
	}

	private static removeUnnamedSegments(dir: string, manifest: Manifest): void {
		for (const name of fs.readdirSync(dir)) {
			if (!SEGMENT_RE.test(name) || name === manifest.snapshot || name === manifest.journal) continue;
			fs.rmSync(path.join(dir, name), { force: true });
		}
	}

	private static quarantineSegment(
		dir: string,
		quota: DomainQuota,
		lock: OwnerLock,
		now: () => number,
		manifest: Manifest,
		name: string,
		missing: Missing,
	): OwnerStateStore {
		const target = path.join(dir, name);
		const at = now();
		const segment = `${name}.quarantine-${at}`;
		if (fs.existsSync(target)) renameFileSync(target, path.join(dir, segment));
		const bounded = { from: missing.from, to: Math.max(missing.from, missing.to) };
		const next: Manifest = { ...manifest, quarantine: { segment, missing: bounded, at } };
		writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify(next), { fsyncFile: true, fsyncDirectory: true });
		console.warn(`[owner-state] quarantined ${segment} in ${dir}: seq ${bounded.from}..${bounded.to} lost`);
		return new OwnerStateStore(dir, quota, lock, now, empty(), next).quarantine(bounded);
	}

	private quarantine(missing: Missing): OwnerStateStore {
		this.quarantinedState = missing;
		return this;
	}

	get(kind: RecordKind, id: string): StateRecord | null {
		this.assertReadable();
		return clone(this.state.records[kind]?.[id] ?? null);
	}
	list(kind: RecordKind): StateRecord[] {
		this.assertReadable();
		return Object.values(this.state.records[kind] ?? {}).map(clone);
	}
	put(
		kind: RecordKind,
		id: string,
		expectedVersion: number | null,
		record: { clear: Record<string, unknown>; sealed?: Record<string, unknown> },
	): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		const current = this.get(kind, id);
		// CAS before journal append.
		if ((expectedVersion === null && current) || (expectedVersion !== null && current?.version !== expectedVersion))
			return { kind: "conflict", current };
		const version = (current?.version ?? 0) + 1;
		return this.commit([{ op: "put", kind, id, version, record }], version);
	}
	del(kind: RecordKind, id: string, expectedVersion: number): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		const current = this.get(kind, id);
		if (!current || current.version !== expectedVersion) return { kind: "conflict", current };
		return this.commit([{ op: "del", kind, id, version: expectedVersion }], expectedVersion);
	}
	append(address: string, row: Record<string, unknown>): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		return this.commit(
			[{ op: "append", address, row, rowSeq: this.state.nextSeq[address] ?? 1 }],
			this.state.nextSeq[address] ?? 1,
		);
	}
	addresses(): string[] {
		this.assertReadable();
		return [...new Set([...Object.keys(this.state.rows), ...Object.keys(this.state.nextSeq)])];
	}
	nextSeq(address: string): number {
		this.assertReadable();
		return this.state.nextSeq[address] ?? 1;
	}
	remove(address: string, seq: number): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		return this.commit([{ op: "remove", address, seq }], seq);
	}
	rows(address: string, fromSeq: number, limit: number): { seq: number; row: Record<string, unknown> }[] {
		this.assertReadable();
		return clone((this.state.rows[address] ?? []).filter((row) => row.seq >= fromSeq).slice(0, limit));
	}
	retire(address: string, uptoSeq: number): WriteResult {
		return this.commit([{ op: "retire", address, uptoSeq }], uptoSeq);
	}
	batch(fn: (tx: Tx) => void): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		const ops: JournalOp[] = [];
		const cursors = new Map<string, number>();
		try {
			fn({
				put: (kind, id, expectedVersion, record) => {
					const current = this.state.records[kind]?.[id];
					if (
						(expectedVersion === null && current) ||
						(expectedVersion !== null && current?.version !== expectedVersion)
					)
						throw Object.assign(new Error(), { current: current ?? null });
					ops.push({ op: "put", kind, id, version: (current?.version ?? 0) + 1, record });
				},
				del: (kind, id, expectedVersion) => {
					const current = this.state.records[kind]?.[id];
					if (!current || current.version !== expectedVersion)
						throw Object.assign(new Error(), { current: current ?? null });
					ops.push({ op: "del", kind, id, version: expectedVersion });
				},
				append: (address, row) => {
					const seq = cursors.get(address) ?? this.state.nextSeq[address] ?? 1;
					cursors.set(address, seq + 1);
					ops.push({ op: "append", address, row, rowSeq: seq });
				},
				remove: (address, seq) => ops.push({ op: "remove", address, seq }),
			});
		} catch (error) {
			return { kind: "conflict", current: (error as Error & { current?: StateRecord | null }).current ?? null };
		}
		return this.commit(ops, 0);
	}

	compact(): void {
		if (this.closed || this.quarantinedState) return;
		if (!this.lock.stillOwned()) {
			this.lock.stop();
			return;
		}
		const old = this.manifest;
		const gen = Number(this.manifest.snapshot.match(/(\d+)/)?.[1] ?? 0) + 1;
		const snapshot = `snapshot-${gen}.json`;
		const journal = `journal-${gen}.log`;
		const snapshotText = JSON.stringify(this.state);
		writeFileAtomic(path.join(this.dir, snapshot), snapshotText, { fsyncFile: true, fsyncDirectory: true });
		writeFileAtomic(path.join(this.dir, journal), "", { fsyncFile: true, fsyncDirectory: true });
		const next = { v: 1 as const, snapshot, journal, seq: this.state.seq };
		writeFileAtomic(path.join(this.dir, MANIFEST), JSON.stringify(next), {
			fsyncFile: true,
			fsyncDirectory: true,
		});
		if (this.journalFd !== undefined) fs.closeSync(this.journalFd);
		this.manifest = next;
		for (const name of [old.snapshot, old.journal])
			if (name !== snapshot && name !== journal) fs.rmSync(path.join(this.dir, name), { force: true });
		this.quota.settle(this.dir, Buffer.byteLength(snapshotText));
		this.journalBytesState = 0;
		this.journalFd = fs.openSync(path.join(this.dir, journal), "a");
	}
	health(): { quarantined: boolean; missing?: Missing; degraded: boolean; journalBytes: number } {
		return {
			quarantined: !!this.quarantinedState,
			missing: this.quarantinedState,
			degraded: this.degradedState,
			journalBytes: this.journalBytesState,
		};
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.journalFd !== undefined) fs.closeSync(this.journalFd);
		this.lock.stop();
	}

	private assertReadable(): void {
		if (this.quarantinedState) throw new OwnerQuarantined(this.quarantinedState);
	}
	private commit(ops: JournalOp[], fallback: number): WriteResult {
		if (this.quarantinedState) return { kind: "quarantined", missing: this.quarantinedState };
		if (this.closed) return { kind: "durability_failure", reason: "closed" };
		if (!this.lock.stillOwned()) {
			this.lock.stop();
			return { kind: "durability_failure", reason: "lock lost" };
		}
		if (!ops.length) return { kind: "ok", version: fallback, seq: this.state.seq };
		const line: JournalLine = { seq: this.state.seq + 1, gen: this.lock.generation, ops };
		const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
		const reservation = this.quota.reserve(this.dir, bytes.byteLength);
		if (!reservation.ok) {
			this.degradedState = true;
			return { kind: "durability_failure", reason: reservation.reason };
		}
		const fd = this.journalFd;
		if (fd === undefined) {
			this.quota.release(this.dir, bytes.byteLength);
			return { kind: "durability_failure", reason: "journal closed" };
		}
		const start = fs.fstatSync(fd).size;
		try {
			let offset = 0;
			while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		} catch (error) {
			this.quota.release(this.dir, bytes.byteLength);
			this.degradedState = true;
			// Restore pre-write length.
			try {
				fs.ftruncateSync(fd, start);
			} catch (truncateError) {
				console.warn(`[owner-state] journal truncate failed in ${this.dir}: ${String(truncateError)}`);
				this.closed = true;
			}
			return { kind: "durability_failure", reason: String(error) };
		}
		let uncertain: string | null = null;
		try {
			fs.fsyncSync(fd);
		} catch (error) {
			// Never reuse sequence after fsync failure.
			this.degradedState = true;
			uncertain = String(error);
		}
		const next = clone(this.state);
		// Journal precedes state.
		OwnerStateStore.apply(next, line);
		next.seq = line.seq;
		this.state = next;
		this.journalBytesState += bytes.byteLength;
		if (uncertain !== null) return { kind: "durability_uncertain", reason: uncertain };
		const last = ops.at(-1);
		const resultSeq = last?.op === "append" ? last.rowSeq : last?.op === "retire" ? last.uptoSeq : next.seq;
		return { kind: "ok", version: last && "version" in last ? last.version : fallback, seq: resultSeq };
	}

	private static apply(state: Snapshot, line: JournalLine): void {
		for (const op of line.ops) OwnerStateStore.applyOp(state, op);
	}

	private static applyOp(state: Snapshot, op: JournalOp): void {
		if (op.op === "put") {
			state.records[op.kind] ??= {};
			state.records[op.kind][op.id] = {
				kind: op.kind as RecordKind,
				id: op.id,
				version: op.version,
				clear: op.record.clear,
				sealed: op.record.sealed,
			};
		} else if (op.op === "del") delete state.records[op.kind]?.[op.id];
		else if (op.op === "append") {
			state.rows[op.address] ??= [];
			state.rows[op.address].push({ seq: op.rowSeq, row: op.row });
			state.nextSeq[op.address] = op.rowSeq + 1;
		} else if (op.op === "remove") {
			state.rows[op.address] = (state.rows[op.address] ?? []).filter((row) => row.seq !== op.seq);
		} else state.rows[op.address] = (state.rows[op.address] ?? []).filter((row) => row.seq > op.uptoSeq);
	}
}

export { OwnerLockHeld };
