import crypto from "node:crypto";
import { isAgentWorking, isAtPrompt, isPromptEmpty } from "../shared/agent-screen.js";
import type { SessionRecord } from "../shared/session-store.js";

////////////////////////////////
//  Interfaces & Types

export type VibeInboundOrigin = "user" | "agent";

/** The narrow slice of session access vibeCheck needs - satisfied structurally by both a raw
 * SessionStore (tests) and the presence facade (production, so a description write announces
 * itself on the presence plane instead of escaping the single-writer funnel). */
export interface VibeCheckSessionAccess {
	getByTeam: (team: string) => SessionRecord | undefined;
	setDescription: (team: string, raw: string) => string | null;
}

export interface VibeCheckDeps {
	sessionAccess: VibeCheckSessionAccess;
	/** The CONFIRMED lead socket serving a team, or undefined (asleep / unconfirmed / virtual). The
	 * vibe check goes only to the lead - never broadcast to sub-sessions, never to a session still
	 * verifying. */
	resolveLead: (team: string) => { send: (payload: string) => void } | undefined;
	/** Capture the record's pane screen (raw ANSI), or null when unpeekable right now (host daemon
	 * offline, container booting, transient error). Null and errors both leave the check due. */
	peekScreen: (record: SessionRecord) => Promise<string | null>;
	/** Type `/rename <description>` into the record's pane (submitted). Rejects on failure, leaving
	 * the rename pending for the next tick. dedupKey makes a re-relayed injection idempotent. */
	sendRename: (record: SessionRecord, description: string, dedupKey: string) => Promise<void>;
	now?: () => number;
	idGen?: () => string;
}

interface TeamVibeState {
	// fresh = a new session or one that just came (back) online: the first check arms after
	// FRESH_USER_THRESHOLD messages from the USER. steady = it has been checked once: re-arms every
	// STEADY_ANY_THRESHOLD inbound messages from anyone (user or agent).
	phase: "fresh" | "steady";
	count: number;
	due: boolean;
	pending?: { id: string; sentAt: number };
	// Armed by resolve() when a description stores: the follow-through `/rename <description>`
	// keystroke, injected at the NEXT idle detection (the answering turn itself occupies the pane).
	// The vc id doubles as the dedup key, so a retried injection of the same answer cannot double.
	renamePending?: { description: string; dedupKey: string };
}

////////////////////////////////
//  Functions & Helpers

// A new/rewoken session gets described after its first few USER messages; an established one
// refreshes every N inbound messages of any origin ("thereafter" counts user and agent alike).
const FRESH_USER_THRESHOLD = 3;
const STEADY_ANY_THRESHOLD = 10;
// An unanswered check expires rather than re-sending: the session got its shot, so it settles to
// steady and waits out a whole fresh message threshold. No retry hammering a session that ignores it.
const PENDING_EXPIRY_MS = 10 * 60_000;

/**
 * The vibe check: an AI-managed session description. The gateway periodically asks a session's OWN
 * agent "what is this session about, as a short phrase" and stores the answer on the SessionRecord
 * (surfaced to the console via TeamInfo.description). Same wire as the bridge handshake - a
 * channel_push carrying a replyJsonSchema, answered via channel_reply_structured and intercepted in
 * respond() by resolve() below - but `from` is "vibe-check", NOT "gateway": the MCP plugin
 * auto-answers a gateway-authored reply_schema push with its cached isMainOrLead (helpers.ts), which
 * would swallow the question before the LLM ever saw it.
 *
 * A check only fires when a pane peek shows the session idle (not working AND at the composer
 * prompt, agent-screen.ts), so it never burns an esc-interrupt or queues behind a running turn; a
 * busy session stays due and is re-checked each tick.
 *
 * A stored answer also arms a follow-through: at the NEXT idle detection (the answering turn itself
 * occupies the pane), the gateway types `/rename <description>` into the session's own composer so
 * the harness-side session title tracks the description. Gated additionally on an EMPTY composer -
 * injecting into a human's staged draft would corrupt and submit it.
 */
export function createVibeCheck(deps: VibeCheckDeps) {
	const now = deps.now ?? (() => Date.now());
	const idGen = deps.idGen ?? (() => `vc-${crypto.randomUUID().slice(0, 8)}`);
	const states = new Map<string, TeamVibeState>();
	// vc id -> team, so respond() resolves an answer without scanning states.
	const pendingById = new Map<string, string>();
	// Per-team single-flight for the tick's async peek, so a slow peek is never doubled by the next
	// tick firing while the previous await is still out.
	const peekInFlight = new Set<string>();

	function buildPush(id: string): string {
		return JSON.stringify({
			type: "channel_push",
			from: "vibe-check",
			body: `Session vibe check from the gateway. Reply with the \`channel_reply_structured\` tool using the session_id shown above, setting \`responseData\` to \`{ "description": "<short phrase>" }\` - one short phrase, 7 words or fewer, saying what this session is currently about or working on. It labels this session on the owner's console board, where it renders truncated on one line, so shorter reads better. Answer from what you already know - this is not a task. Do not use \`crosstalk_send\`.`,
			session_id: id,
			replyJsonSchema: "{ description: string }",
		});
	}

	function clearPending(state: TeamVibeState): void {
		if (state.pending) pendingById.delete(state.pending.id);
		state.pending = undefined;
		state.renamePending = undefined;
	}

	/** Count one inbound message delivered INTO a session (user = console send/reply, agent =
	 * crosstalk or a reply landing back). Gateway-authored pushes (handshakes, vibe checks) are never
	 * routed through here. Only store-recorded sessions are tracked - a recordless loose peer has no
	 * row to describe. */
	function noteInbound(team: string, origin: VibeInboundOrigin): void {
		if (!deps.sessionAccess.getByTeam(team)) return;
		let state = states.get(team);
		if (!state) {
			state = { phase: "fresh", count: 0, due: false };
			states.set(team, state);
		}
		// Already armed or awaiting an answer: further traffic changes nothing.
		if (state.due || state.pending) return;
		// The fresh phase counts USER messages only, per spec - agent chatter alone does not trigger
		// the first check of a brand-new session.
		if (state.phase === "fresh" && origin !== "user") return;
		state.count += 1;
		const threshold = state.phase === "fresh" ? FRESH_USER_THRESHOLD : STEADY_ANY_THRESHOLD;
		if (state.count >= threshold) {
			state.due = true;
			state.count = 0;
		}
	}

	/** Disconnect hook (the team's last real socket dropped): the next incarnation is a fresh wake or
	 * reconnect, which per spec restarts the 3-user-message fresh phase. The stored description
	 * itself survives - only the counting state resets. */
	function noteOffline(team: string): void {
		const state = states.get(team);
		if (!state) return;
		clearPending(state);
		states.set(team, { phase: "fresh", count: 0, due: false });
	}

	/** Intercept a vc-* answer arriving through respond(), mirroring resolveHandshake's contract.
	 * Returns true when the session id was a pending vibe check (whether or not the answer stored
	 * cleanly), false to let respond() continue normal delivery. */
	function resolve(sessionId: string, replyAsJson?: Record<string, unknown>, response?: string): boolean {
		const team = pendingById.get(sessionId);
		if (team === undefined) return false;
		pendingById.delete(sessionId);
		const state = states.get(team);
		if (state) {
			state.pending = undefined;
			state.due = false;
			state.phase = "steady";
			state.count = 0;
		}
		const raw = typeof replyAsJson?.description === "string" ? replyAsJson.description : (response ?? "");
		const stored = deps.sessionAccess.setDescription(team, raw);
		// Follow through with the harness-side title: arm the /rename injection for the next idle
		// detection. Only for a storable answer - a blank one renames nothing.
		if (stored && state) state.renamePending = { description: stored, dedupKey: sessionId };
		console.log(
			stored
				? `[vibe] ${team} described: "${stored}" [${sessionId}]`
				: `[vibe] ${team} answered with nothing storable [${sessionId}]`,
		);
		return true;
	}

	/** One scheduler pass: expire stale pendings, prune states whose record is gone, and for each team
	 * with work (a due check, or an answered check owing its /rename) peek the pane and act at the
	 * earliest idle detection (not working AND at prompt). A busy/unpeekable/asleep session keeps its
	 * work for the next tick. */
	async function tick(): Promise<void> {
		const t = now();
		for (const [team, state] of [...states]) {
			// A forgotten / TTL-swept record has nothing left to describe.
			if (!deps.sessionAccess.getByTeam(team)) {
				clearPending(state);
				states.delete(team);
				continue;
			}
			if (state.pending && t - state.pending.sentAt >= PENDING_EXPIRY_MS) {
				// The session got its shot and ignored it: settle to steady and wait out a whole
				// fresh message threshold rather than re-sending forever.
				clearPending(state);
				state.phase = "steady";
				state.count = 0;
			}
			const hasWork = state.renamePending !== undefined || (state.due && !state.pending);
			if (!hasWork || peekInFlight.has(team)) continue;
			const record = deps.sessionAccess.getByTeam(team);
			if (!record) continue;
			// Only a live, CONFIRMED lead is actionable; an asleep or verifying session keeps its work.
			if (!deps.resolveLead(team)) continue;
			peekInFlight.add(team);
			try {
				const screen = await deps.peekScreen(record);
				if (screen === null) continue;
				if (isAgentWorking(screen) || !isAtPrompt(screen)) continue;
				// The rename follow-through outranks a newly-due check: it belongs to the answer the
				// session already gave, and the composer must ALSO be provably empty - injecting into a
				// human's staged draft would corrupt and submit it.
				if (state.renamePending) {
					if (!isPromptEmpty(screen)) continue;
					const { description, dedupKey } = state.renamePending;
					await deps.sendRename(record, description, dedupKey);
					state.renamePending = undefined;
					console.log(`[vibe] renamed ${team} to "${description}"`);
					continue;
				}
				// Re-resolve after the await: the socket may have dropped while the peek was out.
				const lead = deps.resolveLead(team);
				if (!lead) continue;
				const id = idGen();
				lead.send(buildPush(id));
				state.due = false;
				state.pending = { id, sentAt: now() };
				pendingById.set(id, team);
				console.log(`[vibe] check sent to ${team} [${id}]`);
			} catch (err) {
				// A transient peek/send/rename failure leaves the work in place for the next tick.
				console.warn(`[vibe] attempt for ${team} failed: ${err instanceof Error ? err.message : err}`);
			} finally {
				peekInFlight.delete(team);
			}
		}
	}

	return { noteInbound, noteOffline, resolve, tick };
}

export type VibeCheck = ReturnType<typeof createVibeCheck>;
