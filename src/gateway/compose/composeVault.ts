import type { Ambient } from "../../shared/ambient.js";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { VaultRequest } from "../../shared/schemasVault.js";
import { storeKey } from "../../shared/session-id.js";
import type { VaultConsoleHandlers } from "../console/consoleTypes.js";
import { createAddressing } from "../routes/addressing.js";
import { createVaultDecisions } from "../vault/decisions.js";
import { createHelperTokens } from "../vault/helperTokens.js";
import { createVaultRequests } from "../vault/requests.js";
import { createVaultRoutes } from "../vault/vaultRoutes.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { FederationContext } from "./federationContext.js";

export interface VaultStageDeps {
	dataDir: string;
	localGatewayId: string;
	hostWsToken?: string;
	ambient: Ambient;
	context: FederationContext;
	routes: () => Pick<GatewayRoutes, "deliverToOwner">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionStore">;
}

export interface VaultStage {
	routes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	console: VaultConsoleHandlers;
	sessionEnded: (team: string) => void;
}

export function composeVault(deps: VaultStageDeps): VaultStage {
	const { ambient, context, localGatewayId, sessions } = deps;
	const decisions = createVaultDecisions({ dataDir: deps.dataDir, ambient });
	const helperTokens = createHelperTokens({ dataDir: deps.dataDir, ambient });
	const ownThread = `gateway.${localGatewayId}.vault`;
	const ownerSignPub = () => context.slice()?.allowlist.ownerSignPub ?? null;

	/** Helpers use the gateway's vault thread. */
	const threadKey = (sessionTarget: string, owner: string): string => {
		if (sessionTarget.startsWith("helper.")) return ownThread;
		try {
			const { localAddress } = createAddressing({
				config: { localGatewayId, localDomainId: context.domainId() },
			});
			return storeKey({ kind: "conv", conversationId: ownerKeyId(owner), address: localAddress(sessionTarget) });
		} catch {
			return ownThread;
		}
	};

	const deliver = (request: VaultRequest): boolean | typeof MIGRATING => {
		const owner = ownerSignPub();
		if (!owner) return false;
		const entry: ConsolePushEntry = {
			kind: "plugin_action",
			session_id: threadKey(request.sessionTarget, owner),
			pluginId: "vault",
			actionType: "request",
			payload: request,
		};
		return deps.routes().deliverToOwner({ entry, dedupeKey: `vault:${request.requestId}`, label: "vault" });
	};

	const requests = createVaultRequests({
		ambient,
		deliver,
		openTyped: (envelope, requestId) => context.slice()?.vaultClient.openTyped(envelope, requestId) ?? null,
		onApproved: (request, decision) => {
			if (request.kind !== "entry") return;
			decisions.grant(
				decision,
				{ entryId: request.entryId, shape: request.shape, sessionTarget: request.sessionTarget },
				ambient.now(),
			);
		},
	});

	const routes = createVaultRoutes({
		client: () => context.slice()?.vaultClient ?? null,
		decisions,
		requests,
		helperTokens,
		ambient,
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
		notifyOwner: (title, body) => {
			deps.routes().deliverToOwner({
				entry: { kind: "notice", session_id: ownThread, title, summary: body, body },
				dedupeKey: ambient.newId(),
				label: "vault",
			});
		},
		hostToken: deps.hostWsToken,
	});

	return {
		routes,
		console: {
			answer: (requestId, decision, value) => requests.answer(requestId, decision, value),
			grants: () => ({ grants: decisions.list(ambient.now()) }),
			revoke: (grantId) => ({ revoked: decisions.revoke(grantId) || helperTokens.revoke(grantId) }),
		},
		sessionEnded: (team) => {
			decisions.sessionEnded(team);
			requests.sessionEnded(team);
		},
	};
}
