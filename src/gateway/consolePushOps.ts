import crypto from "node:crypto";
import type { ConsolePushEntry, FederatedOp } from "../shared/federation-protocol.js";
import { type NoticeTierWire, pickTiers } from "../shared/notice.js";
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

////////////////////////////////
//  Interfaces & Types

export interface ConsolePushOpsDeps {
	/** Console mailboxes. Absent when the console bridge is off, which makes every path here a no-op. */
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	/** This Gateway's own Domain owner id, the shared inbox key. Null pre-enrollment. */
	ownerId?: (() => string | null) | null;
	evieClient?: import("./evie/evieClient.js").EvieClient | null;
	/** Whether a gateway id resolves to a LOCAL peer, the allowlist filter the fan-out applies. */
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	localGatewayId: string;
	/** The ONE producer of a local session's canonical Address (routes.ts's own). */
	localAddress: (name: string) => Address;
	refuseImpersonation: (req: Request, claimed: string) => Response | null;
	relayWithRetry: (
		dstGateway: string,
		op: FederatedOp,
		label: string,
		dstDomain?: string,
	) => Promise<{ ok: boolean; error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

export function createConsolePushOps({
	mailboxStore,
	ownerId,
	evieClient,
	resolvesLocalGateway,
	localGatewayId,
	localAddress,
	refuseImpersonation,
	relayWithRetry,
}: ConsolePushOpsDeps) {
	/** THE single writer of a mailbox append that embeds `dedupeKey` onto the entry (the
	 * MailboxEntrySchema field, carried verbatim through any further relay) AND passes the
	 * identical value as `append()`'s own dedup parameter (DeviceMailbox's seenKeys map) - the
	 * two necessarily-equal uses of one key can never independently drift by going through two
	 * separate call sites. Never throws; swallows and logs under `label`, since every caller of
	 * this (mirrorPeer, consolePush, humanNotify) treats console-mailbox delivery as best-effort. */
	function landMailboxEntry(owner: string, entry: ConsolePushEntry, dedupeKey: string, label: string): boolean {
		if (!mailboxStore) return false;
		try {
			mailboxStore.ensure(owner).append({ ...entry, dedupeKey }, dedupeKey);
			return true;
		} catch (err) {
			console.warn(`[${label}] failed to append entry: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Append a "peer" display mirror into this Gateway's own Domain-owner mailbox, tagged under
	 * `threadAddr`'s own thread, then fan the same entry out to every other same-Domain Gateway
	 * (fanOutConsolePush) so it lands wherever the owner's console actually polls. A no-op
	 * pre-enrollment (no owner id) or when the console bridge is off (no mailboxStore) - the
	 * mirror is purely additive display, never load-bearing. */
	function mirrorPeer(
		threadAddr: Address,
		from: string,
		to: string,
		payload: NoticeTierWire & {
			body?: string;
			files?: ChannelFile[];
			status?: string;
		},
		// A stable id lets an at-least-once RELAY of this same already-composed entry (the
		// console_push convergence hop, see fanOutConsolePush) dedupe against the same key on
		// each receiving gateway. It does NOT protect against a caller-level HTTP retry of
		// send()/respond() itself - that gap is pre-existing (the channel_push/response_push it
		// mirrors has no such protection either) and is not solved here. Defaults to a fresh id
		// when no caller has one to give.
		dedupeKey: string = crypto.randomUUID(),
	): void {
		const owner = ownerId?.();
		if (!owner || !mailboxStore) return;
		const entry: ConsolePushEntry = {
			kind: "peer",
			session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
			from,
			to,
			...payload,
		};
		// Never load-bearing: a failure here must not turn an already-delivered/already-relayed
		// primary operation into a spurious failure for the caller, so the local outcome is
		// ignored and the fan-out is attempted regardless.
		landMailboxEntry(owner, entry, dedupeKey, "mirror");
		void fanOutConsolePush(entry, dedupeKey);
	}

	/** Land a fully-composed mailbox entry (a peer mirror, a notify_human notice, or a plugin_action
	 * relayed from ANOTHER same-Domain Gateway) onto THIS Gateway's own owner mailbox - the
	 * console_push LANDING side. Idempotent per dedupeKey. Local-append only: this function never
	 * fans out further, so a receiving Gateway can never gossip-loop an entry back out to the mesh
	 * (only fanOutConsolePush calls the relay, and nothing calls it from here). A no-op (not an
	 * error, so the origin's relayWithRetry does not burn retries on it) pre-enrollment, when the
	 * console bridge is off, when the attached files exceed the same byte cap every other
	 * mailbox-writing path enforces (send/respond/humanNotify - this is the only path that lands
	 * relayed-in content rather than a request this Gateway already validated itself), when a
	 * plugin_action payload exceeds its own byte cap, or if the append itself fails - mirroring
	 * mirrorPeer's own "purely additive, never load-bearing" posture. */
	function consolePush(entry: ConsolePushEntry, dedupeKey: string): { delivered: boolean } {
		const owner = ownerId?.();
		if (!owner || !mailboxStore) return { delivered: false };
		if (entry.files && entry.files.length > 0 && fileBytes(entry.files) > MAX_RESPONSE_FILE_BYTES) {
			console.warn(`[console_push] dropped an oversized entry (over ${MAX_RESPONSE_FILE_BYTES} bytes)`);
			return { delivered: false };
		}
		if (entry.payload && payloadBytes(entry.payload) > MAX_PLUGIN_ACTION_PAYLOAD_BYTES) {
			console.warn(
				`[console_push] dropped an oversized plugin_action payload (over ${MAX_PLUGIN_ACTION_PAYLOAD_BYTES} bytes)`,
			);
			return { delivered: false };
		}
		return { delivered: landMailboxEntry(owner, entry, dedupeKey, "console_push") };
	}

	/** Fan a console-bound entry (already appended locally by the caller) out to every OTHER
	 * same-Domain Gateway, so it lands wherever the owner's console actually polls - not just the
	 * Gateway that composed it. Same-Domain peers are enumerated the same way discover() already
	 * does (evie's list_gateways; no new discovery machinery), filtered through the
	 * locally-mirrored Allowlist where available (a mailbox WRITE deserves the extra check
	 * discover()'s read-only list_teams fan-out doesn't bother with) and self-excluded as cheap
	 * insurance against evie ever including the caller in its own roster. Fire-and-forget with
	 * retry (relayWithRetry); never throws. ORIGIN-ONLY: call this from an origination tap point
	 * (mirrorPeer, humanNotify) alone - never from console_push's own landing case in handleOp, or
	 * an entry would gossip-loop around the mesh forever. */
	async function fanOutConsolePush(entry: ConsolePushEntry, dedupeKey: string): Promise<void> {
		if (!evieClient?.isConnected()) return;
		if (!resolvesLocalGateway) {
			// Not just "no extra check" - trusting evie's roster alone for a mailbox WRITE is a
			// deliberately bigger trust extension than list_teams' read-only fan-out takes, so a
			// missing filter is worth a log, not a silent downgrade.
			console.warn("[console_push] fan-out running with no allowlist filter (resolvesLocalGateway unset)");
		}
		try {
			const rosterCall = await evieClient.callTool("list_gateways", {});
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

	/** Broadcast a notice to the owner's mailbox (one shared inbox drained by every one of their
	 * devices). Notices thread under the sender on the console and are never respondable: they
	 * are appended directly here (not via a peer push), so no inbound session is recorded.
	 * Ensures the mailbox by owner id rather than iterating whatever conversations already happen
	 * to be registered ON THIS GATEWAY: a Gateway with zero consoles ever registered against it
	 * (the ordinary shape for a multi-gateway Domain's non-home Gateway) would otherwise have an
	 * empty mailbox map, silently dropping the notice instead of landing it somewhere the owner
	 * will eventually poll. fanOutConsolePush then relays the same entry to every other
	 * same-Domain Gateway too, so it reaches wherever the console actually is. */
	function humanNotify(req: Request, body: Record<string, unknown>): Response {
		const parsed = HumanNotifySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, title, summary, full, fullSpoken, files: rawNoticeFiles } = parsed.data;
		// Stamped like every other locally-composed message. This route has no federated or console
		// caller - a notice is always posted by an agent on this machine, whose bytes are therefore
		// here - and the notice then fans out to wherever the owner's console actually polls, so
		// without the stamp a multi-Gateway owner can never fetch a notify_human attachment.
		const files = rawNoticeFiles && stampBlobHolder(rawNoticeFiles, localGatewayId);
		const refused = refuseImpersonation(req, from);
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
		const entry: ConsolePushEntry = {
			kind: "notice",
			// `from` is agent-origin (the notifying session's PROJECT_NAME, a slug), so localAddress
			// never throws here - unlike a console send's free-form Device Name. notify_human is an
			// agent-only tool; a console never posts a notice, so the sender is always a slug.
			session_id: storeKey({ kind: "notice", sender: localAddress(from) }),
			from,
			body: full,
			...pickTiers({ title, summary, fullSpoken }),
			...(files && files.length > 0 ? { files } : {}),
		};
		if (!landMailboxEntry(owner, entry, dedupeKey, "notify")) {
			return jsonResponse({ error: "failed to store notice" }, 500);
		}
		void fanOutConsolePush(entry, dedupeKey);
		console.log(`[notify] notice from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	/** Land a generic plugin-action envelope (pluginId/actionType/payload) into the owner's mailbox
	 * as a `plugin_action` entry, threaded under the CALLING agent's own address - never a
	 * client-suppliable target - so a caller can only ever act on its own conversation.
	 * Best-effort/never-load-bearing, matching every other mailbox-writing path here: the console
	 * routes an unclaimed pluginId:actionType to nothing (silently skipped), so a dropped write here
	 * is no worse than a dropped claim there. */
	function pluginAction(req: Request, body: Record<string, unknown>): Response {
		const parsed = PluginActionRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, pluginId, actionType, payload } = parsed.data;
		const refused = refuseImpersonation(req, from);
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
		if (!landMailboxEntry(owner, entry, dedupeKey, "plugin_action")) {
			return jsonResponse({ error: "failed to store plugin action" }, 500);
		}
		void fanOutConsolePush(entry, dedupeKey);
		console.log(`[plugin_action] ${pluginId}:${actionType} from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	return { mirrorPeer, consolePush, humanNotify, pluginAction };
}
