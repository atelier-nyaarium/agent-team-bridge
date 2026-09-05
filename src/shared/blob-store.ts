import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Ambient, processAmbient } from "./ambient.js";

export interface BlobStat {
	/** Contiguous bytes from offset zero. */
	have: number;
	/** Total size after completion. */
	size?: number;
	/** Fully written and digest-verified. */
	complete: boolean;
}

export interface BlobWriteResult {
	have: number;
	complete: boolean;
}

export interface BlobReadResult {
	bytes: Buffer;
	eof: boolean;
}

export interface BlobSweepOptions {
	/** Storage ceiling in bytes. */
	maxBytes: number;
	/** Maximum idle age for partials. */
	partMaxAgeMs?: number;
	now?: number;
}

/** Canonical blob ID shape. */
const BLOB_ID_RE = /^sha256-[0-9a-f]{64}$/;

/** Digest-derived blob ID. */
export function blobIdFor(bytes: Buffer): string {
	return `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function isBlobId(value: string): boolean {
	return BLOB_ID_RE.test(value);
}

/** Content-addressed, bounded chunk store. */
export class BlobStore {
	// The MCP process builds one without a graph, so its ambient is the process one.
	constructor(
		private readonly root: string,
		private readonly ambient: Pick<Ambient, "now" | "newId"> = processAmbient(),
	) {}

	stat(blobId: string): BlobStat {
		this.assertId(blobId);
		const final = this.finalPath(blobId);
		const finalSize = sizeOf(final);
		if (finalSize !== null) return { have: finalSize, size: finalSize, complete: true };
		const partSize = sizeOf(this.partPath(blobId));
		return { have: partSize ?? 0, complete: false };
	}

	/** Gaps rejected. Retries idempotent. */
	write(blobId: string, offset: number, chunk: Buffer, final: boolean, expectedDigest = blobId): BlobWriteResult {
		this.assertId(blobId);
		const current = this.stat(blobId);
		if (current.complete) return { have: current.have, complete: true };
		if (offset > current.have) {
			throw new Error(`blob ${blobId}: chunk at ${offset} leaves a gap after ${current.have}`);
		}
		const part = this.partPath(blobId);
		fs.mkdirSync(path.dirname(part), { recursive: true });

		// Retries may add nothing before sealing.
		const covered = offset + chunk.length <= current.have;
		if (!covered || !fs.existsSync(part)) {
			const fd = fs.openSync(part, fs.existsSync(part) ? "r+" : "w+");
			try {
				// Write only bytes beyond the prefix.
				const skip = current.have - offset;
				if (chunk.length > skip) fs.writeSync(fd, chunk, skip, chunk.length - skip, current.have);
			} finally {
				fs.closeSync(fd);
			}
		}

		const have = sizeOf(part) ?? 0;
		if (!final) return { have, complete: false };
		// Short writes must resume.
		if (have < offset + chunk.length) return { have, complete: false };
		return { have, complete: this.seal(blobId, expectedDigest) };
	}

	/** Range read. */
	read(blobId: string, offset: number, length: number): BlobReadResult {
		this.assertId(blobId);
		const file = this.path(blobId);
		if (file === null) throw new Error(`blob ${blobId} is not complete`);
		const size = sizeOf(file) ?? 0;
		if (offset >= size) return { bytes: Buffer.alloc(0), eof: true };
		const want = Math.min(length, size - offset);
		const out = Buffer.alloc(want);
		const fd = fs.openSync(file, "r");
		try {
			fs.readSync(fd, out, 0, want, offset);
		} finally {
			fs.closeSync(fd);
		}
		// Reads refresh eviction time.
		touch(file, this.ambient.now());
		return { bytes: out, eof: offset + want >= size };
	}

	/** Path only for verified blobs. */
	path(blobId: string): string | null {
		this.assertId(blobId);
		const final = this.finalPath(blobId);
		return fs.existsSync(final) ? final : null;
	}

	/** Stream and hash a local file. */
	ingestFile(source: string): string {
		const hash = crypto.createHash("sha256");
		const tmp = path.join(this.root, `.ingest-${process.pid}-${this.ambient.newId()}`);
		fs.mkdirSync(path.dirname(tmp), { recursive: true });
		const input = fs.openSync(source, "r");
		const out = fs.openSync(tmp, "w");
		try {
			const buf = Buffer.alloc(1 << 20);
			for (;;) {
				const n = fs.readSync(input, buf, 0, buf.length, null);
				if (n <= 0) break;
				hash.update(buf.subarray(0, n));
				fs.writeSync(out, buf, 0, n);
			}
		} finally {
			fs.closeSync(input);
			fs.closeSync(out);
		}
		const blobId = `sha256-${hash.digest("hex")}`;
		const final = this.finalPath(blobId);
		fs.mkdirSync(path.dirname(final), { recursive: true });
		if (fs.existsSync(final)) fs.rmSync(tmp, { force: true });
		else fs.renameSync(tmp, final);
		return blobId;
	}

	/** Drop a blob and its partial. */
	remove(blobId: string): void {
		this.assertId(blobId);
		fs.rmSync(this.finalPath(blobId), { force: true });
		fs.rmSync(this.partPath(blobId), { force: true });
	}

	/** Reclaim space under the byte ceiling. */
	sweep({ maxBytes, partMaxAgeMs = 3_600_000, now = this.ambient.now() }: BlobSweepOptions): number {
		const entries = this.entries();
		let freed = 0;
		const live: typeof entries = [];

		for (const entry of entries) {
			if (entry.partial && now - entry.mtimeMs >= partMaxAgeMs) {
				fs.rmSync(entry.path, { force: true });
				freed += entry.size;
				continue;
			}
			live.push(entry);
		}

		// Partials count toward the budget.
		const ordered = live.sort((a, b) => a.mtimeMs - b.mtimeMs || Number(b.partial) - Number(a.partial));
		let total = ordered.reduce((n, e) => n + e.size, 0);
		for (const entry of ordered) {
			if (total <= maxBytes) break;
			fs.rmSync(entry.path, { force: true });
			total -= entry.size;
			freed += entry.size;
		}
		return freed;
	}

	/** List sweep candidates. */
	private entries(): Array<{ path: string; size: number; mtimeMs: number; partial: boolean }> {
		const out: Array<{ path: string; size: number; mtimeMs: number; partial: boolean }> = [];
		let fanout: string[];
		try {
			fanout = fs.readdirSync(this.root);
		} catch {
			return out;
		}
		for (const dir of fanout) {
			const dirPath = path.join(this.root, dir);
			// Root staging files are debris.
			let names: string[];
			try {
				names = fs.statSync(dirPath).isDirectory() ? fs.readdirSync(dirPath) : [];
			} catch {
				continue;
			}
			if (names.length === 0 && dir.startsWith(".ingest-")) {
				const st = statOf(dirPath);
				if (st) out.push({ path: dirPath, size: st.size, mtimeMs: st.mtimeMs, partial: true });
				continue;
			}
			for (const name of names) {
				const full = path.join(dirPath, name);
				const st = statOf(full);
				if (!st) continue;
				out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, partial: name.endsWith(".part") });
			}
		}
		return out;
	}

	/** Hash before promotion. */
	private seal(blobId: string, expectedDigest: string): boolean {
		const part = this.partPath(blobId);
		const hash = crypto.createHash("sha256");
		const fd = fs.openSync(part, "r");
		try {
			const buf = Buffer.alloc(1 << 20);
			for (;;) {
				const n = fs.readSync(fd, buf, 0, buf.length, null);
				if (n <= 0) break;
				hash.update(buf.subarray(0, n));
			}
		} finally {
			fs.closeSync(fd);
		}
		if (`sha256-${hash.digest("hex")}` !== expectedDigest) {
			fs.rmSync(part, { force: true });
			return false;
		}
		fs.renameSync(part, this.finalPath(blobId));
		return true;
	}

	private assertId(blobId: string): void {
		if (!BLOB_ID_RE.test(blobId)) throw new Error(`not a blob id: ${blobId}`);
	}

	private finalPath(blobId: string): string {
		const hex = blobId.slice("sha256-".length);
		return path.join(this.root, hex.slice(0, 2), hex);
	}

	private partPath(blobId: string): string {
		return `${this.finalPath(blobId)}.part`;
	}
}

function sizeOf(file: string): number | null {
	return statOf(file)?.size ?? null;
}

/** Refresh usage timestamp, best effort. */
function touch(file: string, atMs: number): void {
	try {
		const at = new Date(atMs);
		fs.utimesSync(file, at, at);
	} catch {
		// Timestamp failure is non-fatal.
	}
}

function statOf(file: string): { size: number; mtimeMs: number } | null {
	try {
		const st = fs.statSync(file);
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}
