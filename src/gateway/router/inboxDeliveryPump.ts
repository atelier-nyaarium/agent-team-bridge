import type { ConsoleOp } from "../../shared/console-protocol.js";
import { opPayloadAadKind, opResultAadKind, scheduledBodyAadKind } from "../../shared/content-envelope.js";
import { SealedEnvelopeSchema } from "../../shared/crypto.js";
import { type FederatedOp, FederatedOpSchema } from "../../shared/federation-protocol.js";
import { BoardObservationRowSchema, type BoardStoredEntry } from "../../shared/schemasBoardState.js";
import {
	ConsoleOpSchema,
	DELIVERY_OP_KINDS,
	TOLERATED_DELIVERY_OP_KINDS,
	VALUE_OP_KINDS,
} from "../../shared/schemasConsoleOp.js";
import { ContentEnvelopeSchema, KeyGrantSchema } from "../../shared/schemasContentKey.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	InboxRowSchema,
	parseInboxAddress,
	signRowEnvelope,
} from "../../shared/schemasInbox.js";
import { OP_OUTCOME_ACCEPTED } from "../../shared/wire-vocabulary.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";
import type { Sealer } from "../federation/sealer.js";
import type { InboxClaims } from "./inboxClaims.js";

type AckOutcome = "delivered" | "waking" | "failed";
type AckReply = { error?: string; result?: { outcome?: string; error?: string } };

export interface InboxDeliveryPumpDeps {
	claims: InboxClaims;
	routerClient: { callInboxTool: (action: string, params: Record<string, unknown>) => Promise<unknown> };
	/** Drops frames for another registration. */
	incarnation?: () => number | null;
	domainId: string;
	ownerSignPub: () => string | null;
	contentKeyStore: Pick<ContentKeyStore, "open" | "seal" | "epochs" | "install">;
	keyRequester?: {
		request: (epoch: number) => void;
		installed: (epoch: number) => void;
		sendReceipt: (epoch: number) => Promise<void>;
		resendReceipts: (epochs: number[]) => Promise<void>;
	};
	gatewayId?: string;
	gatewaySignPub?: string;
	allowlistSnapshot?: () => {
		ownerSignPub: string;
		admissions: import("../../shared/admission.js").SignedAdmission[];
		revocations: import("../../shared/admission.js").SignedRevocation[];
	} | null;
	sealer?: Pick<Sealer, "openWithSource">;
	consoleDispatch?: (
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
	) => Promise<unknown>;
	producerSignPriv?: string;
	coordinator?: Pick<ChannelDeliveryCoordinator, "accept" | "acknowledge">;
	tryWakeTeam?: (team: string) => Promise<{ ok: boolean; error?: string; errorKind?: string }>;
	isSessionLive?: (sessionId: string) => boolean;
	consolePush?: (body: unknown) => void;
	boardObservation?: (
		sessionKey: string,
		row: {
			identity: string;
			pre: BoardStoredEntry | null;
			post: BoardStoredEntry | null;
		},
	) => void;
	/** Runs an op using the seal's verified source Domain. */
	peerHandler?: (op: FederatedOp, srcGateway: string, srcDomainId: string | null) => Promise<unknown>;
}

interface DeliveryPayload {
	to?: string;
	from?: string;
	body?: string;
	files?: unknown[];
	disposition?: string;
	messageId?: string;
}

const deliveryIdOf = (address: string, seq: number, deliveryEpoch: number) => `${address}:${seq}:${deliveryEpoch}`;

export function createInboxDeliveryPump(deps: InboxDeliveryPumpDeps) {
	const waiting = new Map<string, { epoch: number; address: string; row: InboxRow; deliveryEpoch: number }>();
	/** Claims survive lost Router acknowledgements; non-custodial outcomes are retried. */
	async function ack(
		address: string,
		seq: number,
		deliveryEpoch: number,
		outcome: AckOutcome,
		reason?: string,
		custody = true,
	) {
		if (outcome === "failed") console.warn(`[inbox] ${address} seq=${seq} failed: ${reason ?? "unknown"}`);
		deps.claims.setOutcome(address, seq, deliveryEpoch, outcome);
		const reply = (await deps.routerClient.callInboxTool("inbox_ack", {
			address,
			seq,
			deliveryEpoch,
			outcome,
			...(reason ? { reason } : {}),
		})) as AckReply | undefined;
		const answered = reply?.result?.outcome;
		const landed = !reply?.error && (answered === outcome || answered === "gone");
		if (!custody || (landed && (outcome !== "waking" || answered === "gone")))
			deps.claims.ack(address, seq, deliveryEpoch);
	}

	async function deliver(address: string, row: InboxRow, deliveryEpoch: number): Promise<void> {
		const claim = deps.claims.claim(address, row.seq, deliveryEpoch);
		if (claim) {
			if (row.envelope.kind === "console_op" && claim.outcome === "waking")
				return appendConsoleResult(
					address,
					parseInboxAddress(address) as Extract<InboxAddress, { kind: "session" }>,
					row,
					deliveryEpoch,
					{ ok: false, error: "lost" },
				);
			return ack(address, row.seq, deliveryEpoch, claim.outcome);
		}
		const parsed = parseInboxAddress(address);
		if (!parsed || parsed.kind === "owner")
			return ack(address, row.seq, deliveryEpoch, "failed", "unsupported_address");
		if (row.envelope.epoch === "peer") return deliverPeer(address, parsed, row, deliveryEpoch);
		if (row.envelope.epoch === "clear") {
			if (row.envelope.origin.kind !== "router")
				return ack(address, row.seq, deliveryEpoch, "failed", "clear_origin");
			return land(address, parsed, row, deliveryEpoch, row.body);
		}
		if (row.envelope.kind === "console_op") {
			if (parsed.kind !== "session") return ack(address, row.seq, deliveryEpoch, "failed", "unsupported_address");
			return deliverConsoleOp(address, parsed, row, deliveryEpoch);
		}
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub) return ack(address, row.seq, deliveryEpoch, "waking", "missing_epoch", false);
		const kind =
			row.envelope.origin.kind === "router" && row.envelope.kind === "message"
				? scheduledBodyAadKind(row.envelope.opKey.conversationId, row.envelope.opKey.opId)
				: opPayloadAadKind();
		const content = ContentEnvelopeSchema.safeParse(row.body);
		if (!content.success) return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
		const opened = deps.contentKeyStore.open(content.data, {
			domainId: deps.domainId,
			ownerSignPub,
			epoch: row.envelope.epoch,
			kind,
		});
		if (opened.kind === "missing_epoch") {
			const deliveryId = deliveryIdOf(address, row.seq, deliveryEpoch);
			waiting.set(deliveryId, { epoch: opened.epoch, address, row, deliveryEpoch });
			deps.keyRequester?.request(opened.epoch);
			return ack(address, row.seq, deliveryEpoch, "waking", "missing_epoch", false);
		}
		if (opened.kind === "bad_tag") return ack(address, row.seq, deliveryEpoch, "failed", "bad_tag");
		let body: unknown;
		try {
			body = JSON.parse(opened.plaintext.toString("utf8"));
		} catch {
			return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
		}
		return land(address, parsed, row, deliveryEpoch, body);
	}

	async function deliverConsoleOp(
		address: string,
		parsed: Extract<InboxAddress, { kind: "session" }>,
		row: InboxRow,
		deliveryEpoch: number,
	): Promise<void> {
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub || !deps.consoleDispatch || !deps.producerSignPriv)
			return ack(address, row.seq, deliveryEpoch, "failed", "delivery_unavailable");
		if (row.envelope.epoch === "peer" || row.envelope.epoch === "clear")
			return ack(address, row.seq, deliveryEpoch, "failed", "unsupported_envelope");
		const content = ContentEnvelopeSchema.safeParse(row.body);
		if (!content.success) return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
		const opened = deps.contentKeyStore.open(content.data, {
			domainId: deps.domainId,
			ownerSignPub,
			epoch: row.envelope.epoch,
			kind: opPayloadAadKind(),
		});
		if (opened.kind === "missing_epoch") {
			const deliveryId = deliveryIdOf(address, row.seq, deliveryEpoch);
			waiting.set(deliveryId, { epoch: opened.epoch, address, row, deliveryEpoch });
			deps.keyRequester?.request(opened.epoch);
			return ack(address, row.seq, deliveryEpoch, "waking", "missing_epoch", false);
		}
		if (opened.kind === "bad_tag") return ack(address, row.seq, deliveryEpoch, "failed", "bad_tag");
		let body: unknown;
		try {
			body = JSON.parse(opened.plaintext.toString("utf8"));
		} catch {
			return appendConsoleResult(address, parsed, row, deliveryEpoch, { ok: false, error: "malformed_body" });
		}
		const op = ConsoleOpSchema.safeParse(body);
		if (
			!op.success ||
			((!DELIVERY_OP_KINDS.has(op.data.kind) || VALUE_OP_KINDS.has(op.data.kind)) &&
				!TOLERATED_DELIVERY_OP_KINDS.has(op.data.kind))
		)
			return appendConsoleResult(address, parsed, row, deliveryEpoch, {
				ok: false,
				error: "delivery op kind is not allowed",
			});
		const target =
			op.data.kind === "respond"
				? op.data.session_id
				: op.data.kind === "send"
					? op.data.to
					: (op.data as { target: string }).target;
		const targetMatches = new Set([
			parsed.sessionId,
			// The console names sessions by their canonical dotted address.
			`${parsed.domainId}.${parsed.gatewayId}.${parsed.sessionId}`,
			`${parsed.gatewayId}.${parsed.sessionId}`,
			`${parsed.gatewayId}/${parsed.sessionId}`,
			`gateway/${parsed.gatewayId}/${parsed.sessionId}`,
			`${parsed.domainId}/${parsed.gatewayId}/${parsed.sessionId}`,
		]);
		if (parsed.domainId !== deps.domainId || parsed.gatewayId !== deps.gatewayId || !targetMatches.has(target)) {
			console.log(
				`[console-op] ${op.data.kind} target=${target} -> target_mismatch (${parsed.domainId}/${parsed.gatewayId}/${parsed.sessionId})`,
			);
			return appendConsoleResult(address, parsed, row, deliveryEpoch, { ok: false, error: "target_mismatch" });
		}
		try {
			const result = await deps.consoleDispatch(
				op.data,
				row.envelope.origin.device ?? "",
				row.envelope.opKey.conversationId,
				row.envelope.opKey.opId,
				ownerSignPub,
			);
			return appendConsoleResult(address, parsed, row, deliveryEpoch, { ok: true, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(`[console-op] ${op.data.kind} target=${target} -> error: ${message}`);
			return appendConsoleResult(address, parsed, row, deliveryEpoch, { ok: false, error: message });
		}
	}

	async function appendConsoleResult(
		address: string,
		parsed: Extract<InboxAddress, { kind: "session" }>,
		row: InboxRow,
		deliveryEpoch: number,
		resultBody: Record<string, unknown>,
	): Promise<void> {
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub || !deps.producerSignPriv)
			return ack(address, row.seq, deliveryEpoch, "failed", "result_unavailable");
		const sealed = deps.contentKeyStore.seal(Buffer.from(JSON.stringify(resultBody), "utf8"), {
			domainId: deps.domainId,
			ownerSignPub,
			kind: opResultAadKind(row.envelope.opKey.conversationId, row.envelope.opKey.opId),
		});
		if (sealed.kind !== "ok") return ack(address, row.seq, deliveryEpoch, "failed", "result_unavailable");
		const envelope = {
			origin: { kind: "gateway" as const, domainId: deps.domainId, gatewayId: deps.gatewayId },
			opKey: row.envelope.opKey,
			epoch: sealed.envelope.epoch,
			kind: "op_result" as const,
			contentRefs: [],
		};
		const reply = (await deps.routerClient.callInboxTool("inbox_append", {
			address: formatInboxAddress({ kind: "owner", domainId: deps.domainId, ownerSignPub }),
			row: { envelope, producerSig: signRowEnvelope(envelope, deps.producerSignPriv), body: sealed.envelope },
		})) as AckReply | undefined;
		const outcome = reply?.result?.outcome;
		if (outcome !== OP_OUTCOME_ACCEPTED && outcome !== "conflict")
			return ack(address, row.seq, deliveryEpoch, "waking", "result_pending", false);
		return ack(address, row.seq, deliveryEpoch, "delivered");
	}

	async function deliverPeer(address: string, parsed: InboxAddress, row: InboxRow, deliveryEpoch: number) {
		const origin = row.envelope.origin;
		if (!deps.sealer || !deps.peerHandler || parsed.kind !== "session" || !origin.gatewayId)
			return ack(address, row.seq, deliveryEpoch, "failed", "peer_unavailable");
		let opened: ReturnType<Sealer["openWithSource"]>;
		try {
			const sealed = SealedEnvelopeSchema.parse(row.body);
			opened = deps.sealer.openWithSource(origin.gatewayId, sealed, origin.domainId, {
				sealedAt: row.acceptedAt,
			});
		} catch {
			return ack(address, row.seq, deliveryEpoch, "failed", "bad_tag");
		}
		const op = FederatedOpSchema.safeParse(opened.body);
		if (!op.success) return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
		try {
			await deps.peerHandler(op.data, origin.gatewayId, opened.srcDomainId);
		} catch (err) {
			return ack(address, row.seq, deliveryEpoch, "failed", (err as Error).message);
		}
		return ack(address, row.seq, deliveryEpoch, "delivered");
	}

	async function land(address: string, parsed: InboxAddress, row: InboxRow, deliveryEpoch: number, body: unknown) {
		if (parsed.kind === "gateway") {
			if (row.envelope.kind === "key_grant") {
				if (parsed.domainId !== deps.domainId || parsed.gatewayId !== deps.gatewayId || !deps.gatewaySignPub)
					return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
				const grant = KeyGrantSchema.safeParse(body);
				if (!grant.success || grant.data.recipientSignPub !== deps.gatewaySignPub)
					return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
				const snapshot = deps.allowlistSnapshot?.();
				if (!snapshot || !deps.keyRequester)
					return ack(address, row.seq, deliveryEpoch, "failed", "key_refused");
				const result = deps.contentKeyStore.install(grant.data.envelope, snapshot);
				console.log(`[inbox] key grant epoch ${grant.data.envelope.epoch}: ${result}`);
				if (result === "refused") return ack(address, row.seq, deliveryEpoch, "failed", "key_refused");
				try {
					await deps.keyRequester.sendReceipt(grant.data.envelope.epoch);
				} catch (error) {
					console.warn(
						`[inbox] receipt send failed for epoch ${grant.data.envelope.epoch}: ${error instanceof Error ? error.message : error}`,
					);
				}
				deps.keyRequester.installed(grant.data.envelope.epoch);
				const retry = [...waiting.values()].filter((item) => item.epoch === grant.data.envelope.epoch);
				for (const item of retry) {
					waiting.delete(deliveryIdOf(item.address, item.row.seq, item.deliveryEpoch));
					await deliver(item.address, item.row, item.deliveryEpoch);
				}
				return ack(address, row.seq, deliveryEpoch, "delivered");
			}
			if (!deps.consolePush) return ack(address, row.seq, deliveryEpoch, "waking", "no_consumer", false);
			deps.consolePush(body);
			return ack(address, row.seq, deliveryEpoch, "delivered");
		}
		if (parsed.kind !== "session") return ack(address, row.seq, deliveryEpoch, "failed", "unsupported_address");
		// No session reader handles this gateway's own result.
		if (row.envelope.kind === "op_result") {
			// Result rows complete ledger.
			console.log(`[inbox] result op=${row.envelope.opKey.opId} kind=${row.envelope.kind} bytes=${row.size}`);
			return ack(address, row.seq, deliveryEpoch, "delivered");
		}
		if (row.envelope.kind === "board_observation") {
			const observation = BoardObservationRowSchema.safeParse(body);
			if (!observation.success) return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
			if (!deps.boardObservation) return ack(address, row.seq, deliveryEpoch, "waking", "no_consumer", false);
			deps.boardObservation(parsed.sessionId, observation.data);
			return ack(address, row.seq, deliveryEpoch, "delivered");
		}
		const payload = (body ?? {}) as DeliveryPayload;
		if (!payload.to || !payload.from) return ack(address, row.seq, deliveryEpoch, "failed", "malformed_body");
		if (!deps.coordinator) return ack(address, row.seq, deliveryEpoch, "failed", "delivery_unavailable");
		const deliveryId = deliveryIdOf(address, row.seq, deliveryEpoch);
		const outcome = deps.coordinator.accept({
			deliveryId,
			team: parsed.sessionId,
			channelJobId: payload.messageId ?? `${address}:${row.seq}`,
			from: payload.from,
			body: payload.body ?? "",
			...(payload.files ? { files: payload.files as never } : {}),
			...(payload.disposition ? { disposition: payload.disposition } : {}),
			enqueuedAt: row.acceptedAt,
		});
		if (outcome === "refused") return ack(address, row.seq, deliveryEpoch, "failed", "delivery_refused");
		// The receiver's channel_delivery_ack retires socket deliveries.
		if (outcome === "delivered") return;
		if (deps.isSessionLive?.(parsed.sessionId)) return ack(address, row.seq, deliveryEpoch, "waking");
		const wake = await deps.tryWakeTeam?.(payload.to);
		const definitive = wake && !wake.ok && wake.errorKind !== "timeout" && wake.errorKind !== "disconnected";
		if (definitive) {
			deps.coordinator.acknowledge(deliveryId);
			return ack(address, row.seq, deliveryEpoch, "failed", wake.error);
		}
		return ack(address, row.seq, deliveryEpoch, "waking");
	}

	async function onFrame(frame: {
		address: string;
		rows: unknown;
		incarnation?: number;
		deliveryEpoch: number;
	}): Promise<void> {
		// Ignore frames for a previous registration.
		const current = deps.incarnation?.();
		if (current !== undefined && frame.incarnation !== current) {
			console.warn(`[inbox] dropped a frame for incarnation ${frame.incarnation} (current ${current})`);
			return;
		}
		const rows = (Array.isArray(frame.rows) ? frame.rows : [])
			.map((row) => InboxRowSchema.safeParse(row).data)
			.filter((row): row is InboxRow => row !== undefined)
			.sort((a, b) => a.seq - b.seq);
		for (const row of rows) await deliver(frame.address, row, frame.deliveryEpoch);
	}

	/** Acknowledges delivery to the addressed session. */
	async function onChannelDeliveryAck(team: string, deliveryId: string): Promise<boolean> {
		const match = /^(.+):(\d+):(\d+)$/.exec(deliveryId);
		if (!match) return false;
		const address = parseInboxAddress(match[1]);
		if (address?.kind !== "session" || address.sessionId !== team) return false;
		const seq = Number(match[2]);
		const deliveryEpoch = Number(match[3]);
		if (!deps.claims.get(match[1], seq, deliveryEpoch)) return false;
		await ack(match[1], seq, deliveryEpoch, "delivered");
		deps.coordinator?.acknowledge(deliveryId);
		return true;
	}

	async function resendReceipts(): Promise<void> {
		await deps.keyRequester?.resendReceipts(deps.contentKeyStore.epochs());
	}

	return { onFrame, onChannelDeliveryAck, resendReceipts };
}
