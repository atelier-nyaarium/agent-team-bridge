import type { FederatedOp } from "../shared/federation-protocol.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { openSealedBlobRange } from "../shared/sealed-blob.js";
import type { BlobFetchOutcome } from "./blobOps.js";

export interface BlobFetcherDeps {
	blobStore?: import("../shared/blob-store.js").BlobStore;
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	localGatewayId: string;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	inFlight: Map<string, Promise<BlobFetchOutcome>>;
	routerFetch?: (params: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
	domainId?: string;
	ownerSignPub?: () => string | null;
	contentKeys?: { keyFor(epoch: number): Buffer | null };
}

export function createBlobFetcher({
	blobStore,
	crossDomainPeers,
	localGatewayId,
	relayToGateway,
	inFlight,
	routerFetch,
	domainId,
	ownerSignPub,
	contentKeys,
}: BlobFetcherDeps) {
	/** Fetch and cache a blob. */
	function fetchBlobFromGateway(blobId: string, fromGateway: string): Promise<BlobFetchOutcome> {
		// Coalesce concurrent reads.
		const running = inFlight.get(blobId);
		if (running) return running;
		const started = runBlobFetch(blobId, fromGateway).finally(() => inFlight.delete(blobId));
		inFlight.set(blobId, started);
		return started;
	}

	// Try every matching Domain.
	function holderCandidates(fromGateway: string): Array<string | undefined> {
		const domains = (crossDomainPeers?.all() ?? [])
			.filter((p) => p.friendGatewayId === fromGateway)
			.map((p) => p.friendDomainId);
		return [undefined, ...domains];
	}

	async function runBlobFetch(blobId: string, fromGateway: string): Promise<BlobFetchOutcome> {
		if (!blobStore) return "unreachable";
		let sawUnreachable = false;
		for (const domain of holderCandidates(fromGateway)) {
			if (domain === undefined && fromGateway === localGatewayId) {
				if (blobStore.stat(blobId).have > 0) sawUnreachable = true;
				continue;
			}
			const outcome = await fetchBlobFrom(blobId, fromGateway, domain);
			if (outcome === "fetched") return "fetched";
			if (outcome === "unreachable") sawUnreachable = true;
		}
		// Absent requires every candidate to answer.
		return sawUnreachable ? "unreachable" : "absent";
	}

	async function fetchBlobFrom(blobId: string, fromGateway: string, fromDomain?: string): Promise<BlobFetchOutcome> {
		if (!blobStore) return "unreachable";
		let offset = blobStore.stat(blobId).have;
		for (;;) {
			if (offset > MAX_BLOB_BYTES) return "unreachable";
			const relay = routerFetch
				? await routerFetch({
						opId: crypto.randomUUID(),
						blobId,
						range: { offset, length: BLOB_CHUNK_BYTES },
						origin: { domainId: fromDomain ?? domainId, gatewayId: fromGateway },
					})
				: await relayToGateway(
						fromGateway,
						{ kind: "blob_fetch", blobId, offset, length: BLOB_CHUNK_BYTES },
						fromDomain,
					);
			if (!relay.ok) return "unreachable";
			const res = relay.result as
				| {
						outcome?: string;
						bytes?: string;
						chunk?: string;
						eof?: boolean;
						sealed?: boolean;
						epoch?: number;
						offset?: number;
						size?: number;
				  }
				| undefined;
			if (!res) return "unreachable";
			if (res.outcome && res.outcome !== "fetched") return res.outcome === "absent" ? "absent" : "unreachable";
			if (routerFetch && typeof res.sealed !== "boolean") return "unreachable";
			let bytes: Buffer = Buffer.from(res.bytes ?? res.chunk ?? "", "base64");
			let eof = !!res.eof;
			if (res.sealed) {
				const owner = ownerSignPub?.();
				const key = res.epoch === undefined ? null : contentKeys?.keyFor(res.epoch);
				if (!owner || !key || res.epoch === undefined || res.offset === undefined || res.size === undefined)
					return "unreachable";
				try {
					const opened = openSealedBlobRange(
						{ bytes, offset: res.offset, size: res.size, epoch: res.epoch },
						offset,
						BLOB_CHUNK_BYTES,
						key,
						{ domainId: domainId ?? "", ownerSignPub: owner, blobId },
					);
					bytes = opened.bytes;
					eof = opened.eof;
				} catch {
					return "unreachable";
				}
			}
			// Only an empty initial response proves absence.
			if (bytes.length === 0 && !eof) return offset === 0 ? "absent" : "unreachable";
			const written = blobStore.write(blobId, offset, bytes, eof);
			if (eof) return written.complete ? "fetched" : "unreachable";
			if (written.have <= offset) return "unreachable";
			offset = written.have;
		}
	}

	return { fetchBlobFromGateway };
}
