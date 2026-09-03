import { formatInboxAddress, type InboxAddress, parseInboxAddress } from "./schemasInbox.js";
import { type ScheduledTarget, ScheduledTargetSchema } from "./schemasScheduled.js";

export type BlobReference =
	| { kind: "entry"; entryId: string }
	| { kind: "row"; address: InboxAddress; seq: number }
	| { kind: "scheduled"; target: ScheduledTarget };

export function formatBlobReference(ref: BlobReference): string {
	if (ref.kind === "entry") return `entry:${encodeURIComponent(ref.entryId)}`;
	if (ref.kind === "row") return `row:${formatInboxAddress(ref.address)}:${ref.seq}`;
	return `scheduled:${ref.target.domainId}/${ref.target.gatewayId}/${ref.target.sessionId}`;
}

export function parseBlobReference(id: string): BlobReference | null {
	if (id.startsWith("entry:")) {
		const value = id.slice("entry:".length);
		try {
			const entryId = decodeURIComponent(value);
			return entryId && encodeURIComponent(entryId) === value ? { kind: "entry", entryId } : null;
		} catch {
			return null;
		}
	}
	if (id.startsWith("row:")) {
		const split = id.lastIndexOf(":");
		const address = parseInboxAddress(id.slice("row:".length, split));
		const seq = Number(id.slice(split + 1));
		return split > 4 && address && Number.isSafeInteger(seq) && seq > 0 ? { kind: "row", address, seq } : null;
	}
	if (!id.startsWith("scheduled:")) return null;
	const parts = id.slice("scheduled:".length).split("/");
	if (parts.length !== 3) return null;
	const target = ScheduledTargetSchema.safeParse({ domainId: parts[0], gatewayId: parts[1], sessionId: parts[2] });
	return target.success ? { kind: "scheduled", target: target.data } : null;
}
