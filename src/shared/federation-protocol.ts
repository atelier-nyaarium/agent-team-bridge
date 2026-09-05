import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { SealedEnvelopeSchema, sign, verify } from "./crypto.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { NOTICE_TITLE_MAX, NoticeTierWireFields } from "./notice.js";
import { BLOB_CHUNK_BYTES } from "./router-protocol.js";
import { isSlug } from "./session-id.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

export { FEDERATION_PROTOCOL_VERSION } from "./router-protocol.js";

const MAX_STORE_KEY_LEN = 512;
const MAX_ADDRESS_LEN = 320;

export const MAX_CROSSDOMAIN_PRESENCE_SESSIONS = 200;

export const CrossDomainPresenceSessionSchema = z
	.object({
		team: z.string().min(1).max(MAX_ADDRESS_LEN),
		gatewayId: z.string().min(1).max(64),
		status: z.enum(["online", "verifying", "available"]),
		kind: z.enum(["devcontainer", "loose"]),
		sessionLabel: z.string().max(64).optional(),
		description: z.string().max(120).optional(),
		lastActive: z.number().int().optional(),
		queueDepth: z.number().int().nonnegative(),
		working: z.boolean().optional(),
		needsLogin: z.boolean().optional(),
	})
	.meta({ id: "CrossDomainPresenceSession" });

export type CrossDomainPresenceSession = z.infer<typeof CrossDomainPresenceSessionSchema>;

export const ReturnRouteSchema = z.object({
	srcGateway: z.string().min(1).max(64),
	srcConversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
	srcSession: z.string().min(1).max(MAX_STORE_KEY_LEN),
});

export const ConsolePushEntrySchema = z.object({
	kind: z.enum(["notice", "peer", "plugin_action", "message", "reply", "sent"]),
	session_id: z.string().min(1).max(MAX_STORE_KEY_LEN),
	from: z.string().min(1).max(MAX_ADDRESS_LEN).optional(),
	to: z.string().min(1).max(MAX_ADDRESS_LEN).optional(),
	...NoticeTierWireFields,
	title: z
		.string()
		.min(1)
		.transform((value) => value.slice(0, NOTICE_TITLE_MAX))
		.optional(),
	body: z.string().optional(),
	status: z.string().optional(),
	opId: z.string().min(1).max(MAX_STORE_KEY_LEN).optional(),
	files: ChannelFilesSchema.optional(),
	pluginId: z
		.string()
		.optional()
		.refine((s) => !s || isSlug(s), "pluginId must be a slug"),
	actionType: z
		.string()
		.optional()
		.refine((s) => !s || isSlug(s), "actionType must be a slug"),
	payload: z.record(z.string(), z.unknown()).optional(),
});

// Federated payloads remain sealed.
export const FederatedOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("send"),
		from: z.string().min(1).max(MAX_ADDRESS_LEN),
		to: z.string().min(1).max(MAX_ADDRESS_LEN),
		body: z.string(),
		files: ChannelFilesSchema.optional(),
		displayLabel: z.string().min(1).max(64).optional(),
		disposition: z.enum(["asking", "informing", "closing"]).optional(),
		returnRoute: ReturnRouteSchema,
	}),
	z.object({ kind: z.literal("list_teams") }),
	z.object({
		kind: z.literal("blob_fetch"),
		blobId: z.string().regex(/^sha256-[0-9a-f]{64}$/),
		offset: z.number().int().nonnegative(),
		length: z.number().int().positive().max(BLOB_CHUNK_BYTES),
	}),
	z.object({ kind: z.literal("wake"), team: z.string().min(1).max(MAX_ADDRESS_LEN) }),
	z.object({
		kind: z.literal("response_push"),
		session_id: z.string().min(1).max(MAX_STORE_KEY_LEN),
		status: z.string().optional(),
		response: z.string().optional(),
		...NoticeTierWireFields,
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		files: ChannelFilesSchema.optional(),
	}),
	z.object({
		kind: z.literal("presence_push"),
		sessions: z.array(CrossDomainPresenceSessionSchema).max(MAX_CROSSDOMAIN_PRESENCE_SESSIONS),
	}),
]);

export const GatewayRelayPayloadSchema = z.object({
	// Relay traffic remains end-to-end sealed.
	sealed: SealedEnvelopeSchema,
});

export const GatewayRelayFrameSchema = z.object({
	type: z.literal("gateway_relay"),
	v: z.number().int().positive(),
	relayId: z.string().min(1).max(128),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	srcDomain: z.string().min(1).max(64).optional(),
	payload: GatewayRelayPayloadSchema,
});

export type ReturnRoute = z.infer<typeof ReturnRouteSchema>;
export type FederatedOp = z.infer<typeof FederatedOpSchema>;
export type FederatedOpKind = FederatedOp["kind"];
export type ConsolePushEntry = z.infer<typeof ConsolePushEntrySchema>;
export type GatewayRelayPayload = z.infer<typeof GatewayRelayPayloadSchema>;
export type GatewayRelayFrame = z.infer<typeof GatewayRelayFrameSchema>;

export const XDomainLinkSchema = z
	.object({
		myOwnerSignPub: z.string().min(1),
		peerOwnerSignPub: z.string().min(1),
		peerDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		peerGatewayId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		peerSignPub: z.string().min(1),
		peerBoxPub: z.string().min(1),
		issuedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLink" });

export const SignedXDomainLinkSchema = z
	.object({
		link: XDomainLinkSchema,
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLink" });

export type XDomainLink = z.infer<typeof XDomainLinkSchema>;
export type SignedXDomainLink = z.infer<typeof SignedXDomainLinkSchema>;

// Fixed-order bytes match the Kotlin twin.
export function xDomainLinkSigningBytes(link: XDomainLink): Buffer {
	return Buffer.from(
		[
			SIGNING_TAGS.xdomainLink,
			link.myOwnerSignPub,
			link.peerOwnerSignPub,
			link.peerDomainId,
			link.peerGatewayId,
			link.peerSignPub,
			link.peerBoxPub,
			String(link.issuedAt),
			link.nonce,
		].join("\n"),
		"utf8",
	);
}

export function signXDomainLink(
	link: XDomainLink,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLink {
	return {
		link,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkSigningBytes(link), ownerSignPrivB64),
	};
}

export function verifyXDomainLink(s: SignedXDomainLink, expectedOwnerSignPubB64: string): boolean {
	// Claimed signer must match owner key.
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainLinkSigningBytes(s.link), s.signature, expectedOwnerSignPubB64);
}

export const XDomainUntrustSchema = z
	.object({
		myOwnerSignPub: z.string().min(1),
		peerOwnerSignPub: z.string().min(1),
		revokedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainUntrust" });

export const SignedXDomainUntrustSchema = z
	.object({
		untrust: XDomainUntrustSchema,
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainUntrust" });

export type XDomainUntrust = z.infer<typeof XDomainUntrustSchema>;
export type SignedXDomainUntrust = z.infer<typeof SignedXDomainUntrustSchema>;

export function xDomainUntrustSigningBytes(u: XDomainUntrust): Buffer {
	// Fixed-order bytes match the Kotlin twin.
	return Buffer.from(
		[SIGNING_TAGS.xdomainUntrust, u.myOwnerSignPub, u.peerOwnerSignPub, String(u.revokedAt), u.nonce].join("\n"),
		"utf8",
	);
}

export function signXDomainUntrust(
	untrust: XDomainUntrust,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainUntrust {
	return {
		untrust,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainUntrustSigningBytes(untrust), ownerSignPrivB64),
	};
}

export function verifyXDomainUntrust(s: SignedXDomainUntrust, expectedOwnerSignPubB64: string): boolean {
	// Only the owner key may withdraw trust.
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainUntrustSigningBytes(s.untrust), s.signature, expectedOwnerSignPubB64);
}
