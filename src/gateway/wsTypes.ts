import type { ServerWebSocket } from "bun";
import type { Capability } from "../shared/capabilities.js";
import type { SessionStore } from "../shared/session-store.js";
import type { ConnectionMode, WebSocketConfig } from "../shared/types.js";
import type { SessionAuthority } from "./sessionAuthority.js";
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
	// Fired on a presence_derive frame from the host daemon: a genuine, hysteresis-confirmed flip for
	// one team, or `undefined` for a derivation-impossible clear (the daemon lost its only frame source
	// for that team - a peek-failure streak, or the team dropped from its watch list). Absent when
	// presence is not wired.
	onPresenceDerive?: (
		team: string,
		derived: { working?: boolean; needsLogin?: boolean; limitBlocked?: boolean; limitDetail?: string } | undefined,
	) => void;
	// Fired when a real registration evicts a virtual console peer, so the console
	// handler can clear its binding/mailbox and let the device re-register.
	onVirtualPeerEvicted?: (conversationId: string) => void;
	// Fired with the complete declaration from the register that actually holds the host slot, so
	// neither a LAN peer nor a refused second daemon can announce a capability this way.
	onDaemonCapabilities?: (capabilities: Capability[]) => void;
	// Every Codex frame from the authenticated host socket. Gated on that slot for the same reason the
	// terminal ops are: these frames mutate session-owned durable state.
	onCodexHostMessage?: (msg: Record<string, unknown>) => void;
	// Every Copilot ACP frame from the authenticated host socket.
	onCopilotHostMessage?: (msg: Record<string, unknown>) => void;
	// The gateway's authoritative session store. The handshake confirm establishes/binds a record
	// here (register only stashes the reported ids on the socket); disconnect clears the live pointer.
	// Absent in tests that do not exercise session recording.
	sessionStore?: SessionStore;
	// The sole resolver of "what must a caller prove to act as X". Absent in tests that do not
	// exercise the identity gates, which then behave as an ungated gateway does.
	auth?: SessionAuthority;
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
	// The presence facade's own markDirty(), threaded in raw rather than through presenceWriter's
	// sessionStore-mirroring interface above (SessionStore has no markDirty concept of its own). A
	// live-socket transition with no dedicated wrapper method - a fresh register, before its
	// handshake resolves either way - can still announce itself on the presence plane immediately
	// through this, rather than leaving the row's already-live content unannounced until the
	// eventual handshake confirm or the periodic tripwire notices it.
	announcePresenceDirty?: () => void;
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
	// The launcher-delivered binding this connection proved at register: set only when the presented
	// token resolved to a record whose team is the one being claimed. Undefined for a hand-launched
	// session, the host daemon, and console peers, all of which operate unbound.
	boundToken?: string;
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
export const REGISTER_WINDOW_MS = 60_000;

// repushHandshake's dedupe window, applied both per pending entry (collapses a same-instant
// double-trigger, e.g. two respond() calls landing in the same batch - same-id reuse already
// prevents a growing pileup here, so it does not need to cover a real reply-attempt's think time)
// and per team (in websocket.ts - closes the round-robin gap a caller who knows several of one team's
// sub-session conversationIds would otherwise have around the per-entry window). The team-level
// window exempts an entry's OWN first attempt: without that, several sub-sessions of one team
// recovering at once (the exact scenario repushHandshake exists for) could starve each other
// indefinitely queuing behind a shared window, rather than merely being rate-limited on repeats.
//
// MUST stay comfortably above the send path's post-wake settle delay (routes.ts waits for the woken
// session's channel listener before delivering, which re-pushes the handshake for an unconfirmed
// recipient): a value merely equal to that delay lets the post-wake nudge land right as this window
// opens, so every wake-then-deliver duplicates the handshake - the window only postpones the
// duplicate rather than preventing it. 30s also absorbs a slow `claude --resume`, where registration
// lands well before the session can answer anything.
export const HANDSHAKE_REPUSH_DEDUPE_MS = 30_000;

// repushHandshake's total attempt cap. /respond is unauthenticated and conversationId is spoofable
// (it rides verbatim in every session_id a caller has seen), so without a cap a peer that merely
// knows a victim's conversationId could sustain gateway-authored handshake prompts into the victim's
// unconfirmed socket indefinitely. Self-closes once the victim confirms (its pending entry clears).
export const HANDSHAKE_REPUSH_MAX_ATTEMPTS = 5;

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
