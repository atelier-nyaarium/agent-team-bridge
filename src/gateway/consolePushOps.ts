import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../shared/canonical-json.js";
import { inboxBodyAadKind } from "../shared/content-envelope.js";
import { DurableOutbox } from "../shared/durable-outbox.js";
import { DurableStore } from "../shared/durable-store.js";
import { type ConsolePushEntry, ConsolePushEntrySchema } from "../shared/federation-protocol.js";
import { fenced, MIGRATING } from "../shared/migration-fence.js";
import { type NoticeTierWire, pickTiers } from "../shared/notice.js";
import { formatInboxAddress, OpResultEnvelopeSchema, signRowEnvelope } from "../shared/schemasInbox.js";
import { type Address, storeKey } from "../shared/session-id.js";
import type { ChannelFile } from "../shared/types.js";
import {
	fileBytes,
	HumanNotifySchema,
	jsonResponse,
	MAX_PLUGIN_ACTION_PAYLOAD_BYTES,
	MAX_RESPONSE_FILE_BYTES,
	PluginActionRequestSchema,
	payloadBytes,
	stampBlobHolder,
} from "./routeSchemas.js";
import type { CallerScope } from "./routes.js";

export interface DeliverToOwnerOptions {
	entry: ConsolePushEntry;
	/** Caller-chosen deduplication key. */
	dedupeKey: string;
	label?: string;
}

export type DeliverToOwnerResult = boolean | typeof MIGRATING;
export type DeliverToOwner = (opts: DeliverToOwnerOptions) => DeliverToOwnerResult;

export interface ConsolePushOpsDeps {
	ownerId?: (() => string | null) | null;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	localGatewayId: string;
	localDomainId?: string;
	producerSignPriv?: string;
	ownerSignPub?: (() => string | null) | null;
	contentKeyStore?: Pick<import("./federation/contentKeyStore.js").ContentKeyStore, "seal">;
	localAddress: (name: string) => Address;
	cacheBlobs?: ((blobIds: readonly string[]) => void) | null;
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
}

type OwnerRowOutboxItem = {
	entry: ConsolePushEntry;
	opId: string;
	label: string;
};

export function createConsolePushOps({
	ownerId,
	routerClient,
	localGatewayId,
	localDomainId,
	producerSignPriv,
	ownerSignPub,
	contentKeyStore,
	localAddress,
	cacheBlobs,
	refuseImpersonation,
}: ConsolePushOpsDeps) {
	const outboxStore = new DurableStore(process.env.DATA_DIR || "/app/data", "owner-row-outbox");
	const opKeyOf = (item: OwnerRowOutboxItem) => JSON.stringify([sha256Hex(item.entry.session_id ?? ""), item.opId]);
	const OutboxItemsSchema = z.array(
		z.object({
			entry: ConsolePushEntrySchema,
			opId: z.string().min(1),
			label: z.string().min(1),
		}),
	);
	let storedInvalid = false;
	const outbox = new DurableOutbox<OwnerRowOutboxItem>({
		durable: outboxStore,
		restore: (raw) => {
			if (raw === null) return [];
			const parsed = OutboxItemsSchema.safeParse(raw);
			if (parsed.success) return parsed.data;
			storedInvalid = true;
			return [];
		},
		keyOf: opKeyOf,
	});
	if (storedInvalid) console.warn("[owner-row-outbox] invalid stored value, starting empty");
	function queueOutbox(item: OwnerRowOutboxItem): boolean {
		try {
			const result = outbox.enqueue(item);
			return result === "enqueued" || result === "replaced";
		} catch (err) {
			console.warn(
				`[${item.label}] owner row outbox save failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	function sealOwnerRow(
		entry: ConsolePushEntry,
		opId: string,
	): {
		payload: Record<string, unknown>;
		opKey: Record<string, string>;
	} | null {
		const domainId = localDomainId;
		const ownerSign = ownerSignPub?.();
		if (!domainId || !ownerSign || !producerSignPriv || !contentKeyStore) return null;
		const conversationId = sha256Hex(entry.session_id ?? "");
		const sealed = contentKeyStore.seal(Buffer.from(JSON.stringify(entry), "utf8"), {
			domainId,
			ownerSignPub: ownerSign,
			kind: inboxBodyAadKind(conversationId, opId),
		});
		if (sealed.kind !== "ok") return null;
		const envelope = {
			origin: { kind: "gateway" as const, domainId, gatewayId: localGatewayId },
			opKey: { conversationId, opId },
			epoch: sealed.envelope.epoch,
			kind: entry.kind,
			contentRefs: [...new Set((entry.files ?? []).flatMap((file) => (file.blobId ? [file.blobId] : [])))],
		};
		const payload = {
			address: formatInboxAddress({ kind: "owner", domainId, ownerSignPub: ownerSign }),
			row: { envelope, producerSig: signRowEnvelope(envelope, producerSignPriv), body: sealed.envelope },
		};
		return { payload, opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ entry, opId })) } };
	}

	let lastWait = "";
	function waiting(reason: string): void {
		const line = `${reason} (depth ${outbox.size})`;
		if (line === lastWait) return;
		lastWait = line;
		console.log(`[owner-outbox] waiting: ${line}`);
	}

	async function drainOutbox(): Promise<void> {
		if (
			!routerClient ||
			typeof routerClient.isConnected !== "function" ||
			!routerClient.isConnected() ||
			(routerClient.isRegistered && !routerClient.isRegistered())
		) {
			if (outbox.size > 0) waiting("router link down");
			return;
		}
		await outbox.drain(async (item) => {
			const sealed = sealOwnerRow(item.entry, item.opId);
			if (!sealed) {
				waiting("no content key");
				return;
			}
			let result: Awaited<ReturnType<NonNullable<typeof routerClient>["callInboxTool"]>>;
			try {
				result = await routerClient.callInboxTool("inbox_append", {
					...sealed.payload,
					opKey: sealed.opKey,
				});
			} catch (err) {
				console.warn(
					`[${item.label}] owner inbox append failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
			const parsed = result.error ? null : OpResultEnvelopeSchema.safeParse(result.result).data;
			if (!parsed || !["accepted", "conflict", "refused"].includes(parsed.outcome)) {
				const raw = result.result as { error?: unknown } | undefined;
				waiting(
					`answer ${parsed?.outcome ?? result.error ?? `unparsed error=${String(raw?.error ?? "")} keys=${Object.keys(raw ?? {}).join(",")}`}`,
				);
				return;
			}
			if (parsed.outcome === "refused") {
				console.warn(`[${item.label}] owner row ${item.opId} refused: ${parsed.reason ?? "refused"}`);
			}
			try {
				if (outbox.retire(opKeyOf(item)) === MIGRATING) return;
			} catch (err) {
				console.warn(
					`[${item.label}] owner row outbox save failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
			lastWait = "";
		});
	}

	setInterval(() => void drainOutbox(), 1000).unref?.();

	function deliverToOwner({ entry, dedupeKey, label = "deliver" }: DeliverToOwnerOptions): DeliverToOwnerResult {
		if (fenced()) {
			console.warn(`[${label}] refused: migrating`);
			return MIGRATING;
		}
		if (entry.files && entry.files.length > 0 && fileBytes(entry.files) > MAX_RESPONSE_FILE_BYTES) {
			console.warn(`[${label}] dropped an oversized entry (over ${MAX_RESPONSE_FILE_BYTES} bytes)`);
			return false;
		}
		if (entry.payload && payloadBytes(entry.payload) > MAX_PLUGIN_ACTION_PAYLOAD_BYTES) {
			console.warn(
				`[${label}] dropped an oversized plugin_action payload (over ${MAX_PLUGIN_ACTION_PAYLOAD_BYTES} bytes)`,
			);
			return false;
		}
		if (!appendOwnerRow(entry, entry.opId ?? dedupeKey, label)) return false;
		const blobIds = [...new Set((entry.files ?? []).flatMap((file) => (file.blobId ? [file.blobId] : [])))];
		if (blobIds.length > 0) cacheBlobs?.(blobIds);
		return true;
	}

	function appendOwnerRow(entry: ConsolePushEntry, opId: string, label: string): boolean {
		const item = { entry, opId, label };
		if (!queueOutbox(item)) return false;
		void drainOutbox();
		return true;
	}

	/** Mirrors peer display entries. */
	function mirrorPeer(
		threadAddr: Address,
		from: string,
		to: string,
		payload: NoticeTierWire & {
			body?: string;
			files?: ChannelFile[];
			status?: string;
		},
		// Stable across relay hops.
		dedupeKey: string = crypto.randomUUID(),
	): void {
		const owner = ownerId?.();
		if (!owner) return;
		try {
			const entry: ConsolePushEntry = {
				kind: "peer",
				session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
				from,
				to,
				...payload,
			};
			deliverToOwner({ entry, dedupeKey, label: "mirror" });
		} catch (err) {
			console.warn(`[mirror] dropped: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Broadcasts a notice to the owner mailbox. */
	function humanNotify(req: Request, body: Record<string, unknown>): Response {
		const parsed = HumanNotifySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, title, summary, full, fullSpoken, files: rawNoticeFiles } = parsed.data;
		// Blob ownership follows the originating gateway.
		const files = rawNoticeFiles && stampBlobHolder(rawNoticeFiles, localGatewayId);
		const refused = refuseImpersonation(req, from, "owner-data");
		if (refused) return refused;
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}
		const owner = ownerId?.();
		if (!owner) {
			return jsonResponse({ error: "not yet enrolled; no owner to notify" }, 503);
		}
		const dedupeKey = crypto.randomUUID();
		// Notices require qualified sender addresses.
		const sender = localAddress(from);
		const entry: ConsolePushEntry = {
			kind: "notice",
			session_id: storeKey({ kind: "notice", sender }),
			from: sender.canonical,
			body: full,
			...pickTiers({ title, summary, fullSpoken }),
			...(files && files.length > 0 ? { files } : {}),
		};
		const delivered = deliverToOwner({ entry, dedupeKey, label: "notify" });
		if (delivered === MIGRATING) return jsonResponse({ error: MIGRATING }, 503);
		if (!delivered) {
			return jsonResponse({ error: "failed to store notice" }, 500);
		}
		console.log(`[notify] notice from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	/** Lands a plugin action in the owner's mailbox. */
	function pluginAction(req: Request, body: Record<string, unknown>): Response {
		const parsed = PluginActionRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, pluginId, actionType, payload } = parsed.data;
		const refused = refuseImpersonation(req, from, "owner-data");
		if (refused) return refused;
		const owner = ownerId?.();
		if (!owner) {
			return jsonResponse({ error: "not yet enrolled; no owner to notify" }, 503);
		}
		let threadAddr: Address;
		try {
			threadAddr = localAddress(from);
		} catch {
			return jsonResponse({ error: `invalid "from" session name: ${from}` }, 400);
		}
		const dedupeKey = crypto.randomUUID();
		const entry: ConsolePushEntry = {
			kind: "plugin_action",
			session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
			pluginId,
			actionType,
			...(payload ? { payload } : {}),
		};
		const delivered = deliverToOwner({
			entry,
			dedupeKey,
			label: "plugin_action",
		});
		if (delivered === MIGRATING) return jsonResponse({ error: MIGRATING }, 503);
		if (!delivered) {
			return jsonResponse({ error: "failed to store plugin action" }, 500);
		}
		console.log(`[plugin_action] ${pluginId}:${actionType} from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	return { mirrorPeer, humanNotify, pluginAction, deliverToOwner, drainOutbox };
}
