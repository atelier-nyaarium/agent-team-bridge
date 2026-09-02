import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlobRange } from "../gateway/blobOps.js";
import { type BoardAttachmentSink, BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { BlobStore } from "../shared/blob-store.js";
import { BoardAttachmentStore } from "../shared/board-attachment-store.js";
import { BOARD_TRASH_TTL_MS } from "../shared/board-structure.js";
import type { BoardAttachment, BoardEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const OWNER = "a".repeat(64);
const ENTRY = "b".repeat(32);

function entry(id: string, over: Partial<BoardEntry> = {}): BoardEntry {
	return { id, title: `t-${id}`, state: "open", rank: "m", ...over };
}

function attachment(bytes: string, over: Partial<BoardAttachment> = {}): BoardAttachment {
	return {
		blobId: blobIdOf(bytes),
		blobGateway: "gw-1",
		filename: `${bytes}.png`,
		mime: "image/png",
		size: bytes.length,
		...over,
	};
}

function blobIdOf(bytes: string): string {
	return `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

let dir: string;
let store: BoardStore;
let attachments: BoardAttachmentStore;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-attach-"));
	attachments = new BoardAttachmentStore(path.join(dir, "board-attachments"));
	const sink: BoardAttachmentSink = {
		released: (ownerId, entryId, blobIds) => {
			for (const blobId of blobIds) attachments.remove(ownerId, entryId, blobId);
		},
		releasedAll: (ownerId, entryId) => attachments.removeEntry(ownerId, entryId),
	};
	store = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined, undefined, sink);
	store.upsert(OWNER, [entry(ENTRY)], OWNER_ACTOR);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function hold(bytes: string, entryId = ENTRY): BoardAttachment {
	const a = attachment(bytes);
	const source = path.join(dir, `src-${bytes}`);
	fs.writeFileSync(source, bytes);
	attachments.adopt(OWNER, entryId, a.blobId, source);
	return a;
}

const setAttachments = (list: readonly BoardAttachment[], id = ENTRY) =>
	store.setAttachments(OWNER, id, list, OWNER_ACTOR);

describe("setting an entry's attachments", () => {
	it("adding then removing one leaves the survivor's bytes and reclaims only what left", () => {
		const one = hold("one");
		const two = hold("two");
		setAttachments([one, two]);
		expect(store.entry(OWNER, ENTRY)?.attachments).toHaveLength(2);

		setAttachments([one]);
		expect(store.entry(OWNER, ENTRY)?.attachments?.map((a) => a.filename)).toEqual(["one.png"]);
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(true);
		expect(attachments.has(OWNER, ENTRY, two.blobId)).toBe(false);
	});

	it("a same-count swap still reclaims the picture that left, because the diff is by membership", () => {
		const one = hold("one");
		const two = hold("two");
		setAttachments([one]);
		setAttachments([two]);
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(false);
		expect(attachments.has(OWNER, ENTRY, two.blobId)).toBe(true);
	});

	it("an empty list clears the field and releases everything the entry held", () => {
		const one = hold("one");
		setAttachments([one]);
		setAttachments([]);
		expect(store.entry(OWNER, ENTRY)?.attachments).toBeUndefined();
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(false);
	});

	it("re-sending the same list in a different order neither commits nor reclaims", () => {
		const one = hold("one");
		const two = hold("two");
		setAttachments([one, two]);
		expect(setAttachments([two, one])).toEqual({ applied: true });
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(true);
		expect(attachments.has(OWNER, ENTRY, two.blobId)).toBe(true);
	});

	it("stores sorted by blobId, so a rebuild in another order hashes identically", () => {
		const one = hold("one");
		const two = hold("two");
		setAttachments([one, two]);
		const first = store.entry(OWNER, ENTRY)?.attachments?.map((a) => a.blobId);
		setAttachments([two, one]);
		expect(store.entry(OWNER, ENTRY)?.attachments?.map((a) => a.blobId)).toEqual(first);
		expect(first).toEqual([...(first ?? [])].sort());
	});

	it("a refused write reclaims nothing", () => {
		const one = hold("one");
		setAttachments([one]);
		expect(store.setAttachments(OWNER, "no-such-entry", [], OWNER_ACTOR)).toEqual({
			applied: false,
			refused: "entry_missing",
		});
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(true);
	});
});

describe("upsert and attachments", () => {
	it("ignores an incoming list, so a move cannot land members nothing ingested", () => {
		const one = hold("one");
		setAttachments([one]);
		const forged = attachment("never-uploaded");
		store.upsert(OWNER, [{ ...entry(ENTRY), attachments: [forged] }], OWNER_ACTOR);
		expect(store.entry(OWNER, ENTRY)?.attachments?.map((a) => a.blobId)).toEqual([one.blobId]);
	});

	it("drops an incoming list on an entry it has NEVER held, which is the move's destination", () => {
		// Unknown entries cannot adopt attachment metadata.
		const fresh = "d".repeat(32);
		store.upsert(OWNER, [{ ...entry(fresh), attachments: [attachment("never-uploaded")] }], OWNER_ACTOR);
		expect(store.entry(OWNER, fresh)?.attachments).toBeUndefined();
	});

	it("preserves the stored list when an older console upserts an entry with no attachments field", () => {
		const one = hold("one");
		setAttachments([one]);
		store.upsert(OWNER, [entry(ENTRY, { title: "renamed" })], OWNER_ACTOR);
		const stored = store.entry(OWNER, ENTRY);
		expect(stored?.title).toBe("renamed");
		expect(stored?.attachments?.map((a) => a.blobId)).toEqual([one.blobId]);
	});

	it("treats a re-send differing ONLY in attachments as no change at all", () => {
		const one = hold("one");
		setAttachments([one]);
		const resent = { ...entry(ENTRY), attachments: [attachment("never-uploaded")] };
		// An unchanged write cannot adopt forged attachments.
		expect(store.upsert(OWNER, [resent], OWNER_ACTOR)).toEqual({ applied: true });
		expect(store.entry(OWNER, ENTRY)?.attachments?.map((a) => a.blobId)).toEqual([one.blobId]);
	});
});

describe("the trash sweep", () => {
	it("takes an entry's whole directory when the retention window is up", () => {
		const one = hold("one");
		setAttachments([one]);
		store.setTrashed(OWNER, ENTRY, true);
		store.sweepTrash(Date.now() + BOARD_TRASH_TTL_MS + 1);
		expect(store.entry(OWNER, ENTRY)).toBeUndefined();
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(false);
	});

	it("leaves a trashed entry's bytes alone until the window is up, so a restore still opens", () => {
		const one = hold("one");
		setAttachments([one]);
		store.setTrashed(OWNER, ENTRY, true);
		store.sweepTrash(Date.now());
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(true);
	});
});

describe("the delete half of a move", () => {
	it("leaves the origin's bytes alone, because the op carries no evidence they landed elsewhere", () => {
		// The receiver owns cleanup after attachment delivery.
		const one = hold("one");
		setAttachments([one]);
		expect(store.remove(OWNER, [ENTRY])).toEqual({ applied: true });
		expect(attachments.has(OWNER, ENTRY, one.blobId)).toBe(true);
	});
});

describe("the durable store's path segments", () => {
	it("refuses an entry id that is not the shape every real one has", () => {
		expect(() => attachments.has(OWNER, "../../federation", blobIdOf("x"))).toThrow(/board entry id/);
	});

	it("refuses an owner id that did not come off the deriver", () => {
		expect(() => attachments.has("../evil", ENTRY, blobIdOf("x"))).toThrow(/owner id/);
	});

	it("refuses a blob id that is not a sha256 name", () => {
		expect(() => attachments.has(OWNER, ENTRY, "../../../etc/passwd")).toThrow(/blob id/);
	});

	it("keys by entry, so the same bytes on two entries survive one being cleared", () => {
		const other = "c".repeat(32);
		store.upsert(OWNER, [entry(other)], OWNER_ACTOR);
		const here = hold("shared");
		hold("shared", other);
		setAttachments([here]);
		setAttachments([attachment("shared")], other);

		setAttachments([], other);
		expect(attachments.has(OWNER, ENTRY, here.blobId)).toBe(true);
	});
});

describe("serving bytes after the cache has swept", () => {
	it("reads through to the durable store, which is what a peer Gateway's door depends on", () => {
		const blobs = new BlobStore(path.join(dir, "blobs"));
		const one = hold("one");
		const served = readBlobRange(blobs, attachments, one.blobId, 0, 1024);
		expect(served.bytes.toString()).toBe("one");
		expect(served.eof).toBe(true);
	});

	it("still fails loudly when neither the cache nor any entry holds the bytes", () => {
		const blobs = new BlobStore(path.join(dir, "blobs"));
		expect(() => readBlobRange(blobs, attachments, blobIdOf("absent"), 0, 1024)).toThrow(/not complete/);
	});
});
