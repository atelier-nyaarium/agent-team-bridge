import { mintEpoch } from "../../shared/epoch.js";
import {
	CONSUMER_IDLE_TTL_MS,
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	type InboxRowInput,
	type OpKey,
	type OpResultEnvelope,
	parseInboxAddress,
} from "../../shared/schemasInbox.js";
import type { OwnerStateStore } from "../owner/ownerStateStore.js";
import { appendInboxRow, sessionExists } from "./inboxAppend.js";
import { durabilityOutcome, floorOf, guarded, ledgerTransaction, ownerAddress, recordId } from "./inboxCore.js";
import { appendRouterOpResultRow, readOpResult } from "./inboxOpResult.js";
import { retireRow } from "./inboxRetire.js";
import { compactInbox, sweepInbox } from "./inboxSweep.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

type OpKeyInput = OpKey | { conversationId: string; opId: string; hash?: string };
type AckOutcome = "delivered" | "waking" | "failed";
export type PeerRowGate = (dstDomainId: string, sessionTarget: string, srcDomainId: string) => number | null;

export function sessionTargetOf(address: InboxAddress): string | null {
	return address.kind === "session" ? `${address.domainId}.${address.gatewayId}.${address.sessionId}` : null;
}
const addressOfTarget = (sessionTarget: string): InboxAddress | null => {
	const [domainId, gatewayId, ...rest] = sessionTarget.split(".");
	if (!domainId || !gatewayId || rest.length < 2) return null;
	return { kind: "session", domainId, gatewayId, sessionId: rest.join(".") };
};
const CONSUMER_SEEN_REFRESH_MS = 60 * 60 * 1000;

export class InboxService {
	private peerGate: PeerRowGate | null = null;
	private readonly retiredListeners: Array<(domainId: string, address: string, row: InboxRow) => void> = [];

	/** Final row transition. */
	onRowRetired(listener: (domainId: string, address: string, row: InboxRow) => void): void {
		this.retiredListeners.push(listener);
	}
	private rowRetired(domainId: string, address: string, row: InboxRow): void {
		for (const listener of this.retiredListeners) listener(domainId, address, row);
	}

	constructor(
		private readonly registry: OwnerStoreRegistry,
		private readonly routerIdentity: { signPub: string; signPriv: string },
	) {}

	/** Gate peer rows. */
	setPeerGate(gate: PeerRowGate): void {
		this.peerGate = gate;
	}

	appendRow(input: {
		address: InboxAddress;
		row: InboxRowInput;
		producerSignPub: string;
		opKey?: OpKeyInput;
		shareGeneration?: number;
		nonce?: { signerSignPub: string; nonce: string; at: number };
	}): OpResultEnvelope & { row?: InboxRow } {
		return appendInboxRow(this.registry, input);
	}

	ownerOpNonce(domainId: string, signerSignPub: string, nonce: string): { at: number } | null {
		return (
			(this.registry.for(domainId).get("nonce", `${signerSignPub}/${nonce}`)?.clear as
				| { at: number }
				| undefined) ?? null
		);
	}

	acceptOwnerOpNonce(domainId: string, signerSignPub: string, nonce: string, at: number): boolean {
		const store = this.registry.for(domainId);
		return store.put("nonce", `${signerSignPub}/${nonce}`, null, { clear: { at } }).kind === "ok";
	}

	retireRevokedPeerRows(domainId: string, sessionTarget: string, friendDomainId: string): number {
		return this.guarded(() => {
			const address = addressOfTarget(sessionTarget);
			if (!address || address.domainId !== domainId) return 0;
			const store = this.registry.for(domainId);
			let retired = 0;
			for (const row of this.rows(address, 1, Number.MAX_SAFE_INTEGER)) {
				if (row.envelope.epoch !== "peer" || row.envelope.origin.domainId !== friendDomainId) continue;
				if (this.retire(store, domainId, address, row, "target_revoked")) retired++;
			}
			return retired;
		}, 0);
	}

	retireRevokedPeerRowsInBatch(
		store: OwnerStateStore,
		tx: Parameters<Parameters<OwnerStateStore["batch"]>[0]>[0],
		domainId: string,
		sessionTarget: string,
		friendDomainId: string,
	): number {
		const address = addressOfTarget(sessionTarget);
		if (!address || address.domainId !== domainId) return 0;
		let retired = 0;
		for (const row of this.rows(address, 1, Number.MAX_SAFE_INTEGER)) {
			if (row.envelope.epoch !== "peer" || row.envelope.origin.domainId !== friendDomainId) continue;
			const ledgerId = recordId(row.envelope.opKey, this.registry.ownerKey(domainId).ownerSignPub);
			const ledger = store.get("op", ledgerId);
			const result: OpResultEnvelope = { opKey: row.envelope.opKey, outcome: "target_revoked", seq: row.seq };
			if (ledger)
				tx.put("op", ledger.id, ledger.version, {
					clear: { ...ledger.clear, state: "target_revoked", result },
				});
			tx.remove(formatInboxAddress(address), row.seq);
			retired++;
		}
		return retired;
	}

	ack(input: {
		address: InboxAddress;
		seq: number;
		/** Reject stale epochs. */
		deliveryEpoch?: number;
		outcome: AckOutcome;
		reason?: string;
		by: { domainId: string; gatewayId: string; incarnation: number };
	}): OpResultEnvelope | { opKey: OpKey; outcome: "gone" | "delivered" | "waking"; seq?: number } {
		const { address, by } = input;
		const ackKey = { conversationId: "ack", opId: String(input.seq) };
		if (
			address.domainId !== by.domainId ||
			(address.kind !== "session" && address.kind !== "gateway") ||
			address.gatewayId !== by.gatewayId
		)
			return { opKey: ackKey, outcome: "refused" };
		const incarnation = this.currentIncarnation(by.domainId, by.gatewayId);
		if (incarnation === null || by.incarnation !== incarnation) return { opKey: ackKey, outcome: "refused" };
		if (input.deliveryEpoch !== undefined && input.deliveryEpoch !== this.deliveryEpoch(address))
			return { opKey: ackKey, outcome: "refused", reason: "delivery_epoch" };
		const store = this.registry.for(address.domainId);
		let found: { seq: number; row: Record<string, unknown> } | undefined;
		try {
			found = store.rows(formatInboxAddress(address), input.seq, 1)[0];
		} catch {
			return { opKey: ackKey, outcome: "durability_uncertain" };
		}
		if (!found || found.seq !== input.seq) return { opKey: ackKey, outcome: "gone" };
		const row = found.row as unknown as InboxRow;
		if (input.outcome === "failed")
			return (
				this.retire(store, address.domainId, address, row, "failed", input.reason) ?? {
					opKey: row.envelope.opKey,
					outcome: "durability_uncertain",
				}
			);
		const opId = recordId(row.envelope.opKey, this.registry.ownerKey(address.domainId).ownerSignPub);
		const ledger = store.get("op", opId);
		const write = ledgerTransaction(store, (tx) => {
			if (ledger) tx.put("op", opId, ledger.version, { clear: { ...ledger.clear, state: input.outcome } });
			if (input.outcome === "delivered") tx.remove(formatInboxAddress(address), input.seq);
		});
		if (write.kind !== "ok") return { opKey: row.envelope.opKey, outcome: durabilityOutcome(write.kind) };
		if (input.outcome === "delivered") this.rowRetired(address.domainId, formatInboxAddress(address), row);
		return { opKey: row.envelope.opKey, outcome: input.outcome, seq: input.seq };
	}

	markWaking(domainId: string, opKey: OpKey): void {
		this.guarded(() => {
			const store = this.registry.for(domainId);
			const id = recordId(opKey, this.registry.ownerKey(domainId).ownerSignPub);
			const ledger = store.get("op", id);
			if (ledger && ledger.clear.state === "accepted")
				store.put("op", id, ledger.version, { clear: { ...ledger.clear, state: "waking" } });
		}, undefined);
	}

	rows(address: InboxAddress, fromSeq: number, limit: number): InboxRow[] {
		return this.registry
			.for(address.domainId)
			.rows(formatInboxAddress(address), fromSeq, limit)
			.map((entry) => entry.row as unknown as InboxRow);
	}

	appendRouterRow(input: {
		address: InboxAddress;
		kind: "board_observation" | "scheduled_result" | "op_result";
		opKey: OpKey;
		body: Record<string, unknown>;
		contentRefs?: string[];
	}): OpResultEnvelope & { row?: InboxRow } {
		return appendRouterOpResultRow(this.registry, this.routerIdentity, input);
	}

	pendingFor(domainId: string, gatewayId: string): Array<{ address: string; rows: InboxRow[] }> {
		return this.guarded(() => {
			const store = this.registry.for(domainId);
			const own = `gateway:${domainId}/${gatewayId}`;
			const sessions = `session:${domainId}/${gatewayId}/`;
			return store
				.addresses()
				.filter((address) => address === own || address.startsWith(sessions))
				.map((address) => ({
					address,
					rows: store
						.rows(address, 1, Number.MAX_SAFE_INTEGER)
						.map((entry) => entry.row as unknown as InboxRow)
						.filter((row) => this.stillShared(store, domainId, address, row)),
				}))
				.filter((entry) => entry.rows.length > 0);
		}, []);
	}

	private stillShared(store: OwnerStateStore, domainId: string, addressText: string, row: InboxRow): boolean {
		if (row.envelope.epoch !== "peer" || !this.peerGate) return true;
		const address = parseInboxAddress(addressText);
		const target = address ? sessionTargetOf(address) : null;
		if (!address || !target) return true;
		const ledger = store.get("op", recordId(row.envelope.opKey, this.registry.ownerKey(domainId).ownerSignPub));
		const accepted = Number(ledger?.clear.shareGeneration ?? 0);
		const current = this.peerGate(domainId, target, row.envelope.origin.domainId);
		if (current !== null && current <= accepted) return true;
		this.retire(store, domainId, address, row, "target_revoked");
		return false;
	}

	readOwner(
		domainId: string,
		signerSignPub: string,
		fromSeq: number,
		limit: number,
		cursorEpoch?: number,
	): InboxRow[] | { outcome: "cursor_stale"; floor: number; dropped: number } {
		const store = this.registry.for(domainId);
		const id = `consumer:${signerSignPub}`;
		const consumer = store.get("consumer", id);
		const owner = this.ownerAddress(domainId);
		const floor = floorOf(store, this.registry, domainId);
		// Mailbox epochs are random tags. Compare equality only across re-mints.
		if (
			!consumer ||
			(cursorEpoch !== undefined && cursorEpoch !== Number(consumer.clear.cursorEpoch)) ||
			fromSeq < floor
		)
			return { outcome: "cursor_stale", floor, dropped: Math.max(0, floor - fromSeq) };
		if (this.now() - Number(consumer.clear.lastSeen ?? 0) > CONSUMER_SEEN_REFRESH_MS)
			store.put("consumer", id, consumer.version, { clear: { ...consumer.clear, lastSeen: this.now() } });
		return this.rows(owner, fromSeq, limit);
	}

	readOwnerKeyRows(domainId: string, _signerSignPub: string, sinceMs: number): InboxRow[] {
		return this.rows(this.ownerAddress(domainId), 1, Number.MAX_SAFE_INTEGER).filter(
			(row) =>
				(row.envelope.kind === "key_request" || row.envelope.kind === "key_grant") && row.acceptedAt >= sinceMs,
		);
	}

	advanceCursor(
		domainId: string,
		signerSignPub: string,
		cursor: number,
		cursorEpoch: number,
	): { outcome: "ok" } | { outcome: "cursor_stale"; floor: number; dropped: number } {
		const store = this.registry.for(domainId);
		const id = `consumer:${signerSignPub}`;
		const current = store.get("consumer", id);
		const floor = floorOf(store, this.registry, domainId);
		if (!current || cursorEpoch !== Number(current.clear.cursorEpoch) || cursor < floor)
			return { outcome: "cursor_stale", floor, dropped: Math.max(0, floor - cursor) };
		const result = store.put("consumer", id, current.version, {
			clear: { cursor, cursorEpoch, lastSeen: this.now(), incarnation: Number(current.clear.incarnation ?? 0) },
		});
		return result.kind === "ok" ? { outcome: "ok" } : { outcome: "cursor_stale", floor, dropped: 0 };
	}

	compactOwnerInbox(domainId: string): void {
		compactInbox(this.registry, domainId);
	}

	forgetConsumer(domainId: string, signerSignPub: string): void {
		this.guarded(() => {
			const store = this.registry.for(domainId);
			const record = store.get("consumer", `consumer:${signerSignPub}`);
			if (record) store.del("consumer", record.id, record.version);
		}, undefined);
	}
	registerConsumer(
		domainId: string,
		signerSignPub: string,
		incarnation: number,
	): { cursor: number; cursorEpoch: number } {
		const store = this.registry.for(domainId);
		const id = `consumer:${signerSignPub}`;
		const current = store.get("consumer", id);
		const ownerAddressText = formatInboxAddress(this.ownerAddress(domainId));
		const metadata = store.get("inbox.address", ownerAddressText);
		const cursorEpoch = current ? Number(current.clear.cursorEpoch) : mintEpoch();
		ledgerTransaction(store, (tx) => {
			tx.put("consumer", id, current?.version ?? null, {
				clear: { cursor: Number(current?.clear.cursor ?? 0), cursorEpoch, lastSeen: this.now(), incarnation },
			});
			tx.put("inbox.address", ownerAddressText, metadata?.version ?? null, {
				clear: {
					...metadata?.clear,
					nextCursorEpoch: metadata?.clear.nextCursorEpoch,
				},
			});
		});
		return { cursor: Number(current?.clear.cursor ?? 0), cursorEpoch };
	}

	upsertSession(
		domainId: string,
		gatewayId: string,
		sessionId: string,
		value: { kind: string; label: string; recordExists: boolean },
	): void {
		this.guarded(() => {
			const store = this.registry.for(domainId);
			const id = `session:${gatewayId}/${sessionId}`;
			const current = store.get("session", id);
			store.put("session", id, current?.version ?? null, { clear: { ...value, lastSeen: this.now() } });
		}, undefined);
	}
	forgetSession(domainId: string, gatewayId: string, sessionId: string): void {
		this.guarded(() => {
			const store = this.registry.for(domainId);
			const id = `session:${gatewayId}/${sessionId}`;
			const record = store.get("session", id);
			if (record) store.del("session", id, record.version);
			const address: InboxAddress = { kind: "session", domainId, gatewayId, sessionId };
			for (const row of this.rows(address, 1, Number.MAX_SAFE_INTEGER))
				this.retire(store, domainId, address, row, "failed", "session_forgotten");
			// Forgetting fails rows and advances the epoch.
			this.recreateAddress(address);
		}, undefined);
	}
	hasSession(domainId: string, gatewayId: string, sessionId: string): boolean {
		return sessionExists(this.registry, domainId, gatewayId, sessionId);
	}
	registerGateway(domainId: string, gatewayId: string): number | null {
		return this.guarded(() => {
			const store = this.registry.for(domainId);
			const id = `gateway:${gatewayId}`;
			const current = store.get("gateway", id);
			const incarnation = Number(current?.clear.incarnation ?? 0) + 1;
			const write = store.put("gateway", id, current?.version ?? null, { clear: { incarnation } });
			return write.kind === "ok" ? incarnation : null;
		}, null);
	}
	currentIncarnation(domainId: string, gatewayId: string): number | null {
		return this.guarded(
			() =>
				Number(this.registry.for(domainId).get("gateway", `gateway:${gatewayId}`)?.clear.incarnation ?? NaN) ||
				null,
			null,
		);
	}
	deliveryEpoch(address: InboxAddress): number {
		return this.guarded(
			() =>
				Number(
					this.registry.for(address.domainId).get("inbox.address", formatInboxAddress(address))?.clear
						.epoch ?? 1,
				),
			1,
		);
	}
	recreateAddress(address: InboxAddress): number {
		const store = this.registry.for(address.domainId);
		const id = formatInboxAddress(address);
		const current = store.get("inbox.address", id);
		const epoch = mintEpoch();
		store.put("inbox.address", id, current?.version ?? null, { clear: { ...current?.clear, epoch } });
		return epoch;
	}
	opResult(domainId: string, opKey: OpKey): OpResultEnvelope | null {
		return readOpResult(this.registry, domainId, opKey);
	}

	sweep(now: number = this.now()): void {
		sweepInbox(
			this.registry,
			this.routerIdentity,
			(domainId, address, row) => this.rowRetired(domainId, address, row),
			(domainId, signerSignPub) => this.forgetConsumer(domainId, signerSignPub),
			now,
		);
	}

	private now(): number {
		return this.registry.now();
	}
	private guarded<T>(fn: () => T, fallback: T): T {
		return guarded(fn, fallback);
	}
	/** Below floor means dropped. */
	ownerFloor(domainId: string): number {
		return floorOf(this.registry.for(domainId), this.registry, domainId);
	}

	private ownerAddress(domainId: string): InboxAddress {
		return ownerAddress(this.registry, domainId);
	}

	/** Retire atomically. */
	private retire(
		store: OwnerStateStore,
		domainId: string,
		address: InboxAddress,
		row: InboxRow,
		outcome: "failed" | "expired" | "target_revoked",
		reason?: string,
	): OpResultEnvelope | null {
		return retireRow(
			this.registry,
			this.routerIdentity,
			store,
			domainId,
			address,
			row,
			outcome,
			reason,
			(d, a, r) => this.rowRetired(d, a, r),
		);
	}
}
