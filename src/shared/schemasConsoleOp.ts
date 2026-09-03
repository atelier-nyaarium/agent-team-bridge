import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { SealedEnvelopeSchema } from "./crypto.js";
import { SignedFirstRootSchema } from "./federation-lifecycle.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema } from "./schemasBlob.js";
import {
	BOARD_ATTACHMENTS_MAX,
	BOARD_BATCH_MAX,
	BOARD_BODY_MAX,
	BOARD_RANK_MAX,
	BoardAttachmentSchema,
	BoardEntrySchema,
} from "./schemasBoard.js";
import { EnabledPluginSchema } from "./schemasCapability.js";
import {
	CrossDomainPresenceKnownVersionSchema,
	FocusIntentSchema,
	LinkedPeersVersionSchema,
	PresenceVersionSchema,
	ReadAnchorsVersionSchema,
	TaskBoardVersionSchema,
} from "./schemasPresence.js";

export { SealedEnvelopeSchema } from "./crypto.js";

////////////////////////////////
//  Console relay frames

/** Trusted audience. */
export const CrossDomainShareTargetSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("domain"), domainId: z.string().min(1).max(64) }),
		z.object({ kind: z.literal("everyone_trusted") }),
	])
	.meta({ id: "CrossDomainShareTarget" });

// Long-poll hold ceiling.
export const MAX_POLL_HOLD_MS = 45_000;

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("register"),
			clientVersion: z.string().max(64).optional(),
			clientVariant: z.string().max(16).optional(),
			enabledPlugins: z.array(EnabledPluginSchema).max(64).optional(),
		}),
		z.object({ kind: z.literal("first_root"), firstRoot: SignedFirstRootSchema }),
		z.object({ kind: z.literal("list_teams") }),
		z.object({
			kind: z.literal("send"),
			to: z.string().min(1).max(128),
			domainId: z.string().min(1).max(64).optional(),
			body: z.string().min(1),
			files: ChannelFilesSchema.optional(),
		}),
		z.object({
			kind: z.literal("respond"),
			session_id: z.string().min(1),
			status: z.string().optional(),
			response: z.string().optional(),
			replyAsJson: z.record(z.string(), z.unknown()).optional(),
			files: ChannelFilesSchema.optional(),
		}),
		z.object({
			kind: z.literal("poll"),
			cursor: z.number().int().nonnegative().optional(),
			epoch: z.number().int().nonnegative().optional(),
			holdMs: z.number().int().nonnegative().max(MAX_POLL_HOLD_MS).optional(),
			knownDomainVersion: z.string().optional(),
			knownPresenceVersions: z.array(PresenceVersionSchema).optional(),
			focus: FocusIntentSchema.optional(),
			knownLinkedPeersVersion: LinkedPeersVersionSchema.optional(),
			knownReadAnchorsVersion: ReadAnchorsVersionSchema.optional(),
			knownTaskBoardVersion: TaskBoardVersionSchema.optional(),
			knownCrossDomainPresenceVersions: z.array(CrossDomainPresenceKnownVersionSchema).optional(),
		}),
		z.object({
			kind: z.literal("report_read"),
			team: z.string().min(1).max(128),
			epoch: z.number().int().nonnegative().max(0x7fffffff),
			seq: z.number().int().nonnegative(),
		}),
		z.object({
			kind: z.literal("board_upsert"),
			entries: z.array(BoardEntrySchema).min(1).max(BOARD_BATCH_MAX),
		}),
		z.object({
			kind: z.literal("board_set_state"),
			id: z.string().min(1).max(64),
			state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]),
		}),
		z.object({
			kind: z.literal("board_set_title"),
			id: z.string().min(1).max(64),
			title: z.string().min(1).max(500),
		}),
		// Absent body clears it.
		z.object({
			kind: z.literal("board_set_body"),
			id: z.string().min(1).max(64),
			body: z.string().max(BOARD_BODY_MAX).optional(),
		}),
		z.object({
			kind: z.literal("board_set_attachments"),
			id: z.string().min(1).max(64),
			attachments: z.array(BoardAttachmentSchema).max(BOARD_ATTACHMENTS_MAX),
			supplied: z.array(z.string().min(1).max(128)).max(BOARD_ATTACHMENTS_MAX).optional(),
		}),
		z.object({
			kind: z.literal("board_set_parent"),
			id: z.string().min(1).max(64),
			parent: z.string().min(1).max(64).optional(),
			rank: z.string().min(1).max(BOARD_RANK_MAX),
		}),
		z.object({
			kind: z.literal("board_set_trashed"),
			id: z.string().min(1).max(64),
			trashed: z.boolean(),
		}),
		z.object({
			kind: z.literal("board_set_session"),
			id: z.string().min(1).max(64),
			sessionId: z.string().min(1).max(128).optional(),
		}),
		z.object({
			kind: z.literal("board_remove"),
			ids: z.array(z.string().min(1).max(64)).min(1).max(BOARD_BATCH_MAX),
		}),
		z.object({ kind: z.literal("board_read") }),
		z.object({
			kind: z.literal("peek"),
			target: z.string().min(1).max(128),
			sinceHash: z.string().max(64).optional(),
		}),
		z.object({
			kind: z.literal("tmux_send"),
			target: z.string().min(1).max(128),
			text: z.string().max(4096).optional(),
			key: z.string().max(32).optional(),
			submit: z.boolean().optional(),
		}),
		z.object({
			kind: z.literal("create_session"),
			target: z.string().min(1).max(128),
			sessionName: z.string().min(1).max(64).optional(),
			displayLabel: z.string().min(1).max(64).optional(),
			workdir: z.string().min(1).max(512).optional(),
		}),
		z.object({
			kind: z.literal("reload_plugins"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("forget"),
			target: z.string().min(1).max(128),
			boardDisposition: z.enum(["release", "cancel"]).optional(),
		}),
		z.object({
			kind: z.literal("close_session"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("rename_session"),
			target: z.string().min(1).max(128),
			sessionLabel: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("wake"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("list_dirs"),
			path: z.string().min(1).max(512),
			spawn: z.string().min(1).max(64).optional(),
		}),
		BlobStatOpSchema,
		BlobPutOpSchema,
		BlobGetOpSchema,
		z.object({ kind: z.literal("cross_domain_listen") }),
		z.object({
			kind: z.literal("cross_domain_request"),
			listeningToken: z.string().min(1),
			pin: z.string().min(1),
			requesterOwnerSignPub: z.string().min(1),
			requesterDomainId: z.string().min(1).max(64),
			requesterGatewayId: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("cross_domain_confirm"),
			pin: z.string().min(1),
			mySignedLink: SignedXDomainLinkSchema,
		}),
		z.object({
			kind: z.literal("cross_domain_listen_state"),
			listeningToken: z.string().min(1),
		}),
		z.object({
			kind: z.literal("cross_domain_cancel"),
			listeningToken: z.string().optional(),
			pin: z.string().optional(),
		}),
		z.object({
			kind: z.literal("cross_domain_share"),
			sessionTarget: z.string().min(1).max(128),
			target: CrossDomainShareTargetSchema,
		}),
		z.object({
			kind: z.literal("cross_domain_unshare"),
			sessionTarget: z.string().min(1).max(128),
			target: CrossDomainShareTargetSchema,
		}),
		z.object({ kind: z.literal("cross_domain_list_shares") }),
		z.object({ kind: z.literal("cross_domain_list_peers") }),
		z.object({
			kind: z.literal("cross_domain_unlink"),
			domainId: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("cross_domain_untrust"),
			ownerSignPub: z.string().min(1).max(128),
		}),
	])
	.meta({ id: "ConsoleOp" });

export const DELIVERY_OP_KINDS = new Set([
	"send",
	"respond",
	"peek",
	"tmux_send",
	"rename_session",
	"close_session",
	"forget",
	"wake",
]);

export const VALUE_OP_KINDS = new Set([
	"list_dirs",
	"create_session",
	"blob_stat",
	"blob_put",
	"blob_get",
	"reload_plugins",
	"cross_domain_listen",
	"cross_domain_request",
	"cross_domain_confirm",
	"cross_domain_listen_state",
	"cross_domain_cancel",
	"cross_domain_share",
	"cross_domain_unshare",
	"cross_domain_list_shares",
	"cross_domain_list_peers",
	"cross_domain_unlink",
	"cross_domain_untrust",
]);

////////////////////////////////
//  Console relay frame schema

export const ConsoleRelayFrameSchema = z
	.object({
		type: z.literal("console_relay"),
		v: z.number().int().positive(),
		opId: z.string().min(1).max(128),
		signerSignPub: z.string().min(1),
		targetGateway: z.string().optional(),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "ConsoleRelayFrame" });

////////////////////////////////
//  Console op envelope

export const ConsoleOpEnvelopeSchema = z
	.object({
		v: z.number().int().positive(),
		conversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
		device: z.string().min(1).max(64),
		at: z.number().int().nonnegative(),
		op: ConsoleOpSchema,
	})
	.meta({ id: "ConsoleOpEnvelope" });

////////////////////////////////
//  Mailbox entry schema

export const MailboxEntrySchema = z
	.object({
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
		kind: z.enum(["message", "reply", "notice", "sent", "peer", "plugin_action"]),
		session_id: z.string(),
		from: z.string().optional(),
		to: z.string().optional(),
		dedupeKey: z.string().optional(),
		opId: z.string().optional(),
		title: z.string().optional(),
		summary: z.string().optional(),
		body: z.string().optional(),
		fullSpoken: z.string().optional(),
		status: z.string().optional(),
		files: ChannelFilesSchema.optional(),
		pluginId: z.string().optional(),
		actionType: z.string().optional(),
		payload: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "MailboxEntry" });
