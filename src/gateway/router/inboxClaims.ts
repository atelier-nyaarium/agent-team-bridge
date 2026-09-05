import path from "node:path";
import type { Clock } from "../../shared/ambient.js";
import { DurableStore } from "../../shared/durable-store.js";

export interface InboxClaim {
	deliveryId: string;
	seq: number;
	deliveryEpoch: number;
	offeredAt: number;
	outcome: "delivered" | "waking" | "failed";
}

interface ClaimFile {
	deliveryEpoch: number;
	claims: Record<string, InboxClaim>;
}

export class InboxClaims {
	private readonly files = new Map<string, DurableStore>();
	private readonly claims = new Map<string, ClaimFile>();

	constructor(
		private readonly dataDir: string,
		private readonly ambient: Clock,
	) {}

	claim(address: string, seq: number, deliveryEpoch: number): InboxClaim | null {
		const file = this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) {
			current.deliveryEpoch = deliveryEpoch;
			current.claims = {};
			file.saveChecked(current);
		}
		const deliveryId = `${address}:${seq}:${deliveryEpoch}`;
		const existing = current.claims[deliveryId];
		if (existing) return existing;
		const claim = {
			deliveryId,
			seq,
			deliveryEpoch,
			offeredAt: this.ambient.now(),
			outcome: "waking" as const,
		};
		current.claims[deliveryId] = claim;
		file.saveChecked(current);
		return null;
	}

	get(address: string, seq: number, deliveryEpoch: number): InboxClaim | null {
		this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return null;
		return current.claims[`${address}:${seq}:${deliveryEpoch}`] ?? null;
	}

	setOutcome(address: string, seq: number, deliveryEpoch: number, outcome: InboxClaim["outcome"]): void {
		const file = this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return;
		const deliveryId = `${address}:${seq}:${deliveryEpoch}`;
		const claim = current.claims[deliveryId];
		if (!claim) return;
		claim.outcome = outcome;
		file.saveChecked(current);
	}

	ack(address: string, seq: number, deliveryEpoch: number): void {
		const file = this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return;
		delete current.claims[`${address}:${seq}:${deliveryEpoch}`];
		file.saveChecked(current);
	}

	private file(address: string): DurableStore {
		const existing = this.files.get(address);
		if (existing) return existing;
		const name = `claim-${Buffer.from(address).toString("base64url")}`;
		const store = new DurableStore(path.join(this.dataDir, "inbox-claims"), name);
		const restored = store.load();
		const state: ClaimFile =
			restored && typeof restored === "object" && typeof (restored as ClaimFile).deliveryEpoch === "number"
				? (restored as ClaimFile)
				: { deliveryEpoch: 0, claims: {} };
		this.files.set(address, store);
		this.claims.set(address, state);
		return store;
	}
}

export function createInboxClaims(dataDir: string, ambient: Clock): InboxClaims {
	return new InboxClaims(dataDir, ambient);
}
