import type { Clock } from "../shared/ambient.js";
import type { EnrollHandshakeOp, EnrollHandshakeResult, EnrollReveal } from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Interfaces & Types

type Role = "ADMIN" | "ENROLLEE";

interface RoleSlot {
	commitment: string;
	reveal?: EnrollReveal;
}

interface HandshakeWindow {
	createdAt: number;
	attempts: number;
	slots: { ADMIN: RoleSlot | null; ENROLLEE: RoleSlot | null };
}

////////////////////////////////
//  Constants

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_WINDOWS = 256;

////////////////////////////////
//  Class

export class EnrollHandshakeCoordinator {
	private readonly windows = new Map<string, HandshakeWindow>();

	public constructor(
		private readonly ambient: Clock,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
		private readonly maxWindows: number = DEFAULT_MAX_WINDOWS,
	) {}

	private now(): number {
		return this.ambient.now();
	}

	public handle(op: EnrollHandshakeOp): EnrollHandshakeResult {
		this.sweep();
		switch (op.step) {
			case "commit":
				return this.handleCommit(op.handshakeId, op.role, op.commitment);
			case "reveal":
				return this.handleReveal(op.handshakeId, op.role, op.reveal);
			case "cancel":
				this.windows.delete(op.handshakeId);
				return { ok: true };
		}
	}

	////////////////////////////////
	//  Functions & Helpers

	private peerRole(role: Role): Role {
		return role === "ADMIN" ? "ENROLLEE" : "ADMIN";
	}

	private handleCommit(handshakeId: string, role: Role, commitment: string): EnrollHandshakeResult {
		let w = this.windows.get(handshakeId);
		if (!w) {
			if (this.windows.size >= this.maxWindows) {
				return { ok: false, error: "too many enroll handshakes in flight" };
			}
			w = { createdAt: this.now(), attempts: 0, slots: { ADMIN: null, ENROLLEE: null } };
			this.windows.set(handshakeId, w);
		}
		const slot = w.slots[role];
		if (slot && slot.commitment === commitment) {
			return { ok: true, peerCommitment: w.slots[this.peerRole(role)]?.commitment };
		}
		w.attempts += 1;
		if (w.attempts > this.maxAttempts) {
			this.windows.delete(handshakeId);
			return { ok: false, error: "too many enroll attempts; rescan to restart" };
		}
		if (slot) return { ok: false, error: "this enroll role is already committed" };
		w.slots[role] = { commitment };
		return { ok: true, peerCommitment: w.slots[this.peerRole(role)]?.commitment };
	}

	private handleReveal(handshakeId: string, role: Role, reveal: EnrollReveal): EnrollHandshakeResult {
		const w = this.windows.get(handshakeId);
		if (!w) return { ok: false, error: "no such enroll handshake (expired or never started)" };
		const slot = w.slots[role];
		if (!slot) return { ok: false, error: "reveal before commit for this role" };
		if (!slot.reveal) slot.reveal = reveal;
		return { ok: true, peerReveal: w.slots[this.peerRole(role)]?.reveal };
	}

	private sweep(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [id, w] of this.windows) {
			if (w.createdAt <= cutoff) this.windows.delete(id);
		}
	}
}
