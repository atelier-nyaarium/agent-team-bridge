import { z } from "zod";
import type { DomainSnapshot } from "../../shared/admission.js";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { parseBlobReference } from "../../shared/blob-reference.js";
import {
	BlobBeginParamsSchema,
	BlobChunkParamsSchema,
	BlobFetchParamsSchema,
	BlobFetchReplyParamsSchema,
	FEDERATION_VALUE_PROTOCOL_VERSION,
	InboxAckParamsSchema,
	InboxAppendParamsSchema,
	SessionForgetParamsSchema,
	SessionUpsertParamsSchema,
	ValueResultParamsSchema,
} from "../../shared/router-protocol.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	InboxRowInputSchema,
	parseInboxAddress,
} from "../../shared/schemasInbox.js";
import { GATEWAY_REASON_NO_WAITER } from "../../shared/wire-vocabulary.js";
import type { ReferenceHeldStore } from "../blobs/referenceHeldStore.js";
import type { RouterBlobCache } from "../blobs/routerBlobCache.js";
import type { ConnGatewayRecord, GatewayRegistration } from "../gatewayBridge.js";
import type { ConnectionId, GatewayTransport } from "../gatewayTransport.js";
import type { BlobFetchRoute } from "../inbox/blobFetchRoute.js";
import { type InboxService, type PeerRowGate, sessionTargetOf } from "../inbox/inboxService.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import { GATEWAY_RELAY_TIMEOUT_MS } from "../relayTimeouts.js";

/** Stable producer identity deduplicates retries. */
const ProducerOpHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

type WSLike = ReturnType<GatewayTransport["getConnection"]>;

export interface InboxFramesDeps {
	inbox: InboxService | null;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	getDomain: (domainId: string) => DomainSnapshot | null;
	blobCache: RouterBlobCache | null;
	referenceHeld: ReferenceHeldStore | null;
	blobFetch: BlobFetchRoute | null;
	isMigrationFenced: (domainId: string, gatewayId: string) => boolean;
	getRegistration: (connId: ConnectionId) => ConnGatewayRecord | undefined;
	getConnectionId: (domainId: string, gatewayId: string) => ConnectionId | undefined;
	getConnection: (connId: ConnectionId) => WSLike;
	send: (domainId: string, gatewayId: string, frame: Record<string, unknown>) => boolean;
	notifySessionForgotten: (identity: GatewayRegistration, sessionId: string) => void;
}

/** Inbox append/ack, session bookkeeping, blob transfer, and value forwarding. */
export class InboxFrames {
	private peerRowGate: PeerRowGate | null = null;
	private ownerRowPush: ((domainId: string, row: InboxRow) => void) | null = null;
	private pendingValues = new Map<
		string,
		{ resolve: (result: unknown) => void; timer: TimerHandle; connId: ConnectionId }[]
	>();

	constructor(private readonly deps: InboxFramesDeps) {}

	/** Gate peer rows. */
	setPeerRowGate(gate: PeerRowGate): void {
		this.peerRowGate = gate;
	}

	/** Owner rows a gateway appends reach the bound console sockets through this. */
	setOwnerRowPush(push: (domainId: string, row: InboxRow) => void): void {
		this.ownerRowPush = push;
	}

	appendRow(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		if (!this.deps.inbox) return { ok: false, error: "inbox unavailable" };
		const parsed = InboxAppendParamsSchema.safeParse(params);
		const address = parsed.success ? parseInboxAddress(parsed.data.address) : null;
		const row = parsed.success ? InboxRowInputSchema.safeParse(parsed.data.row) : null;
		if (!parsed.success || !address || !row?.success) return { ok: false, error: "invalid inbox_append" };
		// Migration-fenced gateways must reconcile before writing.
		if (this.deps.isMigrationFenced(reg.domainId, reg.gatewayId)) return { ok: false, error: "migrating" };
		const origin = row.data.envelope.origin;
		const peerRow = origin.kind === "gateway" && row.data.envelope.epoch === "peer" && address.kind === "session";
		// A reply targets a job key.
		const peerReply = peerRow && row.data.envelope.kind === "reply";
		// Replies need the return edge.
		const allowedDomain =
			address.domainId === reg.domainId ||
			(peerRow &&
				this.deps.hasLinkEdge(reg.domainId, address.domainId) &&
				(peerReply
					? this.deps.hasLinkEdge(address.domainId, reg.domainId)
					: this.deps.inbox.hasSession(address.domainId, address.gatewayId, address.sessionId)));
		const addressOwned =
			address.kind === "owner" || address.domainId !== reg.domainId || address.gatewayId === reg.gatewayId;
		const originAllowed =
			origin.domainId === reg.domainId &&
			origin.gatewayId === reg.gatewayId &&
			(origin.kind === "gateway" ||
				(origin.kind === "session" &&
					!!origin.sessionId &&
					this.deps.inbox.hasSession(reg.domainId, reg.gatewayId, origin.sessionId)));
		if (!allowedDomain || !addressOwned || !originAllowed) return { ok: false, error: "refused" };
		// Share state authorizes friend rows and supplies generation.
		let shareGeneration: number | undefined;
		if (address.domainId !== reg.domainId && this.peerRowGate && !peerReply) {
			const target = sessionTargetOf(address);
			const generation = target ? this.peerRowGate(address.domainId, target, reg.domainId) : null;
			if (generation === null) return { ok: false, error: "refused" };
			shareGeneration = generation;
		}
		// Hash only the row's operation key.
		const hash = ProducerOpHashSchema.safeParse((parsed.data.opKey as { hash?: unknown })?.hash);
		const result = this.deps.inbox.appendRow({
			address,
			row: row.data,
			producerSignPub: reg.signPub,
			shareGeneration,
			...(hash.success ? { opKey: { ...row.data.envelope.opKey, hash: hash.data } } : {}),
		});
		if (result.row && !this.pushRow(address, result.row))
			this.deps.inbox.markWaking(address.domainId, result.opKey);
		return result;
	}

	ack(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		if (!this.deps.inbox) return { ok: false, error: "inbox unavailable" };
		const parsed = InboxAckParamsSchema.safeParse(params);
		const address = parsed.success ? parseInboxAddress(parsed.data.address) : null;
		if (!parsed.success || !address) return { ok: false, error: "invalid inbox_ack" };
		return this.deps.inbox.ack({
			address,
			seq: parsed.data.seq,
			deliveryEpoch: parsed.data.deliveryEpoch,
			outcome: parsed.data.outcome,
			reason: parsed.data.reason,
			by: { domainId: reg.domainId, gatewayId: reg.gatewayId, incarnation: reg.incarnation },
		});
	}

	upsertSession(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		const parsed = SessionUpsertParamsSchema.safeParse(params);
		if (!parsed.success) return { ok: false, error: "invalid session_upsert" };
		this.deps.inbox?.upsertSession(reg.domainId, reg.gatewayId, parsed.data.sessionId, parsed.data);
		return { ok: true };
	}

	forgetSession(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		const parsed = SessionForgetParamsSchema.safeParse(params);
		if (!parsed.success) return { ok: false, error: "invalid session_forget" };
		this.deps.inbox?.forgetSession(reg.domainId, reg.gatewayId, parsed.data.sessionId);
		this.deps.notifySessionForgotten(reg, parsed.data.sessionId);
		return { ok: true };
	}

	async fetchBlob(reg: GatewayRegistration, params: Record<string, unknown>): Promise<unknown> {
		const parsed = BlobFetchParamsSchema.safeParse(params);
		if (!parsed.success || !this.deps.blobFetch) return { ok: false, error: "invalid blob_fetch" };
		const origin = parsed.data.origin;
		if (origin && origin.domainId !== reg.domainId && !this.deps.hasLinkEdge(reg.domainId, origin.domainId))
			return { outcome: "unreachable" };
		return this.deps.blobFetch.fetch(reg.domainId, parsed.data);
	}

	beginBlob(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		const parsed = BlobBeginParamsSchema.safeParse(params);
		if (!parsed.success) return { ok: false, error: "invalid blob_begin" };
		const value = parsed.data;
		if (value.store === "cache") {
			if (!this.deps.blobCache) return { ok: false, error: "blob cache unavailable" };
			return this.deps.blobCache.begin(
				reg.domainId,
				value.blobId,
				{ domainId: reg.domainId, gatewayId: reg.gatewayId },
				value.size,
				value.ciphertextSize,
				value.ciphertextDigest,
				value.epoch,
			);
		}
		if (!this.deps.referenceHeld || !value.ref) return { ok: false, error: "held blob requires a reference" };
		const ref = parseBlobReference(value.ref.id);
		if (!ref || ref.kind !== value.ref.kind) return { ok: false, error: "reference missing" };
		let referenceExists = false;
		try {
			referenceExists = this.deps.referenceHeld.hasReference(reg.domainId, ref);
		} catch (error) {
			if (error instanceof OwnerQuarantined)
				return { ok: false, error: "refused", reason: "durability_uncertain" };
			throw error;
		}
		if (!referenceExists) return { ok: false, error: "reference missing" };
		const begun = this.deps.referenceHeld.begin(
			reg.domainId,
			value.blobId,
			value.size,
			value.ciphertextSize,
			value.ciphertextDigest,
			value.epoch,
		);
		if (begun.kind !== "quota") this.deps.referenceHeld.applyRefs(reg.domainId, [{ ref, blobIds: [value.blobId] }]);
		return begun;
	}

	chunkBlob(reg: GatewayRegistration, params: Record<string, unknown>): unknown {
		const parsed = BlobChunkParamsSchema.safeParse(params);
		if (!parsed.success) return { ok: false, error: "invalid blob_chunk" };
		const value = parsed.data;
		const bytes = Buffer.from(value.bytes, "base64");
		const renewed =
			value.store === "cache" ? this.deps.blobCache?.renew(reg.domainId, value.blobId, value.lease.id) : null;
		if (value.store === "cache" && (!renewed || renewed.kind === "lease_expired"))
			return { ok: false, error: "lease_expired" };
		return value.store === "cache"
			? (this.deps.blobCache?.commitChunk(
					reg.domainId,
					value.blobId,
					value.lease,
					value.offset,
					bytes,
					value.final,
				) ?? { ok: false, error: "blob cache unavailable" })
			: (this.deps.referenceHeld?.commitChunk(
					reg.domainId,
					value.blobId,
					value.lease,
					value.offset,
					bytes,
					value.final,
				) ?? { ok: false, error: "held blob store unavailable" });
	}

	settleBlobFetch(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = BlobFetchReplyParamsSchema.safeParse(params);
		return parsed.success && this.deps.blobFetch?.settle(connId, parsed.data) ? { ok: true } : { ok: false };
	}

	private pushRow(address: InboxAddress, row: InboxRow): boolean {
		if (address.kind === "owner") {
			// Bound console sockets get the row now; the cursor covers the rest.
			this.ownerRowPush?.(address.domainId, row);
			return true;
		}
		const connId = this.deps.getConnectionId(address.domainId, address.gatewayId);
		const reg = connId ? this.deps.getRegistration(connId) : undefined;
		if (!reg || reg.incarnation === null) return false;
		return this.deps.send(address.domainId, address.gatewayId, {
			type: "inbox_deliver",
			address: formatInboxAddress(address),
			rows: [row],
			incarnation: reg.incarnation,
			deliveryEpoch: this.deps.inbox?.deliveryEpoch(address) ?? 1,
		});
	}

	forwardGatewayValue(
		domainId: string,
		params: {
			opId: string;
			conversationId: string;
			signerSignPub: string;
			device: string;
			gatewayId: string;
			value: unknown;
		},
	): Promise<unknown> {
		const admitted = this.deps
			.getDomain(domainId)
			?.admissions.some(
				(entry) => entry.admission.kind === "gateway" && entry.admission.gatewayId === params.gatewayId,
			);
		if (!admitted) return Promise.resolve({ outcome: "unreachable" });
		const connId = this.deps.getConnectionId(domainId, params.gatewayId);
		const reg = connId ? this.deps.getRegistration(connId) : undefined;
		const ws = connId ? this.deps.getConnection(connId) : null;
		if (reg && (reg.protocolVersion ?? 0) < FEDERATION_VALUE_PROTOCOL_VERSION) {
			// Remove-by: every registered gateway reports protocol 2.
			return Promise.resolve({ outcome: "unsupported" });
		}
		if (!connId || !reg || reg.incarnation === null || !ws) return Promise.resolve({ outcome: "unreachable" });
		const key = `${domainId}/${params.gatewayId}/${params.conversationId}/${params.opId}`;
		return new Promise((resolve) => {
			const timer = this.deps.ambient.setTimer(() => {
				const waiters = this.pendingValues.get(key) ?? [];
				const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
				if (remaining.length) this.pendingValues.set(key, remaining);
				else this.pendingValues.delete(key);
				resolve({ outcome: "timeout" });
			}, GATEWAY_RELAY_TIMEOUT_MS);
			this.pendingValues.set(key, [...(this.pendingValues.get(key) ?? []), { resolve, timer, connId }]);
			try {
				ws.send(JSON.stringify({ type: "value_op", ...params, incarnation: reg.incarnation }));
			} catch {
				this.deps.ambient.clearTimer(timer);
				const waiters = this.pendingValues.get(key) ?? [];
				const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
				if (remaining.length) this.pendingValues.set(key, remaining);
				else this.pendingValues.delete(key);
				resolve({ outcome: "unreachable" });
			}
		});
	}

	settleValue(reg: GatewayRegistration, params: Record<string, unknown>, connId: ConnectionId): unknown {
		const parsed = ValueResultParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false, reason: "malformed" };
		const key = `${reg.domainId}/${reg.gatewayId}/${parsed.data.conversationId}/${parsed.data.opId}`;
		const pending = this.pendingValues.get(key);
		if (!pending || pending.every((waiter) => waiter.connId !== connId))
			return { settled: false, reason: GATEWAY_REASON_NO_WAITER };
		for (const waiter of pending) this.deps.ambient.clearTimer(waiter.timer);
		this.pendingValues.delete(key);
		for (const waiter of pending) waiter.resolve(parsed.data.result);
		return { settled: true };
	}

	/** Fails value waiters owned by a dropped connection. */
	dropConnection(connId: ConnectionId): void {
		for (const [key, pending] of this.pendingValues) {
			const remaining = pending.filter((waiter) => waiter.connId !== connId);
			if (remaining.length === pending.length) continue;
			for (const waiter of pending) {
				if (waiter.connId !== connId) continue;
				this.deps.ambient.clearTimer(waiter.timer);
				waiter.resolve({ outcome: "unreachable" });
			}
			if (remaining.length) this.pendingValues.set(key, remaining);
			else this.pendingValues.delete(key);
		}
	}

	stop(): void {
		for (const pending of this.pendingValues.values()) {
			for (const waiter of pending) {
				this.deps.ambient.clearTimer(waiter.timer);
				waiter.resolve({ outcome: "timeout" });
			}
		}
		this.pendingValues.clear();
	}
}
