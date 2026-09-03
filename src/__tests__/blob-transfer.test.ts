import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlobFetchOutcome } from "../gateway/blobOps.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";

const wire = vi.hoisted(() => ({
	root: "",
	routes: [] as string[],
	putsBeforeFailure: null as number | null,
}));

vi.mock("../mcp/bridge/helpers.js", () => ({
	opLedgerRefusal: () => null,
	routerPost: async (route: string, body: Record<string, unknown>) => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const { BlobStore: Store } = await import("../shared/blob-store.js");
		wire.routes.push(route);
		if (route === "/blob/put" && wire.putsBeforeFailure !== null) {
			if (wire.putsBeforeFailure === 0) {
				wire.putsBeforeFailure = null;
				throw new Error("link dropped");
			}
			wire.putsBeforeFailure -= 1;
		}
		return answerBlobOp(new Store(wire.root), { kind: route.replace("/blob/", "blob_"), ...body } as never);
	},
}));

const TMP_ROOT = os.tmpdir();
const REAL_TMPDIR = process.env.TMPDIR;

describe("moving bytes between an agent and the gateway", () => {
	let scratch: string;
	let source: string;

	beforeEach(async () => {
		scratch = fs.mkdtempSync(path.join(TMP_ROOT, "blob-transfer-"));
		wire.root = path.join(scratch, "gateway");
		wire.routes = [];
		wire.putsBeforeFailure = null;
		source = path.join(scratch, "payload.bin");
		process.env.TMPDIR = scratch;
	});

	afterEach(() => {
		if (REAL_TMPDIR === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = REAL_TMPDIR;
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	async function transfer(bytes: Buffer): Promise<Buffer> {
		fs.writeFileSync(source, bytes);
		const { agentStagingRoot, downloadBlob, uploadBlob } = await import("../mcp/blobTransfer.js");
		const blobId = await uploadBlob(source);
		new BlobStore(agentStagingRoot()).remove(blobId);
		return fs.readFileSync(await downloadBlob(blobId));
	}

	function expectSameBytes(got: Buffer, want: Buffer): void {
		expect({ length: got.length, digest: blobIdFor(got) }).toEqual({
			length: want.length,
			digest: blobIdFor(want),
		});
	}

	it("delivers the same bytes it was handed", async () => {
		const bytes = Buffer.from("a modest attachment");
		expectSameBytes(await transfer(bytes), bytes);
	});

	it("delivers a payload larger than one chunk, and never reads more than a chunk at a time", async () => {
		const { BLOB_CHUNK_BYTES } = await import("../shared/router-protocol.js");
		// Exercise final short chunk.
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 7, "x");
		bytes.write("head", 0);
		bytes.write("tail", bytes.length - 4);

		expectSameBytes(await transfer(bytes), bytes);
		expect(wire.routes.filter((r) => r === "/blob/put")).toHaveLength(3);
		expect(wire.routes.filter((r) => r === "/blob/get")).toHaveLength(3);
	});

	it("delivers an empty file rather than reporting it sent and landing nothing", async () => {
		expectSameBytes(await transfer(Buffer.alloc(0)), Buffer.alloc(0));
	});

	it("costs one round trip when the gateway already holds the bytes", async () => {
		const bytes = Buffer.from("sent once, attached twice");
		await transfer(bytes);
		wire.routes = [];

		const { uploadBlob } = await import("../mcp/blobTransfer.js");
		await uploadBlob(source);

		expect(wire.routes).toEqual(["/blob/stat"]);
	});

	it("resumes an interrupted upload from where it stopped instead of restarting", async () => {
		const { BLOB_CHUNK_BYTES } = await import("../shared/router-protocol.js");
		const { downloadBlob, uploadBlob } = await import("../mcp/blobTransfer.js");
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 3, "y");
		bytes.write("tail", bytes.length - 4);
		fs.writeFileSync(source, bytes);

		wire.putsBeforeFailure = 1;
		await expect(uploadBlob(source)).rejects.toThrow(/link dropped/);

		wire.routes = [];
		const blobId = await uploadBlob(source);

		expect(wire.routes.filter((r) => r === "/blob/put")).toHaveLength(2);
		expectSameBytes(fs.readFileSync(await downloadBlob(blobId)), bytes);
	});

	it("hands out nothing for bytes that do not hash to the name they claim", async () => {
		const { agentStagingRoot, downloadBlob, uploadBlob } = await import("../mcp/blobTransfer.js");
		fs.writeFileSync(source, "honest bytes");
		const blobId = await uploadBlob(source);

		new BlobStore(agentStagingRoot()).remove(blobId);
		const served = new BlobStore(wire.root).path(blobId)!;
		fs.writeFileSync(served, "tampered!!!");

		await expect(downloadBlob(blobId)).rejects.toThrow(/verification/);
		expect(new BlobStore(agentStagingRoot()).path(blobId)).toBeNull();
	});

	it("pulls a blob in from the Gateway that holds it, so a client only ever asks its own", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const holder = new BlobStore(path.join(scratch, "holder"));
		const asked = new BlobStore(path.join(scratch, "asked"));
		const bytes = Buffer.from("held somewhere else entirely");
		const blobId = blobIdFor(bytes);
		holder.write(blobId, 0, bytes, true);

		expect(asked.path(blobId)).toBeNull();
		const fetcher = async (id: string, from: string) => {
			expect(from).toBe("gw-holder");
			const r = holder.read(id, 0, bytes.length);
			return asked.write(id, 0, r.bytes, r.eof).complete ? ("fetched" as const) : ("unreachable" as const);
		};
		const res = (await answerBlobOp(
			asked,
			{ kind: "blob_get", blobId, offset: 0, length: 1024, fromGateway: "gw-holder" },
			fetcher,
		)) as { chunk?: string; eof: boolean };

		expect(Buffer.from(res.chunk ?? "", "base64").toString()).toBe("held somewhere else entirely");
		expect(asked.path(blobId)).not.toBeNull();
	});

	it("a proven-absent pull answers { absent: true } instead of throwing the ordinary read", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const empty = new BlobStore(path.join(scratch, "proven-empty"));
		const res = (await answerBlobOp(
			empty,
			{
				kind: "blob_get",
				blobId: blobIdFor(Buffer.from("nowhere")),
				offset: 0,
				length: 1024,
				fromGateway: "gw-h",
			},
			async () => "absent" as const,
		)) as { absent?: boolean; eof: boolean };
		expect(res).toEqual({ eof: false, absent: true });

		await expect(
			answerBlobOp(
				empty,
				{
					kind: "blob_get",
					blobId: blobIdFor(Buffer.from("nowhere")),
					offset: 0,
					length: 1024,
					fromGateway: "gw-h",
				},
				async () => "unreachable" as const,
			),
		).rejects.toThrow();

		const partialBytes = Buffer.alloc(2048, "p");
		const partialId = blobIdFor(partialBytes);
		empty.write(partialId, 0, partialBytes.subarray(0, 1024), false);
		await expect(
			answerBlobOp(
				empty,
				{ kind: "blob_get", blobId: partialId, offset: 0, length: 1024, fromGateway: "gw-h" },
				async () => "absent" as const,
			),
		).rejects.toThrow();
	});

	it("never turns a stat into a cross-Gateway pull, however the caller asks", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const empty = new BlobStore(path.join(scratch, "empty"));
		let pulled = false;

		const res = (await answerBlobOp(
			empty,
			{ kind: "blob_stat", blobId: blobIdFor(Buffer.from("absent")), fromGateway: "gw-holder" },
			async () => {
				pulled = true;
				return "fetched" as const;
			},
		)) as { have: number; complete: boolean };

		expect(pulled).toBe(false);
		expect(res).toEqual({ have: 0, complete: false });
	});

	it("coalesces concurrent readers of one absent blob into a single fetch", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const holder = new BlobStore(path.join(scratch, "h2"));
		const asked = new BlobStore(path.join(scratch, "a2"));
		const bytes = Buffer.from("fetched once");
		const blobId = blobIdFor(bytes);
		holder.write(blobId, 0, bytes, true);

		let fetches = 0;
		const inFlight = new Map<string, Promise<BlobFetchOutcome>>();
		const single = (id: string) => {
			const running = inFlight.get(id);
			if (running) return running;
			const started = (async (): Promise<BlobFetchOutcome> => {
				fetches++;
				await new Promise((r) => setTimeout(r, 5));
				const r = holder.read(id, 0, bytes.length);
				return asked.write(id, 0, r.bytes, r.eof).complete ? "fetched" : "unreachable";
			})().finally(() => inFlight.delete(id));
			inFlight.set(id, started);
			return started;
		};

		await Promise.all(
			Array.from({ length: 5 }, () =>
				answerBlobOp(
					asked,
					{ kind: "blob_get", blobId, offset: 0, length: 1024, fromGateway: "gw-h2" },
					single,
				),
			),
		);

		expect(fetches).toBe(1);
	});

	it("does not go looking when the blob is already local", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const local = new BlobStore(path.join(scratch, "local"));
		const bytes = Buffer.from("already here");
		const blobId = blobIdFor(bytes);
		local.write(blobId, 0, bytes, true);
		let asked = false;

		await answerBlobOp(
			local,
			{ kind: "blob_get", blobId, offset: 0, length: 1024, fromGateway: "gw-other" },
			async () => {
				asked = true;
				return "unreachable" as const;
			},
		);

		expect(asked).toBe(false);
	});

	it("refuses a chunk over the transport cap rather than buffering it", async () => {
		const { answerBlobOp, BlobTooLarge } = await import("../gateway/blobOps.js");
		const { BLOB_CHUNK_BYTES } = await import("../shared/router-protocol.js");
		const oversize = Buffer.alloc(BLOB_CHUNK_BYTES + 1, "z");

		await expect(
			answerBlobOp(new BlobStore(wire.root), {
				kind: "blob_put",
				blobId: blobIdFor(oversize),
				offset: 0,
				chunk: oversize.toString("base64"),
				final: true,
			}),
		).rejects.toThrow(BlobTooLarge);
	});

	it("refuses a transfer that would grow past the total cap, however small its chunks", async () => {
		const { answerBlobOp, BlobTooLarge } = await import("../gateway/blobOps.js");
		const { MAX_BLOB_BYTES } = await import("../shared/router-protocol.js");
		const tail = Buffer.from("one byte too far");

		await expect(
			answerBlobOp(new BlobStore(wire.root), {
				kind: "blob_put",
				blobId: blobIdFor(tail),
				offset: MAX_BLOB_BYTES,
				chunk: tail.toString("base64"),
				final: true,
			}),
		).rejects.toThrow(BlobTooLarge);
	});

	it("clamps an oversized read instead of allocating whatever the caller named", async () => {
		const { answerBlobOp } = await import("../gateway/blobOps.js");
		const { BLOB_CHUNK_BYTES } = await import("../shared/router-protocol.js");
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 2, "w");
		fs.writeFileSync(source, bytes);
		const { uploadBlob } = await import("../mcp/blobTransfer.js");
		const blobId = await uploadBlob(source);

		const r = (await answerBlobOp(new BlobStore(wire.root), {
			kind: "blob_get",
			blobId,
			offset: 0,
			length: Number.MAX_SAFE_INTEGER,
		})) as { chunk?: string; eof: boolean };

		expect(Buffer.from(r.chunk ?? "", "base64")).toHaveLength(BLOB_CHUNK_BYTES);
		expect(r.eof).toBe(false);
	});
});
