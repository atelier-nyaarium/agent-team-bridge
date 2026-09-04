import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBlobRange } from "../gateway/blobOps.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { BoardAttachmentStore } from "../shared/board-attachment-store.js";

const owner = "a".repeat(64);
const entry = "b".repeat(32);
const roots: string[] = [];
const make = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-attachments-"));
	roots.push(root);
	return { store: new BoardAttachmentStore(path.join(root, "attachments")), root };
};
const source = (root: string, name: string, bytes: string) => {
	const file = path.join(root, name);
	fs.writeFileSync(file, bytes);
	return file;
};
const blob = (name: string) => `sha256-${name.padStart(64, "0")}`;

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("board attachment store", () => {
	it("adopts bytes", () => {
		const { store, root } = make();
		const id = blob("1");
		store.adopt(owner, entry, id, source(root, "one", "one"));
		expect(store.has(owner, entry, id)).toBe(true);
	});
	it("returns the stored path", () => {
		const { store, root } = make();
		const id = blob("2");
		store.adopt(owner, entry, id, source(root, "two", "two"));
		expect(store.path(owner, entry, id)).not.toBeNull();
	});
	it("returns null for a missing path", () => expect(make().store.path(owner, entry, blob("3"))).toBeNull());
	it("does not overwrite an existing copy", () => {
		const { store, root } = make();
		const id = blob("4");
		store.adopt(owner, entry, id, source(root, "a", "first"));
		store.adopt(owner, entry, id, source(root, "b", "second"));
		expect(store.readAny(id, 0, 20)?.bytes.toString()).toBe("first");
	});
	it("reads a range", () => {
		const { store, root } = make();
		const id = blob("5");
		store.adopt(owner, entry, id, source(root, "five", "abcdef"));
		expect(store.readAny(id, 2, 2)).toEqual({ bytes: Buffer.from("cd"), eof: false });
	});
	it("reports eof for the final range", () => {
		const { store, root } = make();
		const id = blob("6");
		store.adopt(owner, entry, id, source(root, "six", "abcdef"));
		expect(store.readAny(id, 4, 8)?.eof).toBe(true);
	});
	it("reads an empty range at eof", () => {
		const { store, root } = make();
		const id = blob("7");
		store.adopt(owner, entry, id, source(root, "seven", "abc"));
		expect(store.readAny(id, 3, 1)).toEqual({ bytes: Buffer.alloc(0), eof: true });
	});
	it("finds bytes across entries", () => {
		const { store, root } = make();
		const id = blob("8");
		store.adopt(owner, entry, id, source(root, "eight", "eight"));
		expect(store.hasAny(id)).toBe(true);
	});
	it("rejects invalid blob ids", () => expect(() => make().store.has(owner, entry, "bad")).toThrow(/blob id/));
	it("rejects invalid owner ids", () => expect(() => make().store.has("bad", entry, blob("9"))).toThrow(/owner id/));
	it("rejects invalid entry ids", () =>
		expect(() => make().store.has(owner, "bad", blob("a"))).toThrow(/board entry id/));
	it("rejects invalid ids before joining paths", () =>
		expect(() => make().store.remove(owner, "../x", blob("b"))).toThrow(/board entry id/));
	it("removes one blob", () => {
		const { store, root } = make();
		const id = blob("c");
		store.adopt(owner, entry, id, source(root, "c", "c"));
		store.remove(owner, entry, id);
		expect(store.has(owner, entry, id)).toBe(false);
	});
	it("removing a missing blob is harmless", () =>
		expect(() => make().store.remove(owner, entry, blob("d"))).not.toThrow());
	it("removes an entry directory", () => {
		const { store, root } = make();
		const id = blob("e");
		store.adopt(owner, entry, id, source(root, "e", "e"));
		store.removeEntry(owner, entry);
		expect(store.has(owner, entry, id)).toBe(false);
	});
	it("removes all blobs for one entry only", () => {
		const { store, root } = make();
		const first = blob("f");
		const second = blob("10");
		store.adopt(owner, entry, first, source(root, "f", "f"));
		store.adopt(owner, "c".repeat(32), second, source(root, "ten", "ten"));
		store.removeEntry(owner, entry);
		expect(store.hasAny(first)).toBe(false);
		expect(store.hasAny(second)).toBe(true);
	});
	it("keeps identical bytes independent by entry", () => {
		const { store, root } = make();
		const id = blob("11");
		const other = "c".repeat(32);
		store.adopt(owner, entry, id, source(root, "eleven", "same"));
		store.adopt(owner, other, id, source(root, "eleven-b", "same"));
		store.remove(owner, entry, id);
		expect(store.has(owner, other, id)).toBe(true);
	});
	it("reports absent bytes as null", () => expect(make().store.readAny(blob("12"), 0, 1)).toBeNull());
	it("does not leave an adopting temp file as a hit", () => {
		const { store, root } = make();
		const id = blob("13");
		const dir = path.join(root, "attachments", owner, entry);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${id}.adopting`), "partial");
		expect(store.has(owner, entry, id)).toBe(false);
	});

	it("reads through from the cache to the durable attachment store", () => {
		const { store, root } = make();
		const bytes = Buffer.from("durable");
		const id = blobIdFor(bytes);
		store.adopt(owner, entry, id, source(root, "durable", bytes.toString()));
		const cache = new BlobStore(path.join(root, "blobs"));
		expect(readBlobRange(cache, store, id, 0, 1024)).toEqual({ bytes, eof: true });
	});

	it("fails loudly when neither store holds the blob", () => {
		const { store, root } = make();
		const cache = new BlobStore(path.join(root, "blobs"));
		const id = blobIdFor(Buffer.from("absent"));
		expect(() => readBlobRange(cache, store, id, 0, 1024)).toThrow(/not complete/);
	});
});
