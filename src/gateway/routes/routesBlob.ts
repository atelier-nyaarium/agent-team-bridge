import type { FederatedOp } from "../../shared/federation-protocol.js";
import type { GatewayConfig } from "../../shared/types.js";
import { createBlobFetcher } from "../blobFetch.js";
import type { BlobFetchOutcome } from "../blobOps.js";

export interface BlobRoutesDeps {
	config: GatewayConfig;
	ambient: Pick<import("../../shared/ambient.js").Ambient, "newId">;
	/** This Gateway's byte store, for pulling in a blob a peer Gateway holds. Absent in tests that
	 * never move bytes, which makes a cross-Gateway fetch a clean refusal rather than a crash. */
	blobStore?: import("../../shared/blob-store.js").BlobStore;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain.
	crossDomainPeers?: import("../federation/crossDomainPeers.js").CrossDomainPeers | null;
	contentKeyStore?: Pick<import("../federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	ownerSignPub?: (() => string | null) | null;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "callInboxTool"> | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	/** In-flight cross-Gateway fetches, owned by the caller so a rebuild does not un-coalesce them. */
	inFlight: Map<string, Promise<BlobFetchOutcome>>;
}

export function createBlobRoutes({
	config,
	ambient,
	blobStore,
	crossDomainPeers,
	contentKeyStore,
	ownerSignPub,
	routerClient,
	relayToGateway,
	inFlight,
}: BlobRoutesDeps) {
	return createBlobFetcher({
		blobStore,
		ambient,
		crossDomainPeers,
		localGatewayId: config.localGatewayId,
		relayToGateway,
		inFlight,
		routerFetch: routerClient
			? async (params) => {
					const answer = await routerClient.callInboxTool("blob_fetch", params);
					return { ok: !answer.error, result: answer.result, error: answer.error };
				}
			: undefined,
		domainId: config.localDomainId ?? undefined,
		ownerSignPub: ownerSignPub ?? undefined,
		contentKeys: contentKeyStore,
	});
}
