import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { WsRegisterSchema } from "../shared/schemas.js";
import { isComposite } from "../shared/session-id.js";
import type { ConnectionMode, WebSocketConfig } from "../shared/types.js";
import type { WakeCoordinator } from "./wake.js";

////////////////////////////////
//  Interfaces & Types

export type TeamRegistry = Map<string, Map<string, ServerWebSocket<WsData>>>;
export type ConversationRegistry = Map<string, ServerWebSocket<WsData>>;

export interface WebSocketDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	wakeCoordinator: WakeCoordinator;
	// Settles a host_op (peek/send) reply by reqId, and fails all in-flight ops when the host
	// drops. Absent in tests that do not exercise the console terminal relay.
	hostOpCoordinator?: {
		settle: (
			reqId: string,
			result: { ok: boolean; result?: unknown; error?: string; errorKind?: "absent" | "failure" },
		) => void;
		failAll: (error: string) => void;
	};
	config: WebSocketConfig;
	onTeamConnect?: (team: string, ws: ServerWebSocket<WsData>) => void;
	onTeamDisconnect?: (team: string) => void;
	// Fired when a real registration evicts a virtual console peer, so the console
	// handler can clear its binding/mailbox and let the device re-register.
	onVirtualPeerEvicted?: (conversationId: string) => void;
	// Record a session's reported Claude harness id, keyed by team, for later `claude --resume`.
	recordSessionResume?: (team: string, claudeSessionId: string) => void;
}

export interface WsData {
	teamName: string | null;
	subId: string;
	conversationId: string | null;
	mode: ConnectionMode;
	// Plugin version (package.json) this connection reported at register, surfaced in
	// teams() so the console can flag a version-lagging agent. Undefined for virtual
	// console peers and non-plugin registrants (e.g. the host daemon).
	version?: string;
	missedPings: number;
	isStale: boolean;
	handshakeConfirmed: boolean;
	proxyProject?: string;
	proxyAuth?: string;
	// True for a console mailbox peer: a duck-typed socket whose send() appends to a
	// DeviceMailbox instead of writing a wire. Liveness comes from the console<->evie
	// connection, so it is excluded from the ping/pong heartbeat.
	virtual?: boolean;
}

////////////////////////////////
//  Functions & Helpers

export const RESERVED_TEAM_NAMES = new Set(["host"]);

// After a positive wake_result (the container started), how long to wait for its register before
// failing the wake. Register normally arrives BEFORE the ack (the in-container MCP connects during
// boot, ahead of the daemon's readiness probe), so this is a backstop for the rare started-but-
// never-registered case (a crashed or unreachable MCP). A generous 60s avoids failing a slow
// register while still bounding the stall far below the full WAKE_TIMEOUT_MS (~10 min).
const REGISTER_WINDOW_MS = 60_000;

export function getAllActiveWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	const result: ServerWebSocket<WsData>[] = [];
	for (const [, ws] of subs) {
		if (ws.readyState === 1) result.push(ws);
	}
	return result;
}

/**
 * Active sockets excluding virtual console peers, whose readyState is hardwired
 * open. Use this wherever "online" must mean a live process that can act (DM
 * holder selection, liveness checks), not a passive mailbox.
 */
export function getAllActiveRealWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	return getAllActiveWs(subs).filter((ws) => !ws.data.virtual);
}

export function createWebSocketHandlers({
	registry,
	conversationRegistry,
	knownTeamPaths,
	offlineCatalog,
	wakeCoordinator,
	hostOpCoordinator,
	config,
	onTeamConnect,
	onTeamDisconnect,
	onVirtualPeerEvicted,
	recordSessionResume,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;

	const heartbeatInterval = setInterval(() => {
		for (const subs of registry.values()) {
			for (const ws of subs.values()) {
				const data = ws.data as WsData;
				if (data.virtual) continue;
				data.missedPings = (data.missedPings || 0) + 1;
				if (data.missedPings >= MISSED_PINGS_LIMIT) {
					ws.close();
					continue;
				}
				ws.ping();
			}
		}
	}, HEARTBEAT_INTERVAL_MS);

	// Maps handshake session_id -> { team, subId } so we can resolve handshake responses
	const handshakePending = new Map<string, { team: string; subId: string }>();

	function open(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		ws.data.isStale = false;
		ws.data.handshakeConfirmed = false;
		ws.data.conversationId = null;
	}

	function message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return;
		}

		if (msg.type === "register") {
			const reg = WsRegisterSchema.safeParse(msg);
			if (!reg.success) {
				console.warn(`[ws] dropped malformed register: ${reg.error.issues[0]?.message ?? "invalid"}`);
				return;
			}
			const team = reg.data.team;
			const subId = reg.data.subId || crypto.randomUUID().slice(0, 8);
			// Every bridge connection is channel mode.
			const mode: ConnectionMode = "channel";
			const conversationId = reg.data.conversationId ?? null;

			// Host-daemon auth: the reserved "host" slot (which drives agent terminals and
			// receives wakes) is admission-gated by a shared secret so a LAN peer cannot
			// claim it. Refused unless the gateway has HOST_WS_TOKEN configured and the
			// daemon presents the matching token.
			if (team === "host" && (!config.hostWsToken || reg.data.token !== config.hostWsToken)) {
				console.log(`[ws] rejected host register - bad or missing token`);
				ws.send(JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }));
				ws.data.isStale = true;
				ws.close();
				return;
			}

			// Reserved-name protection: first live registration wins. A second process
			// trying to claim "host" is rejected so a stray container project cannot squat
			// on the host daemon's slot.
			if (RESERVED_TEAM_NAMES.has(team)) {
				const existingSubs = registry.get(team);
				const existingActive = existingSubs ? getAllActiveWs(existingSubs) : [];
				const sameSocketAlready = existingSubs?.get(subId) === ws;
				if (!sameSocketAlready && existingActive.length > 0) {
					console.log(`[ws] rejected register for reserved team "${team}" - already held`);
					ws.send(JSON.stringify({ type: "register_reject", team, reason: "reserved" }));
					ws.data.isStale = true;
					ws.close();
					return;
				}
			}

			let subs = registry.get(team);
			if (!subs) {
				subs = new Map();
				registry.set(team, subs);
			}

			// A real registration claims the name over any virtual console peers
			// squatting it: evict them so a console can never absorb a real team's
			// traffic. The console's next frame gets the name-taken rejection.
			for (const [virtualSubId, virtualWs] of [...subs]) {
				if (virtualWs.data.virtual) {
					subs.delete(virtualSubId);
					const virtualConvId = virtualWs.data.conversationId;
					if (virtualConvId && conversationRegistry.get(virtualConvId) === virtualWs) {
						conversationRegistry.delete(virtualConvId);
					}
					if (virtualConvId) onVirtualPeerEvicted?.(virtualConvId);
					console.log(`[ws] evicted virtual peer ${team}/${virtualSubId} (real registration)`);
				}
			}

			// If this subId already exists with a different socket, close the old one
			const existing = subs.get(subId);
			if (existing && existing !== ws) {
				existing.data.isStale = true;
				existing.close();
			}

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			ws.data.version = reg.data.version;
			subs.set(subId, ws);

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
					priorConversationWs.data.isStale = true;
					priorConversationWs.close();
				}
				conversationRegistry.set(conversationId, ws);
			}

			// Only a bare project is a devcontainer catalog entry; a composite `project.session` is a
			// loose session and must never land in knownTeamPaths (it would be misclassified).
			if (typeof msg.projectPath === "string" && msg.projectPath && !isComposite(team)) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			// Remember a COMPOSITE session's Claude harness id so a later wake can `claude --resume`
			// it. A bare project (spawn-point) or bare loose peer has no session to resume. Host
			// sessions (`host.<name>` user-named or `host.<hex>` ad-hoc) are composite and wakeable, so
			// they belong here.
			if (typeof msg.claudeSessionId === "string" && msg.claudeSessionId && isComposite(team)) {
				recordSessionResume?.(team, msg.claudeSessionId);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team}/${subId} connected (mode: ${mode})`);

			// Handshake: ask channel-mode connections if they are the main/lead agent
			if (mode === "channel" && team !== "host") {
				const hsSessionId = `hs-${crypto.randomUUID().slice(0, 8)}`;
				handshakePending.set(hsSessionId, { team, subId });
				ws.send(
					JSON.stringify({
						type: "channel_push",
						from: "gateway",
						body: `This is the initial bridge handshake. Reply with the \`channel_reply\` tool using the session_id shown above, setting \`respondAsStructuredData\` to a JSON string.\n\nUse respondAsStructuredData: '{ "isMainOrLead": true }' if you are the primary session or team lead, or '{ "isMainOrLead": false }' if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
						session_id: hsSessionId,
						replyJsonSchema: "{ isMainOrLead: bool }",
					}),
				);
				console.log(`[ws] handshake sent to ${team}/${subId} [${hsSessionId}]`);
			} else {
				ws.data.handshakeConfirmed = true;
			}

			onTeamConnect?.(team, ws);
		}

		// Only the authenticated host socket may report a wake outcome (matching host_op_reply and
		// catalog), so a LAN peer cannot forge a wake_result to fail or shorten an in-flight wake.
		// A failed wake_result fails the wait at once. A success proves the container started but is
		// not deliverable until it registers, so it shortens the wait to the registration window (the
		// woken container's own register resolves it true) instead of stalling WAKE_TIMEOUT_MS if the
		// agent crashed before registering.
		if (msg.type === "wake_result" && ws.data.teamName === "host" && typeof msg.team === "string") {
			if (msg.success === false) {
				wakeCoordinator.notify(msg.team, false);
			} else {
				wakeCoordinator.ackReceived(msg.team, REGISTER_WINDOW_MS);
			}
		}

		// The host daemon's reply to a peek/send relay, correlated by reqId. Only the
		// authenticated host socket may settle a host op (matching the catalog branch).
		if (msg.type === "host_op_reply" && ws.data.teamName === "host" && typeof msg.reqId === "string") {
			hostOpCoordinator?.settle(msg.reqId, {
				ok: msg.ok === true,
				result: msg.result,
				error: typeof msg.error === "string" ? msg.error : undefined,
				errorKind: msg.errorKind === "absent" || msg.errorKind === "failure" ? msg.errorKind : undefined,
			});
		}

		if (msg.type === "catalog" && ws.data.teamName === "host") {
			const projects = msg.projects;
			if (Array.isArray(projects)) {
				offlineCatalog.clear();
				for (const p of projects) {
					if (typeof p.team === "string" && typeof p.projectPath === "string") {
						offlineCatalog.set(p.team, p.projectPath);
						if (!knownTeamPaths.has(p.team)) {
							knownTeamPaths.set(p.team, p.projectPath);
						}
					}
				}
				console.log(`[ws] catalog received: ${offlineCatalog.size} projects`);
			}
		}

		// Reset missed pings on any message (acts like pong)
		ws.data.missedPings = 0;
	}

	function close(ws: ServerWebSocket<WsData>): void {
		const teamName = ws.data.teamName;
		const subId = ws.data.subId;

		if (ws.data.isStale) {
			console.log(`[ws] stale socket closed for ${teamName}/${subId} - ignoring`);
			return;
		}

		if (!teamName) return;

		if (teamName === "host") {
			const subs = registry.get(teamName);
			if (subs) {
				subs.delete(subId);
				if (subs.size === 0) {
					registry.delete(teamName);
					offlineCatalog.clear();
					// Fail in-flight terminal ops AND wakes so a console peek/send or a /send awaiting a
					// wake returns at once instead of waiting out its full timeout across the host restart.
					hostOpCoordinator?.failAll("host daemon disconnected");
					wakeCoordinator.failAll();
					console.log(`[ws] host disconnected - offline catalog cleared`);
					onTeamDisconnect?.(teamName);
				} else {
					console.log(`[ws] host/${subId} disconnected (${subs.size} remaining)`);
				}
			}
			const hostConversationId = ws.data.conversationId;
			if (hostConversationId && conversationRegistry.get(hostConversationId) === ws) {
				conversationRegistry.delete(hostConversationId);
			}
			return;
		}

		const subs = registry.get(teamName);
		if (!subs) return;

		// Only remove if this is the registered socket for this subId
		if (subs.get(subId) !== ws) {
			console.log(`[ws] stale close for ${teamName}/${subId} - skipping cleanup`);
			return;
		}

		subs.delete(subId);
		console.log(`[ws] ${teamName}/${subId} disconnected (${subs.size} remaining)`);

		// Clear any pending lead-handshake owned by this socket: a socket that drops before it answers
		// would otherwise leave its entry in the map forever (resolveHandshake never fires for it).
		for (const [hsId, pending] of handshakePending) {
			if (pending.team === teamName && pending.subId === subId) handshakePending.delete(hsId);
		}

		// Clear conversation registry entry if it still points at this ws.
		const closingConversationId = ws.data.conversationId;
		if (closingConversationId && conversationRegistry.get(closingConversationId) === ws) {
			conversationRegistry.delete(closingConversationId);
		}

		// If team has no more live sub-sessions, clean up fully. Virtual console
		// peers do not count as liveness; they must not suppress disconnect
		// cleanup (pin clearing, job cancellation).
		const hasRealSubs = [...subs.values()].some((s) => !s.data.virtual);
		if (!hasRealSubs) {
			if (subs.size === 0) registry.delete(teamName);
			onTeamDisconnect?.(teamName);
		}
	}

	/** Resolve a handshake response. Returns true if it was a handshake session. */
	function resolveHandshake(sessionId: string, replyAsJson?: Record<string, unknown>, response?: string): boolean {
		const pending = handshakePending.get(sessionId);
		if (!pending) return false;
		handshakePending.delete(sessionId);

		const subs = registry.get(pending.team);
		const ws = subs?.get(pending.subId);
		if (!ws) return true;

		// Determine if this agent claims to be the lead
		let isMainOrLead = false;
		if (replyAsJson && typeof replyAsJson.isMainOrLead === "boolean") {
			isMainOrLead = replyAsJson.isMainOrLead;
		} else if (response) {
			isMainOrLead = /true/i.test(response);
		}

		if (isMainOrLead) {
			ws.data.handshakeConfirmed = true;
			console.log(`[ws] handshake confirmed: ${pending.team}/${pending.subId} is lead`);
		} else {
			console.log(`[ws] handshake rejected: ${pending.team}/${pending.subId} is worker, closing`);
			ws.data.isStale = true;
			ws.send(JSON.stringify({ type: "handshake_reject" }));
			ws.close();
		}
		return true;
	}

	return { open, message, close, heartbeatInterval, resolveHandshake };
}
