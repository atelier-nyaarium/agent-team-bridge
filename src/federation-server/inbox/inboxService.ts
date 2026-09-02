import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import {
	CONSUMER_IDLE_TTL_MS,
	formatInboxAddress,
	INBOX_ROW_TTL_MS,
	type InboxAddress,
	type InboxRow,
	type InboxRowInput,
	type OpKey,
	type OpResultEnvelope,
	parseInboxAddress,
	signRowEnvelope,
	verifyRowEnvelope,
} from "../../shared/schemasInbox.js";
import { OwnerQuarantined, type OwnerStateStore } from "../owner/ownerStateStore.js";
import { capacityRefusal } from "./inboxCapacity.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

type OpKeyInput = OpKey | { conversationId: string; opId: string; hash?: string };
type AckOutcome = "delivered" | "waking" | "failed";
type Terminal = "failed" | "expired";
const recordId = (key: OpKey, owner: string) => `op:${owner}/${key.conversationId}/${key.opId}`;
const CONSUMER_SEEN_REFRESH_MS = 60 * 60 * 1000;
const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;

export class InboxService {
	constructor(
		private readonly registry: OwnerStoreRegistry,
		private readonly routerIdentity: { signPub: string; signPriv: string },
	) {}

	appendRow(input: {
		address: InboxAddress;
		row: InboxRowInput;
		producerSignPub: string;
		opKey?: OpKeyInput;
	}): OpResultEnvelope & { row?: InboxRow } {
		const { address, row } = input;
		const key = row.envelope.opKey;
		const opHash =
			input.opKey && "hash" in input.opKey && input.opKey.hash
				? input.opKey.hash
				: sha256Hex(canonicalJson({ envelope: row.envelope, body: row.body }));
		const store = this.registry.for(address.domainId);
		const owner = this.registry.ownerKey(address.domainId).ownerSignPub;
		if (address.kind === "owner" && address.ownerSignPub !== owner)
			return { opKey: key, outcome: "refused", reason: "address" };
		const id = recordId(key, owner);
		if (!verifyRowEnvelope(row.envelope, row.producerSig, input.producerSignPub))
			return { opKey: key, outcome: "refused", reason: "signature" };
		let existing: ReturnType<OwnerStateStore["get"]>;
		try {
			existing = store.get("op", id);
		} catch {
			return { opKey: key, outcome: "durability_uncertain" };
		}
		if (existing) {
			const clear = existing.clear;
			if (clear.opHash === opHash && clear.result && typeof clear.result === "object")
				return clear.result as OpResultEnvelope & { row?: InboxRow };
			return { opKey: key, outcome: "conflict" };
		}
		const size = Buffer.byteLength(canonicalJson(row));
		let refusal: string | null;
		try {
			refusal = capacityRefusal(address, store, size);
		} catch {
			return { opKey: key, outcome: "durability_uncertain" };
		}
		if (refusal) return { opKey: key, outcome: "refused", reason: refusal };
		return this.appendLedgerTransaction(store, address, row, { state: "accepted", opHash, at: this.now() });
	}

	ack(input: {
		address: InboxAddress;
		seq: number;
		/** A stale epoch refuses the acknowledgement. */
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
		const write = this.ledgerTransaction(store, (tx) => {
			if (ledger) tx.put("op", opId, ledger.version, { clear: { ...ledger.clear, state: input.outcome } });
			if (input.outcome === "delivered") tx.remove(formatInboxAddress(address), input.seq);
		});
		if (write.kind === "ok") return { opKey: row.envelope.opKey, outcome: input.outcome, seq: input.seq };
		return { opKey: row.envelope.opKey, outcome: this.durabilityOutcome(write.kind) };
	}

	/** Mark held rows so repeats report that they await the gateway. */
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
						.map((entry) => entry.row as unknown as InboxRow),
				}))
				.filter((entry) => entry.rows.length > 0);
		}, []);
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
		const floor = this.floorOf(store, domainId);
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

	advanceCursor(
		domainId: string,
		signerSignPub: string,
		cursor: number,
		cursorEpoch: number,
	): { outcome: "ok" } | { outcome: "cursor_stale"; floor: number; dropped: number } {
		const store = this.registry.for(domainId);
		const id = `consumer:${signerSignPub}`;
		const current = store.get("consumer", id);
		const floor = this.floorOf(store, domainId);
		if (!current || cursorEpoch !== Number(current.clear.cursorEpoch) || cursor < floor)
			return { outcome: "cursor_stale", floor, dropped: Math.max(0, floor - cursor) };
		const result = store.put("consumer", id, current.version, {
			clear: { cursor, cursorEpoch, lastSeen: this.now(), incarnation: Number(current.clear.incarnation ?? 0) },
		});
		return result.kind === "ok" ? { outcome: "ok" } : { outcome: "cursor_stale", floor, dropped: 0 };
	}

	compactOwnerInbox(domainId: string): void {
		const store = this.registry.for(domainId);
		const consumers = store.list("consumer");
		if (!consumers.length) return;
		const floor = Math.min(...consumers.map((r) => Number(r.clear.cursor)));
		const ownerAddress = formatInboxAddress(this.ownerAddress(domainId));
		if (floor + 1 <= this.floorOf(store, domainId)) return;
		const floorRecord = store.get("inbox.address", ownerAddress);
		this.ledgerTransaction(store, (tx) => {
			tx.put("inbox.address", ownerAddress, floorRecord?.version ?? null, {
				clear: { ...floorRecord?.clear, floor: floor + 1 },
			});
		});
		store.retire(ownerAddress, floor);
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
		const ownerAddress = formatInboxAddress(this.ownerAddress(domainId));
		const metadata = store.get("inbox.address", ownerAddress);
		const cursorEpoch = current
			? Number(current.clear.cursorEpoch)
			: Number(metadata?.clear.nextCursorEpoch ?? 0) + 1;
		this.ledgerTransaction(store, (tx) => {
			tx.put("consumer", id, current?.version ?? null, {
				clear: { cursor: Number(current?.clear.cursor ?? 0), cursorEpoch, lastSeen: this.now(), incarnation },
			});
			tx.put("inbox.address", ownerAddress, metadata?.version ?? null, {
				clear: {
					...metadata?.clear,
					nextCursorEpoch: Math.max(Number(metadata?.clear.nextCursorEpoch ?? 0), cursorEpoch),
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
	/** Fail held rows and advance the delivery epoch. */
	forgetSession(domainId: string, gatewayId: string, sessionId: string): void {
		this.guarded(() => {
			const store = this.registry.for(domainId);
			const id = `session:${gatewayId}/${sessionId}`;
			const record = store.get("session", id);
			if (record) store.del("session", id, record.version);
			const address: InboxAddress = { kind: "session", domainId, gatewayId, sessionId };
			for (const row of this.rows(address, 1, Number.MAX_SAFE_INTEGER))
				this.retire(store, domainId, address, row, "failed", "session_forgotten");
			this.recreateAddress(address);
		}, undefined);
	}
	hasSession(domainId: string, gatewayId: string, sessionId: string): boolean {
		return this.guarded(
			() => !!this.registry.for(domainId).get("session", `session:${gatewayId}/${sessionId}`),
			false,
		);
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
		const epoch = Number(current?.clear.epoch ?? 0) + 1;
		store.put("inbox.address", id, current?.version ?? null, { clear: { ...current?.clear, epoch } });
		return epoch;
	}
	opResult(domainId: string, opKey: OpKey): OpResultEnvelope | null {
		const store = this.registry.for(domainId);
		const record = store.get("op", recordId(opKey, this.registry.ownerKey(domainId).ownerSignPub));
		if (record) return (record.clear.result as OpResultEnvelope) ?? null;
		return null;
	}

	sweep(now: number = this.now()): void {
		for (const domainId of this.domains()) {
			try {
				this.sweepDomain(domainId, now);
			} catch (error) {
				if (error instanceof OwnerQuarantined) continue;
				console.warn(`[inbox] sweep skipped ${domainId}: ${(error as Error).message}`);
			}
		}
	}

	private sweepDomain(domainId: string, now: number): void {
		const store = this.registry.for(domainId);
		if (store.health().quarantined) return;
		for (const record of store.list("consumer"))
			if (now - Number(record.clear.lastSeen) > CONSUMER_IDLE_TTL_MS)
				this.forgetConsumer(domainId, record.id.slice("consumer:".length));
		for (const address of this.addresses(store, domainId))
			for (const item of store.rows(address, 1, Number.MAX_SAFE_INTEGER)) {
				if (now - Number((item.row as { acceptedAt: number }).acceptedAt) > INBOX_ROW_TTL_MS)
					this.retire(
						store,
						domainId,
						parseInboxAddress(address) as InboxAddress,
						item.row as unknown as InboxRow,
						"expired",
					);
			}
		this.compactOwnerInbox(domainId);
		if (store.health().journalBytes > JOURNAL_COMPACT_BYTES) store.compact();
	}

	private now(): number {
		return this.registry.now();
	}
	private domains(): string[] {
		return this.registry.domains();
	}
	private guarded<T>(fn: () => T, fallback: T): T {
		try {
			return fn();
		} catch (error) {
			if (error instanceof OwnerQuarantined) return fallback;
			throw error;
		}
	}
	private floorOf(store: OwnerStateStore, domainId: string): number {
		return Number(store.get("inbox.address", formatInboxAddress(this.ownerAddress(domainId)))?.clear.floor ?? 1);
	}
	private durabilityOutcome(kind: string): "durability_uncertain" | "durability_failure" {
		return kind === "quarantined" || kind === "durability_uncertain"
			? "durability_uncertain"
			: "durability_failure";
	}
	private addresses(store: OwnerStateStore, domainId: string): string[] {
		return store
			.addresses()
			.filter(
				(address) =>
					address.startsWith(`owner:${domainId}/`) ||
					address.startsWith(`session:${domainId}/`) ||
					address.startsWith(`gateway:${domainId}/`),
			);
	}
	private storeOrNull(domainId: string): OwnerStateStore | null {
		try {
			const store = this.registry.for(domainId);
			return store.health().quarantined ? null : store;
		} catch {
			return null;
		}
	}
	private ownerAddress(domainId: string): InboxAddress {
		return { kind: "owner", domainId, ownerSignPub: this.registry.ownerKey(domainId).ownerSignPub };
	}
	private senderAddress(domainId: string, row: InboxRow): { domainId: string; address: string } | null {
		const origin = row.envelope.origin;
		if (origin.kind === "router") return null;
		if (origin.kind === "session" && origin.gatewayId && origin.sessionId)
			return {
				domainId: origin.domainId,
				address: `session:${origin.domainId}/${origin.gatewayId}/${origin.sessionId}`,
			};
		if (origin.kind === "gateway" && origin.gatewayId)
			return { domainId: origin.domainId, address: `gateway:${origin.domainId}/${origin.gatewayId}` };
		return { domainId, address: formatInboxAddress(this.ownerAddress(domainId)) };
	}
	private routerRow(domainId: string, opKey: OpKey, result: OpResultEnvelope, seq: number): InboxRow {
		const envelope = {
			origin: { kind: "router" as const, domainId },
			opKey,
			epoch: "clear" as const,
			kind: "op_result" as const,
			contentRefs: [],
		};
		return {
			envelope,
			producerSig: signRowEnvelope(envelope, this.routerIdentity.signPriv),
			body: result,
			seq,
			acceptedAt: this.now(),
			size: Buffer.byteLength(canonicalJson(result)),
		};
	}
	/** Record the outcome, remove the row, and enqueue its result atomically. Cross-domain results write separately. */
	private retire(
		store: OwnerStateStore,
		domainId: string,
		address: InboxAddress,
		row: InboxRow,
		outcome: Terminal,
		reason?: string,
	): OpResultEnvelope | null {
		const opKey = row.envelope.opKey;
		const ledger = store.get("op", recordId(opKey, this.registry.ownerKey(domainId).ownerSignPub));
		const result: OpResultEnvelope = { opKey, outcome, seq: row.seq, ...(reason ? { reason } : {}) };
		const sender = this.senderAddress(domainId, row);
		const senderStore = sender ? (sender.domainId === domainId ? store : this.storeOrNull(sender.domainId)) : null;
		const resultRow =
			sender && senderStore ? this.routerRow(domainId, opKey, result, senderStore.nextSeq(sender.address)) : null;
		const addressText = formatInboxAddress(address);
		const ownerAddress = formatInboxAddress(this.ownerAddress(domainId));
		const floorRecord = addressText === ownerAddress ? store.get("inbox.address", ownerAddress) : undefined;
		const write = this.ledgerTransaction(store, (tx) => {
			if (ledger) tx.put("op", ledger.id, ledger.version, { clear: { ...ledger.clear, state: outcome, result } });
			if (sender && resultRow && senderStore === store) tx.append(sender.address, resultRow);
			tx.remove(addressText, row.seq);
			if (floorRecord !== undefined)
				tx.put("inbox.address", ownerAddress, floorRecord?.version ?? null, {
					clear: {
						...floorRecord?.clear,
						floor: Math.max(Number(floorRecord?.clear.floor ?? 1), row.seq + 1),
					},
				});
		});
		if (write.kind !== "ok") return null;
		if (sender && resultRow && senderStore && senderStore !== store) {
			const cross = this.ledgerTransaction(senderStore, (tx) => tx.append(sender.address, resultRow));
			if (cross.kind !== "ok")
				console.warn(
					`[inbox] result for ${opKey.conversationId}/${opKey.opId} not written to ${sender.domainId}`,
				);
		}
		return result;
	}
	private appendLedgerTransaction(
		store: OwnerStateStore,
		address: InboxAddress,
		input: InboxRowInput,
		ledger: { state: string; opHash: string; at: number },
	): OpResultEnvelope & { row?: InboxRow } {
		const row = {
			...input,
			seq: store.nextSeq(formatInboxAddress(address)),
			acceptedAt: ledger.at,
			size: Buffer.byteLength(canonicalJson(input)),
		} as InboxRow;
		const result = { opKey: input.envelope.opKey, outcome: "accepted" as const, seq: row.seq };
		const write = this.ledgerTransaction(store, (tx) => {
			tx.put("op", recordId(input.envelope.opKey, this.registry.ownerKey(address.domainId).ownerSignPub), null, {
				clear: { ...ledger, seq: row.seq, result },
			});
			tx.append(formatInboxAddress(address), row);
		});
		if (write.kind === "ok") return { ...result, row };
		return { opKey: input.envelope.opKey, outcome: this.durabilityOutcome(write.kind) };
	}
	private ledgerTransaction(
		store: OwnerStateStore,
		fn: Parameters<OwnerStateStore["batch"]>[0],
	): ReturnType<OwnerStateStore["batch"]> {
		return store.batch(fn);
	}
}
