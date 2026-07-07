import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { WsRegisterSchema } from "../shared/schemas.js";
import { isComposite } from "../shared/session-id.js";
import type { SessionStore } from "../shared/session-store.js";
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
	// The gateway's authoritative session store. The handshake confirm establishes/binds a record
	// here (register only stashes the reported ids on the socket); disconnect clears the live pointer.
	// Absent in tests that do not exercise session recording.
	sessionStore?: SessionStore;
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
	// Stashed at register, consumed at handshake-confirm to establish the durable record (no store
	// write happens at register). claudeSessionId is the harness resume id; cwdName is the default
	// session label for a self-appearing session.
	claudeSessionId?: string;
	cwdName?: string;
	missedPings: number;
	isStale: boolean;
	handshakeConfirmed: boolean;
	// How many lead handshakes have been sent to this socket (at register, then re-sent by the
	// heartbeat while unconfirmed). Bounds the retry so a never-answering session is not pinged forever.
	hsAttempts?: number;
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

// How long an unanswered handshake entry lingers before the heartbeat sweep drops it. Generous so a
// long first LLM turn still confirms; a flag-less session never answers and is swept after this.
const HANDSHAKE_PENDING_TTL_MS = 30 * 60_000;

// Re-send the lead handshake to a connected-but-unconfirmed channel session on each heartbeat, up to
// this many total sends. A session that could not answer at register (sitting at a first-run login
// prompt, a slow boot) confirms once it becomes ready, instead of showing "verifying" forever. Bounds
// the re-send so a genuinely never-answering (flag-less) socket is not pinged indefinitely.
const HANDSHAKE_MAX_ATTEMPTS = 20;

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

/**
 * The live socket serving a session record. Resolution order: a CONFIRMED canonical pane (a real
 * sub under the record's own `spawn.id` that answered the lead handshake), else the CONFIRMED alias
 * incarnation the record stamped as `liveTeam`, else an unconfirmed-but-live canonical socket (a
 * session still verifying, with no confirmed lead anywhere). A confirmed lead therefore always wins
 * over an unconfirmed or stray registration under either name, so a bare register cannot intercept a
 * confirmed alias's traffic. Excludes virtual console peers. The single authoritative record ->
 * live-socket resolution order, consulted by presence listing and send/wake routing. (The terminal
 * ops gate on the record's liveTeam field directly, a narrower confirmed-only question.)
 */
export function resolveLiveIncarnation(
	registry: TeamRegistry,
	sessionStore: SessionStore | undefined,
	team: string,
): ServerWebSocket<WsData> | undefined {
	const canonical = getAllActiveRealWs(registry.get(team) ?? new Map());
	const confirmedCanonical = canonical.find((s) => s.data.handshakeConfirmed);
	if (confirmedCanonical) return confirmedCanonical;
	const alias = sessionStore?.resolveLive(team);
	if (alias) {
		const s = registry.get(alias.team)?.get(alias.subId);
		// The stamped incarnation was confirmed; require it still be, so a fresh unconfirmed
		// registrant that lands on the same (team, subId) slot cannot inherit the record's traffic.
		if (s && s.readyState === 1 && !s.data.virtual && s.data.handshakeConfirmed) return s;
	}
	return canonical[0];
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
	sessionStore,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;

	function heartbeatTick() {
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
				// Re-send the handshake to a channel session that is still unconfirmed, so one that
				// could not answer at register (a first-run login prompt, a slow boot) confirms once
				// ready instead of sitting at "verifying" forever. Bounded by HANDSHAKE_MAX_ATTEMPTS.
				if (
					data.mode === "channel" &&
					data.teamName &&
					data.teamName !== "host" &&
					!data.handshakeConfirmed &&
					ws.readyState === 1 &&
					(data.hsAttempts ?? 0) < HANDSHAKE_MAX_ATTEMPTS
				) {
					sendHandshake(ws, data.teamName, data.subId);
				}
			}
		}
		// A flag-less loose session keeps its socket open but never answers the handshake, so its
		// pending entry would sit forever. Age unanswered entries out (a genuinely slow first turn
		// still confirms well within this window).
		const cutoff = Date.now() - HANDSHAKE_PENDING_TTL_MS;
		for (const [hsId, p] of handshakePending) {
			if (p.createdAt < cutoff) handshakePending.delete(hsId);
		}
	}
	const heartbeatInterval = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);

	// Maps handshake session_id -> the socket that owes a lead/worker reply, so we can resolve
	// handshake responses. createdAt bounds the map via the sweep above.
	const handshakePending = new Map<string, { team: string; subId: string; createdAt: number }>();

	/** Drop any pending handshake owned by a (team, subId) - a socket that will never answer. */
	function forgetPending(team: string, subId: string): void {
		for (const [hsId, p] of handshakePending) {
			if (p.team === team && p.subId === subId) handshakePending.delete(hsId);
		}
	}

	/** Send a lead handshake to a channel socket, minting a session id and pending entry, and counting
	 * the attempt. Sent once at register and re-sent by the heartbeat while the socket is unconfirmed. */
	function sendHandshake(ws: ServerWebSocket<WsData>, team: string, subId: string): void {
		const hsSessionId = `hs-${crypto.randomUUID().slice(0, 8)}`;
		handshakePending.set(hsSessionId, { team, subId, createdAt: Date.now() });
		ws.data.hsAttempts = (ws.data.hsAttempts ?? 0) + 1;
		ws.send(
			JSON.stringify({
				type: "channel_push",
				from: "gateway",
				body: `This is the initial bridge handshake. Reply with the \`channel_reply\` tool using the session_id shown above, setting \`respondAsStructuredData\` to a JSON string.\n\nUse respondAsStructuredData: '{ "isMainOrLead": true }' if you are the primary session or team lead, or '{ "isMainOrLead": false }' if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
				session_id: hsSessionId,
				replyJsonSchema: "{ isMainOrLead: bool }",
			}),
		);
		console.log(`[ws] handshake sent to ${team}/${subId} [${hsSessionId}] (attempt ${ws.data.hsAttempts})`);
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
			forgetPending(vTeam, victim.data.subId);
			sessionStore?.clearLive(vTeam, victim.data.subId);
		}
		const vConv = victim.data.conversationId;
		if (vConv && conversationRegistry.get(vConv) === victim) conversationRegistry.delete(vConv);
		victim.close();
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

			// If this subId already exists with a different socket, evict the old one
			const existing = subs.get(subId);
			if (existing && existing !== ws) {
				evictSocket(existing);
			}

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			ws.data.version = reg.data.version;
			// Stashed for the handshake confirm to establish the record; no store write at register.
			ws.data.claudeSessionId = reg.data.claudeSessionId;
			ws.data.cwdName = reg.data.cwdName;
			subs.set(subId, ws);

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
					evictSocket(priorConversationWs);
				}
				conversationRegistry.set(conversationId, ws);
			}

			// Only a bare project is a devcontainer catalog entry; a composite `project.session` is a
			// loose session and must never land in knownTeamPaths (it would be misclassified).
			if (typeof msg.projectPath === "string" && msg.projectPath && !isComposite(team)) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team}/${subId} connected (mode: ${mode})`);

			// Handshake: ask channel-mode connections if they are the main/lead agent. Re-sent by the
			// heartbeat while unconfirmed, so a session that could not answer now (a login prompt) still
			// confirms once ready.
			if (mode === "channel" && team !== "host") {
				sendHandshake(ws, team, subId);
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
		forgetPending(teamName, subId);

		// Drop the record's live pointer if this exact incarnation was serving it, so send/wake
		// resolution stops probing a dead incarnation.
		sessionStore?.clearLive(teamName, subId);

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

	/** Establish the durable session record for a confirmed lead. The binding-order precedence lives
	 * in the store; here we supply the stashed register ids and the confirming incarnation, and apply
	 * first-binding-holds (a registry probe the store cannot make). */
	function establishRecord(ws: ServerWebSocket<WsData>, pending: { team: string; subId: string }): void {
		if (!sessionStore) return;
		const claudeSessionId = ws.data.claudeSessionId;
		// First-binding-holds: if this transcript already lives on a DIFFERENT record's live
		// incarnation, refuse to re-bind it here (the first binding holds), so a second live process on
		// one transcript never steals the card. The session's own segment (a daemon relaunch of the
		// same record) is exempt - that is a legitimate rebind, not a steal.
		if (claudeSessionId) {
			const holder = sessionStore.resumeRecord(claudeSessionId);
			if (holder && sessionStore.teamOf(holder) !== pending.team) {
				const live = resolveLiveIncarnation(registry, sessionStore, sessionStore.teamOf(holder));
				if (live && live !== registry.get(pending.team)?.get(pending.subId)) {
					console.log(
						`[ws] first-binding-holds: ${pending.team}/${pending.subId} claims a transcript already live on ${sessionStore.teamOf(holder)}; refusing`,
					);
					return;
				}
			}
		}
		const record = sessionStore.establishOnConfirm(pending.team, {
			claudeSessionId,
			label: ws.data.cwdName,
			live: { team: pending.team, subId: pending.subId },
		});
		if (record) {
			console.log(
				`[ws] session record ${sessionStore.teamOf(record)} confirmed (label "${record.sessionLabel}")`,
			);
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
		// Honor a confirm only for a still-open socket: a reply arriving after the socket dropped or
		// was evicted must not resurrect a record or mutate registry state.
		if (ws.readyState !== 1) return true;

		// Determine if this agent claims to be the lead
		let isMainOrLead = false;
		if (replyAsJson && typeof replyAsJson.isMainOrLead === "boolean") {
			isMainOrLead = replyAsJson.isMainOrLead;
		} else if (response) {
			isMainOrLead = /true/i.test(response);
		}

		if (isMainOrLead) {
			ws.data.handshakeConfirmed = true;
			establishRecord(ws, pending);
			console.log(`[ws] handshake confirmed: ${pending.team}/${pending.subId} is lead`);
		} else {
			console.log(`[ws] handshake rejected: ${pending.team}/${pending.subId} is worker, closing`);
			ws.send(JSON.stringify({ type: "handshake_reject" }));
			evictSocket(ws);
		}
		return true;
	}

	return { open, message, close, heartbeatInterval, heartbeatTick, resolveHandshake };
}
