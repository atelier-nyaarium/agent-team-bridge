import crypto from "node:crypto";
import { canonicalJson, sha256Hex } from "../shared/canonical-json.js";
import { inboxBodyAadKind } from "../shared/content-envelope.js";
import type { MailboxProvenance } from "../shared/device-mailbox.js";
import type { ConsolePushEntry, FederatedOp } from "../shared/federation-protocol.js";
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
	provenance: MailboxProvenance;
	/** Relays never fan out. */
	origin: "local" | "relay";
	resolveMailbox?: () => import("../shared/device-mailbox.js").DeviceMailbox | undefined;
	label?: string;
}

export type DeliverToOwnerResult = boolean | typeof MIGRATING;
export type DeliverToOwner = (opts: DeliverToOwnerOptions) => DeliverToOwnerResult;

export interface ConsolePushOpsDeps {
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	ownerId?: (() => string | null) | null;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	localGatewayId: string;
	localDomainId?: string;
	producerSignPriv?: string;
	ownerSignPub?: (() => string | null) | null;
	contentKeyStore?: Pick<import("./federation/contentKeyStore.js").ContentKeyStore, "seal">;
	localAddress: (name: string) => Address;
	cacheBlobs?: ((blobIds: readonly string[]) => void) | null;
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
	relayWithRetry: (
		dstGateway: string,
		op: FederatedOp,
		label: string,
		dstDomain?: string,
	) => Promise<{ ok: boolean; error?: string }>;
}

export function createConsolePushOps({
	mailboxStore,
	ownerId,
	routerClient,
	resolvesLocalGateway,
	localGatewayId,
	localDomainId,
	producerSignPriv,
	ownerSignPub,
	contentKeyStore,
	localAddress,
	cacheBlobs,
	refuseImpersonation,
	relayWithRetry,
}: ConsolePushOpsDeps) {
	/** Sole owner-mailbox writer. */
	function deliverToOwner({
		entry,
		dedupeKey,
		provenance,
		origin,
		resolveMailbox,
		label = "deliver",
	}: DeliverToOwnerOptions): DeliverToOwnerResult {
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
		let mailbox: import("../shared/device-mailbox.js").DeviceMailbox | undefined;
		if (resolveMailbox) {
			mailbox = resolveMailbox();
		} else {
			const owner = ownerId?.();
			if (owner && mailboxStore) mailbox = mailboxStore.ensure(owner);
		}
		if (!mailbox) return false;
		try {
			const appended = mailbox.append({ ...entry, dedupeKey }, dedupeKey, provenance);
			if ("outcome" in appended) return MIGRATING;
			if (origin === "local" && entry.kind !== "peer")
				void appendOwnerRow(appended, entry.opId ?? dedupeKey, label);
		} catch (err) {
			console.warn(`[${label}] failed to append entry: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		// Cache only landed blobs.
		const blobIds = [...new Set((entry.files ?? []).flatMap((file) => (file.blobId ? [file.blobId] : [])))];
		if (blobIds.length > 0) cacheBlobs?.(blobIds);
		if (origin === "local" && entry.session_id) void fanOutConsolePush(entry, dedupeKey);
		return true;
	}

	async function appendOwnerRow(
		entry: import("../shared/console-protocol.js").MailboxEntry,
		opId: string,
		label: string,
	): Promise<void> {
		if (!routerClient?.isConnected() || (routerClient.isRegistered && !routerClient.isRegistered())) return;
		const domainId = localDomainId;
		const ownerSign = ownerSignPub?.();
		if (!domainId || !ownerSign || !producerSignPriv || !contentKeyStore) return;
		const conversationId = sha256Hex(entry.session_id);
		const sealed = contentKeyStore.seal(Buffer.from(JSON.stringify(entry), "utf8"), {
			domainId,
			ownerSignPub: ownerSign,
			kind: inboxBodyAadKind(conversationId, opId),
		});
		if (sealed.kind !== "ok") return;
		const envelope = {
			origin: { kind: "gateway" as const, domainId, gatewayId: localGatewayId },
			opKey: { conversationId, opId },
			epoch: sealed.envelope.epoch,
			kind: entry.kind,
			contentRefs: [...new Set((entry.files ?? []).flatMap((file) => (file.blobId ? [file.blobId] : [])))],
		};
		try {
			const result = await routerClient.callInboxTool("inbox_append", {
				address: formatInboxAddress({ kind: "owner", domainId, ownerSignPub: ownerSign }),
				row: { envelope, producerSig: signRowEnvelope(envelope, producerSignPriv), body: sealed.envelope },
				opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ entry, opId })) },
			});
			const outcome = OpResultEnvelopeSchema.safeParse(result.result).data?.outcome;
			if (result.error || ["refused", "durability_failure", "durability_uncertain"].includes(outcome ?? "")) {
				console.warn(`[${label}] owner inbox append refused: ${result.error ?? outcome}`);
			}
		} catch (err) {
			console.warn(`[${label}] owner inbox append failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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
		if (!owner || !mailboxStore) return;
		try {
			const entry: ConsolePushEntry = {
				kind: "peer",
				session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
				from,
				to,
				...payload,
			};
			deliverToOwner({ entry, dedupeKey, provenance: "peer", origin: "local", label: "mirror" });
		} catch (err) {
			console.warn(`[mirror] dropped: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Lands relayed entries without fan-out. */
	function consolePush(entry: ConsolePushEntry, dedupeKey: string): { delivered: boolean; error?: typeof MIGRATING } {
		const delivered = deliverToOwner({
			entry,
			dedupeKey,
			provenance: "message",
			origin: "relay",
			label: "console_push",
		});
		return delivered === MIGRATING ? { delivered: false, error: MIGRATING } : { delivered };
	}

	/** Fans out local entries only. */
	async function fanOutConsolePush(entry: ConsolePushEntry, dedupeKey: string): Promise<void> {
		if (!routerClient?.isConnected()) return;
		if (!resolvesLocalGateway) {
			// Mailbox writes require the allowlist.
			console.warn("[console_push] fan-out running with no allowlist filter (resolvesLocalGateway unset)");
		}
		try {
			const rosterCall = await routerClient.callTool("list_gateways", {});
			const roster = (rosterCall.result as { gateways?: { gatewayId: string }[] } | undefined)?.gateways ?? [];
			for (const { gatewayId } of roster) {
				if (gatewayId === localGatewayId) continue;
				if (resolvesLocalGateway && !resolvesLocalGateway(gatewayId)) continue;
				void relayWithRetry(gatewayId, { kind: "console_push", entry, dedupeKey }, "console_push");
			}
		} catch (err) {
			console.warn(
				`[console_push] fan-out roster fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
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
		if (!mailboxStore) {
			return jsonResponse({ error: "console bridge is not enabled on this gateway" }, 503);
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
		const delivered = deliverToOwner({ entry, dedupeKey, provenance: "message", origin: "local", label: "notify" });
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
		if (!mailboxStore) {
			return jsonResponse({ error: "console bridge is not enabled on this gateway" }, 503);
		}
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
			provenance: "message",
			origin: "local",
			label: "plugin_action",
		});
		if (delivered === MIGRATING) return jsonResponse({ error: MIGRATING }, 503);
		if (!delivered) {
			return jsonResponse({ error: "failed to store plugin action" }, 500);
		}
		console.log(`[plugin_action] ${pluginId}:${actionType} from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	return { mirrorPeer, consolePush, humanNotify, pluginAction, fanOutConsolePush, deliverToOwner };
}
