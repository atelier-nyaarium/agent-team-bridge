import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { isBlobId } from "./blob-store.js";

////////////////////////////////
//  Constants

/** The shape every board entry id in existence has: 32 hex from the console, `bd_` + 32 hex from the
 * MCP. `BoardEntrySchema.id` carries no pattern and `board_upsert` accepts client-authored entries,
 * so this gate is what stops an id from reaching a path segment. */
const ENTRY_ID_RE = /^(bd_)?[0-9a-f]{32}$/;

/** sha256 hex of the owner's signing key. Asserted rather than trusted: the durable board file types
 * its owner keys as a bare string, so what reaches a path here came off disk, not from the deriver. */
const OWNER_ID_RE = /^[0-9a-f]{64}$/;

////////////////////////////////
//  Class

/**
 * Attachment bytes for task board entries, owned by the entry rather than cached.
 *
 * The blob plane cannot hold these: its lifetime is a cache lifetime, it evicts coldest-first past a
 * ceiling, and a board picture attached once and opened once is by construction the coldest object in
 * it. Eviction there is terminal, so the owner's pictures would silently disappear.
 *
 * On disk: `<root>/<ownerId>/<entryId>/<blobId>`. Every segment is asserted before it is joined, and
 * the display filename is never one - it rides the entry's metadata, so a name the owner types can
 * never address a path.
 *
 * Nothing sweeps this store. That IS the durability: reclaim happens only where the plan says an
 * entry's claim on its bytes ends, which is the trash sweep and a write that drops a member.
 */
export class BoardAttachmentStore {
	constructor(private readonly root: string) {}

	/** Whether these bytes are already held for this entry. The presence check every commit runs. */
	has(ownerId: string, entryId: string, blobId: string): boolean {
		return fs.existsSync(this.filePath(ownerId, entryId, blobId));
	}

	path(ownerId: string, entryId: string, blobId: string): string | null {
		const file = this.filePath(ownerId, entryId, blobId);
		return fs.existsSync(file) ? file : null;
	}

	/** Copy bytes already verified elsewhere into the entry's own directory. Landed through a temp
	 * file and a rename, so a torn copy cannot be mistaken for a held attachment. */
	adopt(ownerId: string, entryId: string, blobId: string, source: string): void {
		const file = this.filePath(ownerId, entryId, blobId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (fs.existsSync(file)) return;
		writeFileAtomic(file, (tmp) => fs.copyFileSync(source, tmp));
	}

	/** Whether any entry holds these bytes, without reading them. */
	hasAny(blobId: string): boolean {
		return isBlobId(blobId) && this.findAny(blobId) !== null;
	}

	/**
	 * Range read by blobId ALONE, across every entry, or null if nothing holds it.
	 *
	 * The blob plane names only a blobId, so a read that falls through the cache has nothing else to
	 * search on. Any hit serves identical bytes, since the name IS the digest, which is what makes an
	 * entry-blind lookup sound here. A scan is adequate at the stated scale (a few dozen entries, ten
	 * files each) and is where an index would go if that stops being true.
	 */
	readAny(blobId: string, offset: number, length: number): { bytes: Buffer; eof: boolean } | null {
		if (!isBlobId(blobId)) return null;
		const file = this.findAny(blobId);
		if (file === null) return null;
		const size = fs.statSync(file).size;
		if (offset >= size) return { bytes: Buffer.alloc(0), eof: true };
		const want = Math.min(length, size - offset);
		const out = Buffer.alloc(want);
		const fd = fs.openSync(file, "r");
		try {
			fs.readSync(fd, out, 0, want, offset);
		} finally {
			fs.closeSync(fd);
		}
		return { bytes: out, eof: offset + want >= size };
	}

	/** Drop bytes an entry no longer names. Keyed by entry, so this can never reach another entry's
	 * copy of the same picture - which is why the same bytes attached twice cost two copies. */
	remove(ownerId: string, entryId: string, blobId: string): void {
		fs.rmSync(this.filePath(ownerId, entryId, blobId), { force: true });
	}

	/** Everything an entry held, for the trash sweep's permanent delete. Recursive, so it also takes
	 * bytes no stored list ever named: a partial adopt, or a `.adopting` temp left by a process that
	 * died mid-copy, both of which the by-name delete cannot reach. */
	removeEntry(ownerId: string, entryId: string): void {
		fs.rmSync(this.entryDir(ownerId, entryId), { recursive: true, force: true });
	}

	private findAny(blobId: string): string | null {
		for (const owner of readDirSafe(this.root)) {
			for (const entry of readDirSafe(path.join(this.root, owner))) {
				const file = path.join(this.root, owner, entry, blobId);
				if (fs.existsSync(file)) return file;
			}
		}
		return null;
	}

	private entryDir(ownerId: string, entryId: string): string {
		if (!OWNER_ID_RE.test(ownerId)) throw new Error(`not an owner id: ${ownerId}`);
		if (!ENTRY_ID_RE.test(entryId)) throw new Error(`not a board entry id: ${entryId}`);
		return path.join(this.root, ownerId, entryId);
	}

	private filePath(ownerId: string, entryId: string, blobId: string): string {
		if (!isBlobId(blobId)) throw new Error(`not a blob id: ${blobId}`);
		return path.join(this.entryDir(ownerId, entryId), blobId);
	}
}

////////////////////////////////
//  Functions & Helpers

function readDirSafe(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}
