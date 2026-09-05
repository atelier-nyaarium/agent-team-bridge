import {
	type InboxAddress,
	type InboxRow,
	type OpKey,
	type OpResultEnvelope,
	signRowEnvelope,
} from "../../shared/schemasInbox.js";
import { appendInboxRow } from "./inboxAppend.js";
import { recordId } from "./inboxCore.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

export function appendRouterOpResultRow(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	input: {
		address: InboxAddress;
		kind: "board_observation" | "scheduled_result" | "op_result";
		opKey: OpKey;
		body: Record<string, unknown>;
		contentRefs?: string[];
	},
): OpResultEnvelope & { row?: InboxRow } {
	const envelope = {
		origin: { kind: "router" as const, domainId: input.address.domainId },
		opKey: input.opKey,
		epoch: "clear" as const,
		kind: input.kind,
		contentRefs: input.contentRefs ?? [],
	};
	const row = {
		envelope,
		producerSig: signRowEnvelope(envelope, routerIdentity.signPriv),
		body: input.body,
	};
	return appendInboxRow(registry, { address: input.address, row, producerSignPub: routerIdentity.signPub });
}

export function readOpResult(registry: OwnerStoreRegistry, domainId: string, opKey: OpKey): OpResultEnvelope | null {
	const store = registry.for(domainId);
	const record = store.get("op", recordId(opKey, registry.ownerKey(domainId).ownerSignPub));
	if (record) return (record.clear.result as OpResultEnvelope) ?? null;
	return null;
}
