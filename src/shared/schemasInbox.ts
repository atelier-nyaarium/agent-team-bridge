import { z } from "zod";
import { isBlobId } from "./blob-store.js";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { b64Field, SealedEnvelopeSchema, sign, verify } from "./crypto.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

const idField = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.regex(/^[^/\r\n]+$/);
const domainIdField = idField(64);
const gatewayIdField = idField(64);
const sessionIdField = idField(128);
const opIdField = idField(128);
const deviceField = idField(64);

export const InboxAddressSchema = z.string().refine((value) => parseInboxAddress(value) !== null);

export type InboxAddress =
	| { kind: "owner"; domainId: string; ownerSignPub: string }
	| { kind: "session"; domainId: string; gatewayId: string; sessionId: string }
	| { kind: "gateway"; domainId: string; gatewayId: string };

export function parseInboxAddress(text: string): InboxAddress | null {
	// Standard base64 keys may contain a slash; the Domain id never does.
	const owner = /^owner:([^/\r\n]+)\/([^\r\n]+)$/.exec(text);
	if (owner && domainIdField.safeParse(owner[1]).success && b64Field().safeParse(owner[2]).success) {
		return { kind: "owner", domainId: owner[1], ownerSignPub: owner[2] };
	}
	const session = /^session:([^/\r\n]+)\/([^/\r\n]+)\/([^/\r\n]+)$/.exec(text);
	if (
		session &&
		domainIdField.safeParse(session[1]).success &&
		gatewayIdField.safeParse(session[2]).success &&
		sessionIdField.safeParse(session[3]).success
	) {
		return { kind: "session", domainId: session[1], gatewayId: session[2], sessionId: session[3] };
	}
	const gateway = /^gateway:([^/\r\n]+)\/([^/\r\n]+)$/.exec(text);
	if (gateway && domainIdField.safeParse(gateway[1]).success && gatewayIdField.safeParse(gateway[2]).success) {
		return { kind: "gateway", domainId: gateway[1], gatewayId: gateway[2] };
	}
	return null;
}

export function formatInboxAddress(parsed: InboxAddress): string {
	if (parsed.kind === "owner") return `owner:${parsed.domainId}/${parsed.ownerSignPub}`;
	if (parsed.kind === "session") return `session:${parsed.domainId}/${parsed.gatewayId}/${parsed.sessionId}`;
	return `gateway:${parsed.domainId}/${parsed.gatewayId}`;
}

export const RowOriginSchema = z
	.object({
		kind: z.enum(["console", "session", "gateway", "router"]),
		domainId: domainIdField,
		gatewayId: gatewayIdField.optional(),
		sessionId: sessionIdField.optional(),
		device: deviceField.optional(),
	})
	.meta({ id: "RowOrigin" });

export const OpKeySchema = z
	.object({
		conversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
		opId: opIdField,
		hash: z
			.string()
			.length(64)
			.regex(/^[0-9a-f]+$/)
			.optional(),
	})
	.meta({ id: "OpKey" });

export const RowKindSchema = z.enum([
	"message",
	"reply",
	"notice",
	"sent",
	"peer",
	"plugin_action",
	"awareness",
	"key_request",
	"key_grant",
	"scheduled_result",
	"board_observation",
	"console_op",
	"op_result",
]);

export const RowEnvelopeSchema = z
	.object({
		origin: RowOriginSchema,
		opKey: OpKeySchema,
		epoch: z.union([z.number().int().min(1).max(2147483647), z.enum(["peer", "clear"])]),
		kind: RowKindSchema,
		contentRefs: z.array(z.string().refine(isBlobId)).max(64),
	})
	.meta({ id: "RowEnvelope" });

export type RowOrigin = z.infer<typeof RowOriginSchema>;
export type OpKey = z.infer<typeof OpKeySchema>;
export type RowKind = z.infer<typeof RowKindSchema>;
export type RowEnvelope = z.infer<typeof RowEnvelopeSchema>;

export function rowEnvelopeSigningBytes(envelope: RowEnvelope): Buffer {
	return Buffer.from(`${SIGNING_TAGS.inboxRow}\n${canonicalJson(envelope)}`, "utf8");
}

export function signRowEnvelope(envelope: RowEnvelope, signPriv: string): string {
	return sign(rowEnvelopeSigningBytes(envelope), signPriv);
}

export function verifyRowEnvelope(envelope: RowEnvelope, signature: string, signPub: string): boolean {
	return verify(rowEnvelopeSigningBytes(envelope), signature, signPub);
}

const inboxRowInputShape = {
	envelope: RowEnvelopeSchema,
	producerSig: b64Field(),
	body: z.unknown(),
};

function refineInboxRowInput(row: z.infer<z.ZodObject<typeof inboxRowInputShape>>, ctx: z.RefinementCtx): void {
	if (typeof row.envelope.epoch === "number" && !ContentEnvelopeSchema.safeParse(row.body).success) {
		ctx.addIssue({ code: "custom", path: ["body"] });
	}
	if (row.envelope.epoch === "peer" && !SealedEnvelopeSchema.safeParse(row.body).success) {
		ctx.addIssue({ code: "custom", path: ["body"] });
	}
	// Only the Router composes clear rows; a producer's clear body would land unopened.
	if (
		row.envelope.epoch === "clear" &&
		(row.envelope.origin.kind !== "router" ||
			(row.envelope.kind !== "board_observation" &&
				row.envelope.kind !== "scheduled_result" &&
				row.envelope.kind !== "op_result" &&
				row.envelope.kind !== "key_request" &&
				row.envelope.kind !== "key_grant") ||
			row.body === null ||
			typeof row.body !== "object" ||
			Array.isArray(row.body))
	) {
		ctx.addIssue({ code: "custom", path: ["body"] });
	}
}

export const InboxRowInputSchema = z
	.object(inboxRowInputShape)
	.superRefine(refineInboxRowInput)
	.meta({ id: "InboxRowInput" });

export const InboxRowSchema = z
	.object({
		...inboxRowInputShape,
		seq: z.number().int().min(1),
		acceptedAt: z.number().int().nonnegative(),
		size: z.number().int().nonnegative(),
	})
	.superRefine(refineInboxRowInput)
	.meta({ id: "InboxRow" });

export type InboxRowInput = z.infer<typeof InboxRowInputSchema>;
export type InboxRow = z.infer<typeof InboxRowSchema>;

export const OwnerOpSchema = z
	.object({
		v: z.literal(1),
		domainId: domainIdField,
		signerSignPub: b64Field(),
		conversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
		device: deviceField,
		opId: opIdField,
		at: z.number().int().nonnegative(),
		nonce: b64Field(),
		op: z.record(z.string(), z.unknown()),
		signature: b64Field(),
	})
	.meta({ id: "OwnerOp" });

export type OwnerOp = z.infer<typeof OwnerOpSchema>;
export type OwnerOpFields = Omit<OwnerOp, "signature">;

export const PlanesReadValueSchema = z
	.object({ kind: z.literal("planes_read"), known: z.record(z.string(), z.number().int().nonnegative()) })
	.meta({ id: "PlanesReadValue" });

export const PlaneReadSchema = z
	.object({ name: z.string(), version: z.number().int().nonnegative(), payload: z.unknown().optional() })
	.meta({ id: "PlaneRead" });

export const PlanesReadResultSchema = z
	.object({
		planes: z.array(PlaneReadSchema),
	})
	.meta({ id: "PlanesReadResult" });

export const GatewayValueOpSchema = z
	.object({
		kind: z.literal("gateway_value"),
		gatewayId: gatewayIdField,
		value: ContentEnvelopeSchema,
	})
	.meta({ id: "GatewayValueOp" });

export type GatewayValueOp = z.infer<typeof GatewayValueOpSchema>;

export function ownerOpSigningBytes(op: OwnerOpFields): Buffer {
	return Buffer.from(
		[
			SIGNING_TAGS.ownerOp,
			op.domainId,
			op.signerSignPub,
			op.conversationId,
			op.device,
			op.opId,
			String(op.at),
			op.nonce,
			sha256Hex(canonicalJson(op.op)),
		].join("\n"),
		"utf8",
	);
}

export function signOwnerOp(fields: OwnerOpFields, signPriv: string): OwnerOp {
	return { ...fields, signature: sign(ownerOpSigningBytes(fields), signPriv) };
}

export function verifyOwnerOp(op: OwnerOp): boolean {
	return verify(ownerOpSigningBytes(op), op.signature, op.signerSignPub);
}

export const OpOutcomeSchema = z.enum([
	"accepted",
	"refused",
	"expired",
	"target_revoked",
	"failed",
	"durability_failure",
	"durability_uncertain",
	"conflict",
]);

export const OpResultEnvelopeSchema = z
	.object({
		opKey: OpKeySchema,
		outcome: OpOutcomeSchema,
		result: z.unknown().optional(),
		seq: z.number().int().min(1).optional(),
		reason: z
			.string()
			.regex(/^[^\r\n]*$/)
			.optional(),
	})
	.meta({ id: "OpResultEnvelope" });

export type OpOutcome = z.infer<typeof OpOutcomeSchema>;
export type OpResultEnvelope = z.infer<typeof OpResultEnvelopeSchema>;

export const OWNER_INBOX_MAX_ROWS = 10_000;
export const OWNER_INBOX_MAX_BYTES = 67_108_864;
export const SESSION_INBOX_MAX_ROWS = 200;
export const GATEWAY_INBOX_MAX_ROWS = 200;
export const INBOX_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONSUMER_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INBOX_ACK_OUTCOMES = ["delivered", "waking", "failed"] as const;
