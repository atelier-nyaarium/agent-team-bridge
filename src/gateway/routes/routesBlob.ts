import type { FederatedOp } from "../../shared/federation-protocol.js";
import type { GatewayConfig } from "../../shared/types.js";
import { createBlobFetcher } from "../blobFetch.js";
import type { BlobFetchOutcome } from "../blobOps.js";

export interface BlobRoutesDeps {
	config: GatewayConfig;
	ambient: Pick<import("../../shared/ambient.js").Ambient, "newId">;
	// Missing stores produce clean fetch refusals in test-only gateways.
	blobStore?: import("../../shared/blob-store.js").BlobStore;
	crossDomainPeers?: import("../federation/crossDomainPeers.js").CrossDomainPeers | null;
	contentKeyStore?: Pick<import("../federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	ownerSignPub?: (() => string | null) | null;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "callInboxTool"> | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	// Caller-owned state preserves fetch coalescing across route rebuilds.
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
