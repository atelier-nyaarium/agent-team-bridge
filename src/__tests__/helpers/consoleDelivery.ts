import { createConsoleDispatcher } from "../../gateway/console/consoleHandler.js";
import type {
	ConsoleRoutes,
	CrossDomainConsoleHandlers,
	CrossDomainShareHandlers,
} from "../../gateway/console/consoleTypes.js";
import { createRoutes } from "../../gateway/routes.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { generateIdentity } from "../../shared/crypto.js";
import { makeCtx } from "./federation.js";

export const OWNER_SIGN = generateIdentity();

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function makeValueHarness(
	options: {
		crossDomain?: Partial<CrossDomainConsoleHandlers>;
		crossDomainShare?: Partial<CrossDomainShareHandlers>;
		unlinkDomain?: (domainId: string) => { peersRemoved: number; sharesDropped: number; jobsExpired: number };
		teams?: unknown[];
	} = {},
) {
	const calls = {
		listen: 0,
		request: [] as Record<string, unknown>[],
		confirm: [] as Record<string, unknown>[],
		cancel: [] as Record<string, unknown>[],
		listenState: [] as string[],
		listPeers: 0,
		share: [] as Record<string, unknown>[],
		unshare: [] as Record<string, unknown>[],
		expire: [] as Record<string, unknown>[],
		listShares: 0,
		unlink: [] as string[],
	};
	const routes: ConsoleRoutes = {
		deliverToOwner: () => true,
		send: async () => jsonResponse({ session_id: "s", status: "running" }),
		respond: () => jsonResponse({ delivered: true }),
		teams: () => jsonResponse(options.teams ?? []),
		discover: async () => jsonResponse(options.teams ?? []),
		discoverFull: async () => ({
			teams: (options.teams ?? []) as never,
			coverage: { rosterKnown: true, asked: 0, answered: 0 },
		}),
	};
	const crossDomain: CrossDomainConsoleHandlers = {
		listen: () => {
			calls.listen++;
			return {
				listeningToken: "test-host.token",
				receiverOwnerSignPub: "receiver-owner",
				receiverGatewaySignPub: "receiver-sign",
				receiverGatewayBoxPub: "receiver-box",
				receiverDomainId: "alice",
				receiverGatewayId: "test-host",
				expiresAt: 123,
			};
		},
		request: async (args) => {
			calls.request.push(args);
			return {
				sas: "421717930842",
				requesterOwnerSignPub: args.requesterOwnerSignPub,
				receiverOwnerSignPub: "receiver-owner",
				receiverDomainId: "bob",
				receiverGatewayId: "bob-gateway",
				receiverGatewaySignPub: "receiver-sign",
				receiverGatewayBoxPub: "receiver-box",
			};
		},
		confirm: (args) => {
			calls.confirm.push(args as Record<string, unknown>);
			return { ok: true };
		},
		cancel: (args) => {
			calls.cancel.push(args as Record<string, unknown>);
			return true;
		},
		listenState: (token) => {
			calls.listenState.push(token);
			return { pairingArrived: true, pin: "pin", sas: "sas", expiresAt: 123 };
		},
		listPeers: () => {
			calls.listPeers++;
			return { peers: [{ domainId: "bob", gatewayId: "bob-gateway", ownerSignPub: "bob-owner" }] };
		},
		...options.crossDomain,
	};
	const shares = new Map<string, unknown>();
	const crossDomainShare: CrossDomainShareHandlers = {
		share: (sessionTarget, target) => {
			calls.share.push({ sessionTarget, target });
			shares.set(`${sessionTarget}:${JSON.stringify(target)}`, { sessionTarget, target });
		},
		unshare: (sessionTarget, target) => {
			calls.unshare.push({ sessionTarget, target });
			const key = `${sessionTarget}:${JSON.stringify(target)}`;
			const removed = shares.delete(key);
			return removed;
		},
		expireSessionJobsForTarget: (sessionTarget, target) => calls.expire.push({ sessionTarget, target }),
		listShares: () => {
			calls.listShares++;
			return [...shares.values()] as never;
		},
		isLinkedDomain: (domainId) => domainId === "bob",
		...options.crossDomainShare,
	};
	const handler = createConsoleDispatcher({
		registry: new Map(),
		conversationRegistry: new Map(),
		localGatewayId: "test-host",
		localDomainId: "alice",
		routes,
		crossDomain,
		crossDomainShare,
		unlinkDomain: (domainId) => {
			calls.unlink.push(domainId);
			return options.unlinkDomain?.(domainId) ?? { peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 };
		},
	});
	const dispatch = (op: ConsoleOp, opId = "op-1") =>
		handler.handleValue(op, "Pixel", "conversation", opId, "verified-owner");
	return { handler, dispatch, calls, shares };
}

export function makePushRoutes(
	options: {
		onCall?: (action: string, params: Record<string, unknown>) => unknown;
		roster?: string[];
		ownerId?: string | null;
	} = {},
) {
	const identity = generateIdentity();
	const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
	const routerClient = {
		isConnected: () => true,
		isRegistered: () => true,
		callTool: async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			return {
				result: options.onCall?.(action, params) ?? {
					gateways: (options.roster ?? []).map((gatewayId) => ({ gatewayId })),
				},
			};
		},
		callInboxTool: async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			return { result: { outcome: "accepted", seq: calls.length } };
		},
	};
	const ctx = makeCtx("hosta", {
		routerClient: routerClient as never,
		sealer: {
			seal: () => ({ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" }),
			open: () => ({}),
		} as never,
		ownerId: () => (options.ownerId === undefined ? "owner-1" : options.ownerId),
		producerSignPriv: identity.sign.priv,
		ownerSignPub: () => OWNER_SIGN.sign.pub,
		contentKeyStore: {
			seal: () => ({
				kind: "ok",
				envelope: { v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
			}),
		} as never,
		resolvesLocalGateway: (gatewayId) => gatewayId === "hosta" || gatewayId === "hostb",
	});
	return { routes: createRoutes(ctx), calls, identity };
}
