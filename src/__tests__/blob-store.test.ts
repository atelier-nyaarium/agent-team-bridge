import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobStore, blobIdFor, isBlobId } from "../shared/blob-store.js";

////////////////////////////////
//  Golden corpus
//
//  tests/fixtures/blob/_manifest.json is iterated by this suite AND by the Android
//  BlobStoreTest, so a chunk-boundary or digest rule cannot be honored by only one runtime.

interface Chunk {
	offset: number;
	text: string;
	final: boolean;
}

interface Case {
	name: string;
	content: string;
	blobId: string;
	chunks: Chunk[];
	corruptLastChunkTo?: string;
	expect: "complete" | "throws" | "rejected";
}

const corpus = (
	JSON.parse(fs.readFileSync(path.join(__dirname, "../../tests/fixtures/blob/_manifest.json"), "utf8")) as {
		cases: Case[];
	}
).cases;

describe("blob store", () => {
	let root: string;
	let store: BlobStore;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
		store = new BlobStore(root);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("names a blob by the digest of its own bytes", () => {
		const id = blobIdFor(Buffer.from("hello blob"));
		expect(isBlobId(id)).toBe(true);
		expect(id).toBe(blobIdFor(Buffer.from("hello blob")));
		expect(id).not.toBe(blobIdFor(Buffer.from("hello blobs")));
	});

	it("corpus blobIds agree with this runtime's digest", () => {
		for (const c of corpus) {
			expect(blobIdFor(Buffer.from(c.content)), c.name).toBe(c.blobId);
		}
	});

	it.each(corpus.map((c) => [c.name, c] as const))("%s", (_, c) => {
		const write = (chunk: Chunk, i: number) => {
			const last = i === c.chunks.length - 1;
			const text = last && c.corruptLastChunkTo ? c.corruptLastChunkTo : chunk.text;
			return store.write(c.blobId, chunk.offset, Buffer.from(text), chunk.final);
		};

		if (c.expect === "throws") {
			expect(() => c.chunks.forEach(write)).toThrow();
			// A refused gap must not leave the blob readable either.
			expect(store.stat(c.blobId).complete).toBe(false);
			expect(store.path(c.blobId)).toBeNull();
			return;
		}

		c.chunks.forEach(write);

		if (c.expect === "rejected") {
			// Bytes that do not hash to the name they claim never become readable, and the
			// partial is destroyed rather than left to be resumed into the same corrupt state.
			expect(store.stat(c.blobId).complete).toBe(false);
			expect(store.path(c.blobId)).toBeNull();
			return;
		}

		const stat = store.stat(c.blobId);
		expect(stat.complete).toBe(true);
		expect(stat.have).toBe(c.content.length);
		expect(fs.readFileSync(store.path(c.blobId)!, "utf8")).toBe(c.content);
	});

	it("reports have as the resume cursor while a transfer is open", () => {
		const content = "resume me please";
		const id = blobIdFor(Buffer.from(content));
		expect(store.stat(id)).toEqual({ have: 0, complete: false });
		store.write(id, 0, Buffer.from(content.slice(0, 6)), false);
		expect(store.stat(id).have).toBe(6);
		store.write(id, 6, Buffer.from(content.slice(6)), true);
		expect(store.stat(id).complete).toBe(true);
	});

	it("reads a range without materializing the whole blob", () => {
		const content = "0123456789";
		const id = blobIdFor(Buffer.from(content));
		store.write(id, 0, Buffer.from(content), true);
		expect(store.read(id, 2, 4).bytes.toString()).toBe("2345");
		expect(store.read(id, 2, 4).eof).toBe(false);
		expect(store.read(id, 8, 4)).toEqual({ bytes: Buffer.from("89"), eof: true });
		expect(store.read(id, 10, 4).eof).toBe(true);
	});

	it("refuses to hand out a path for an incomplete blob", () => {
		const id = blobIdFor(Buffer.from("not finished yet"));
		store.write(id, 0, Buffer.from("not fin"), false);
		expect(store.path(id)).toBeNull();
		expect(() => store.read(id, 0, 4)).toThrow(/not complete/);
	});

	it("ingests a local file by streaming it, and a second ingest of the same bytes dedups", () => {
		const src = path.join(root, "source.bin");
		fs.writeFileSync(src, "the same bytes");
		const first = store.ingestFile(src);
		const second = store.ingestFile(src);
		expect(second).toBe(first);
		expect(store.stat(first).complete).toBe(true);
		expect(fs.readFileSync(store.path(first)!, "utf8")).toBe("the same bytes");
	});

	////////////////////////////////
	//  Sweep: the only thing that reclaims, since nothing reference-counts a blob

	it("evicts the coldest blobs until the store is back under its ceiling", () => {
		const cold = blobIdFor(Buffer.alloc(100, "c"));
		const warm = blobIdFor(Buffer.alloc(100, "w"));
		store.write(cold, 0, Buffer.alloc(100, "c"), true);
		fs.utimesSync(store.path(cold)!, new Date(1), new Date(1));
		store.write(warm, 0, Buffer.alloc(100, "w"), true);

		const freed = store.sweep({ maxBytes: 150 });

		expect(freed).toBe(100);
		expect(store.path(cold)).toBeNull();
		expect(store.path(warm)).not.toBeNull();
	});

	it("leaves everything alone while the store is under its ceiling", () => {
		const id = blobIdFor(Buffer.from("small"));
		store.write(id, 0, Buffer.from("small"), true);

		expect(store.sweep({ maxBytes: 1_000_000 })).toBe(0);
		expect(store.path(id)).not.toBeNull();
	});

	it("reclaims an abandoned transfer without waiting for the ceiling", () => {
		// A `.part` is nameless to every reader until it seals, so nothing can be pointing at it, and
		// an interrupted upload resumes correctly from nothing at all.
		const id = blobIdFor(Buffer.from("never finished"));
		store.write(id, 0, Buffer.from("never"), false);
		expect(store.stat(id).have).toBe(5);

		// Explicit `now` rather than a zero window: a just-written file's mtime can round a hair
		// ahead of Date.now(), which would make its age negative and the test flaky either way.
		const freed = store.sweep({ maxBytes: 1_000_000, partMaxAgeMs: 1000, now: Date.now() + 10_000 });

		expect(freed).toBe(5);
		expect(store.stat(id).have).toBe(0);
	});

	it("keeps a transfer that is still young, so a live upload is not swept out from under itself", () => {
		const id = blobIdFor(Buffer.from("in flight"));
		store.write(id, 0, Buffer.from("in "), false);

		expect(store.sweep({ maxBytes: 1_000_000, partMaxAgeMs: 3_600_000 })).toBe(0);
		expect(store.stat(id).have).toBe(3);
	});

	it("keeps a blob that is being read, and drops the one nobody has touched", () => {
		// Eviction order has to mean "least recently USED", not "written longest ago", or a large
		// transfer in progress is first out precisely because it started early.
		const reading = blobIdFor(Buffer.alloc(100, "r"));
		const idle = blobIdFor(Buffer.alloc(100, "i"));
		store.write(reading, 0, Buffer.alloc(100, "r"), true);
		store.write(idle, 0, Buffer.alloc(100, "i"), true);
		// The one being read is the OLDER of the two by write time, so without the read refreshing it
		// the sweep evicts exactly the wrong one. Equal timestamps would let this pass on tie order.
		const older = new Date(Date.now() - 120_000);
		const newer = new Date(Date.now() - 60_000);
		fs.utimesSync(store.path(reading)!, older, older);
		fs.utimesSync(store.path(idle)!, newer, newer);

		store.read(reading, 0, 10);
		store.sweep({ maxBytes: 150 });

		expect(store.path(reading)).not.toBeNull();
		expect(store.path(idle)).toBeNull();
	});

	it("keeps the prefix when the final chunk only partly lands, instead of destroying the transfer", () => {
		// A disk filling mid-write makes writeSync return a partial count rather than throw, leaving
		// the part shorter than the chunk that claimed to finish it. Sealing there hashes a truncated
		// file, fails, and deletes everything transferred so far to punish a lost tail. Simulated,
		// because the real trigger is a full filesystem.
		const content = Buffer.from("0123456789");
		const id = blobIdFor(content);
		store.write(id, 0, content.subarray(0, 6), false);

		const real = fs.writeSync;
		const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Buffer, off: number) =>
			// Only the first byte of the final chunk makes it to disk.
			real(fd, buf, off, 1, 6)) as unknown as typeof fs.writeSync);
		const written = store.write(id, 6, content.subarray(6), true);
		spy.mockRestore();

		expect(written.complete).toBe(false);
		// The prefix survives and is honestly reported, so the sender resumes from 7 rather than
		// starting a 10-byte transfer again into the same full disk.
		expect(written.have).toBe(7);
		expect(store.stat(id).have).toBe(7);
	});

	it("counts unfinished transfers toward the ceiling, so never finishing one is not a way around it", () => {
		// A partial is reclaimed by AGE, so if it also escaped the byte budget a caller could hold
		// arbitrary space simply by never sending a final chunk, and the store's only bound would not
		// apply to its only unbounded writer.
		for (let i = 0; i < 5; i++) {
			const id = blobIdFor(Buffer.alloc(100, String(i)));
			store.write(id, 0, Buffer.alloc(100, String(i)), false);
		}

		// Well inside partMaxAgeMs, so age reclaims nothing here; only the ceiling can.
		const freed = store.sweep({ maxBytes: 250, partMaxAgeMs: 3_600_000 });

		expect(freed).toBeGreaterThanOrEqual(250);
	});

	it("evicts an unfinished transfer before a sealed blob of the same age", () => {
		// Nothing can name a partial yet, so losing one costs a resume; losing a sealed blob loses
		// the file, because there is no re-fetch path.
		const sealedId = blobIdFor(Buffer.alloc(100, "s"));
		store.write(sealedId, 0, Buffer.alloc(100, "s"), true);
		const partialId = blobIdFor(Buffer.alloc(200, "p"));
		store.write(partialId, 0, Buffer.alloc(100, "p"), false);
		// Equal mtimes on everything, so age cannot decide it and only the tiebreak can. Set by
		// walking the root rather than rebuilding internal paths by hand.
		const same = new Date(Date.now() - 60_000);
		for (const dir of fs.readdirSync(root)) {
			const dirPath = path.join(root, dir);
			if (!fs.statSync(dirPath).isDirectory()) continue;
			for (const name of fs.readdirSync(dirPath)) fs.utimesSync(path.join(dirPath, name), same, same);
		}

		store.sweep({ maxBytes: 150, partMaxAgeMs: 3_600_000 });

		expect(store.path(sealedId)).not.toBeNull();
		expect(store.stat(partialId).have).toBe(0);
	});

	it("survives a root that does not exist yet", () => {
		const fresh = new BlobStore(path.join(root, "never-written"));
		expect(fresh.sweep({ maxBytes: 0 })).toBe(0);
	});

	it("rejects anything that is not a blob id rather than treating it as a path", () => {
		for (const bad of ["", "sha256-xyz", "../escape", `sha256-${"F".repeat(64)}`]) {
			expect(() => store.stat(bad), bad).toThrow(/not a blob id/);
		}
	});
});
