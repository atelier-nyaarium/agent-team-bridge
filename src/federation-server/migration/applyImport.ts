import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { sign, verify } from "../../shared/crypto.js";
import { CONVERSATION_ID_RE } from "../../shared/host-op.js";
import { formatInboxAddress, parseInboxAddress, signRowEnvelope } from "../../shared/schemasInbox.js";
import type { MigrationExport } from "../../shared/schemasMigration.js";

export interface ImportStore {
	get(kind: string, id: string): { version: number; clear?: Record<string, unknown> } | null;
	put(kind: string, id: string, expectedVersion: number | null, value: Record<string, unknown>): { kind: string };
	append(address: string, row: Record<string, unknown>): { kind: string; seq?: number };
	rows(address: string, from: number, to: number): Array<{ seq?: number; row: Record<string, unknown> }>;
	nextSeq?(address: string): number;
}

export interface ApplyResult {
	addresses: string[];
	blobReferences: Map<string, string[]>;
}

function opId(address: string, row: { dedupeKey?: string; seq?: number }, oldEpoch: number): string {
	return sha256Hex(canonicalJson(row.dedupeKey ?? [address, oldEpoch, row.seq])).slice(0, 128);
}

function legacyConversationId(row: Record<string, unknown>): string {
	const conversationId = row.conversationId;
	return typeof conversationId === "string" && CONVERSATION_ID_RE.test(conversationId) ? conversationId : "migrated";
}

function contentRefs(row: Record<string, unknown>): string[] {
	const files = Array.isArray(row.files) ? row.files : [];
	return files.flatMap((file) => {
		if (!file || typeof file !== "object") return [];
		const blobId = (file as Record<string, unknown>).blobId;
		return typeof blobId === "string" ? [blobId] : [];
	});
}

function routerRow(
	row: { row: Record<string, unknown>; text?: Record<string, unknown> },
	address: string,
	conversationId: string,
	oldEpoch: number,
	domainId: string,
	seq: number,
	routerSignPriv: string,
	routerSignPub: string,
): Record<string, unknown> {
	if (!row.text) throw new Error(`row ${conversationId}/${String(row.row.seq)} has no sealed body`);
	const legacyId = legacyConversationId(row.row);
	const envelope = {
		origin: { kind: "router" as const, domainId },
		opKey: {
			conversationId: legacyId,
			opId: opId(address, row.row, oldEpoch),
		},
		epoch: row.text.epoch,
		kind: row.row.kind,
		contentRefs: contentRefs(row.row),
	} as Parameters<typeof signRowEnvelope>[0];
	return {
		envelope,
		producerSig: signRowEnvelope(envelope, routerSignPriv),
		body: row.text,
		seq,
		acceptedAt: Number(row.row.at ?? 0),
		size: Buffer.byteLength(canonicalJson({ envelope, body: row.text })),
	};
}

export function applyImport(
	store: ImportStore,
	snapshot: MigrationExport,
	ownerSignPub: string,
	dedupe: <T extends { dedupeKey?: string; seq?: number }>(
		existing: readonly { dedupeKey?: string; seq?: number }[],
		incoming: readonly T[],
	) => T[],
	routerSignPriv: string,
	routerSignPub: string,
): ApplyResult {
	if (!routerSignPriv || !routerSignPub) throw new Error("Router signing identity is required for migration import");
	try {
		if (!verify(Buffer.alloc(0), sign(Buffer.alloc(0), routerSignPriv), routerSignPub))
			throw new Error("Router signing identity mismatch");
	} catch {
		throw new Error("Router signing identity mismatch");
	}
	const addresses: string[] = [];
	const blobReferences = new Map<string, string[]>();
	const addBlobReference = (blobId: string, reference: string) => {
		const refs = blobReferences.get(blobId) ?? [];
		refs.push(reference);
		blobReferences.set(blobId, refs);
	};
	const planned = new Map<string, number>();
	const mailboxPlans: Array<{
		owner: MigrationExport["owners"][number];
		box: MigrationExport["owners"][number]["mailboxes"][number];
		address: string;
		start: number;
		expected: number[];
	}> = [];
	for (const owner of snapshot.owners) {
		for (const box of owner.mailboxes) {
			const addressText = (box as typeof box & { address?: string }).address ?? box.conversationId;
			const parsed = parseInboxAddress(addressText);
			if (!parsed) throw new Error(`invalid mailbox address: ${addressText}`);
			const address = formatInboxAddress(parsed);
			const start = planned.get(address) ?? store.nextSeq?.(address) ?? 1;
			const expected: number[] = [];
			for (const item of box.rows) {
				const mapped = box.cursorMap.find(
					(entry) => entry.oldEpoch === box.epoch && entry.oldSeq === item.row.seq,
				);
				if (!mapped) throw new Error(`unmapped row: ${address}/${item.row.seq}`);
				const seq = start + expected.length;
				if (mapped.epoch !== snapshot.epoch || mapped.seq !== seq)
					throw new Error(`cursor sequence mismatch at ${address}/${mapped.seq}`);
				expected.push(seq);
			}
			planned.set(address, start + box.rows.length);
			mailboxPlans.push({ owner, box, address, start, expected });
		}
	}
	planned.clear();
	const manifestIds = new Set((snapshot.blobs ?? []).map((blob) => blob.blobId));
	for (const owner of snapshot.owners) {
		for (const item of owner.board) {
			const entry = item.entry;
			const attachments = entry.attachments?.filter((attachment) => manifestIds.has(attachment.blobId));
			for (const attachment of entry.attachments ?? []) {
				if (!manifestIds.has(attachment.blobId)) {
					owner.refusals.push({
						entryId: item.entry.id,
						sessionId: item.session?.sessionId ?? "",
						reason: "blob_missing",
					});
				}
			}
			const sealedNames = item.sealed.names
				? Object.fromEntries(Object.entries(item.sealed.names).filter(([blobId]) => manifestIds.has(blobId)))
				: undefined;
			const clear = {
				id: entry.id,
				state: entry.state,
				rank: entry.rank,
				...(entry.parent ? { parent: entry.parent } : {}),
				...(entry.trashedAt !== undefined ? { trashedAt: entry.trashedAt } : {}),
				...(attachments?.length ? { attachments } : {}),
			};
			const sealed = {
				...item.sealed,
				...(sealedNames && Object.keys(sealedNames).length ? { names: sealedNames } : { names: undefined }),
			};
			const result = store.put("board.entry", entry.id, null, { clear, sealed });
			if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`board write ${result.kind}`);
			if (result.kind === "ok")
				for (const attachment of attachments ?? [])
					addBlobReference(attachment.blobId, `entry:${encodeURIComponent(entry.id)}`);
		}
		for (const plan of mailboxPlans.filter((candidate) => candidate.owner === owner)) {
			const { box, address, expected } = plan;
			const existing = store.rows(address, 1, Number.MAX_SAFE_INTEGER).map((item) => item.row);
			for (const item of box.rows) {
				const rawRow = item.row as Record<string, unknown> & { files?: unknown };
				const manifestIds = new Set((snapshot.blobs ?? []).map((blob) => blob.blobId));
				const files = Array.isArray(rawRow.files) ? rawRow.files : [];
				const keptFiles = files.filter((file) => {
					const blobId =
						file && typeof file === "object" ? (file as Record<string, unknown>).blobId : undefined;
					if (typeof blobId !== "string" || manifestIds.has(blobId)) return true;
					owner.refusals.push({
						entryId: `${address}/${item.row.seq}`,
						sessionId: "",
						reason: "blob_missing",
					});
					return false;
				});
				rawRow.files = keptFiles;
				const incoming = routerRow(
					item,
					address,
					box.conversationId,
					box.epoch,
					snapshot.domainId,
					expected[box.rows.indexOf(item)]!,
					routerSignPriv,
					routerSignPub,
				);
				const candidate = { ...incoming, seq: item.row.seq, dedupeKey: item.row.dedupeKey };
				let wrote = false;
				for (const _row of dedupe(existing, [candidate])) {
					const result = store.append(address, { ...incoming, dedupeKey: item.row.dedupeKey });
					if (
						result.kind !== "ok" ||
						(result.seq !== undefined && result.seq !== expected[box.rows.indexOf(item)])
					)
						throw new Error(`mailbox write ${result.kind}`);
					wrote = true;
				}
				if (wrote)
					for (const file of keptFiles) {
						const blobId =
							file && typeof file === "object" ? (file as Record<string, unknown>).blobId : undefined;
						if (typeof blobId === "string" && manifestIds.has(blobId))
							addBlobReference(blobId, `row:${address}:${expected[box.rows.indexOf(item)]}`);
					}
			}
			const addressResult = store.put(
				"inbox.address",
				address,
				store.get("inbox.address", address)?.version ?? null,
				{
					clear: { epoch: snapshot.epoch, deliveryEpoch: snapshot.epoch, cursorMap: box.cursorMap },
				},
			);
			if (addressResult.kind !== "ok" && addressResult.kind !== "conflict")
				throw new Error(`address write ${addressResult.kind}`);
			for (const [device, seq] of box.consumerCursors) {
				const mapped = box.cursorMap.find((entry) => entry.oldEpoch === box.epoch && entry.oldSeq === seq);
				if (!mapped) throw new Error(`unmapped consumer cursor: ${address}/${device}/${seq}`);
				const result = store.put(
					"consumer",
					`${address}/${device}`,
					store.get("consumer", `${address}/${device}`)?.version ?? null,
					{
						clear: { address, device, epoch: mapped.epoch, seq: mapped.seq },
					},
				);
				if (result.kind !== "ok" && result.kind !== "conflict")
					throw new Error(`consumer write ${result.kind}`);
			}
			addresses.push(address);
		}
		for (const [team, anchor] of Object.entries(owner.readAnchors)) {
			const id = `readAnchor:${team}`;
			store.put("readAnchor", id, store.get("readAnchor", id)?.version ?? null, {
				clear: anchor as Record<string, unknown>,
			});
		}
		for (const refusal of owner.refusals) {
			const id = `refusal:${owner.ownerId}:${refusal.entryId}`;
			store.put("migration", id, null, { clear: refusal as Record<string, unknown> });
		}
	}
	for (const share of snapshot.shares as Array<Record<string, unknown>>) {
		const id = `share:${String(share.sessionTarget)}|${JSON.stringify(share.target)}`;
		const result = store.put("share", id, null, { clear: share });
		if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`share write ${result.kind}`);
	}
	return { addresses: [...new Set(addresses)], blobReferences };
}
