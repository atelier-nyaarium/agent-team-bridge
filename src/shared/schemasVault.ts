import { z } from "zod";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

/** Router stores fields without opening them. */
export const VAULT_FIELD_NAMES = [
	"publicTitle",
	"publicDescription",
	"privateTitle",
	"privateDescription",
	"value",
	"gateways",
] as const;
export type VaultFieldName = (typeof VAULT_FIELD_NAMES)[number];

// Phone loads every entry.
export const MAX_VAULT_ENTRIES_PER_OWNER = 500;
// Bounds live entries and tombstones.
export const MAX_VAULT_RECORDS_PER_OWNER = 2_000;
export const MAX_VAULT_FIELD_B64 = 16_384;
// Long enough for every console to list once.
export const VAULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const entryId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[^/\r\n]+$/);
const revision = z.number().int().nonnegative();
const requestId = z.string().min(1).max(128);

export const VaultCreatedBySchema = z.enum(["phone", "gateway"]).meta({ id: "VaultCreatedBy", catalog: "createdBy" });

/** Tombstones retain identity until swept. */
export const VaultEntryClearSchema = z
	.object({
		id: entryId,
		revision: z.number().int().positive(),
		tombstone: z.boolean(),
		// The vault revision of the write; delta lists key on it.
		changedAt: revision,
		createdBy: VaultCreatedBySchema,
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "VaultEntryClear" });

export const VaultEntrySealedSchema = z
	.object({
		publicTitle: ContentEnvelopeSchema.optional(),
		publicDescription: ContentEnvelopeSchema.optional(),
		privateTitle: ContentEnvelopeSchema.optional(),
		privateDescription: ContentEnvelopeSchema.optional(),
		value: ContentEnvelopeSchema.optional(),
		gateways: ContentEnvelopeSchema.optional(),
	})
	.meta({ id: "VaultEntrySealed" });

export const VaultStoredEntrySchema = z
	.object({ clear: VaultEntryClearSchema, sealed: VaultEntrySealedSchema })
	.meta({ id: "VaultStoredEntry" });

export const titled = (sealed: VaultEntrySealed): boolean =>
	sealed.publicTitle !== undefined || sealed.privateTitle !== undefined;

/** 0 creates; otherwise the revision read against, a tombstone's to revive. */
export const VaultPutSchema = z
	.object({ id: entryId, expectedRevision: revision, sealed: VaultEntrySealedSchema })
	.refine((put) => titled(put.sealed), "a vault entry needs a title")
	.meta({ id: "VaultPut" });

/** `revision` is the vault's; `entry` is the applied entry, or the winner on a conflict. */
export const VaultWriteResultSchema = z
	.object({
		outcome: z.enum(["applied", "conflict", "refused"]).meta({ id: "VaultWriteOutcome", catalog: "outcome" }),
		revision,
		entry: VaultStoredEntrySchema.optional(),
		refusal: z.string().optional(),
	})
	.meta({ id: "VaultWriteResult" });

/** `since` is the revision the delta starts after; 0 is a full list, and an entry absent from it is gone. */
export const VaultListResultSchema = z
	.object({ revision, since: revision, entries: z.array(VaultStoredEntrySchema) })
	.meta({ id: "VaultListResult" });

/** Delta lists include tombstones. */
export const VaultListValueSchema = z
	.object({ kind: z.literal("vault_list"), sinceRevision: revision.optional() })
	.meta({ id: "VaultListValue" });
export const VaultPutValueSchema = z
	.object({ kind: z.literal("vault_put"), put: VaultPutSchema })
	.meta({ id: "VaultPutValue" });
export const VaultDeleteValueSchema = z
	.object({ kind: z.literal("vault_delete"), id: entryId, expectedRevision: z.number().int().positive() })
	.meta({ id: "VaultDeleteValue" });

export const VaultReadParamsSchema = z
	.object({ incarnation: z.number().int().nonnegative(), sinceRevision: revision.optional() })
	.meta({ id: "VaultReadParams" });
export const VaultCreateParamsSchema = z
	.object({ incarnation: z.number().int().nonnegative(), put: VaultPutSchema })
	.meta({ id: "VaultCreateParams" });

/** `window` covers program plus target for 30 minutes; `session` until the session ends. */
export const VaultDecisionSchema = z
	.enum(["once", "window", "session", "deny"])
	.meta({ id: "VaultDecision", catalog: "decision" });

const operation = z.string().trim().min(1).max(512);

/** One run of the program asking: the helper's parent pid and start ticks. A second ask under the same asker is a rejected value. */
const asker = z.string().min(1).max(128).optional();

const requestFields = {
	v: z.literal(1),
	requestId,
	operation,
	shape: z.string().min(1).max(256),
	sessionTarget: z.string().min(1).max(128),
	deadlineAt: z.number().int().nonnegative(),
	asker,
};

/** The `vault:request` payload a phone renders; `typed` asks the owner for a value. */
export const VaultRequestSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("entry"), entryId, ...requestFields }),
		z.object({ kind: z.literal("typed"), ...requestFields }),
	])
	.meta({ id: "VaultRequest" });

/** The `vault:retract` payload: the request settled elsewhere, so the phone drops it. */
export const VaultRetractSchema = z.object({ requestId }).meta({ id: "VaultRetract" });

export const VaultGrantSchema = z
	.object({
		grantId: z.string().min(1).max(128),
		tier: z.enum(["window", "session"]).meta({ id: "VaultGrantTier", catalog: "tier" }),
		entryId: entryId.optional(),
		shape: z.string().max(256).optional(),
		sessionTarget: z.string().min(1).max(128),
		expiresAt: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "VaultGrant" });

export const ConsoleVaultAnswerResultSchema = z
	.object({ ok: z.boolean(), reason: z.string().optional() })
	.meta({ id: "ConsoleVaultAnswerResult" });
export const ConsoleVaultGrantsResultSchema = z
	.object({ grants: z.array(VaultGrantSchema) })
	.meta({ id: "ConsoleVaultGrantsResult" });
export const ConsoleVaultRevokeResultSchema = z
	.object({ revoked: z.boolean() })
	.meta({ id: "ConsoleVaultRevokeResult" });

export const VAULT_REQUEST_DEADLINE_MS = 9 * 60 * 1000;
export const VAULT_WINDOW_MS = 30 * 60 * 1000;
// Whole-session grants cap at eight hours.
export const VAULT_SESSION_GRANT_CAP_MS = 8 * 60 * 60 * 1000;
export const MAX_VAULT_CAPTURE_CHARS = 8_192;
// Under fetch's five-minute silence limit; longer holds re-collect.
export const VAULT_ROUTE_WAIT_CAP_MS = 230_000;

const waitMs = z.number().int().nonnegative().optional();

/** Loopback request shapes. */
export const VaultPublicEntrySchema = z.object({
	id: entryId,
	publicTitle: z.string(),
	publicDescription: z.string().optional(),
	hasValue: z.boolean(),
});
export const VaultSearchRequestSchema = z.object({ query: z.string().max(256).optional() });
export const VaultUseRequestSchema = z.object({ entryId, operation, waitMs });
export const VaultCollectRequestSchema = z.object({ requestId, waitMs });
export const VaultWithdrawRequestSchema = z.object({ requestId });
export const VaultCaptureRequestSchema = z.object({
	publicTitle: z.string().min(1).max(256),
	publicDescription: z.string().max(2048).optional(),
	value: z.string().min(1).max(MAX_VAULT_CAPTURE_CHARS),
});
export const VaultAskpassRequestSchema = z.object({ cmdline: operation, waitMs, asker });
export const VaultApprovedDecisionSchema = z.enum(["once", "window", "session"]);
/** What use, collect, and askpass answer: pending hands back the request; deny and timeout both refuse. */
export const VaultValueAnswerSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("approved"), decision: VaultApprovedDecisionSchema, value: z.string() }),
	z.object({ outcome: z.literal("refused"), reason: z.string() }),
	z.object({ outcome: z.literal("pending"), requestId, deadlineAt: z.number().int().nonnegative() }),
]);

export type VaultEntryClear = z.infer<typeof VaultEntryClearSchema>;
export type VaultEntrySealed = z.infer<typeof VaultEntrySealedSchema>;
export type VaultStoredEntry = z.infer<typeof VaultStoredEntrySchema>;
export type VaultPut = z.infer<typeof VaultPutSchema>;
export type VaultWriteResult = z.infer<typeof VaultWriteResultSchema>;
export type VaultListResult = z.infer<typeof VaultListResultSchema>;
export type VaultDecision = z.infer<typeof VaultDecisionSchema>;
export type VaultRequest = z.infer<typeof VaultRequestSchema>;
export type VaultRetract = z.infer<typeof VaultRetractSchema>;
export type VaultGrant = z.infer<typeof VaultGrantSchema>;
export type VaultPublicEntry = z.infer<typeof VaultPublicEntrySchema>;
export type VaultApprovedDecision = z.infer<typeof VaultApprovedDecisionSchema>;
export type VaultValueAnswer = z.infer<typeof VaultValueAnswerSchema>;
