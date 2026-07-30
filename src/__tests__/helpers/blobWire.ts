import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { answerBlobOp } from "../../gateway/blobOps.js";
import { BlobStore, blobIdFor } from "../../shared/blob-store.js";

////////////////////////////////
//  Interfaces & Types

export interface BlobWire {
	/** The gateway's store root, for a test that wants to inspect what landed. */
	gatewayRoot: string;
	/** Answer a `/blob/*` route the way the real gateway would. */
	answer(route: string, body: unknown): Promise<unknown>;
	/** Put bytes on the gateway directly and return the reference a file would name them by. For
	 * building an inbound fixture: it stands in for whatever peer already uploaded them. */
	stage(bytes: Buffer): string;
	/** Read a blob's bytes back out of the gateway, for asserting what a producer uploaded. */
	read(blobId: string): Buffer;
	/** Remove both stores. Call from afterEach. */
	dispose(): void;
}

////////////////////////////////
//  Functions & Helpers

export function isBlobRoute(route: string): boolean {
	return route.startsWith("/blob/");
}

/**
 * A gateway that actually holds bytes, for a test whose subject moves attachments.
 *
 * Any tool that attaches a file stages it on the blob plane first, so a `routerPost` mock that
 * answers everything with `{}` reports a failed transfer. This answers the three blob routes off a
 * real store, through the gateway's own op handler rather than a second implementation of it, and
 * leaves every other route to the test's own mock.
 *
 * Both halves live under one scratch dir: the agent's staging root follows TMPDIR, so pointing that
 * here keeps a test's uploads out of the machine's real /tmp and out of the next test's way.
 */
export function mountBlobWire(): BlobWire {
	const priorTmpdir = process.env.TMPDIR;
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "blob-wire-"));
	const gatewayRoot = path.join(scratch, "gateway");
	process.env.TMPDIR = scratch;
	const store = new BlobStore(gatewayRoot);

	return {
		gatewayRoot,
		answer: (route, body) =>
			answerBlobOp(store, { kind: route.replace("/blob/", "blob_"), ...(body as object) } as never),
		stage(bytes) {
			const blobId = blobIdFor(bytes);
			store.write(blobId, 0, bytes, true);
			return blobId;
		},
		read(blobId) {
			const file = store.path(blobId);
			if (!file) throw new Error(`gateway holds no complete blob ${blobId}`);
			return fs.readFileSync(file);
		},
		dispose() {
			if (priorTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = priorTmpdir;
			fs.rmSync(scratch, { recursive: true, force: true });
		},
	};
}
