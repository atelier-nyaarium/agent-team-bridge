import type { Ambient } from "../shared/ambient.js";
import type { SessionBinding } from "./sessionAuthority.js";
import { HANDSHAKE_PENDING_TTL_MS, HANDSHAKE_REPUSH_DEDUPE_MS, HANDSHAKE_REPUSH_MAX_ATTEMPTS } from "./wsTypes.js";

export interface HandshakePending {
	team: string;
	subId: string;
	sentAt: number;
	repushCount: number;
}

// Commit a repush only after the socket send succeeds.
export type RepushDecision =
	| { kind: "no-pending" }
	| { kind: "capped" }
	| { kind: "throttled" }
	| { kind: "send"; hsId: string; push: string; attempt: number; commit: () => void };

export class HandshakeGate {
	// Pending entries stay bounded by live unconfirmed sockets.
	private pending = new Map<string, HandshakePending>();

	// Throttle by team to prevent round-robin bypass across entries.
	private teamLastRepushAt = new Map<string, number>();

	// Confirmed lead requires a real challenge response and its binding.
	private confirmedLeadTeams = new Map<string, SessionBinding>();

	constructor(private readonly ambient: Pick<Ambient, "now" | "newId">) {}

	private now(): number {
		return this.ambient.now();
	}

	static buildPush(hsSessionId: string): string {
		// Repushes must preserve the exact confirmation payload.
		return JSON.stringify({
			type: "channel_push",
			from: "gateway",
			body: `This is the initial bridge handshake. Reply with the \`channel_reply_structured\` tool using the session_id shown above, setting \`responseData\` to \`{ "isMainOrLead": true }\` if you are the primary session or team lead, or \`{ "isMainOrLead": false }\` if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
			session_id: hsSessionId,
			replyJsonSchema: "{ isMainOrLead: bool }",
		});
	}

	static leadClaim(replyAsJson?: Record<string, unknown>, response?: string): boolean | undefined {
		if (replyAsJson && typeof replyAsJson.isMainOrLead === "boolean") return replyAsJson.isMainOrLead;
		const legacy = response?.trim().toLowerCase();
		if (legacy === "true") return true;
		if (legacy === "false") return false;
		return undefined;
	}

	mint(team: string, subId: string): { hsId: string; push: string } {
		// Replace old coordinates before minting a new handshake.
		this.forget(team, subId);
		const hsId = `hs-${this.ambient.newId().slice(0, 8)}`;
		this.pending.set(hsId, { team, subId, sentAt: this.now(), repushCount: 0 });
		return { hsId, push: HandshakeGate.buildPush(hsId) };
	}

	private expired(p: HandshakePending, now: number): boolean {
		// Expiry stops blocking and repush, not the pending socket's late answer.
		return now - p.sentAt >= HANDSHAKE_PENDING_TTL_MS;
	}

	pendingIdFor(team: string, subId: string): string | undefined {
		// Expired entries do not block the reply gate.
		const now = this.now();
		for (const [hsId, p] of this.pending) {
			if (p.team === team && p.subId === subId && !this.expired(p, now)) return hsId;
		}
		return undefined;
	}

	pendingOf(sessionId: string): HandshakePending | undefined {
		// Do not consume or expiry-filter before authentication.
		return this.pending.get(sessionId);
	}

	consume(sessionId: string): void {
		this.pending.delete(sessionId);
	}

	forget(team: string, subId: string): void {
		for (const [hsId, p] of this.pending) {
			if (p.team === team && p.subId === subId) this.pending.delete(hsId);
		}
	}

	decideRepush(team: string, subId: string): RepushDecision {
		const hsId = this.pendingIdFor(team, subId);
		const entry = hsId ? this.pending.get(hsId) : undefined;
		if (!hsId || !entry) return { kind: "no-pending" };
		if (entry.repushCount >= HANDSHAKE_REPUSH_MAX_ATTEMPTS) return { kind: "capped" };
		const now = this.now();
		// Reuse the existing hsId so retries cannot create duplicate entries.
		if (now - entry.sentAt < HANDSHAKE_REPUSH_DEDUPE_MS) return { kind: "throttled" };
		if (entry.repushCount > 0) {
			const teamLast = this.teamLastRepushAt.get(team);
			if (teamLast !== undefined && now - teamLast < HANDSHAKE_REPUSH_DEDUPE_MS) return { kind: "throttled" };
		}
		return {
			kind: "send",
			hsId,
			push: HandshakeGate.buildPush(hsId),
			attempt: entry.repushCount + 1,
			commit: () => {
				entry.sentAt = now;
				entry.repushCount += 1;
				this.teamLastRepushAt.set(team, now);
			},
		};
	}

	confirmLead(team: string, binding: SessionBinding): void {
		// Store the binding that answered, not only the team name.
		this.confirmedLeadTeams.set(team, binding);
	}

	confirmedBy(team: string): SessionBinding | undefined {
		return this.confirmedLeadTeams.get(team);
	}

	sweep(): number {
		// Sweep throttle state only. Expired pending entries may still answer.
		const now = this.now();
		let dropped = 0;
		for (const [team, lastAt] of this.teamLastRepushAt) {
			if (now - lastAt >= HANDSHAKE_REPUSH_DEDUPE_MS) {
				this.teamLastRepushAt.delete(team);
				dropped += 1;
			}
		}
		return dropped;
	}

	expirePending(): HandshakePending[] {
		const now = this.now();
		const expired: HandshakePending[] = [];
		for (const [hsId, pending] of this.pending) {
			if (!this.expired(pending, now)) continue;
			expired.push(pending);
			this.pending.delete(hsId);
		}
		return expired;
	}
}
