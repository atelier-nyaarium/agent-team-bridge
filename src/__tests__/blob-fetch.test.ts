import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobFetcher } from "../gateway/blobFetch.js";
import type { BlobFetchOutcome } from "../gateway/blobOps.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import type { FederatedOp } from "../shared/federation-protocol.js";
import { A, B, peersOf, xdPeer } from "./helpers/federation.js";

/** The cross-Gateway blob pull: single-flight per blob, every Domain a holder id could mean. */
describe("createBlobFetcher", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function makeStore() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-fetch-"));
		dirs.push(dir);
		return new BlobStore(dir);
	}

	/** A relay serving `content` a range at a time, recording every call it answers. */
	function servingRelay(content: Buffer, failFor?: (dstDomain?: string) => boolean) {
		const calls: { offset: number; dstDomain?: string }[] = [];
		let gate: Promise<void> | undefined;
		const relay = async (_dstGateway: string, op: FederatedOp, dstDomain?: string) => {
			if (gate) await gate;
			const { offset, length } = op as unknown as { offset: number; length: number };
			calls.push({ offset, dstDomain });
			if (failFor?.(dstDomain)) return { ok: false, error: "unreachable" };
			const chunk = content.subarray(offset, offset + length);
			return {
				ok: true,
				result: { chunk: chunk.toString("base64"), eof: offset + chunk.length >= content.length },
			};
		};
		return { relay, calls, holdUntil: (p: Promise<void>) => (gate = p) };
	}

	function fetcher(over: Partial<Parameters<typeof createBlobFetcher>[0]> = {}) {
		const inFlight = new Map<string, Promise<BlobFetchOutcome>>();
		const content = Buffer.from("the blob's own bytes");
		const blobId = blobIdFor(content);
		const serving = servingRelay(content);
		const blobStore = makeStore();
		const made = createBlobFetcher({
			blobStore,
			localGatewayId: "here",
			relayToGateway: serving.relay,
			inFlight,
			...over,
		});
		return { ...made, inFlight, content, blobId, serving, blobStore };
	}

	it("pulls a whole blob across the relay and lands it complete", async () => {
		const f = fetcher();
		await expect(f.fetchBlobFromGateway(f.blobId, "elsewhere")).resolves.toBe("fetched");
		expect(f.blobStore.stat(f.blobId).complete).toBe(true);
	});

	it("concurrent readers of one absent blob share a single fetch, and a settle clears it", async () => {
		const f = fetcher();
		let release = () => {};
		f.serving.holdUntil(new Promise<void>((r) => (release = r)));

		const first = f.fetchBlobFromGateway(f.blobId, "elsewhere");
		const second = f.fetchBlobFromGateway(f.blobId, "elsewhere");
		// One promise serves both callers; a second relay loop for identical bytes never opens.
		expect(second).toBe(first);
		release();
		await expect(first).resolves.toBe("fetched");
		// A coalescer, not a cache: nothing in-flight survives the settle.
		expect(f.inFlight.size).toBe(0);
		expect(f.serving.calls.filter((c) => c.offset === 0)).toHaveLength(1);
	});

	it("tries every Domain a holder's gateway id could mean, bare form first", async () => {
		const crossDomainPeers = peersOf(
			xdPeer(B, "aria", "desktop", generateIdentity(), A),
			xdPeer(B, "briar", "desktop", generateIdentity(), A),
		);
		const content = Buffer.from("held only by briar's desktop");
		const serving = servingRelay(content, (dstDomain) => dstDomain !== "briar");
		const f = fetcher({ crossDomainPeers, relayToGateway: serving.relay });

		await expect(f.fetchBlobFromGateway(blobIdFor(content), "desktop")).resolves.toBe("fetched");
		// A wrong guess costs one refused call, never wrong bytes (ids are content digests).
		expect(serving.calls.map((c) => c.dstDomain)).toEqual([undefined, "aria", "briar"]);
	});

	it("a peer whose cursor stops advancing mid-transfer is unreachable, never absent", async () => {
		const f = fetcher();
		// Serve the first range, then answer the follow-up with an empty non-eof chunk: a truncated
		// holder says nothing definitive about the blob existing elsewhere.
		const stalled = async (_g: string, op: FederatedOp) => {
			const { offset, length } = op as unknown as { offset: number; length: number };
			const chunk = f.content.subarray(offset, offset + length);
			return { ok: true, result: { chunk: chunk.toString("base64"), eof: false } };
		};
		const g = fetcher({ relayToGateway: stalled });
		await expect(g.fetchBlobFromGateway(g.blobId, "elsewhere")).resolves.toBe("unreachable");
	});

	it("a holder that ANSWERS with nothing from offset 0 is absent; one that never answers is not", async () => {
		// The distinction is the whole point of the tri-state: absent retires a doomed fetch (a board
		// move's terminal refusal derives from it), so a rebooting machine must never produce it.
		const f = fetcher();
		const empty = async () => ({ ok: true, result: { eof: false } });
		const g = fetcher({ relayToGateway: empty });
		await expect(g.fetchBlobFromGateway(g.blobId, "elsewhere")).resolves.toBe("absent");

		const dead = async () => ({ ok: false, error: "unreachable" });
		const h = fetcher({ relayToGateway: dead });
		await expect(h.fetchBlobFromGateway(h.blobId, "elsewhere")).resolves.toBe("unreachable");
		expect(f.serving.calls).toHaveLength(0);
	});

	it("one unreachable candidate poisons absent: a silent Domain could still be the holder", async () => {
		const crossDomainPeers = peersOf(xdPeer(B, "aria", "desktop", generateIdentity(), A));
		const mixed = async (_g: string, _op: FederatedOp, dstDomain?: string) =>
			dstDomain === undefined ? { ok: true, result: { eof: false } } : { ok: false, error: "unreachable" };
		const f = fetcher({ crossDomainPeers, relayToGateway: mixed });
		await expect(f.fetchBlobFromGateway(f.blobId, "desktop")).resolves.toBe("unreachable");
	});

	it("a self-fetch is definitively absent; a storeless gateway knows nothing", async () => {
		const f = fetcher();
		// Bytes this gateway should hold and does not: nothing anywhere will ever produce them.
		await expect(f.fetchBlobFromGateway(f.blobId, "here")).resolves.toBe("absent");
		const bare = fetcher({ blobStore: undefined });
		await expect(bare.fetchBlobFromGateway(f.blobId, "elsewhere")).resolves.toBe("unreachable");
		expect(f.serving.calls).toHaveLength(0);
		expect(bare.serving.calls).toHaveLength(0);
	});

	it("a self-fetch still tries a colliding friend Domain before calling the blob absent", async () => {
		// A friend's gateway can share this one's id (hostname defaults), and the friend can genuinely
		// be the holder. Answering "absent" without asking turned "my desktop has nothing" into
		// "nobody has it" - which is what retires a fetch for good on the console.
		const crossDomainPeers = peersOf(xdPeer(B, "aria", "here", generateIdentity(), A));
		const content = Buffer.from("held only by the friend's here");
		const serving = servingRelay(content);
		const f = fetcher({ crossDomainPeers, relayToGateway: serving.relay });

		await expect(f.fetchBlobFromGateway(blobIdFor(content), "here")).resolves.toBe("fetched");
		// The bare (self) candidate made no relay call; only the friend Domain was asked.
		expect(serving.calls.map((c) => c.dstDomain)).toEqual(["aria"]);
	});
});
