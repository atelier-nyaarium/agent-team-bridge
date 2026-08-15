import type {
	EnrollReveal,
	TrustHandshakeOp,
	TrustHandshakeResult,
	TrustPendingEntry,
} from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Interfaces & Types

type Side = "INITIATOR" | "TARGET";

interface SideSlot {
	commitment: string;
	reveal?: EnrollReveal;
}

interface Rendezvous {
	createdAt: number;
	initiatorOwnerSignPub: string;
	targetOwnerSignPub: string;
	attempts: number;
	slots: { INITIATOR: SideSlot | null; TARGET: SideSlot | null };
}

////////////////////////////////
//  Constants

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_RENDEZVOUS = 512;
const DEFAULT_MAX_PER_TARGET = 32;

////////////////////////////////
//  Class

export class TrustRendezvousCoordinator {
	private readonly rendezvous = new Map<string, Rendezvous>();
	private readonly byTarget = new Map<string, Set<string>>();

	public constructor(
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
		private readonly maxRendezvous: number = DEFAULT_MAX_RENDEZVOUS,
		private readonly maxPerTarget: number = DEFAULT_MAX_PER_TARGET,
		private readonly now: () => number = Date.now,
	) {}

	public handle(op: TrustHandshakeOp): TrustHandshakeResult {
		this.sweep();
		switch (op.step) {
			case "arm":
				return this.handleArm(op.rendezvousId, op.initiatorOwnerSignPub, op.targetOwnerSignPub, op.commitment);
			case "join":
				return this.handleJoin(op.rendezvousId, op.joinerOwnerSignPub, op.commitment);
			case "reveal":
				return this.handleReveal(op.rendezvousId, op.side, op.reveal);
			case "cancel":
				this.drop(op.rendezvousId);
				return { ok: true };
		}
	}

	public pending(targetOwnerSignPub: string): TrustPendingEntry[] {
		this.sweep();
		const ids = this.byTarget.get(targetOwnerSignPub);
		if (!ids) return [];
		const out: TrustPendingEntry[] = [];
		for (const id of ids) {
			const r = this.rendezvous.get(id);
			if (!r) continue;
			if (r.slots.INITIATOR?.reveal && r.slots.TARGET?.reveal) continue;
			out.push({ initiatorOwnerSignPub: r.initiatorOwnerSignPub, rendezvousId: id });
		}
		return out;
	}

	////////////////////////////////
	//  Functions & Helpers

	private peerSide(side: Side): Side {
		return side === "INITIATOR" ? "TARGET" : "INITIATOR";
	}

	private handleArm(
		rendezvousId: string,
		initiatorOwnerSignPub: string,
		targetOwnerSignPub: string,
		commitment: string,
	): TrustHandshakeResult {
		let r = this.rendezvous.get(rendezvousId);
		if (!r) {
			if (this.rendezvous.size >= this.maxRendezvous) {
				return { ok: false, error: "too many trust rendezvous in flight" };
			}
			const armed = this.byTarget.get(targetOwnerSignPub);
			if (armed && armed.size >= this.maxPerTarget) {
				return { ok: false, error: "too many pending trust requests for this person" };
			}
			r = {
				createdAt: this.now(),
				initiatorOwnerSignPub,
				targetOwnerSignPub,
				attempts: 0,
				slots: { INITIATOR: null, TARGET: null },
			};
			this.rendezvous.set(rendezvousId, r);
			this.index(targetOwnerSignPub, rendezvousId);
		}
		if (r.initiatorOwnerSignPub !== initiatorOwnerSignPub || r.targetOwnerSignPub !== targetOwnerSignPub) {
			return { ok: false, error: "trust rendezvous owner mismatch" };
		}
		return this.commit(r, "INITIATOR", commitment);
	}

	private handleJoin(rendezvousId: string, joinerOwnerSignPub: string, commitment: string): TrustHandshakeResult {
		const r = this.rendezvous.get(rendezvousId);
		if (!r) return { ok: false, error: "no such trust rendezvous (expired or never armed)" };
		if (r.targetOwnerSignPub !== joinerOwnerSignPub) {
			return { ok: false, error: "not the target of this trust rendezvous" };
		}
		return this.commit(r, "TARGET", commitment);
	}

	private commit(r: Rendezvous, side: Side, commitment: string): TrustHandshakeResult {
		const slot = r.slots[side];
		if (slot && slot.commitment === commitment) {
			return { ok: true, peerCommitment: r.slots[this.peerSide(side)]?.commitment };
		}
		r.attempts += 1;
		if (r.attempts > this.maxAttempts) {
			this.dropById(r);
			return { ok: false, error: "too many trust attempts; re-arm to restart" };
		}
		if (slot) return { ok: false, error: "this trust side is already committed" };
		r.slots[side] = { commitment };
		return { ok: true, peerCommitment: r.slots[this.peerSide(side)]?.commitment };
	}

	private handleReveal(rendezvousId: string, side: Side, reveal: EnrollReveal): TrustHandshakeResult {
		const r = this.rendezvous.get(rendezvousId);
		if (!r) return { ok: false, error: "no such trust rendezvous (expired or never armed)" };
		const slot = r.slots[side];
		if (!slot) return { ok: false, error: "reveal before commit for this side" };
		if (!slot.reveal) slot.reveal = reveal;
		return { ok: true, peerReveal: r.slots[this.peerSide(side)]?.reveal };
	}

	private index(targetOwnerSignPub: string, rendezvousId: string): void {
		let set = this.byTarget.get(targetOwnerSignPub);
		if (!set) {
			set = new Set();
			this.byTarget.set(targetOwnerSignPub, set);
		}
		set.add(rendezvousId);
	}

	private drop(rendezvousId: string): void {
		const r = this.rendezvous.get(rendezvousId);
		if (r) this.dropById(r, rendezvousId);
	}

	private dropById(r: Rendezvous, rendezvousId?: string): void {
		const id = rendezvousId ?? this.idOf(r);
		if (id) this.rendezvous.delete(id);
		const set = this.byTarget.get(r.targetOwnerSignPub);
		if (set && id) {
			set.delete(id);
			if (set.size === 0) this.byTarget.delete(r.targetOwnerSignPub);
		}
	}

	private idOf(r: Rendezvous): string | undefined {
		for (const [id, candidate] of this.rendezvous) {
			if (candidate === r) return id;
		}
		return undefined;
	}

	private sweep(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [id, r] of this.rendezvous) {
			if (r.createdAt <= cutoff) this.dropById(r, id);
		}
	}
}
