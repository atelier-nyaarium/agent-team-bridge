import type { FederatedOp } from "../shared/federation-protocol.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/router-protocol.js";

////////////////////////////////
//  Interfaces & Types

export interface BlobFetcherDeps {
	/** This Gateway's byte store. Absent in tests that never move bytes, which makes a cross-Gateway
	 * fetch a clean refusal rather than a crash. */
	blobStore?: import("../shared/blob-store.js").BlobStore;
	/** The disjoint cross-Domain peer set, scanned for every Domain a holder's gateway id could mean. */
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	localGatewayId: string;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	/** In-progress cross-Gateway fetches, keyed by blob. Cleared on settle, so this is a coalescer
	 * rather than a cache: a later reader of an absent blob still triggers a fresh attempt. Owned by
	 * the caller, so a routes rebuild does not un-coalesce the fetches already running. */
	inFlight: Map<string, Promise<boolean>>;
}

////////////////////////////////
//  Functions & Helpers

export function createBlobFetcher({
	blobStore,
	crossDomainPeers,
	localGatewayId,
	relayToGateway,
	inFlight,
}: BlobFetcherDeps) {
	/**
	 * Pull a whole blob in from the Gateway that holds it, and report whether this Gateway now has it.
	 *
	 * The hop that makes an attachment survive routing. Bytes live on ONE Gateway while the message
	 * naming them routes by its own rules, so a receiver regularly asks a Gateway that never had
	 * them. Rather than teaching every client which Gateway holds what, a client always asks its own
	 * and this fills the gap behind it, caching the result. Content addressing means the cache needs
	 * no invalidation, and a re-fetch of something already held costs one stat.
	 *
	 * Bounded exactly like every other transfer: a range at a time, against MAX_BLOB_BYTES, refusing
	 * a peer whose cursor stops advancing. A failure returns false rather than throwing, because the
	 * caller's next move is to report the file unavailable, not to fail the whole message.
	 */
	function fetchBlobFromGateway(blobId: string, fromGateway: string): Promise<boolean> {
		// Single-flight per blob. A client-facing door now initiates outbound mesh traffic, and while
		// the bytes are absent every request re-enters here, so concurrent readers of one attachment
		// would each open their own 16-round-trip relay loop for identical content. They share one.
		const running = inFlight.get(blobId);
		if (running) return running;
		const started = runBlobFetch(blobId, fromGateway).finally(() => inFlight.delete(blobId));
		inFlight.set(blobId, started);
		return started;
	}

	/**
	 * Every Domain a holder's gateway id could mean, most likely first.
	 *
	 * A gateway id defaults to the machine's hostname and duplicates are an anticipated condition
	 * (see GATEWAY_ID in docker-compose.yml), so a friend's `desktop` and my own `desktop` are the
	 * same string. `sealTargetFor` is local-first by deliberate design, which is right for a SEND -
	 * misrouting a message is a disclosure - but wrong for a fetch, where local-first silently asks a
	 * sibling that never held the file.
	 *
	 * So a fetch tries every candidate rather than betting on one. That is safe here and nowhere else
	 * in this file: a blob is named by the digest of its own contents, so a wrong guess cannot return
	 * wrong bytes, only no bytes. Asking is the cheap half; being wrong about who to ask was costing
	 * the attachment entirely.
	 */
	function holderCandidates(fromGateway: string): Array<string | undefined> {
		const domains = (crossDomainPeers?.all() ?? [])
			.filter((p) => p.friendGatewayId === fromGateway)
			.map((p) => p.friendDomainId);
		// Undefined first: the bare form is the local/same-Domain resolution and the common case.
		return [undefined, ...domains];
	}

	async function runBlobFetch(blobId: string, fromGateway: string): Promise<boolean> {
		if (!blobStore || fromGateway === localGatewayId) return false;
		for (const domain of holderCandidates(fromGateway)) {
			if (await fetchBlobFrom(blobId, fromGateway, domain)) return true;
		}
		return false;
	}

	async function fetchBlobFrom(blobId: string, fromGateway: string, fromDomain?: string): Promise<boolean> {
		if (!blobStore) return false;
		let offset = blobStore.stat(blobId).have;
		for (;;) {
			if (offset > MAX_BLOB_BYTES) return false;
			const relay = await relayToGateway(
				fromGateway,
				{ kind: "blob_fetch", blobId, offset, length: BLOB_CHUNK_BYTES },
				fromDomain,
			);
			if (!relay.ok) return false;
			const res = relay.result as { chunk?: string; eof?: boolean } | undefined;
			if (!res) return false;
			const bytes = Buffer.from(res.chunk ?? "", "base64");
			if (bytes.length === 0 && !res.eof) return false;
			const written = blobStore.write(blobId, offset, bytes, !!res.eof);
			if (res.eof) return written.complete;
			if (written.have <= offset) return false;
			offset = written.have;
		}
	}

	return { fetchBlobFromGateway };
}
