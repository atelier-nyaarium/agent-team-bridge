import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBlobUploader } from "../gateway/router/blobUploader.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES } from "../shared/router-protocol.js";
import { openSealedBlobRange, sealedBlobSize } from "../shared/sealed-blob.js";

const key = Buffer.alloc(32, 7);
const ownerSignPub = "owner";
const domainId = "domain";
const lease = { id: "lease-1", generation: 1 };

function blobStub(bytes: Buffer, complete = true) {
	return {
		stat: vi.fn(() =>
			complete
				? { have: bytes.length, size: bytes.length, complete: true }
				: { have: bytes.length, complete: false },
		),
		read: vi.fn((_blobId: string, offset: number, length: number) => ({
			bytes: bytes.subarray(offset, offset + length),
			eof: offset + length >= bytes.length,
		})),
	};
}

function blobMapStub(entries: Record<string, Buffer>) {
	return {
		stat: vi.fn((blobId: string) => ({
			have: entries[blobId].length,
			size: entries[blobId].length,
			complete: true,
		})),
		read: vi.fn((blobId: string, offset: number, length: number) => ({
			bytes: entries[blobId].subarray(offset, offset + length),
			eof: offset + length >= entries[blobId].length,
		})),
	};
}

function uploader(
	bytes: Buffer,
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>,
	complete = true,
) {
	return createBlobUploader({
		call,
		blobs: blobStub(bytes, complete),
		incarnation: () => 1,
		domainId,
		ownerSignPub: () => ownerSignPub,
		keys: { epochs: () => [3], keyFor: () => key },
	});
}

describe("blob uploader", () => {
	it("declares and uploads the exact sealed bytes", async () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES + 7, 65);
		const blobId = blobIdFor(bytes);
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			return action === "blob_begin" ? { result: { kind: "lease", lease } } : { result: { complete: true } };
		});

		expect(await uploader(bytes, call).upload(blobId, "cache")).toEqual({ kind: "uploaded" });
		const begin = calls[0].params;
		const frames = calls.slice(1).map((entry) => Buffer.from(entry.params.bytes as string, "base64"));
		const ciphertext = Buffer.concat(frames);
		expect(begin).toMatchObject({
			blobId,
			size: bytes.length,
			ciphertextSize: sealedBlobSize(bytes.length),
			ciphertextDigest: `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`,
			epoch: 3,
			store: "cache",
		});
		expect(calls.slice(1).map((entry) => entry.params.final)).toEqual([false, true]);
		expect(frames[0].subarray(0, 12)).not.toEqual(frames[1].subarray(0, 12));
		const opened = openSealedBlobRange(
			{ bytes: ciphertext, offset: 0, size: bytes.length, epoch: 3 },
			0,
			bytes.length,
			key,
			{ domainId, ownerSignPub, blobId },
		);
		expect(opened.bytes).toEqual(bytes);
	});

	it("seals an empty blob as one authenticated final frame", async () => {
		const bytes = Buffer.alloc(0);
		const call = vi
			.fn()
			.mockResolvedValueOnce({ result: { kind: "lease", lease } })
			.mockResolvedValueOnce({ result: { complete: true } });
		expect(await uploader(bytes, call).upload(blobIdFor(bytes), "cache")).toEqual({ kind: "uploaded" });
		expect(Buffer.from(call.mock.calls[1][1].bytes, "base64")).toHaveLength(28);
		expect(call.mock.calls[1][1].final).toBe(true);
	});

	it("does not upload incomplete or keyless blobs", async () => {
		const bytes = Buffer.from("partial");
		const call = vi.fn();
		expect(await uploader(bytes, call, false).upload(blobIdFor(bytes), "cache")).toEqual({ kind: "absent" });
		const keyless = createBlobUploader({
			call,
			blobs: blobStub(bytes),
			incarnation: () => 1,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [], keyFor: () => null },
		});
		expect(await keyless.upload(blobIdFor(bytes), "cache")).toMatchObject({ kind: "failed" });
		expect(call).not.toHaveBeenCalled();
	});

	it("stops after a Router chunk refusal", async () => {
		const bytes = Buffer.from("refused");
		const call = vi
			.fn()
			.mockResolvedValueOnce({ result: { kind: "lease", lease } })
			.mockResolvedValueOnce({ result: { kind: "gap" } });
		expect(await uploader(bytes, call).upload(blobIdFor(bytes), "cache")).toEqual({ kind: "failed", error: "gap" });
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("does not send chunks when the Router already has the blob", async () => {
		const bytes = Buffer.from("held");
		const call = vi.fn().mockResolvedValue({ result: { kind: "exists" } });
		expect(await uploader(bytes, call).upload(blobIdFor(bytes), "held", { kind: "entry", id: "e" })).toEqual({
			kind: "already_held",
		});
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("answers failed when begin reports quota without sending a chunk", async () => {
		const bytes = Buffer.from("quota");
		const call = vi.fn().mockResolvedValue({ result: { kind: "quota" } });
		expect(await uploader(bytes, call).upload(blobIdFor(bytes), "cache")).toEqual({
			kind: "failed",
			error: "begin refused",
		});
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("answers failed without calling the Router when the gateway is unregistered", async () => {
		const bytes = Buffer.from("local");
		const blobs = blobStub(bytes);
		const call = vi.fn();
		const value = createBlobUploader({
			call,
			blobs,
			incarnation: () => null,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [3], keyFor: () => key },
		});
		expect(await value.upload(blobIdFor(bytes), "cache")).toMatchObject({ kind: "failed" });
		expect(call).not.toHaveBeenCalled();
		expect(blobs.stat).not.toHaveBeenCalled();
	});

	it("uploadAll returns uploaded and already held ids while skipping failures", async () => {
		const entries = {
			uploaded: Buffer.from("uploaded"),
			held: Buffer.from("held"),
			failed: Buffer.from("failed"),
		};
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			if (action === "blob_begin" && params.blobId === "held") return { result: { kind: "exists" } };
			if (action === "blob_begin" && params.blobId === "failed") return { result: { kind: "quota" } };
			if (action === "blob_begin") return { result: { kind: "lease", lease } };
			return { result: { complete: true } };
		});
		const value = createBlobUploader({
			call,
			blobs: blobMapStub(entries),
			incarnation: () => 1,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [3], keyFor: () => key },
		});
		expect(await value.uploadAll(Object.keys(entries), "cache")).toEqual(["uploaded", "held"]);
	});

	it("passes refs only for held uploads", async () => {
		const entries = { held: Buffer.from("held"), cached: Buffer.from("cached") };
		const call = vi.fn().mockResolvedValue({ result: { kind: "exists" } });
		const value = createBlobUploader({
			call,
			blobs: blobMapStub(entries),
			incarnation: () => 1,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [3], keyFor: () => key },
		});
		const ref = { kind: "entry" as const, id: "entry-1" };
		await value.upload("held", "held", ref);
		await value.upload("cached", "cache");
		expect(call.mock.calls[0][1]).toMatchObject({ blobId: "held", store: "held", ref });
		expect(call.mock.calls[1][1]).toMatchObject({ blobId: "cached", store: "cache" });
		expect(call.mock.calls[1][1]).not.toHaveProperty("ref");
	});

	// Final verification may delete the partial. complete:false must not report an uploaded blob.
	it("reports failed when the Router does not verify the final ciphertext", async () => {
		const bytes = Buffer.from("unverified");
		const blobId = blobIdFor(bytes);
		const call = vi.fn(async (action: string) =>
			action === "blob_begin" ? { result: { kind: "lease", lease } } : { result: { complete: false } },
		);

		expect(await uploader(bytes, call).upload(blobId, "cache")).toEqual({
			kind: "failed",
			error: "ciphertext_unverified",
		});
	});

	it("uploadAll drops a blob the Router never verified", async () => {
		const entries = { good: Buffer.from("good") };
		const call = vi.fn(async (action: string) =>
			action === "blob_begin" ? { result: { kind: "lease", lease } } : { result: { complete: false } },
		);
		const value = createBlobUploader({
			call,
			blobs: blobMapStub(entries),
			incarnation: () => 1,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [3], keyFor: () => key },
		});

		expect(await value.uploadAll(["good"], "cache")).toEqual([]);
	});
});
