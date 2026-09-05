import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobFetcher } from "../gateway/blobFetch.js";
import { processAmbient } from "../shared/ambient.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { contentAad } from "../shared/content-envelope.js";
import { BLOB_CHUNK_BYTES } from "../shared/router-protocol.js";
import { blobChunkAad, openSealedBlobRange, sealBlobChunk, sealedBlobSize } from "../shared/sealed-blob.js";

const key = Buffer.alloc(32, 6);
const roots: string[] = [];
const base = { domainId: "domain", ownerSignPub: "owner", epoch: 5 };

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sealed blob framing", () => {
	it("rejects a spliced chunk", () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 2, 1);
		const blobId = blobIdFor(bytes);
		const first = sealBlobChunk(bytes.subarray(0, BLOB_CHUNK_BYTES), key, { ...base, blobId }, 0, false);
		const second = sealBlobChunk(bytes.subarray(BLOB_CHUNK_BYTES), key, { ...base, blobId }, 1, true);
		expect(() =>
			openSealedBlobRange(
				{ bytes: Buffer.concat([second, first]), offset: 0, size: bytes.length, epoch: 5 },
				0,
				bytes.length,
				key,
				{ domainId: base.domainId, ownerSignPub: base.ownerSignPub, blobId },
			),
		).toThrow();
	});

	it("rejects a chunk swapped from another blob", () => {
		const targetId = blobIdFor(Buffer.from("target"));
		const source = Buffer.from("source");
		const frame = sealBlobChunk(source, key, { ...base, blobId: blobIdFor(source) }, 0, true);
		expect(() =>
			openSealedBlobRange({ bytes: frame, offset: 0, size: source.length, epoch: 5 }, 0, source.length, key, {
				domainId: base.domainId,
				ownerSignPub: base.ownerSignPub,
				blobId: targetId,
			}),
		).toThrow();
	});

	it("rejects a truncated final frame", () => {
		const bytes = Buffer.from("truncated");
		const blobId = blobIdFor(bytes);
		const frame = sealBlobChunk(bytes, key, { ...base, blobId }, 0, true);
		expect(() =>
			openSealedBlobRange(
				{ bytes: frame.subarray(0, -1), offset: 0, size: bytes.length, epoch: 5 },
				0,
				bytes.length,
				key,
				{ domainId: base.domainId, ownerSignPub: base.ownerSignPub, blobId },
			),
		).toThrow("truncated");
	});

	it("rejects a truncated blob whose first chunk is relabeled final", () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 2, 4);
		const blobId = blobIdFor(bytes);
		const first = sealBlobChunk(bytes.subarray(0, BLOB_CHUNK_BYTES), key, { ...base, blobId }, 0, false);
		expect(() =>
			openSealedBlobRange(
				{ bytes: first, offset: 0, size: BLOB_CHUNK_BYTES, epoch: 5 },
				0,
				BLOB_CHUNK_BYTES,
				key,
				{ domainId: base.domainId, ownerSignPub: base.ownerSignPub, blobId },
			),
		).toThrow();
	});

	it("opens and trims a range that straddles a chunk boundary", () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES + 12, 2);
		bytes.fill(3, BLOB_CHUNK_BYTES);
		const blobId = blobIdFor(bytes);
		const frames = Buffer.concat([
			sealBlobChunk(bytes.subarray(0, BLOB_CHUNK_BYTES), key, { ...base, blobId }, 0, false),
			sealBlobChunk(bytes.subarray(BLOB_CHUNK_BYTES), key, { ...base, blobId }, 1, true),
		]);
		const opened = openSealedBlobRange(
			{ bytes: frames, offset: 0, size: bytes.length, epoch: 5 },
			BLOB_CHUNK_BYTES - 4,
			8,
			key,
			{ domainId: base.domainId, ownerSignPub: base.ownerSignPub, blobId },
		);
		expect(opened.bytes).toEqual(Buffer.from([2, 2, 2, 2, 3, 3, 3, 3]));
		expect(opened.eof).toBe(false);
	});

	it("rejects valid sealed bytes whose plaintext digest is wrong", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-reader-"));
		roots.push(root);
		const store = new BlobStore(root);
		const claimed = blobIdFor(Buffer.from("right"));
		const wrong = Buffer.from("wrong");
		const frame = sealBlobChunk(wrong, key, { ...base, blobId: claimed }, 0, true);
		const fetcher = createBlobFetcher({
			blobStore: store,
			ambient: processAmbient(),
			localGatewayId: "reader",
			relayToGateway: async () => ({ ok: false }),
			inFlight: new Map(),
			routerFetch: async () => ({
				ok: true,
				result: {
					outcome: "fetched",
					bytes: frame.toString("base64"),
					eof: true,
					sealed: true,
					epoch: 5,
					offset: 0,
					size: wrong.length,
				},
			}),
			domainId: base.domainId,
			ownerSignPub: () => base.ownerSignPub,
			contentKeys: { keyFor: () => key },
		});
		expect(await fetcher.fetchBlobFromGateway(claimed, "origin")).toBe("unreachable");
		expect(store.path(claimed)).toBeNull();
	});

	// Shared Kotlin vectors.
	it("matches the shared corpus the Kotlin twin reads", () => {
		const vectors = JSON.parse(
			fs.readFileSync(
				path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "sealed-blob", "vectors.json"),
				"utf8",
			),
		) as {
			key: string;
			context: { domainId: string; ownerSignPub: string; epoch: number; blobId: string };
			aadSample: string;
			cases: Array<{ size: number; ciphertextSize: number; frames: string[] }>;
		};
		const key = Buffer.from(vectors.key, "base64");
		expect(contentAad(blobChunkAad(vectors.context, 0, true)).toString("base64")).toBe(vectors.aadSample);
		for (const value of vectors.cases) {
			expect(sealedBlobSize(value.size)).toBe(value.ciphertextSize);
			const ciphertext = Buffer.concat(value.frames.map((frame) => Buffer.from(frame, "base64")));
			const opened = openSealedBlobRange(
				{ bytes: ciphertext, offset: 0, size: value.size, epoch: vectors.context.epoch },
				0,
				value.size,
				key,
				vectors.context,
			);
			expect(opened.bytes).toEqual(Buffer.alloc(value.size, 65));
		}
	});
});
