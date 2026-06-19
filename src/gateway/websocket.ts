import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { debugLog } from "../shared/debug-log.js";
import { WsRegisterSchema } from "../shared/schemas.js";
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
	config: WebSocketConfig;
	onTeamConnect?: (team: string, ws: ServerWebSocket<WsData>) => void;
	onTeamDisconnect?: (team: string) => void;
	// Fired when a real registration evicts a virtual console peer, so the console
	// handler can clear its binding/mailbox and let the device re-register.
	onVirtualPeerEvicted?: (conversationId: string) => void;
}

export interface WsData {
	teamName: string | null;
	subId: string;
	conversationId: string | null;
	mode: ConnectionMode;
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

export const RESERVED_TEAM_NAMES = new Set(["gateway", "host"]);

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
	config,
	onTeamConnect,
	onTeamDisconnect,
	onVirtualPeerEvicted,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;

	const heartbeatInterval = setInterval(() => {
		for (const [teamName, subs] of registry) {
			for (const [subId, ws] of subs) {
				const data = ws.data as WsData;
				if (data.virtual) continue;
				data.missedPings = (data.missedPings || 0) + 1;
				if (data.missedPings >= MISSED_PINGS_LIMIT) {
					// #region Hypothesis E: heartbeat evicting stale socket
					debugLog("E", "src/gateway/websocket.ts:heartbeat", "evicting stale socket", {
						team: teamName,
						subId,
						missedPings: data.missedPings,
						readyState: ws.readyState,
						totalSubsForTeam: subs.size,
					});
					// #endregion
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
			const mode: ConnectionMode = reg.data.mode === "channel" ? "channel" : "cli";
			const conversationId = reg.data.conversationId ?? null;

			// Reserved-name protection: first live registration wins. A second process
			// trying to claim "gateway" or "host" is rejected so a stray container project
			// cannot squat on the host's slots.
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

			// #region Hypothesis D/F: log register with pre-existing sub-session state
			debugLog("D", "src/gateway/websocket.ts:register", "team registered", {
				team,
				subId,
				mode,
				conversationId: conversationId ?? "none",
				existingSubIds: Array.from(subs.keys()),
				existingSubCount: subs.size,
				replacedExisting: !!existing,
			});
			// #endregion

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			subs.set(subId, ws);

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
					priorConversationWs.data.isStale = true;
					priorConversationWs.close();
				}
				conversationRegistry.set(conversationId, ws);
			}

			if (typeof msg.projectPath === "string" && msg.projectPath) {
				knownTeamPaths.set(team, msg.projectPath);
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
						request_type: "question",
						body: `This is the initial bridge handshake. Reply with the \`channel_reply\` tool using the session_id shown above, setting \`respondAsStructuredData\` to a JSON string.\n\nUse respondAsStructuredData: '{ "isMainOrLead": true }' if you are the primary session or team lead, or '{ "isMainOrLead": false }' if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
						effort: "simple",
						session_id: hsSessionId,
						is_follow_up: false,
						replyJsonSchema: "{ isMainOrLead: bool }",
					}),
				);
				console.log(`[ws] handshake sent to ${team}/${subId} [${hsSessionId}]`);
			} else {
				ws.data.handshakeConfirmed = true;
			}

			onTeamConnect?.(team, ws);
		}

		// #region Hypothesis M: log all wake_results (gateway only handles success=false)
		if (msg.type === "wake_result" && typeof msg.team === "string") {
			debugLog("M", "src/gateway/websocket.ts:wake_result", "wake_result received", {
				team: msg.team as string,
				success: msg.success as boolean,
				error: (msg.error as string) ?? null,
				screen: typeof msg.screen === "string" ? (msg.screen as string).slice(0, 200) : null,
			});
			if (msg.success === false) {
				wakeCoordinator.notify(msg.team, false);
			}
		}
		// #endregion

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

		// #region Hypothesis D: log close event with registry state
		if (teamName && teamName !== "host") {
			const subs = registry.get(teamName);
			debugLog("D", "src/gateway/websocket.ts:close", "socket closing", {
				team: teamName,
				subId,
				isStale: ws.data.isStale,
				readyState: ws.readyState,
				subsBeforeClose: subs ? Array.from(subs.keys()) : [],
				subsCount: subs?.size ?? 0,
			});
		}
		// #endregion

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

		// #region Hypothesis G: log resolveHandshake inputs and result
		debugLog("G", "src/gateway/websocket.ts:resolveHandshake", "handshake resolution", {
			sessionId,
			team: pending.team,
			subId: pending.subId,
			replyAsJson: replyAsJson ?? null,
			response: response ?? null,
			isMainOrLead,
			replyAsJsonType: typeof replyAsJson,
			fieldType: replyAsJson ? typeof replyAsJson.isMainOrLead : "n/a",
		});
		// #endregion

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
