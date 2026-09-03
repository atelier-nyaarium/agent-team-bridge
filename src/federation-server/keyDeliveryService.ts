import { type DomainSnapshot, REGISTER_MAX_SKEW_MS, resolveAdmitted } from "../shared/admission.js";
import { sha256Hex } from "../shared/canonical-json.js";
import { verifyKeyReceipt, verifyKeyRequest } from "../shared/content-envelope.js";
import {
	type KeyGrant,
	KeyGrantOpSchema,
	type KeyReceipt,
	KeyReceiptFrameSchema,
	KeyReceiptOpSchema,
	KeyReceiptsReadResultSchema,
	type KeyRequest,
	KeyRequestFrameSchema,
	KeyRequestOpSchema,
} from "../shared/schemasContentKey.js";
import { type InboxAddress, type InboxRow, signRowEnvelope } from "../shared/schemasInbox.js";
import type { GatewayRegistration } from "./gatewayBridge.js";
import type { InboxService } from "./inbox/inboxService.js";
import type { OwnerOpIntake } from "./inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "./inbox/ownerStoreRegistry.js";
import type { OwnerServiceHooks } from "./ownerServiceHooks.js";

export function createKeyDeliveryService(params: {
	registry: OwnerStoreRegistry;
	inbox: InboxService;
	intake: OwnerOpIntake;
	routerIdentity: { signPub: string; signPriv: string };
	getDomain: (domainId: string) => DomainSnapshot | null;
	deliver: (domainId: string, address: InboxAddress, row: InboxRow) => void;
}) {
	const refuse = (opKey: { conversationId: string; opId: string }, reason: string) => ({
		opKey,
		outcome: "refused" as const,
		reason,
	});
	const requestNonces = new Map<string, { at: number; result: unknown }>();
	const admission = (domainId: string, signPub: string) => {
		const domain = params.getDomain(domainId);
		return domain ? resolveAdmitted(domain.admissions, domain.revocations, domain.ownerSignPub, signPub) : null;
	};
	const append = (
		domainId: string,
		address: InboxAddress,
		kind: "key_request" | "key_grant",
		body: KeyRequest | KeyGrant,
		opKey: { conversationId: string; opId: string },
	) => {
		const envelope = {
			origin: { kind: "router" as const, domainId },
			opKey,
			epoch: "clear" as const,
			kind,
			contentRefs: [],
		};
		const result = params.inbox.appendRow({
			address,
			row: { envelope, producerSig: signRowEnvelope(envelope, params.routerIdentity.signPriv), body },
			producerSignPub: params.routerIdentity.signPub,
			opKey: { ...opKey, hash: sha256Hex(JSON.stringify(body)) },
		});
		if (result.row) params.deliver(domainId, address, result.row);
		return result;
	};
	const ownerAddress = (domainId: string): InboxAddress => ({
		kind: "owner",
		domainId,
		ownerSignPub: params.registry.ownerKey(domainId).ownerSignPub,
	});
	const grantAddress = (domainId: string, signPub: string): InboxAddress | null => {
		const subject = admission(domainId, signPub);
		if (!subject) return null;
		if (subject.kind === "gateway") {
			return subject.gatewayId ? { kind: "gateway", domainId, gatewayId: subject.gatewayId } : null;
		}
		return ownerAddress(domainId);
	};
	const receipt = (domainId: string, opKey: { conversationId: string; opId: string }, value: KeyReceipt) => {
		const store = params.registry.for(domainId);
		const id = `${value.recipientSignPub}/${value.epoch}`;
		const current = store.get("keyReceipt", id);
		if (current?.clear.nonce === value.nonce) return { opKey, outcome: "accepted" as const };
		if (current && Number(current.clear.at) > value.at) return refuse(opKey, "stale");
		const write = store.put("keyReceipt", id, current?.version ?? null, {
			clear: { recipientSignPub: value.recipientSignPub, epoch: value.epoch, at: value.at, nonce: value.nonce },
		});
		if (write.kind !== "ok")
			return {
				opKey,
				outcome:
					write.kind === "quarantined" || write.kind === "durability_uncertain"
						? ("durability_uncertain" as const)
						: ("durability_failure" as const),
			};
		return { opKey, outcome: "accepted" as const };
	};
	const requestHandler = (
		op: { domainId: string; signerSignPub: string; conversationId: string; opId: string; at: number },
		request: KeyRequest,
	) => {
		const opKey = { conversationId: op.conversationId, opId: op.opId };
		const domain = params.getDomain(op.domainId);
		if (
			!domain ||
			request.domainId !== op.domainId ||
			!verifyKeyRequest(request) ||
			Math.abs(params.registry.now() - request.at) > REGISTER_MAX_SKEW_MS ||
			!admission(op.domainId, request.requesterSignPub)
		)
			return refuse(opKey, "invalid request");
		for (const [key, entry] of requestNonces)
			if (params.registry.now() - entry.at > REGISTER_MAX_SKEW_MS) requestNonces.delete(key);
		const nonceKey = `${op.domainId}/${request.requesterSignPub}/${request.nonce}`;
		const replay = requestNonces.get(nonceKey);
		if (replay) return replay.result;
		const result = append(op.domainId, ownerAddress(op.domainId), "key_request", request, opKey);
		requestNonces.set(nonceKey, { at: request.at, result });
		return result;
	};
	const grantHandler = (
		op: { domainId: string; signerSignPub: string; conversationId: string; opId: string },
		grant: KeyGrant,
	) => {
		const opKey = { conversationId: op.conversationId, opId: op.opId };
		if (grant.envelope.signerSignPub !== op.signerSignPub) return refuse(opKey, "signer");
		const address = grantAddress(op.domainId, grant.recipientSignPub);
		return address ? append(op.domainId, address, "key_grant", grant, opKey) : refuse(opKey, "recipient");
	};
	const register = (hooks: OwnerServiceHooks) => {
		hooks.ownerOp("key_request", (op, value) => {
			const parsed = KeyRequestOpSchema.safeParse(value);
			if (!parsed.success) return refuse({ conversationId: op.conversationId, opId: op.opId }, "malformed");
			if (parsed.data.request.requesterSignPub !== op.signerSignPub)
				return refuse({ conversationId: op.conversationId, opId: op.opId }, "requester");
			return requestHandler(op, parsed.data.request);
		});
		hooks.ownerOp("key_grant", (op, value) => {
			const parsed = KeyGrantOpSchema.safeParse(value);
			if (!parsed.success) return refuse({ conversationId: op.conversationId, opId: op.opId }, "malformed");
			return grantHandler(op, parsed.data.grant);
		});
		hooks.ownerOp("key_receipt", (op, value) => {
			const parsed = KeyReceiptOpSchema.safeParse(value);
			const opKey = { conversationId: op.conversationId, opId: op.opId };
			if (
				!parsed.success ||
				!verifyKeyReceipt(parsed.data.receipt) ||
				parsed.data.receipt.domainId !== op.domainId ||
				parsed.data.receipt.recipientSignPub !== op.signerSignPub ||
				Math.abs(params.registry.now() - parsed.data.receipt.at) > REGISTER_MAX_SKEW_MS ||
				!admission(op.domainId, parsed.data.receipt.recipientSignPub)
			)
				return refuse(opKey, "invalid receipt");
			return receipt(op.domainId, opKey, parsed.data.receipt);
		});
		hooks.ownerOp("key_receipts_read", (op) => {
			const receipts = params.registry
				.for(op.domainId)
				.list("keyReceipt")
				.map((record) => ({
					recipientSignPub: String(record.clear.recipientSignPub),
					epoch: Number(record.clear.epoch),
					at: Number(record.clear.at),
				}));
			return KeyReceiptsReadResultSchema.parse({ receipts });
		});
		hooks.gatewayFrame("key_request", (reg, value) => frameRequest(reg, value));
		hooks.gatewayFrame("key_receipt", (reg, value) => frameReceipt(reg, value));
	};
	const frameRequest = (reg: GatewayRegistration, value: Record<string, unknown>) => {
		const parsed = KeyRequestFrameSchema.safeParse(value);
		const opKey = {
			conversationId: "key-request",
			opId: sha256Hex(`${reg.gatewayId}\n${String((value.request as { nonce?: unknown })?.nonce ?? "")}`),
		};
		if (!parsed.success || parsed.data.request.requesterSignPub !== reg.signPub) return refuse(opKey, "requester");
		return requestHandler(
			{
				domainId: reg.domainId,
				signerSignPub: reg.signPub,
				conversationId: opKey.conversationId,
				opId: opKey.opId,
				at: parsed.data.request.at,
			},
			parsed.data.request,
		);
	};
	const frameReceipt = (reg: GatewayRegistration, value: Record<string, unknown>) => {
		const parsed = KeyReceiptFrameSchema.safeParse(value);
		const receiptValue = parsed.success ? parsed.data.receipt : null;
		const opKey = {
			conversationId: "key-receipt",
			opId: sha256Hex(`${reg.gatewayId}\n${String(receiptValue?.nonce ?? "")}`),
		};
		if (
			!receiptValue ||
			receiptValue.recipientSignPub !== reg.signPub ||
			receiptValue.domainId !== reg.domainId ||
			!verifyKeyReceipt(receiptValue) ||
			Math.abs(params.registry.now() - receiptValue.at) > REGISTER_MAX_SKEW_MS ||
			!admission(reg.domainId, reg.signPub)
		)
			return refuse(opKey, "invalid receipt");
		return receipt(reg.domainId, opKey, receiptValue);
	};
	return { register };
}
