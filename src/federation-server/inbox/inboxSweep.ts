import { REGISTER_MAX_SKEW_MS } from "../../shared/admission.js";
import {
	CONSUMER_IDLE_TTL_MS,
	formatInboxAddress,
	INBOX_ROW_TTL_MS,
	type InboxAddress,
	type InboxRow,
	parseInboxAddress,
} from "../../shared/schemasInbox.js";
import { OwnerQuarantined, type OwnerStateStore } from "../owner/ownerStateStore.js";
import { floorOf, ledgerTransaction, ownerAddress } from "./inboxCore.js";
import { retireRow } from "./inboxRetire.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;

function sweepOwnerOpNonces(store: OwnerStateStore, now: number): void {
	for (const record of store.list("nonce"))
		if (now - Number(record.clear.at) > REGISTER_MAX_SKEW_MS) store.del("nonce", record.id, record.version);
}

function addresses(store: OwnerStateStore, domainId: string): string[] {
	return store
		.addresses()
		.filter(
			(address) =>
				address.startsWith(`owner:${domainId}/`) ||
				address.startsWith(`session:${domainId}/`) ||
				address.startsWith(`gateway:${domainId}/`),
		);
}

export function compactInbox(registry: OwnerStoreRegistry, domainId: string): void {
	const store = registry.for(domainId);
	const consumers = store.list("consumer");
	if (!consumers.length) return;
	const floor = Math.min(...consumers.map((r) => Number(r.clear.cursor)));
	const ownerAddressText = formatInboxAddress(ownerAddress(registry, domainId));
	if (floor + 1 <= floorOf(store, registry, domainId)) return;
	const retired = store.retire(ownerAddressText, floor);
	if (retired.kind !== "ok") return;
	const floorRecord = store.get("inbox.address", ownerAddressText);
	ledgerTransaction(store, (tx) => {
		tx.put("inbox.address", ownerAddressText, floorRecord?.version ?? null, {
			clear: { ...floorRecord?.clear, floor: floor + 1 },
		});
	});
}

function sweepDomain(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	notifyRetired: (domainId: string, address: string, row: InboxRow) => void,
	forgetConsumer: (domainId: string, signerSignPub: string) => void,
	domainId: string,
	now: number,
): void {
	const store = registry.for(domainId);
	if (store.health().quarantined) return;
	sweepOwnerOpNonces(store, now);
	for (const record of store.list("consumer"))
		if (now - Number(record.clear.lastSeen) > CONSUMER_IDLE_TTL_MS)
			forgetConsumer(domainId, record.id.slice("consumer:".length));
	for (const address of addresses(store, domainId))
		for (const item of store.rows(address, 1, Number.MAX_SAFE_INTEGER)) {
			if (now - Number((item.row as { acceptedAt: number }).acceptedAt) > INBOX_ROW_TTL_MS)
				retireRow(
					registry,
					routerIdentity,
					store,
					domainId,
					parseInboxAddress(address) as InboxAddress,
					item.row as unknown as InboxRow,
					"expired",
					undefined,
					notifyRetired,
				);
		}
	compactInbox(registry, domainId);
	if (store.health().journalBytes > JOURNAL_COMPACT_BYTES) store.compact();
}

export function sweepInbox(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	notifyRetired: (domainId: string, address: string, row: InboxRow) => void,
	forgetConsumer: (domainId: string, signerSignPub: string) => void,
	now: number,
): void {
	for (const domainId of registry.domains()) {
		try {
			sweepDomain(registry, routerIdentity, notifyRetired, forgetConsumer, domainId, now);
		} catch (error) {
			if (error instanceof OwnerQuarantined) continue;
			console.warn(`[inbox] sweep skipped ${domainId}: ${(error as Error).message}`);
		}
	}
}
