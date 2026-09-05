import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { VaultRequest } from "../../shared/schemasVault.js";
import { Address, DEFAULT_SESSION, storeKey } from "../../shared/session-id.js";
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
	const decisions = openDurable(deps.dataDir, "vault-decisions", (store) => createVaultDecisions({ store, ambient }));
	const helperTokens = openDurable(deps.dataDir, "vault-helper", (store) => createHelperTokens({ store, ambient }));
	const ownerSignPub = () => context.slice()?.allowlist.ownerSignPub ?? null;
	const localAddress = (sessionTarget: string): Address =>
		createAddressing({ config: { localGatewayId, localDomainId: context.domainId() } }).localAddress(sessionTarget);

	/** A helper's request lands in the console's own conversation. */
	const threadKey = (sessionTarget: string, owner: string): string => {
		const conversationId = ownerKeyId(owner);
		const domainId = context.domainId();
		if (!domainId) throw new Error("no Domain");
		const address = sessionTarget.startsWith("helper.")
			? Address.local(domainId, localGatewayId, conversationId, DEFAULT_SESSION)
			: localAddress(sessionTarget);
		return storeKey({ kind: "conv", conversationId, address });
	};

	const deliver = (request: VaultRequest): boolean | typeof MIGRATING => {
		const owner = ownerSignPub();
		if (!owner) return false;
		let sessionId: string;
		try {
			sessionId = threadKey(request.sessionTarget, owner);
		} catch {
			return false;
		}
		const entry: ConsolePushEntry = {
			kind: "plugin_action",
			session_id: sessionId,
			pluginId: "vault",
			actionType: "request",
			payload: request,
		};
		// The answer lives in this process, so a row a restart never delivered would only mislead.
		return deps
			.routes()
			.deliverToOwner({ entry, dedupeKey: `vault:${request.requestId}`, label: "vault", volatile: true });
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
		notifyOwner: (sessionTarget, title, body) => {
			let sender: Address;
			try {
				sender = localAddress(sessionTarget);
			} catch {
				return;
			}
			deps.routes().deliverToOwner({
				entry: {
					kind: "notice",
					session_id: storeKey({ kind: "notice", sender }),
					from: sender.canonical,
					title,
					summary: body,
					body,
				},
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
