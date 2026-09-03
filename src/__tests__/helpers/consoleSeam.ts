import { type ConsoleHandlerDeps, createConsoleDispatcher } from "../../gateway/console/consoleHandler.js";
import { DurableOpStore } from "../../gateway/console/durableOpStore.js";
import type { WakeResult } from "../../gateway/wake.js";
import type { ConversationRegistry, TeamRegistry } from "../../gateway/websocket.js";
import type { ConsoleOp, ConsoleOpResult } from "../../shared/console-protocol.js";
import type { DurableStore } from "../../shared/durable-store.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { DELIVERY_OP_KINDS, VALUE_OP_KINDS } from "../../shared/schemasConsoleOp.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { TeamInfo } from "../../shared/types.js";

export const OWNER_PUB = "owner-pub";
export const CONVERSATION = "conv-pixel";

export function fakeDurable(): DurableStore {
	let state: unknown;
	return {
		load: () => state,
		save: (next: unknown) => {
			state = next;
		},
		saveChecked: (next: unknown) => {
			state = next;
		},
	} as DurableStore;
}

export function scriptedIds(...ids: string[]): () => string {
	let extra = 0;
	return () => ids.shift() ?? `fill${extra++}`;
}

export interface ConsoleSeamOptions {
	sessionStore?: SessionStore;
	isTrustedCatalogProject?: (name: string) => boolean;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	isWakeInFlight?: (team: string) => boolean;
	markCreateInFlight?: (team: string) => () => void;
	awaitRegister?: (team: string) => Promise<WakeResult>;
	createSessionBoundMs?: number;
	dropSessionResume?: (team: string, disposition: "release" | "cancel") => void;
}

export function makeConsoleSeam(options: ConsoleSeamOptions = {}) {
	const hostOps: HostOp[] = [];
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const sessionStore = options.sessionStore;
	const relayToHost =
		options.relayToHost ??
		(async (op: HostOp): Promise<HostOpResult> => {
			if (op.kind === "peek") return { ok: true, result: { kind: "tmux", ansi: "SCREEN", hash: "h1" } };
			if (op.kind === "listDirs") return { ok: true, result: { entries: [".config", "projects"] } };
			return { ok: true, result: { sent: true } };
		});
	const routes: ConsoleHandlerDeps["routes"] = {
		deliverToOwner: () => true,
		send: async () => new Response(JSON.stringify({ session_id: "s", status: "running" })),
		respond: () => new Response(JSON.stringify({ delivered: true })),
		teams: () => new Response("[]"),
		discover: async () => new Response("[]"),
		discoverFull: async () => ({
			teams: [] as TeamInfo[],
			coverage: { rosterKnown: true, asked: 0, answered: 0 },
		}),
	};
	const durableOpStore = new DurableOpStore(fakeDurable());
	const handler = createConsoleDispatcher({
		registry,
		conversationRegistry,
		routes,
		localGatewayId: "test-host",
		localDomainId: "test-domain",
		isTrustedCatalogProject: options.isTrustedCatalogProject ?? ((name) => name === "recipe-app"),
		sessionStore,
		relayToHost: async (op) => {
			hostOps.push(op);
			return relayToHost(op);
		},
		tryWakeTeam: options.tryWakeTeam,
		isWakeInFlight: options.isWakeInFlight,
		markCreateInFlight: options.markCreateInFlight,
		awaitRegister: options.awaitRegister,
		createSessionBoundMs: options.createSessionBoundMs,
		dropSessionResume: options.dropSessionResume,
		durableOpStore,
	});

	async function dispatch(op: ConsoleOp, opId = "op1"): Promise<ConsoleOpResult> {
		const args = [op, "pixel", CONVERSATION, opId, OWNER_PUB] as const;
		if (DELIVERY_OP_KINDS.has(op.kind)) return handler.handleDelivery(...args);
		if (VALUE_OP_KINDS.has(op.kind)) return handler.handleValue(...args);
		throw new Error(`unsupported test op kind: ${op.kind}`);
	}

	return { handler, dispatch, hostOps, sessionStore, durableOpStore };
}
