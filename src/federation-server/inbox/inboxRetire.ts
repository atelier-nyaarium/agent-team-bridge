import { canonicalJson } from "../../shared/canonical-json.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	type OpKey,
	type OpResultEnvelope,
	signRowEnvelope,
} from "../../shared/schemasInbox.js";
import type { OwnerStateStore } from "../owner/ownerStateStore.js";
import { ledgerTransaction, ownerAddress, recordId } from "./inboxCore.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

type Terminal = "failed" | "expired" | "target_revoked";

function senderAddress(
	registry: OwnerStoreRegistry,
	domainId: string,
	row: InboxRow,
): { domainId: string; address: string } | null {
	const origin = row.envelope.origin;
	if (origin.kind === "router") return null;
	if (origin.kind === "session" && origin.gatewayId && origin.sessionId)
		return {
			domainId: origin.domainId,
			address: `session:${origin.domainId}/${origin.gatewayId}/${origin.sessionId}`,
		};
	if (origin.kind === "gateway" && origin.gatewayId)
		return { domainId: origin.domainId, address: `gateway:${origin.domainId}/${origin.gatewayId}` };
	return { domainId, address: formatInboxAddress(ownerAddress(registry, domainId)) };
}

function routerRow(
	routerIdentity: { signPub: string; signPriv: string },
	now: number,
	domainId: string,
	opKey: OpKey,
	result: OpResultEnvelope,
	seq: number,
): InboxRow {
	const envelope = {
		origin: { kind: "router" as const, domainId },
		opKey,
		epoch: "clear" as const,
		kind: "op_result" as const,
		contentRefs: [],
	};
	return {
		envelope,
		producerSig: signRowEnvelope(envelope, routerIdentity.signPriv),
		body: result,
		seq,
		acceptedAt: now,
		size: Buffer.byteLength(canonicalJson(result)),
	};
}

function storeOrNull(registry: OwnerStoreRegistry, domainId: string): OwnerStateStore | null {
	try {
		const store = registry.for(domainId);
		return store.health().quarantined ? null : store;
	} catch {
		return null;
	}
}

/** Retire atomically. */
export function retireRow(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	store: OwnerStateStore,
	domainId: string,
	address: InboxAddress,
	row: InboxRow,
	outcome: Terminal,
	reason: string | undefined,
	notifyRetired: (domainId: string, address: string, row: InboxRow) => void,
): OpResultEnvelope | null {
	const opKey = row.envelope.opKey;
	const ledger = store.get("op", recordId(opKey, registry.ownerKey(domainId).ownerSignPub));
	const result: OpResultEnvelope = { opKey, outcome, seq: row.seq, ...(reason ? { reason } : {}) };
	const sender = senderAddress(registry, domainId, row);
	const senderStore = sender ? (sender.domainId === domainId ? store : storeOrNull(registry, sender.domainId)) : null;
	const resultRow =
		sender && senderStore
			? routerRow(routerIdentity, registry.now(), domainId, opKey, result, senderStore.nextSeq(sender.address))
			: null;
	const addressText = formatInboxAddress(address);
	const ownerAddressText = formatInboxAddress(ownerAddress(registry, domainId));
	const floorRecord = addressText === ownerAddressText ? store.get("inbox.address", ownerAddressText) : undefined;
	if (sender && resultRow && senderStore && senderStore !== store) {
		const senderWrite = ledgerTransaction(senderStore, (tx) => tx.append(sender.address, resultRow));
		if (senderWrite.kind !== "ok" && senderWrite.kind !== "durability_uncertain") {
			console.warn(`[inbox] result for ${sender.address} seq ${row.seq} not written`);
			return null;
		}
	}
	const write = ledgerTransaction(store, (tx) => {
		if (ledger) tx.put("op", ledger.id, ledger.version, { clear: { ...ledger.clear, state: outcome, result } });
		if (sender && resultRow && senderStore === store) tx.append(sender.address, resultRow);
		tx.remove(addressText, row.seq);
		if (floorRecord !== undefined)
			tx.put("inbox.address", ownerAddressText, floorRecord?.version ?? null, {
				clear: {
					...floorRecord?.clear,
					floor: Math.max(Number(floorRecord?.clear.floor ?? 1), row.seq + 1),
				},
			});
	});
	if (write.kind !== "ok") return null;
	notifyRetired(domainId, addressText, row);
	return result;
}
