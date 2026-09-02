import { describe, expect, it, vi } from "vitest";
import { type BlobRef, createBlobUploader } from "../gateway/router/blobUploader.js";
import { BLOB_CHUNK_BYTES } from "../shared/router-protocol.js";

type BlobEntry = { bytes: Buffer; complete: boolean };

function blobStub(entries: Record<string, BlobEntry>) {
	return {
		stat: vi.fn((blobId: string) => {
			const entry = entries[blobId];
			return entry.complete
				? { have: entry.bytes.length, size: entry.bytes.length, complete: true }
				: { have: entry.bytes.length, complete: false };
		}),
		read: vi.fn((blobId: string, offset: number, length: number) => {
			const bytes = entries[blobId].bytes.subarray(offset, offset + length);
			return { bytes, eof: offset + bytes.length >= entries[blobId].bytes.length };
		}),
	};
}

const lease = { id: "lease-1", generation: 1 };
const ref: BlobRef = { kind: "entry", id: "entry-1" };

describe("blob uploader", () => {
	it("uploads a complete small blob in one final chunk", async () => {
		const blobId = "small";
		const bytes = Buffer.from("small blob");
		const blobs = blobStub({ [blobId]: { bytes, complete: true } });
		const call = vi
			.fn()
			.mockResolvedValueOnce({ result: { kind: "lease", lease } })
			.mockResolvedValueOnce({ result: { have: bytes.length, complete: true } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "cache")).toEqual({ kind: "uploaded" });
		expect(call).toHaveBeenNthCalledWith(1, "blob_begin", { blobId, size: bytes.length, store: "cache" });
		expect(call).toHaveBeenNthCalledWith(2, "blob_chunk", {
			blobId,
			store: "cache",
			lease,
			offset: 0,
			bytes: bytes.toString("base64"),
			final: true,
		});
	});

	it("uploads larger blobs in ordered chunks with only the last final", async () => {
		const blobId = "large";
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES + 7, 65);
		const blobs = blobStub({ [blobId]: { bytes, complete: true } });
		const call = vi
			.fn()
			.mockResolvedValueOnce({ result: { kind: "lease", lease } })
			.mockResolvedValue({ result: { have: bytes.length, complete: true } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "cache")).toEqual({ kind: "uploaded" });
		expect(call).toHaveBeenCalledTimes(3);
		expect(call.mock.calls[1][1]).toEqual({
			blobId,
			store: "cache",
			lease,
			offset: 0,
			bytes: bytes.subarray(0, BLOB_CHUNK_BYTES).toString("base64"),
			final: false,
		});
		expect(call.mock.calls[2][1]).toEqual({
			blobId,
			store: "cache",
			lease,
			offset: BLOB_CHUNK_BYTES,
			bytes: bytes.subarray(BLOB_CHUNK_BYTES).toString("base64"),
			final: true,
		});
	});

	it("answers already_held when begin reports exists without sending a chunk", async () => {
		const blobId = "held";
		const bytes = Buffer.from("already here");
		const blobs = blobStub({ [blobId]: { bytes, complete: true } });
		const call = vi.fn().mockResolvedValue({ result: { kind: "exists" } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "held", ref)).toEqual({ kind: "already_held" });
		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith("blob_begin", { blobId, size: bytes.length, store: "held", ref });
	});

	it("answers failed when begin reports quota without sending a chunk", async () => {
		const blobId = "quota";
		const blobs = blobStub({ [blobId]: { bytes: Buffer.from("too much"), complete: true } });
		const call = vi.fn().mockResolvedValue({ result: { kind: "quota" } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "cache")).toEqual({ kind: "failed", error: "begin refused" });
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("answers failed and stops when a chunk reports a gap", async () => {
		const blobId = "gap";
		const bytes = Buffer.from("chunk failure");
		const blobs = blobStub({ [blobId]: { bytes, complete: true } });
		const call = vi
			.fn()
			.mockResolvedValueOnce({ result: { kind: "lease", lease } })
			.mockResolvedValueOnce({ result: { kind: "gap" } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "cache")).toEqual({ kind: "failed", error: "gap" });
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("answers absent without calling the Router for an incomplete blob", async () => {
		const blobId = "partial";
		const blobs = blobStub({ [blobId]: { bytes: Buffer.from("part"), complete: false } });
		const call = vi.fn();
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.upload(blobId, "cache")).toEqual({ kind: "absent" });
		expect(call).not.toHaveBeenCalled();
	});

	it("answers failed without calling the Router when the gateway is unregistered", async () => {
		const blobs = blobStub({ missing: { bytes: Buffer.from("local"), complete: true } });
		const call = vi.fn();
		const uploader = createBlobUploader({ call, blobs, incarnation: () => null });

		expect(await uploader.upload("missing", "cache")).toEqual({
			kind: "failed",
			error: "Gateway is not registered",
		});
		expect(call).not.toHaveBeenCalled();
		expect(blobs.stat).not.toHaveBeenCalled();
	});

	it("uploadAll returns uploaded and already held ids while skipping failures", async () => {
		const entries = {
			uploaded: { bytes: Buffer.from("uploaded"), complete: true },
			held: { bytes: Buffer.from("held"), complete: true },
			failed: { bytes: Buffer.from("failed"), complete: true },
		};
		const blobs = blobStub(entries);
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			if (action === "blob_begin" && params.blobId === "held") return { result: { kind: "exists" } };
			if (action === "blob_begin" && params.blobId === "failed") return { result: { kind: "quota" } };
			if (action === "blob_begin") return { result: { kind: "lease", lease } };
			return { result: { have: entries.uploaded.bytes.length, complete: true } };
		});
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		expect(await uploader.uploadAll(["uploaded", "held", "failed"], "cache")).toEqual(["uploaded", "held"]);
	});

	it("passes refs only for held uploads", async () => {
		const entries = {
			held: { bytes: Buffer.from("held"), complete: true },
			cached: { bytes: Buffer.from("cached"), complete: true },
		};
		const blobs = blobStub(entries);
		const call = vi.fn().mockResolvedValue({ result: { kind: "exists" } });
		const uploader = createBlobUploader({ call, blobs, incarnation: () => 1 });

		await uploader.upload("held", "held", ref);
		await uploader.upload("cached", "cache");

		expect(call).toHaveBeenNthCalledWith(1, "blob_begin", {
			blobId: "held",
			size: entries.held.bytes.length,
			store: "held",
			ref,
		});
		expect(call).toHaveBeenNthCalledWith(2, "blob_begin", {
			blobId: "cached",
			size: entries.cached.bytes.length,
			store: "cache",
		});
	});
});
