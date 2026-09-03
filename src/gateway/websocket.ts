import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { agentInboundFrameTypes } from "../shared/agent-backend.js";
import { isHostSpawnSession } from "../shared/host-spawn.js";
import { OP_LEDGER_PROTOCOL, WsRegisterSchema } from "../shared/schemas.js";
import { isComposite } from "../shared/session-id.js";
import type { ConnectionMode } from "../shared/types.js";
import { HandshakeGate } from "./handshakeGate.js";
import { NOTHING_PRESENTED, type Presented, presentedByRegister } from "./sessionAuthority.js";
import {
	type ConversationRegistry,
	getAllActiveRealWs,
	getAllActiveWs,
	HANDSHAKE_REPUSH_DEDUPE_MS,
	type HandshakeRepushOutcome,
	REGISTER_WINDOW_MS,
	RESERVED_TEAM_NAMES,
	resolveLiveIncarnation,
	type TeamRegistry,
	type WebSocketDeps,
	type WsData,
} from "./wsTypes.js";

// The pre-split public surface of this module, preserved verbatim so the nine importers of.
export type { ConversationRegistry, HandshakeRepushOutcome, TeamRegistry, WebSocketDeps, WsData };
export { getAllActiveRealWs, getAllActiveWs, HANDSHAKE_REPUSH_DEDUPE_MS, RESERVED_TEAM_NAMES, resolveLiveIncarnation };

const CODEX_INBOUND_FRAMES = agentInboundFrameTypes("codex");
const COPILOT_INBOUND_FRAMES = agentInboundFrameTypes("copilot");

export function createWebSocketHandlers({
	registry,
	conversationRegistry,
	knownTeamPaths,
	offlineCatalog,
	hostSpawnPoints,
	wakeCoordinator,
	hostOpCoordinator,
	config,
	onTeamConnect,
	onTeamDisconnect,
	onDeliveryAck,
	onVirtualPeerEvicted,
	onCatalogChange,
	onDaemonCapabilities,
	onCodexHostMessage,
	onCopilotHostMessage,
	onPresenceDerive,
	sessionStore,
	auth,
	presenceWriter,
	announcePresenceDirty,
	now,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;
	// Falls back to sessionStore directly (its own methods have identical signatures) when no.
	const liveWriter = presenceWriter ?? sessionStore;

	function heartbeatTick() {
		for (const pending of handshakeGate.expirePending()) {
			const ws = registry.get(pending.team)?.get(pending.subId);
			if (ws && !ws.data.handshakeConfirmed) evictSocket(ws);
		}
		handshakeGate.sweep();
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
	}
	const heartbeatInterval = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);

	// The handshake's state and rules (which hs-* id a socket owes, throttle windows, attempt caps,.
	const handshakeGate = new HandshakeGate(now);

	/** Mint a fresh lead handshake for a channel socket and send it. Sent once at register; a session
	 * that already reports its remembered role skips this entirely (see the register handler's
	 * isMainOrLead branch). A handshake whose notification is lost recovers via repushHandshake below,
	 * which reuses this same id rather than minting a second one. */
	function mintHandshake(ws: ServerWebSocket<WsData>, team: string, subId: string): void {
		const { hsId, push } = handshakeGate.mint(team, subId);
		try {
			ws.send(push);
		} catch (err) {
			console.error(`[ws] handshake send failed for ${team}/${subId} [${hsId}]: ${err}`);
			return;
		}
		console.log(`[ws] handshake sent to ${team}/${subId} [${hsId}]`);
	}

	/** Re-send a socket's own still-pending handshake, recovering a session whose original
	 * notification was missed (dropped, batched behind other messages, or aged out of a compacted
	 * context) and so can never answer the reply gate that calls this. The gate decides (reusing the
	 * existing hs-* id and owning every throttle rule); the send and its commit happen here, so a
	 * failed send charges no attempt. */
	function repushHandshake(team: string, subId: string): HandshakeRepushOutcome {
		const decision = handshakeGate.decideRepush(team, subId);
		if (decision.kind !== "send") return decision.kind;
		const ws = registry.get(team)?.get(subId);
		if (ws?.readyState !== 1) return "socket-gone";
		try {
			ws.send(decision.push);
		} catch (err) {
			console.error(`[ws] handshake re-push send failed for ${team}/${subId} [${decision.hsId}]: ${err}`);
			return "socket-gone";
		}
		decision.commit();
		console.log(`[ws] handshake re-pushed to ${team}/${subId} [${decision.hsId}] (attempt ${decision.attempt})`);
		return "pushed";
	}

	/** Fully evict a socket the register path is replacing: mark stale, drop it from its team's subs,
	 * its pending handshake, its live-record pointer, and its conversation pointer, then close. close()
	 * short-circuits on isStale, so without this those would leak (an eviction is a disconnect of the
	 * old socket and must clear the same state a clean disconnect does). */
	function evictSocket(victim: ServerWebSocket<WsData>): void {
		victim.data.isStale = true;
		const vTeam = victim.data.teamName;
		if (vTeam) {
			const vSubs = registry.get(vTeam);
			if (vSubs?.get(victim.data.subId) === victim) vSubs.delete(victim.data.subId);
			handshakeGate.forget(vTeam, victim.data.subId);
			liveWriter?.clearLive(vTeam, victim.data.subId);
		}
		const vConv = victim.data.conversationId;
		if (vConv && conversationRegistry.get(vConv) === victim) conversationRegistry.delete(vConv);
		victim.close();
		announcePresenceDirty?.();
	}

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

			// Host-daemon auth: the reserved "host" slot (which drives agent terminals and.
			if (team === "host" && (!config.hostWsToken || reg.data.token !== config.hostWsToken)) {
				console.log(`[ws] rejected host register - bad or missing token`);
				ws.send(JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }));
				ws.data.isStale = true;
				ws.close();
				return;
			}

			// Session binding: the token was minted with the record and reaches the session only.
			const presentedToken = reg.data.sessionToken;
			const boundRecord = presentedToken ? sessionStore?.recordByBindToken(presentedToken) : undefined;
			const isBound = !!boundRecord && sessionStore?.teamOf(boundRecord) === team;
			const presentedHere = presentedByRegister(reg.data);

			// A name whose binding is ACTIVE may be claimed only by the holder of that binding. This.
			if (auth && !auth.satisfies(auth.toClaim(team), presentedHere)) {
				console.log(`[ws] rejected register for bound team "${team}" - binding not presented`);
				ws.send(JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }));
				ws.data.isStale = true;
				ws.close();
				return;
			}
			// A session on a host SHELL must prove the daemon launched it, because that name is what.
			if (auth && isHostSpawnSession(team) && !auth.presentsOwnLaunchToken(team, presentedHere)) {
				console.log(`[ws] rejected register for host session "${team}" - no daemon launch token`);
				ws.send(JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }));
				ws.data.isStale = true;
				ws.close();
				return;
			}
			if (isBound && boundRecord) {
				ws.data.boundToken = presentedToken;
				const wasInert = !sessionStore?.isBindingActive(boundRecord);
				sessionStore?.activateBinding(boundRecord);
				// Arming the binding must also expel anyone who claimed this name while it was inert,.
				if (wasInert) {
					for (const [otherSubId, other] of registry.get(team) ?? []) {
						if (other !== ws && other.data.boundToken !== presentedToken) {
							console.log(
								`[ws] evicting ${team}/${otherSubId} - claimed the name before its binding armed`,
							);
							evictSocket(other);
						}
					}
				}
			}

			// Reserved-name protection: first live registration wins. A second process.
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

			// After every rejection gate, so a second daemon carrying the token cannot replace the live.
			if (team === "host" && reg.data.daemonCapabilities) {
				onDaemonCapabilities?.(reg.data.daemonCapabilities);
			}

			let subs = registry.get(team);
			if (!subs) {
				subs = new Map();
				registry.set(team, subs);
			}

			// A real registration claims the name over any virtual console peers.
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

			// If this subId already exists with a different socket, evict the old one.
			const existing = subs.get(subId);
			if (existing && existing !== ws) {
				evictSocket(existing);
			}

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			ws.data.version = reg.data.version;
			ws.data.deliveryProtocol = reg.data.deliveryProtocol;
			// Stashed for the handshake confirm to establish the record; no store write at register.
			ws.data.claudeSessionId = reg.data.claudeSessionId;
			ws.data.cwdName = reg.data.cwdName;
			subs.set(subId, ws);
			// The registry a snapshot reads from already reflects this socket live at this point (see.
			announcePresenceDirty?.();

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				// A conversationId belongs to ONE MCP process for its whole lifetime, reused across.
				if (priorConversationWs && priorConversationWs.data.teamName !== team) {
					console.warn(
						`[ws] refusing conversationId claim: ${team}/${subId} presented a conversationId already held by team "${priorConversationWs.data.teamName}"`,
					);
				} else {
					if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
						evictSocket(priorConversationWs);
					}
					conversationRegistry.set(conversationId, ws);
				}
			}

			// Only a bare project is a devcontainer catalog entry; a composite `project.session` is a.
			if (typeof msg.projectPath === "string" && msg.projectPath && !isComposite(team)) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team}/${subId} connected (mode: ${mode})`);

			// Handshake: ask channel-mode connections if they are the main/lead agent - UNLESS this.
			try {
				ws.send(JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
			} catch {
				evictSocket(ws);
				return;
			}

			if (mode === "channel" && team !== "host") {
				const confirmedBy = handshakeGate.confirmedBy(team);
				const sameConfirmer = !!auth && !!confirmedBy && auth.sameAs(confirmedBy, auth.toAnswerFor(ws));
				if (reg.data.isMainOrLead === true && sameConfirmer) {
					if (establishRecord(ws, { team, subId }) === "refused") {
						evictSocket(ws);
						return;
					}
					ws.data.handshakeConfirmed = true;
					console.log(`[ws] ${team}/${subId} reconnected as remembered lead - handshake skipped`);
				} else {
					mintHandshake(ws, team, subId);
				}
			} else {
				ws.data.handshakeConfirmed = true;
			}

			onTeamConnect?.(team, ws);
		}

		// Only the authenticated host socket may report a wake outcome (matching host_op_reply and.
		if (msg.type === "wake_result" && ws.data.teamName === "host" && typeof msg.team === "string") {
			if (msg.success === false) {
				wakeCoordinator.notify(msg.team, false);
			} else {
				wakeCoordinator.ackReceived(msg.team, REGISTER_WINDOW_MS);
			}
		}

		// The receiver confirming it emitted a held message, which is the only thing that retires one.
		if (msg.type === "channel_delivery_ack" && typeof msg.delivery_id === "string" && ws.data.teamName) {
			onDeliveryAck?.(ws.data.teamName, msg.delivery_id);
		}

		// The host daemon's reply to a peek/send relay, correlated by reqId. Only the.
		if (msg.type === "host_op_reply" && ws.data.teamName === "host" && typeof msg.reqId === "string") {
			hostOpCoordinator?.settle(msg.reqId, {
				ok: msg.ok === true,
				result: msg.result,
				error: typeof msg.error === "string" ? msg.error : undefined,
				errorKind: msg.errorKind === "absent" || msg.errorKind === "failure" ? msg.errorKind : undefined,
			});
		}

		if (ws.data.teamName === "host" && typeof msg.type === "string" && CODEX_INBOUND_FRAMES.has(msg.type)) {
			onCodexHostMessage?.(msg);
		}

		if (ws.data.teamName === "host" && typeof msg.type === "string" && COPILOT_INBOUND_FRAMES.has(msg.type)) {
			onCopilotHostMessage?.(msg);
		}

		if (msg.type === "catalog" && ws.data.teamName === "host") {
			const projects = msg.projects;
			if (Array.isArray(projects)) {
				offlineCatalog.clear();
				for (const p of projects) {
					if (typeof p.team === "string" && typeof p.projectPath === "string") {
						offlineCatalog.set(p.team, p.projectPath);
						knownTeamPaths.set(p.team, p.projectPath);
					}
				}
				console.log(`[ws] catalog received: ${offlineCatalog.size} projects`);
				// Detected host spawn points ride the same frame. Rewritten whole on every catalog,.
				const spawns = msg.hostSpawns;
				if (Array.isArray(spawns) && hostSpawnPoints) {
					hostSpawnPoints.ids = spawns.filter((s): s is string => typeof s === "string" && s.length > 0);
					// Only NOW is the answer known. An older daemon omits the field entirely and leaves.
					hostSpawnPoints.known = true;
					console.log(`[ws] host spawn points: ${hostSpawnPoints.ids.join(", ") || "(none beyond host)"}`);
				}
				onCatalogChange?.();
			}
		}

		// The daemon's presence-derivation report for one team. Only the authenticated host socket.
		if (msg.type === "presence_derive" && ws.data.teamName === "host" && typeof msg.team === "string") {
			const working = typeof msg.working === "boolean" ? msg.working : undefined;
			const needsLogin = typeof msg.needsLogin === "boolean" ? msg.needsLogin : undefined;
			const limitBlocked = typeof msg.limitBlocked === "boolean" ? msg.limitBlocked : undefined;
			const limitDetail = typeof msg.limitDetail === "string" ? msg.limitDetail : undefined;
			const cleared = working === undefined && needsLogin === undefined && limitBlocked === undefined;
			onPresenceDerive?.(msg.team, cleared ? undefined : { working, needsLogin, limitBlocked, limitDetail });
		}

		// Reset missed pings on any message (acts like pong).
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
					// Cleared with the catalog, for the same reason: a machine with no daemon cannot.
					if (hostSpawnPoints) {
						hostSpawnPoints.known = false;
						hostSpawnPoints.ids = [];
					}
					// Fail in-flight terminal ops AND wakes so a console peek/send or a /send awaiting a.
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

		// Only remove if this is the registered socket for this subId.
		if (subs.get(subId) !== ws) {
			console.log(`[ws] stale close for ${teamName}/${subId} - skipping cleanup`);
			return;
		}

		subs.delete(subId);
		console.log(`[ws] ${teamName}/${subId} disconnected (${subs.size} remaining)`);

		// Clear any pending lead-handshake owned by this socket: a socket that drops before it answers.
		handshakeGate.forget(teamName, subId);

		// Drop the record's live pointer if this exact incarnation was serving it, so send/wake.
		liveWriter?.clearLive(teamName, subId);

		// Clear conversation registry entry if it still points at this ws.
		const closingConversationId = ws.data.conversationId;
		if (closingConversationId && conversationRegistry.get(closingConversationId) === ws) {
			conversationRegistry.delete(closingConversationId);
		}

		// If team has no more live sub-sessions, clean up fully. Virtual console.
		const hasRealSubs = [...subs.values()].some((s) => !s.data.virtual);
		if (!hasRealSubs) {
			if (subs.size === 0) registry.delete(teamName);
			onTeamDisconnect?.(teamName);
		}
	}

	/** Establish the durable session record for a confirmed lead. The binding-order precedence lives
	 * in the store; here we supply the stashed register ids and the confirming incarnation, and apply
	 * first-binding-holds (a registry probe the store cannot make). */
	function establishRecord(
		ws: ServerWebSocket<WsData>,
		pending: { team: string; subId: string },
	): "confirmed" | "refused" | "not-recorded" {
		if (!sessionStore) return "not-recorded";
		const claudeSessionId = ws.data.claudeSessionId;
		let handover = false;
		// First-binding-holds: if this transcript already lives on a DIFFERENT record's live.
		if (claudeSessionId) {
			const holder = sessionStore.resumeRecord(claudeSessionId);
			if (holder && sessionStore.teamOf(holder) !== pending.team) {
				const holderTeam = sessionStore.teamOf(holder);
				const live = resolveLiveIncarnation(registry, sessionStore, holderTeam);
				if (live && live !== ws && live.readyState === 1 && !live.data.virtual) {
					console.log(
						`[ws] transcript binding refused: ${pending.team}/${pending.subId} conflicts with ${holderTeam}`,
					);
					return "refused";
				}
				handover = true;
			}
		}
		const record = liveWriter?.establishOnConfirm(pending.team, {
			claudeSessionId,
			label: ws.data.cwdName,
			live: { team: pending.team, subId: pending.subId },
			handover,
		});
		if (record) {
			console.log(
				`[ws] session record ${sessionStore.teamOf(record)} confirmed (label "${record.sessionLabel}")`,
			);
		}
		return record ? "confirmed" : "refused";
	}

	function pong(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		if (ws.data.handshakeConfirmed && ws.data.teamName) sessionStore?.touchLive(ws.data.teamName);
	}

	/** Resolve a handshake response. Returns true if it was a handshake session. */
	function resolveHandshake(
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		response?: string,
		responderToken?: Presented,
	): boolean {
		const pending = handshakeGate.pendingOf(sessionId);
		if (!pending) return false;

		// Only the challenged session may answer its own handshake. Without this, anyone who learns.
		const challenged = registry.get(pending.team)?.get(pending.subId);
		if (auth && !auth.satisfies(auth.toAnswerFor(challenged), responderToken ?? NOTHING_PRESENTED)) {
			console.log(`[ws] ignored handshake answer for ${pending.team} - not from the challenged session`);
			return true;
		}
		handshakeGate.consume(sessionId);

		const subs = registry.get(pending.team);
		const ws = subs?.get(pending.subId);
		if (!ws) return true;
		// Honor a confirm only for a still-open socket: a reply arriving after the socket dropped or.
		if (ws.readyState !== 1) return true;

		const claim = HandshakeGate.leadClaim(replyAsJson, response);
		if (claim === undefined) {
			console.log(`[ws] ignored malformed handshake answer: ${pending.team}/${pending.subId}`);
			return true;
		}
		if (claim) {
			if (establishRecord(ws, pending) === "refused") {
				evictSocket(ws);
				return true;
			}
			ws.data.handshakeConfirmed = true;
			if (auth) handshakeGate.confirmLead(pending.team, auth.toAnswerFor(ws));
			console.log(`[ws] handshake confirmed: ${pending.team}/${pending.subId} is lead`);
		} else {
			console.log(`[ws] handshake rejected: ${pending.team}/${pending.subId} is worker, closing`);
			ws.send(JSON.stringify({ type: "handshake_reject" }));
			evictSocket(ws);
		}
		return true;
	}

	return {
		open,
		message,
		close,
		heartbeatInterval,
		heartbeatTick,
		resolveHandshake,
		pong,
		findPendingHandshakeId: (team: string, subId: string) => handshakeGate.pendingIdFor(team, subId),
		repushHandshake,
	};
}
