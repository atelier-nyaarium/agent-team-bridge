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
	// Fired when the host daemon's catalog scan replaces offlineCatalog's contents - a presence-read
	// input with no method boundary of its own (a plain Map, mutated in place) to wrap.
	onCatalogChange?: () => void;
	// Fired on a presence_derive frame from the host daemon: a genuine, hysteresis-confirmed
	// working/needsLogin flip for one team, or both undefined for a derivation-impossible clear
	// (the daemon lost its only frame source for that team - a peek-failure streak, or the team
	// dropped from its watch list). Absent when presence is not wired.
	onPresenceDerive?: (team: string, working: boolean | undefined, needsLogin: boolean | undefined) => void;
	// Fired when a real registration evicts a virtual console peer, so the console
	// handler can clear its binding/mailbox and let the device re-register.
	onVirtualPeerEvicted?: (conversationId: string) => void;
	// The gateway's authoritative session store. The handshake confirm establishes/binds a record
	// here (register only stashes the reported ids on the socket); disconnect clears the live pointer.
	// Absent in tests that do not exercise session recording.
	sessionStore?: SessionStore;
	// The presence facade's writer surface for the exact live-socket transition points this module
	// owns (a confirm establishing/binding a record, a disconnect/eviction clearing the live
	// pointer) - routed through the single-writer facade instead of `sessionStore` directly so these
	// transitions announce themselves on the presence plane, matching `sessionStore`'s own method
	// signatures exactly so the swap is drop-in. Falls back to `sessionStore` when absent (tests that
	// do not exercise presence).
	presenceWriter?: {
		establishOnConfirm: SessionStore["establishOnConfirm"];
		clearLive: SessionStore["clearLive"];
	};
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

// repushHandshake's dedupe window, applied both per pending entry (collapses a same-instant
// double-trigger, e.g. two respond() calls landing in the same batch - same-id reuse already
// prevents a growing pileup here, so it does not need to cover a real reply-attempt's think time)
// and per team (below - closes the round-robin gap a caller who knows several of one team's
// sub-session conversationIds would otherwise have around the per-entry window). The team-level
// window exempts an entry's OWN first attempt: without that, several sub-sessions of one team
// recovering at once (the exact scenario repushHandshake exists for) could starve each other
// indefinitely queuing behind a shared window, rather than merely being rate-limited on repeats.
const HANDSHAKE_REPUSH_DEDUPE_MS = 3_000;

// repushHandshake's total attempt cap. /respond is unauthenticated and conversationId is spoofable
// (it rides verbatim in every session_id a caller has seen), so without a cap a peer that merely
// knows a victim's conversationId could sustain gateway-authored handshake prompts into the victim's
// unconfirmed socket indefinitely. Self-closes once the victim confirms (its pending entry clears).
const HANDSHAKE_REPUSH_MAX_ATTEMPTS = 5;

export type HandshakeRepushOutcome = "pushed" | "throttled" | "capped" | "no-pending" | "socket-gone";

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
	onCatalogChange,
	onPresenceDerive,
	sessionStore,
	presenceWriter,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;
	// Falls back to sessionStore directly (its own methods have identical signatures) when no
	// presence facade is wired - tests exercising only read-side behavior stay unaffected.
	const liveWriter = presenceWriter ?? sessionStore;

	function heartbeatTick() {
		// An entry past its dedupe window no longer throttles anything, so this is pure cleanup:
		// bounds teamLastRepushAt against an unauthenticated register minting unbounded team names.
		const now = Date.now();
		for (const [team, lastAt] of teamLastRepushAt) {
			if (now - lastAt >= HANDSHAKE_REPUSH_DEDUPE_MS) teamLastRepushAt.delete(team);
		}
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

	// Maps handshake session_id -> the socket that owes a lead/worker reply, so we can resolve
	// handshake responses. sentAt/repushCount back repushHandshake's dedupe window and attempt cap.
	// Cleared on close/evict (forgetPending); bounded by the count of live unconfirmed sockets, since
	// mintHandshake fires at most once per register and repushHandshake reuses the existing entry.
	const handshakePending = new Map<string, { team: string; subId: string; sentAt: number; repushCount: number }>();

	// Last repushHandshake success per TEAM (not per entry): a caller who knows several of one
	// team's sub-session conversationIds could otherwise round-robin across them to land a fresh
	// push every tick, sidestepping the per-entry dedupe window above. Keyed by team name - an
	// unauthenticated /bridge register can claim any team-shaped string, so this is swept by
	// heartbeatTick below rather than assumed bounded; an entry past HANDSHAKE_REPUSH_DEDUPE_MS has
	// zero remaining throttling effect, so the sweep is pure cleanup with no behavior change.
	const teamLastRepushAt = new Map<string, number>();

	// Teams that have completed at least one REAL handshake round-trip (a genuine challenge
	// answered via resolveHandshake, not a self-reported register field). A register's own
	// isMainOrLead:true claim is only honored for a team already in this set - otherwise a
	// never-before-seen team could skip the handshake challenge entirely on its first-ever
	// connection by simply asserting the field, with no server-side signal backing it.
	const confirmedLeadTeams = new Set<string>();

	/** Drop any pending handshake owned by a (team, subId) - a socket that will never answer. */
	function forgetPending(team: string, subId: string): void {
		for (const [hsId, p] of handshakePending) {
			if (p.team === team && p.subId === subId) handshakePending.delete(hsId);
		}
	}

	/** The exact wire push for a handshake id, byte-identical whether this is the first send or a
	 * re-push. The MCP's confirm guard (receivedIds, keyed off from==="gateway" && replyJsonSchema)
	 * depends on that identity, so a re-push must carry both fields unchanged. */
	function buildHandshakePush(hsSessionId: string): string {
		return JSON.stringify({
			type: "channel_push",
			from: "gateway",
			body: `This is the initial bridge handshake. Reply with the \`channel_reply_structured\` tool using the session_id shown above, setting \`responseData\` to \`{ "isMainOrLead": true }\` if you are the primary session or team lead, or \`{ "isMainOrLead": false }\` if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
			session_id: hsSessionId,
			replyJsonSchema: "{ isMainOrLead: bool }",
		});
	}

	/** Mint a fresh lead handshake for a channel socket and send it. Sent once at register; a session
	 * that already reports its remembered role skips this entirely (see the register handler's
	 * isMainOrLead branch). A handshake whose notification is lost recovers via repushHandshake below,
	 * which reuses this same id rather than minting a second one. Drops any pending entry already
	 * owned by this (team, subId) first, so a same-socket re-register can never leave two
	 * independently-resolvable entries for the same coordinates. */
	function mintHandshake(ws: ServerWebSocket<WsData>, team: string, subId: string): void {
		forgetPending(team, subId);
		const hsSessionId = `hs-${crypto.randomUUID().slice(0, 8)}`;
		handshakePending.set(hsSessionId, { team, subId, sentAt: Date.now(), repushCount: 0 });
		try {
			ws.send(buildHandshakePush(hsSessionId));
		} catch (err) {
			console.error(`[ws] handshake send failed for ${team}/${subId} [${hsSessionId}]: ${err}`);
			return;
		}
		console.log(`[ws] handshake sent to ${team}/${subId} [${hsSessionId}]`);
	}

	/** The pending hs-* id owed by a (team, subId), if any - so a caller with an unconfirmed socket of
	 * its own can be told exactly which handshake to answer first. */
	function findPendingHandshakeId(team: string, subId: string): string | undefined {
		for (const [hsId, p] of handshakePending) {
			if (p.team === team && p.subId === subId) return hsId;
		}
		return undefined;
	}

	/** Re-send a socket's own still-pending handshake, recovering a session whose original
	 * notification was missed (dropped, batched behind other messages, or aged out of a compacted
	 * context) and so can never answer the reply gate that calls this. Reuses the EXISTING hs-* id -
	 * never mints a second one, which would leak a duplicate pending entry and defeat the attempt cap.
	 * The per-entry guards live on the pending entry itself, so forgetPending's existing close/evict
	 * cleanup drops them for free (see the constants above for what each one bounds); the team-level
	 * guard only applies from an entry's SECOND attempt onward, so several sub-sessions of one team
	 * recovering at once each get their one first shot instead of queuing behind a sibling. */
	function repushHandshake(team: string, subId: string): HandshakeRepushOutcome {
		const hsId = findPendingHandshakeId(team, subId);
		const entry = hsId ? handshakePending.get(hsId) : undefined;
		if (!hsId || !entry) return "no-pending";
		if (entry.repushCount >= HANDSHAKE_REPUSH_MAX_ATTEMPTS) return "capped";
		const now = Date.now();
		// Always applies, even on a first attempt: collapses a same-instant double-trigger on THIS
		// entry (e.g. an immediate repush landing right after mintHandshake's own send).
		if (now - entry.sentAt < HANDSHAKE_REPUSH_DEDUPE_MS) return "throttled";
		// Team-wide contention only kicks in from an entry's SECOND attempt onward, so several
		// sub-sessions of one team each get their one first shot instead of queuing behind whichever
		// sibling's timing wins the shared window.
		if (entry.repushCount > 0) {
			const teamLast = teamLastRepushAt.get(team);
			if (teamLast !== undefined && now - teamLast < HANDSHAKE_REPUSH_DEDUPE_MS) return "throttled";
		}
		const ws = registry.get(team)?.get(subId);
		if (ws?.readyState !== 1) return "socket-gone";
		try {
			ws.send(buildHandshakePush(hsId));
		} catch (err) {
			console.error(`[ws] handshake re-push send failed for ${team}/${subId} [${hsId}]: ${err}`);
			return "socket-gone";
		}
		entry.sentAt = now;
		entry.repushCount += 1;
		teamLastRepushAt.set(team, now);
		console.log(`[ws] handshake re-pushed to ${team}/${subId} [${hsId}] (attempt ${entry.repushCount})`);
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
			forgetPending(vTeam, victim.data.subId);
			liveWriter?.clearLive(vTeam, victim.data.subId);
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

			// Handshake: ask channel-mode connections if they are the main/lead agent - UNLESS this
			// registrant already remembers its own answer from a prior handshake (reg.data.isMainOrLead)
			// AND this team has actually completed one (confirmedLeadTeams), in which case it confirms
			// silently with no prompt. The confirmedLeadTeams check keeps the shortcut from ever covering
			// a team's first-ever connection: only a team that has already answered one real challenge
			// can skip being asked again. A remembered "false" never arrives (a worker that answered
			// false is evicted permanently and does not reconnect), so only true is handled here.
			if (mode === "channel" && team !== "host") {
				if (reg.data.isMainOrLead === true && confirmedLeadTeams.has(team)) {
					ws.data.handshakeConfirmed = true;
					establishRecord(ws, { team, subId });
					console.log(`[ws] ${team}/${subId} reconnected as remembered lead - handshake skipped`);
				} else {
					mintHandshake(ws, team, subId);
				}
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
				onCatalogChange?.();
			}
		}

		// The daemon's presence-derivation report for one team. Only the authenticated host socket
		// may report a derivation (matching wake_result/host_op_reply/catalog). Both working and
		// needsLogin absent together means a derivation-impossible clear, not "observed false" -
		// passed through as undefined so the presence facade can tell the two apart.
		if (msg.type === "presence_derive" && ws.data.teamName === "host" && typeof msg.team === "string") {
			onPresenceDerive?.(
				msg.team,
				typeof msg.working === "boolean" ? msg.working : undefined,
				typeof msg.needsLogin === "boolean" ? msg.needsLogin : undefined,
			);
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
		liveWriter?.clearLive(teamName, subId);

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
		const record = liveWriter?.establishOnConfirm(pending.team, {
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
			confirmedLeadTeams.add(pending.team);
			establishRecord(ws, pending);
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
		findPendingHandshakeId,
		repushHandshake,
	};
}
