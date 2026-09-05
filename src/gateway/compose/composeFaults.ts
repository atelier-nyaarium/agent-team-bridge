// The fault port: the only way a test breaks or inspects a running gateway.

import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { type RowEnvelope, signRowEnvelope } from "../../shared/schemasInbox.js";
import type { FederationSlice } from "../boot.js";
import type { SessionsStage } from "./composeSessions.js";
import type { FederationContext } from "./federationContext.js";
import type { GatewayFaultPort, PeerAddress } from "./gatewayTypes.js";

export interface FaultsStageDeps {
	context: FederationContext;
	sessions: Pick<SessionsStage, "sessionStore">;
}

export function composeFaults({ context, sessions }: FaultsStageDeps): GatewayFaultPort {
	function federated(): FederationSlice {
		const slice = context.slice();
		if (!slice) throw new Error("this Gateway is not federated");
		return slice;
	}

	return {
		dropRouterLink: () => context.slice()?.routerClient.stop(),
		routerRegistered: () => context.slice()?.routerClient.isRegistered() ?? false,
		routerIncarnation: () => context.slice()?.routerClient.incarnation() ?? null,
		heldEpochs: () => context.contentKeys().epochs(),
		sessionRecord: (team) => sessions.sessionStore.getByTeam(team),
		forgePeerRow: async (target: PeerAddress, address: string, envelope: RowEnvelope, op: unknown) => {
			const slice = federated();
			const identity = context.boot();
			if (!identity) throw new Error("this Gateway holds no federation identity");
			const answer = await slice.routerClient.callInboxTool("inbox_append", {
				address,
				row: {
					envelope,
					producerSig: signRowEnvelope(envelope, identity.identity.sign.priv),
					body: slice.sealer.seal(target, op),
				},
				opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ address, op })) },
			});
			return answer.result;
		},
		sealForPeer: (target: PeerAddress, op: unknown) => federated().sealer.seal(target, op),
		routerCall: (name, params) => federated().routerClient.callTool(name, params),
		routerInboxCall: (name, params) => federated().routerClient.callInboxTool(name, params),
	};
}
