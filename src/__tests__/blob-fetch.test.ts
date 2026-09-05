import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobFetcher } from "../gateway/blobFetch.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { linkedPeer } from "./helpers/cross-domain-link.js";

type Relay = Parameters<typeof createBlobFetcher>[0]["relayToGateway"];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(relayToGateway: Relay = async () => ({ ok: false, error: "unreachable" }), colliding?: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-fetch-"));
	dirs.push(dir);
	const blobStore = new BlobStore(dir);
	const content = Buffer.from("blob bytes");
	const blobId = blobIdFor(content);
	const crossDomainPeers = new CrossDomainPeers(path.join(dir, "peers"));
	if (colliding) crossDomainPeers.add(linkedPeer(colliding, "local"));
	const fetcher = createBlobFetcher({
		blobStore,
		crossDomainPeers,
		localGatewayId: "local",
		relayToGateway,
		inFlight: new Map(),
	});
	const serve: Relay = async (_gateway, op) => {
		const { offset, length } = op as { offset: number; length: number };
		const chunk = content.subarray(offset, offset + length);
		return { ok: true, result: { chunk: chunk.toString("base64"), eof: offset + chunk.length >= content.length } };
	};
	return { blobStore, blobId, content, fetcher, serve };
}

describe("createBlobFetcher", () => {
	it("fetches chunks and lands a complete blob", async () => {
		const f = setup(async (gateway, op) => f.serve(gateway, op));
		expect(await f.fetcher.fetchBlobFromGateway(f.blobId, "peer")).toBe("fetched");
		expect(f.blobStore.stat(f.blobId)).toMatchObject({ complete: true });
	});

	it("reports absent, unreachable, and self-fetch outcomes", async () => {
		const absent = setup(async () => ({ ok: true, result: { eof: false } }));
		const unreachable = setup();
		const self = setup();
		expect(await absent.fetcher.fetchBlobFromGateway(absent.blobId, "peer")).toBe("absent");
		expect(await unreachable.fetcher.fetchBlobFromGateway(unreachable.blobId, "peer")).toBe("unreachable");
		expect(await self.fetcher.fetchBlobFromGateway(self.blobId, "local")).toBe("absent");
	});

	it("tries a colliding friend Domain on a self-fetch, and a silent one keeps the blob uncertain", async () => {
		const served = setup(
			async (gateway, op, domain) => (domain === "friend" ? served.serve(gateway, op) : { ok: false }),
			"friend",
		);
		expect(await served.fetcher.fetchBlobFromGateway(served.blobId, "local")).toBe("fetched");
		const silent = setup(async () => ({ ok: false }), "friend");
		expect(await silent.fetcher.fetchBlobFromGateway(silent.blobId, "local")).toBe("unreachable");
	});
});
