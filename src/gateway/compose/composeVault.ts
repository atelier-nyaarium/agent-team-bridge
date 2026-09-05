import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { VaultRequest, VaultRetract } from "../../shared/schemasVault.js";
import { Address, DEFAULT_SESSION, storeKey } from "../../shared/session-id.js";
import type { VaultConsoleHandlers } from "../console/consoleTypes.js";
import { createAddressing } from "../routes/addressing.js";
import { createVaultDecisions } from "../vault/decisions.js";
import { createHelperTokens } from "../vault/helperTokens.js";
import { createVaultRequests, helperTarget, isHelperTarget } from "../vault/requests.js";
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
		const address = isHelperTarget(sessionTarget)
			? Address.local(domainId, localGatewayId, conversationId, DEFAULT_SESSION)
			: localAddress(sessionTarget);
		return storeKey({ kind: "conv", conversationId, address });
	};

	const action = (
		request: VaultRequest,
		actionType: "request" | "retract",
		payload: VaultRequest | VaultRetract,
	): ConsolePushEntry | null => {
		const owner = ownerSignPub();
		if (!owner) return null;
		try {
			return {
				kind: "plugin_action",
				session_id: threadKey(request.sessionTarget, owner),
				pluginId: "vault",
				actionType,
				payload,
			};
		} catch {
			return null;
		}
	};

	const deliver = (request: VaultRequest): boolean | typeof MIGRATING => {
		const entry = action(request, "request", request);
		if (!entry) return false;
		// The answer lives in this process, so a row a restart never delivered would only mislead.
		return deps
			.routes()
			.deliverToOwner({ entry, dedupeKey: `vault:${request.requestId}`, label: "vault", volatile: true });
	};

	/** Every console drops the row, whichever road settled it. */
	const retract = (request: VaultRequest): void => {
		const entry = action(request, "retract", { requestId: request.requestId });
		if (entry)
			deps.routes().deliverToOwner({ entry, dedupeKey: `vault-retract:${request.requestId}`, label: "vault" });
	};

	const requests = createVaultRequests({
		ambient,
		deliver,
		onSettled: retract,
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
			revoke: (grantId) => {
				if (decisions.revoke(grantId)) return { revoked: true };
				if (!helperTokens.revoke(grantId)) return { revoked: false };
				// A revoked token ends its grants and open requests, as a session's end does.
				decisions.sessionEnded(helperTarget(grantId));
				requests.sessionEnded(helperTarget(grantId));
				return { revoked: true };
			},
		},
		sessionEnded: (team) => {
			decisions.sessionEnded(team);
			requests.sessionEnded(team);
		},
	};
}
