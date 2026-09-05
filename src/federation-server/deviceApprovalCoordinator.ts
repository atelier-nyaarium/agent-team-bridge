import { timingSafeEqual } from "node:crypto";
import type { Clock } from "../shared/ambient.js";
import type { ConsoleApprovalOp, ConsoleApprovalResult } from "../shared/federation-lifecycle.js";

function constantTimeBearerEquals(provided: string, expected: string): boolean {
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

////////////////////////////////
//  Interfaces & Types

type ConsoleApprovalJoin = NonNullable<ConsoleApprovalResult["join"]>;
type SealedEnvelope = NonNullable<ConsoleApprovalResult["sealed"]>;

interface ApprovalWindow {
	createdAt: number;
	nonce: string;
	attempts: number;
	join?: ConsoleApprovalJoin;
	sealed?: SealedEnvelope;
}

////////////////////////////////
//  Constants

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_WINDOWS = 256;

const OPAQUE_PUBLIC_ERROR = "device approval not available";

////////////////////////////////
//  Class

export class DeviceApprovalCoordinator {
	private readonly windows = new Map<string, ApprovalWindow>();

	public constructor(
		private readonly ambient: Clock,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
		private readonly maxWindows: number = DEFAULT_MAX_WINDOWS,
	) {}

	private now(): number {
		return this.ambient.now();
	}

	public handle(op: ConsoleApprovalOp): ConsoleApprovalResult {
		this.sweep();
		switch (op.step) {
			case "arm":
				return this.handleArm(op.approvalId, op.nonce);
			case "join":
				return this.handleJoin(op.approvalId, op.nonce, {
					newSignPub: op.newSignPub,
					newBoxPub: op.newBoxPub,
					joinSig: op.joinSig,
					device: op.device,
				});
			case "poll":
				return this.handlePoll(op.approvalId);
			case "approve":
				return this.handleApprove(op.approvalId, op.sealed);
			case "fetch":
				return this.handleFetch(op.approvalId, op.nonce);
			case "cancel":
				this.windows.delete(op.approvalId);
				return { ok: true };
		}
	}

	////////////////////////////////
	//  Functions & Helpers

	private handleArm(approvalId: string, nonce: string): ConsoleApprovalResult {
		const existing = this.windows.get(approvalId);
		if (existing) {
			if (existing.nonce === nonce) return { ok: true };
			return { ok: false, error: "approval window already armed" };
		}
		if (this.windows.size >= this.maxWindows) {
			return { ok: false, error: "too many device approvals in flight" };
		}
		this.windows.set(approvalId, { createdAt: this.now(), nonce, attempts: 0 });
		return { ok: true };
	}

	private handleJoin(approvalId: string, nonce: string, join: ConsoleApprovalJoin): ConsoleApprovalResult {
		const w = this.windows.get(approvalId);
		if (!w || !this.nonceMatches(nonce, w.nonce)) {
			if (w) this.charge(approvalId, w);
			return { ok: false, error: OPAQUE_PUBLIC_ERROR };
		}
		if (w.join) {
			if (w.join.newSignPub === join.newSignPub && w.join.newBoxPub === join.newBoxPub) {
				if (w.join.joinSig === join.joinSig) return { ok: true };
				w.join = join;
				return { ok: true };
			}
			return { ok: false, error: OPAQUE_PUBLIC_ERROR };
		}
		w.join = join;
		return { ok: true };
	}

	private handlePoll(approvalId: string): ConsoleApprovalResult {
		const w = this.windows.get(approvalId);
		if (!w) return { ok: false, error: "no such approval window (expired or never armed)" };
		return { ok: true, join: w.join };
	}

	private handleApprove(approvalId: string, sealed: SealedEnvelope): ConsoleApprovalResult {
		const w = this.windows.get(approvalId);
		if (!w) return { ok: false, error: "no such approval window (expired or never armed)" };
		w.sealed = sealed;
		return { ok: true };
	}

	private handleFetch(approvalId: string, nonce: string): ConsoleApprovalResult {
		const w = this.windows.get(approvalId);
		if (!w || !this.nonceMatches(nonce, w.nonce)) {
			if (w) this.charge(approvalId, w);
			return { ok: false, error: OPAQUE_PUBLIC_ERROR };
		}
		return { ok: true, sealed: w.sealed };
	}

	private charge(approvalId: string, w: ApprovalWindow): void {
		w.attempts += 1;
		if (w.attempts > this.maxAttempts) this.windows.delete(approvalId);
	}

	private nonceMatches(provided: string, armed: string): boolean {
		return constantTimeBearerEquals(provided, armed);
	}

	private sweep(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [id, w] of this.windows) {
			if (w.createdAt <= cutoff) this.windows.delete(id);
		}
	}
}
