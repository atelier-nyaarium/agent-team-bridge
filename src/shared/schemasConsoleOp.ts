import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema } from "./schemasBlob.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";
import { RunbookSchema } from "./schemasRunbook.js";
import { VaultDecisionSchema } from "./schemasVault.js";

export { SealedEnvelopeSchema } from "./crypto.js";

export const CrossDomainShareTargetSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("domain"), domainId: z.string().min(1).max(64) }),
		z.object({ kind: z.literal("everyone_trusted") }),
	])
	.meta({ id: "CrossDomainShareTarget" });

export const MAX_POLL_HOLD_MS = 45_000;

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
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
			path: z.string().max(512),
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
		// Typed values bind request IDs. A note on a deny steers the asker.
		z.object({
			kind: z.literal("vault_answer"),
			requestId: z.string().min(1).max(128),
			decision: VaultDecisionSchema,
			value: ContentEnvelopeSchema.optional(),
			note: z.string().max(2048).optional(),
		}),
		z.object({ kind: z.literal("vault_grants") }),
		z.object({ kind: z.literal("vault_revoke"), grantId: z.string().min(1).max(128) }),
		z.object({ kind: z.literal("runbook_list") }),
		// Whole record, never a patch.
		z.object({ kind: z.literal("runbook_put"), runbook: RunbookSchema }),
		z.object({ kind: z.literal("runbook_delete"), runbookId: z.string().min(1).max(64) }),
	])
	.meta({ id: "ConsoleOp" });

export const DELIVERY_OP_KINDS = new Set([
	"send",
	"respond",
	"tmux_send",
	"rename_session",
	"close_session",
	"forget",
	"wake",
]);

export const TOLERATED_DELIVERY_OP_KINDS = new Set<string>();

export const VALUE_OP_KINDS = new Set([
	"peek",
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
	"vault_answer",
	"vault_grants",
	"vault_revoke",
	"runbook_list",
	"runbook_put",
	"runbook_delete",
]);

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
