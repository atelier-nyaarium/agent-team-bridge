import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	type InboxRowInput,
	InboxRowSchema,
	type OpKey,
	type OpResultEnvelope,
	OpResultEnvelopeSchema,
	verifyRowEnvelope,
} from "../../shared/schemasInbox.js";
import { foldWriteResult } from "../../shared/write-result.js";
import type { OwnerStateStore } from "../owner/ownerStateStore.js";
import { capacityRefusal } from "./inboxCapacity.js";
import { durabilityOutcome, guarded, ledgerTransaction, recordId } from "./inboxCore.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

type OpKeyInput = OpKey | { conversationId: string; opId: string; hash?: string };

export function appendInboxRow(
	registry: OwnerStoreRegistry,
	input: {
		address: InboxAddress;
		row: InboxRowInput;
		producerSignPub: string;
		opKey?: OpKeyInput;
		shareGeneration?: number;
		nonce?: { signerSignPub: string; nonce: string; at: number };
	},
): OpResultEnvelope & { row?: InboxRow } {
	const { address, row } = input;
	const key = row.envelope.opKey;
	const opHash =
		input.opKey && "hash" in input.opKey && input.opKey.hash
			? input.opKey.hash
			: sha256Hex(canonicalJson({ envelope: row.envelope, body: row.body }));
	const store = registry.for(address.domainId);
	const owner = registry.ownerKey(address.domainId).ownerSignPub;
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
		if (row.envelope.kind === "op_result" && row.envelope.origin.kind === "gateway") {
			if (clear.state === "complete" && clear.result && typeof clear.result === "object") {
				const result = OpResultEnvelopeSchema.safeParse(clear.result);
				if (result.success) return result.data;
			}
			if (clear.state === "accepted" && clear.address !== formatInboxAddress(address))
				return appendResultRow(registry, store, address, row, existing);
		}
		if (clear.address && clear.address !== formatInboxAddress(address)) return { opKey: key, outcome: "conflict" };
		// Matching op hash replays. Differing hash conflicts.
		if (clear.opHash === opHash && clear.result && typeof clear.result === "object") {
			const result = OpResultEnvelopeSchema.safeParse(clear.result);
			if (result.success) return result.data;
		}
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
	return appendLedgerTransaction(
		registry,
		store,
		address,
		row,
		{
			state: "accepted",
			opHash,
			at: registry.now(),
			...(input.shareGeneration !== undefined ? { shareGeneration: input.shareGeneration } : {}),
		},
		input.nonce,
	);
}

function appendResultRow(
	registry: OwnerStoreRegistry,
	store: OwnerStateStore,
	address: InboxAddress,
	input: InboxRowInput,
	existing: { id: string; version: number; clear: Record<string, unknown> },
): OpResultEnvelope & { row?: InboxRow } {
	const row = InboxRowSchema.parse({
		...input,
		seq: store.nextSeq(formatInboxAddress(address)),
		acceptedAt: registry.now(),
		size: Buffer.byteLength(canonicalJson(input)),
	});
	const result: OpResultEnvelope = {
		opKey: input.envelope.opKey,
		outcome: "accepted",
		seq: row.seq,
		result: input.body,
	};
	const write = ledgerTransaction(store, (tx) => {
		tx.put("op", existing.id, existing.version, {
			clear: { ...existing.clear, state: "complete", seq: row.seq, result },
		});
		tx.append(formatInboxAddress(address), row);
	});
	const folded = foldWriteResult(write);
	if (folded.applied) return { ...result, outcome: folded.outcome, row };
	return { opKey: input.envelope.opKey, outcome: durabilityOutcome(write.kind) };
}

function appendLedgerTransaction(
	registry: OwnerStoreRegistry,
	store: OwnerStateStore,
	address: InboxAddress,
	input: InboxRowInput,
	ledger: { state: string; opHash: string; at: number; shareGeneration?: number },
	nonce?: { signerSignPub: string; nonce: string; at: number },
): OpResultEnvelope & { row?: InboxRow } {
	const row = {
		...input,
		seq: store.nextSeq(formatInboxAddress(address)),
		acceptedAt: ledger.at,
		size: Buffer.byteLength(canonicalJson(input)),
	} as InboxRow;
	const result = { opKey: input.envelope.opKey, outcome: "accepted" as const, seq: row.seq };
	const write = ledgerTransaction(store, (tx) => {
		tx.put("op", recordId(input.envelope.opKey, registry.ownerKey(address.domainId).ownerSignPub), null, {
			clear: { ...ledger, address: formatInboxAddress(address), seq: row.seq, result },
		});
		if (nonce) tx.put("nonce", `${nonce.signerSignPub}/${nonce.nonce}`, null, { clear: { at: nonce.at } });
		tx.append(formatInboxAddress(address), row);
	});
	const folded = foldWriteResult(write);
	if (folded.applied) return { ...result, outcome: folded.outcome, row };
	return { opKey: input.envelope.opKey, outcome: durabilityOutcome(write.kind) };
}

export function sessionExists(
	registry: OwnerStoreRegistry,
	domainId: string,
	gatewayId: string,
	sessionId: string,
): boolean {
	return guarded(() => !!registry.for(domainId).get("session", `session:${gatewayId}/${sessionId}`), false);
}
