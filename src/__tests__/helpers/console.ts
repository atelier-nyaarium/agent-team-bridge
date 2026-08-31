import type { ServerWebSocket } from "bun";
import {
	type ConsoleHandlerDeps,
	type ConsoleRoutes,
	createConsoleDispatcher,
} from "../../gateway/console/consoleHandler.js";
import type { DeliverToOwner } from "../../gateway/consolePushOps.js";
import type { WakeResult } from "../../gateway/wake.js";
import type { ConversationRegistry, TeamRegistry, WsData } from "../../gateway/websocket.js";
import type { ConsoleOp, OpenedConsoleFrame } from "../../shared/console-protocol.js";
import { DeviceMailboxStore } from "../../shared/device-mailbox.js";
import type { DurableStore } from "../../shared/durable-store.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { TeamInfo } from "../../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface Harness {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	mailboxStore: DeviceMailboxStore;
	sendCalls: Record<string, unknown>[];
	respondCalls: Record<string, unknown>[];
	handler: ReturnType<typeof createConsoleDispatcher>;
}

////////////////////////////////
//  Functions & Helpers

export function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An in-memory stand-in for DurableStore (no real disk I/O). Passing the SAME instance to two
 * separately-constructed DurableOpStores simulates a gateway restart: a fresh in-memory opCache
 * (a new createConsoleDispatcher) reading the same durable snapshot a prior instance wrote. */
export function fakeDurable(): DurableStore {
	let state: unknown = null;
	return {
		load: () => state,
		save: (s: unknown) => {
			state = s;
		},
		saveChecked: (s: unknown) => {
			state = s;
		},
	} as unknown as DurableStore;
}

// Deterministic ids for collision tests.
export function scriptedIds(...ids: string[]) {
	let extra = 0;
	return () => ids.shift() ?? `fill${extra++}`;
}

// The default owner for test frames. The mailbox is keyed by this (via ownerKeyId),
// so every default frame shares one owner inbox; pass a different ownerSignPub to
// simulate a second owner.
export const OWNER_PUB = "owner-pub";
export const OWNER = ownerKeyId(OWNER_PUB);

// The handler operates on an OPENED frame (the pump unseals the wire frame first),
// so tests construct that directly. A stable signer per conversation satisfies the
// install binding; tests that exercise the binding pass an explicit signer. All
// frames share one owner by default (the inbox is owner-keyed).
export function frame(
	op: ConsoleOp,
	opId = "op1",
	device = "pixel",
	conversationId = "conv-pixel",
	signerSignPub = `signer-${conversationId}`,
	ownerSignPub = OWNER_PUB,
): OpenedConsoleFrame {
	return { opId, signerSignPub, ownerSignPub, conversationId, device, op };
}

/** A minimal non-virtual socket standing in for a real devcontainer connection. */
export function realTeamWs(team: string, subId: string): ServerWebSocket<WsData> {
	return {
		readyState: 1,
		send: () => {},
		close: () => {},
		ping: () => {},
		data: {
			teamName: team,
			subId,
			conversationId: null,
			mode: "channel",
			missedPings: 0,
			isStale: false,
			handshakeConfirmed: true,
		},
	} as unknown as ServerWebSocket<WsData>;
}

/** The funnel's real semantics for harnesses: append locally, fan on local origin. `fanOut` is
 * the spy seam tests assert relays on. */
export function makeDeliverToOwner(
	mailboxStore: DeviceMailboxStore,
	owner: string = OWNER,
	fanOut?: (entry: Record<string, unknown>, dedupeKey: string) => unknown,
): DeliverToOwner {
	return ({ entry, dedupeKey, origin, provenance, resolveMailbox }) => {
		const mailbox = resolveMailbox ? resolveMailbox() : mailboxStore.ensure(owner);
		if (!mailbox) return false;
		mailbox.append({ ...entry, dedupeKey }, dedupeKey, provenance);
		if (origin === "local" && entry.session_id) void fanOut?.(entry as Record<string, unknown>, dedupeKey);
		return true;
	};
}

export function makeHarness(
	overrides: Partial<ConsoleRoutes> & {
		fanOutConsolePush?: (entry: Record<string, unknown>, dedupeKey: string) => unknown;
	} = {},
	deps: Partial<
		Pick<
			ConsoleHandlerDeps,
			| "domainStatus"
			| "domain"
			| "planeRegistry"
			| "presence"
			| "intentTracker"
			| "readAnchors"
			| "boardStore"
			| "crossDomainPresenceConsumer"
			| "linkedDomainIds"
		>
	> = {},
): Harness {
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const mailboxStore = new DeviceMailboxStore();
	const sendCalls: Record<string, unknown>[] = [];
	const respondCalls: Record<string, unknown>[] = [];
	const { fanOutConsolePush, ...routeOverrides } = overrides;

	const routes: ConsoleRoutes = {
		deliverToOwner: makeDeliverToOwner(mailboxStore, OWNER, fanOutConsolePush),
		send: async (_req, body) => {
			sendCalls.push(body);
			return jsonRes({ session_id: "conv:host:team-a", status: "running" });
		},
		respond: (_req, body) => {
			respondCalls.push(body);
			return jsonRes({ delivered: true });
		},
		teams: () =>
			jsonRes([
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "team-b", status: "online", mode: "channel", queue_depth: 0 },
			]),
		// list_teams fans out via discover; mirror the team list here.
		discover: async () =>
			jsonRes([
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "team-b", status: "online", mode: "channel", queue_depth: 0 },
			]),
		discoverFull: async () => ({
			teams: [
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "team-b", status: "online", mode: "channel", queue_depth: 0 },
			] as unknown as TeamInfo[],
			coverage: { rosterKnown: true, asked: 0, answered: 0 },
		}),
		...routeOverrides,
	};

	const handler = createConsoleDispatcher({
		registry,
		conversationRegistry,
		mailboxStore,
		localGatewayId: "test-host",
		localDomainId: "test-domain",
		routes,
		domainStatus: deps.domainStatus,
		domain: deps.domain,
		planeRegistry: deps.planeRegistry,
		presence: deps.presence,
		intentTracker: deps.intentTracker,
		readAnchors: deps.readAnchors,
		boardStore: deps.boardStore,
		crossDomainPresenceConsumer: deps.crossDomainPresenceConsumer,
		linkedDomainIds: deps.linkedDomainIds,
	});
	return { registry, conversationRegistry, mailboxStore, sendCalls, respondCalls, handler };
}

/** Shared by the terminal-ops (peek/tmux_send/list_dirs/reload_plugins), create_session, and
 * close/forget/rename split files - each exercises this same relayToHost-backed dispatcher. */
export function makeTerminalHarness(
	isProjectName: (n: string) => boolean = (n) => n === "recipe-app",
	relayPeek?: () => { ok: boolean; result?: unknown; error?: string; errorKind?: "absent" | "failure" },
	opts: {
		sessionStore?: SessionStore;
		relayFails?: boolean;
		relayTimesOut?: boolean;
		relayDisconnects?: boolean;
		tryWakeTeam?: (team: string) => Promise<WakeResult>;
		createSessionBoundMs?: number;
		isWakeInFlight?: (team: string) => boolean;
		markCreateInFlight?: (team: string) => () => void;
		awaitRegister?: (team: string) => Promise<WakeResult>;
		dropSessionResume?: (team: string) => void;
	} = {},
) {
	const hostOps: Record<string, unknown>[] = [];
	const routes: ConsoleRoutes = {
		deliverToOwner: makeDeliverToOwner(new DeviceMailboxStore()),
		send: async () => jsonRes({ session_id: "s", status: "running" }),
		respond: () => jsonRes({ delivered: true }),
		teams: () => jsonRes([]),
		discover: async () => jsonRes([]),
		discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
	};
	const handler = createConsoleDispatcher({
		registry: new Map(),
		conversationRegistry: new Map(),
		mailboxStore: new DeviceMailboxStore(),
		localGatewayId: "test-host",
		localDomainId: "test-domain",
		routes,
		isProjectName,
		sessionStore: opts.sessionStore,
		tryWakeTeam: opts.tryWakeTeam,
		isWakeInFlight: opts.isWakeInFlight,
		markCreateInFlight: opts.markCreateInFlight,
		awaitRegister: opts.awaitRegister,
		dropSessionResume: opts.dropSessionResume,
		createSessionBoundMs: opts.createSessionBoundMs,
		relayToHost: async (op) => {
			hostOps.push(op as unknown as Record<string, unknown>);
			if (opts.relayTimesOut) return { ok: false, error: "host op timed out", errorKind: "timeout" };
			if (opts.relayDisconnects) {
				return { ok: false, error: "host daemon disconnected", errorKind: "disconnected" };
			}
			if (opts.relayFails) return { ok: false, error: "launch failed" };
			if (op.kind === "peek")
				return relayPeek ? relayPeek() : { ok: true, result: { kind: "tmux", ansi: "SCREEN", hash: "h1" } };
			if (op.kind === "listDirs") return { ok: true, result: { entries: [".config", "projects"] } };
			return { ok: true, result: { sent: true } };
		},
	});
	return { handler, hostOps, sessionStore: opts.sessionStore };
}
