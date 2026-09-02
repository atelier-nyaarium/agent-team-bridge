import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export interface BlobStat {
	/** Contiguous bytes held from offset 0. This IS the resume cursor. */
	have: number;
	/** Total size once complete; unknown (undefined) while a transfer is still open. */
	size?: number;
	/** Written in full and verified against its caller-supplied digest. */
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
	/** Ceiling for sealed blobs. Anything above it is evicted coldest-first. */
	maxBytes: number;
	/** How long an unfinished transfer may sit untouched before it counts as abandoned. */
	partMaxAgeMs?: number;
	now?: number;
}

////////////////////////////////
//  Constants

/** `sha256-` plus 64 lowercase hex. The only shape a blob may be named. */
const BLOB_ID_RE = /^sha256-[0-9a-f]{64}$/;

////////////////////////////////
//  Functions & Helpers

/** The name a blob will have, derived from its bytes. The only way to mint an id. */
export function blobIdFor(bytes: Buffer): string {
	return `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function isBlobId(value: string): boolean {
	return BLOB_ID_RE.test(value);
}

/**
 * Content-addressed byte store.
 *
 * Two rules carry the design. A blob is named by the digest of its own contents, so the name is
 * simultaneously its identity, its dedup key, its retry idempotency key, and its integrity check.
 * And nothing here accepts or returns a whole file: every write is a bounded chunk at an offset,
 * every read is a bounded range, so no caller can express "hold this entire attachment in memory".
 *
 * On disk: `<root>/<aa>/<sha256>` for a finished blob, `<root>/<aa>/<sha256>.part` while it is
 * still arriving, with the prefix length being the part file's own length. Two-level fanout keeps
 * any one directory small.
 *
 * A blob's lifetime is a CACHE lifetime, not an ownership one, which is what lets nothing hold a
 * reference count. Content addressing makes that safe: anything evicted can be fetched again under
 * the same name, so the worst an over-eager sweep costs is a re-transfer. [sweep] is the only
 * reclaim path and every caller is expected to run it on a timer.
 */
export class BlobStore {
	constructor(private readonly root: string) {}

	stat(blobId: string): BlobStat {
		this.assertId(blobId);
		const final = this.finalPath(blobId);
		const finalSize = sizeOf(final);
		if (finalSize !== null) return { have: finalSize, size: finalSize, complete: true };
		const partSize = sizeOf(this.partPath(blobId));
		return { have: partSize ?? 0, complete: false };
	}

	/**
	 * Write one chunk at `offset`.
	 *
	 * Rejects a gap: writing past the contiguous prefix would create a hole that `have` cannot
	 * describe and the digest cannot detect. Re-writing an offset already held is a NO-OP rather
	 * than an error, which is what makes a retried or duplicated chunk free.
	 */
	write(blobId: string, offset: number, chunk: Buffer, final: boolean, expectedDigest = blobId): BlobWriteResult {
		this.assertId(blobId);
		const current = this.stat(blobId);
		if (current.complete) return { have: current.have, complete: true };
		if (offset > current.have) {
			throw new Error(`blob ${blobId}: chunk at ${offset} leaves a gap after ${current.have}`);
		}
		const part = this.partPath(blobId);
		fs.mkdirSync(path.dirname(part), { recursive: true });

		// Adds nothing past the prefix: the sender retried. Still has to fall through when `final`
		// is set, or a fully-retried last chunk (and an empty blob, whose only chunk adds nothing)
		// would never seal.
		const covered = offset + chunk.length <= current.have;
		if (!covered || !fs.existsSync(part)) {
			const fd = fs.openSync(part, fs.existsSync(part) ? "r+" : "w+");
			try {
				// Only the bytes past the prefix; an overlapping retry re-sends from its own offset.
				const skip = current.have - offset;
				if (chunk.length > skip) fs.writeSync(fd, chunk, skip, chunk.length - skip, current.have);
			} finally {
				fs.closeSync(fd);
			}
		}

		const have = sizeOf(part) ?? 0;
		if (!final) return { have, complete: false };
		// A short write leaves the part shorter than the chunk that just claimed to finish it, which
		// is what a disk filling mid-write looks like: writeSync returns a partial count rather than
		// throwing. Sealing here would hash a truncated file, fail the digest, and DESTROY the whole
		// transfer to punish a lost tail. Report the honest prefix instead and let the sender resume.
		if (have < offset + chunk.length) return { have, complete: false };
		return { have, complete: this.seal(blobId, expectedDigest) };
	}

	/** Range read. Never the whole file unless the caller asks for it a chunk at a time. */
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
		// Reading marks a blob as recently used, which is what makes the sweep's coldest-first order
		// mean anything. A plain open does not: it moves atime, and no filesystem in this path is
		// mounted for that to be readable. Without this touch, a blob being downloaded right now is
		// ordered for eviction by when it was WRITTEN, so a slow transfer is first out rather than last.
		touch(file);
		return { bytes: out, eof: offset + want >= size };
	}

	/** The on-disk path, ONLY for a blob that is complete and verified. Null otherwise, so a torn
	 * or unverified transfer can never be handed to a decoder as if it were the real thing. */
	path(blobId: string): string | null {
		this.assertId(blobId);
		const final = this.finalPath(blobId);
		return fs.existsSync(final) ? final : null;
	}

	/** Take the bytes of an existing local file into the store, streaming and hashing as it goes,
	 * so the file is never held whole. Returns the blob's own name. */
	ingestFile(source: string): string {
		const hash = crypto.createHash("sha256");
		const tmp = path.join(this.root, `.ingest-${process.pid}-${crypto.randomUUID()}`);
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
		// Already present means the identical bytes are already stored; dedup is free.
		if (fs.existsSync(final)) fs.rmSync(tmp, { force: true });
		else fs.renameSync(tmp, final);
		return blobId;
	}

	/** Drop a blob and any partial transfer of it. */
	remove(blobId: string): void {
		this.assertId(blobId);
		fs.rmSync(this.finalPath(blobId), { force: true });
		fs.rmSync(this.partPath(blobId), { force: true });
	}

	/**
	 * Reclaim space: abandoned transfers first, then whole blobs, coldest first, until the store is
	 * back under [maxBytes]. Returns the bytes freed.
	 *
	 * Nothing reference-counts a blob, and deliberately so - a reference can live in a mailbox entry,
	 * a durable job result, a thread row on a phone, or a message still in flight, and a counter that
	 * has to be right in all four places is a counter that will be wrong in one.
	 *
	 * Re-fetch is recoverable while the holding Gateway or Router cache retains the bytes. Evicting
	 * the last copy leaves references unreadable. Reads refresh mtime, keeping active fetches last in
	 * eviction order.
	 *
	 * `.part` and `.ingest-*` files go first regardless of size. They are the debris of a transfer
	 * that died, nobody can name them (a partial is invisible to [path] until it seals), and an
	 * interrupted upload resumes correctly from a shorter prefix or from nothing at all.
	 */
	sweep({ maxBytes, partMaxAgeMs = 3_600_000, now = Date.now() }: BlobSweepOptions): number {
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

		// Partials count toward the ceiling as well as sealed blobs. Excluding them would leave the
		// only unbounded write on this disk outside the only bound on it: an unfinished transfer is
		// reclaimed by AGE, so until its hour is up a caller could hold arbitrary space by simply
		// never sending a final chunk, and none of it would register against the budget.
		//
		// Coldest first, by the mtime that reads refresh, so a blob being fetched right now sorts to
		// the back rather than the front. A partial is evicted before a sealed blob of the same age:
		// nothing can name a partial yet, so losing one costs a resume rather than the file.
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

	/** Every file under the root, flat, with what a sweep needs to decide about it. */
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
			// An `.ingest-*` staging file sits at the root rather than in a fanout dir, so the root's
			// own non-directory children are debris too.
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

	/**
	 * Promote a finished `.part` to its final name, but ONLY if its bytes hash to the name it
	 * claims. A blob that fails is destroyed rather than left to be re-fetched into the same
	 * corrupt state, which is why a partial upload is invisible instead of subtly wrong.
	 */
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

/** Mark a file as used now. Best-effort: a store that cannot stamp is still a working store, it
 * just evicts in a worse order. */
function touch(file: string): void {
	try {
		const at = new Date();
		fs.utimesSync(file, at, at);
	} catch {
		// A read-only mount or a file removed under us; neither is worth failing the read over.
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
