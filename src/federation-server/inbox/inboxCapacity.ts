import type { InboxAddress } from "../../shared/schemasInbox.js";
import {
	GATEWAY_INBOX_MAX_ROWS,
	OWNER_INBOX_MAX_BYTES,
	OWNER_INBOX_MAX_ROWS,
	SESSION_INBOX_MAX_ROWS,
} from "../../shared/schemasInbox.js";
import type { OwnerStateStore } from "../owner/ownerStateStore.js";

export function capacityRefusal(address: InboxAddress, store: OwnerStateStore, size: number): string | null {
	const rows = store.rows(addressText(address), 1, Number.MAX_SAFE_INTEGER).map((entry) => entry.row);
	if (
		address.kind === "owner" &&
		(rows.length >= OWNER_INBOX_MAX_ROWS ||
			rows.reduce((n, row) => n + Number(row.size ?? 0), 0) + size > OWNER_INBOX_MAX_BYTES)
	)
		return "inbox capacity";
	if (address.kind === "session" && rows.length >= SESSION_INBOX_MAX_ROWS) return "inbox capacity";
	if (address.kind === "gateway" && rows.length >= GATEWAY_INBOX_MAX_ROWS) return "inbox capacity";
	return null;
}

function addressText(address: InboxAddress): string {
	if (address.kind === "owner") return `owner:${address.domainId}/${address.ownerSignPub}`;
	if (address.kind === "session") return `session:${address.domainId}/${address.gatewayId}/${address.sessionId}`;
	return `gateway:${address.domainId}/${address.gatewayId}`;
}
