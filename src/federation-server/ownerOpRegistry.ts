import { z } from "zod";
import { OwnerBlobFetchParamsSchema } from "../shared/router-protocol.js";
import { BoardReadResultSchema, BoardWriteResultSchema, BoardWriteSchema } from "../shared/schemasBoardState.js";
import {
	KeyGrantOpSchema,
	KeyReceiptOpSchema,
	KeyReceiptsReadOpSchema,
	KeyReceiptsReadResultSchema,
	KeyRequestOpSchema,
} from "../shared/schemasContentKey.js";
import {
	GatewayValueOpSchema,
	OpKeySchema,
	OpResultEnvelopeSchema,
	type OwnerOp,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
} from "../shared/schemasInbox.js";
import {
	ScheduleCancelValueSchema,
	ScheduleListValueSchema,
	ScheduleSendValueSchema,
} from "../shared/schemasScheduled.js";
import {
	CrossDomainShareValueSchema,
	CrossDomainUnlinkValueSchema,
	CrossDomainUnshareValueSchema,
} from "../shared/schemasShare.js";
import {
	CapabilitiesReadSchema,
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReadAnchorsReadSchema,
	ReadAnchorsResultSchema,
	ReportReadSchema,
} from "../shared/schemasTier1.js";

/**
 * What the intake does with an operation. `delivery` appends a row and carries its own nonce;
 * `value` changes owner state and waits behind the migration fence; `read` does neither.
 */
export type OwnerOpMutation = "delivery" | "value" | "read";

export interface OwnerOpCatalogEntry<Kind extends string = string, Value extends z.ZodType = z.ZodType> {
	readonly kind: Kind;
	readonly value: Value;
	readonly mutation: OwnerOpMutation;
	/** Absent where the answer is a service union no schema states today. */
	readonly answer?: z.ZodType;
}

const HelloAnswerSchema = z.object({
	opKey: OpKeySchema,
	outcome: z.literal("complete"),
	hello: z.object({ domainId: z.string(), signerSignPub: z.string() }),
});

/** Kind order is the wire catalog order the Kotlin constants follow. */
export const OWNER_OP_CATALOG = [
	{
		kind: "deliver",
		value: z.object({ kind: z.literal("deliver"), address: z.string(), row: z.unknown() }),
		mutation: "delivery",
	},
	{
		kind: "consumer_register",
		value: z.object({
			kind: z.literal("consumer_register"),
			incarnation: z.number().int().nonnegative().optional(),
		}),
		mutation: "read",
	},
	{
		kind: "inbox_read",
		value: z.object({
			kind: z.literal("inbox_read"),
			fromSeq: z.number().int().optional(),
			limit: z.number().int().optional(),
			cursorEpoch: z.number().int().optional(),
		}),
		mutation: "read",
	},
	{
		kind: "inbox_advance",
		value: z.object({
			kind: z.literal("inbox_advance"),
			cursor: z.number().int(),
			cursorEpoch: z.number().int(),
		}),
		mutation: "read",
	},
	{
		kind: "op_result",
		value: z.object({ kind: z.literal("op_result"), conversationId: z.string(), opId: z.string() }),
		mutation: "read",
	},
	{
		kind: "hello",
		value: z.object({ kind: z.literal("hello") }),
		mutation: "read",
		answer: HelloAnswerSchema,
	},
	{ kind: "blob_fetch", value: OwnerBlobFetchParamsSchema, mutation: "read" },
	{ kind: "gateway_value", value: GatewayValueOpSchema, mutation: "read" },
	{
		kind: "planes_read",
		value: PlanesReadValueSchema,
		mutation: "read",
		answer: OpResultEnvelopeSchema.extend({ result: PlanesReadResultSchema }),
	},
	{ kind: "report_read", value: ReportReadSchema, mutation: "value" },
	{ kind: "key_request", value: KeyRequestOpSchema, mutation: "read" },
	{ kind: "key_grant", value: KeyGrantOpSchema, mutation: "read" },
	{ kind: "key_receipt", value: KeyReceiptOpSchema, mutation: "read" },
	{
		kind: "key_receipts_read",
		value: KeyReceiptsReadOpSchema,
		mutation: "read",
		answer: KeyReceiptsReadResultSchema,
	},
	{
		kind: "board_read",
		value: z.object({ kind: z.literal("board_read") }),
		mutation: "read",
		answer: BoardReadResultSchema,
	},
	{
		// The write may ride under `write` or stand alone as the value.
		kind: "board_write",
		value: z.looseObject({ kind: z.literal("board_write"), write: BoardWriteSchema.optional() }),
		mutation: "value",
		answer: BoardWriteResultSchema,
	},
	{ kind: "presence_read", value: z.object({ kind: z.literal("presence_read") }), mutation: "read" },
	{ kind: "schedule_send", value: ScheduleSendValueSchema, mutation: "value" },
	{
		kind: "capabilities_read",
		value: CapabilitiesReadSchema,
		mutation: "read",
		answer: CapabilitySnapshotWireSchema,
	},
	{
		kind: "cursor_translate",
		value: z.object({
			kind: z.literal("cursor_translate"),
			address: z.string().optional(),
			epoch: z.number().optional(),
			seq: z.number().optional(),
		}),
		mutation: "read",
	},
	{ kind: "capabilities_report", value: CapabilitiesReportSchema, mutation: "value" },
	{
		kind: "read_anchors_read",
		value: ReadAnchorsReadSchema,
		mutation: "read",
		answer: ReadAnchorsResultSchema,
	},
	{
		kind: "presence_read_friend",
		value: z.object({ kind: z.literal("presence_read_friend"), toDomainId: z.string() }),
		mutation: "read",
	},
	{ kind: "schedule_cancel", value: ScheduleCancelValueSchema, mutation: "value" },
	{ kind: "schedule_list", value: ScheduleListValueSchema, mutation: "read" },
	{
		kind: "cross_domain_share",
		value: CrossDomainShareValueSchema.extend({ kind: z.literal("cross_domain_share") }),
		mutation: "value",
	},
	{
		kind: "cross_domain_unshare",
		value: CrossDomainUnshareValueSchema.extend({ kind: z.literal("cross_domain_unshare") }),
		mutation: "value",
	},
	{
		kind: "cross_domain_unlink",
		value: CrossDomainUnlinkValueSchema.extend({ kind: z.literal("cross_domain_unlink") }),
		mutation: "value",
	},
	{
		kind: "cross_domain_list_shares",
		value: z.object({ kind: z.literal("cross_domain_list_shares") }),
		mutation: "read",
	},
] as const satisfies readonly OwnerOpCatalogEntry[];

type Catalog = (typeof OWNER_OP_CATALOG)[number];

export type OwnerOpKind = Catalog["kind"];
export type OwnerOpValue<Kind extends OwnerOpKind = OwnerOpKind> = Kind extends OwnerOpKind
	? z.infer<Extract<Catalog, { kind: Kind }>["value"]>
	: never;

/** Verified, admitted, fresh operation. */
export type OwnerOpHandler<Kind extends OwnerOpKind = OwnerOpKind> = (
	op: OwnerOp,
	value: OwnerOpValue<Kind>,
) => unknown | Promise<unknown>;

/** A handler with its kind erased, for the stores that hold many. */
export type ErasedOwnerOpHandler = (op: OwnerOp, value: Record<string, unknown>) => unknown | Promise<unknown>;

const BY_KIND = new Map<string, Catalog>(OWNER_OP_CATALOG.map((entry) => [entry.kind, entry]));

export const OWNER_OP_KIND_LIST: readonly OwnerOpKind[] = OWNER_OP_CATALOG.map((entry) => entry.kind);

type ValueSchemas<Entries extends readonly OwnerOpCatalogEntry[]> = {
	[Index in keyof Entries]: Entries[Index]["value"];
};

/** Every catalogued value schema. Building it refuses an entry whose schema omits its own kind. */
export const OwnerOpValueUnion = z.discriminatedUnion(
	"kind",
	OWNER_OP_CATALOG.map((entry) => entry.value) as unknown as ValueSchemas<typeof OWNER_OP_CATALOG>,
);

/** The catalogued entry a kind names, or null when nothing catalogues it. */
export function ownerOpEntry(kind: string): Catalog | null {
	return BY_KIND.get(kind) ?? null;
}

/** One handler per catalogued kind; an uncatalogued kind has nowhere to land. */
export class OwnerOpRegistry {
	private readonly handlers = new Map<string, ErasedOwnerOpHandler>();

	register<Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>): void {
		if (!BY_KIND.has(kind)) throw new Error(`owner op "${kind}" is not in the catalog`);
		if (this.handlers.has(kind)) throw new Error(`owner op "${kind}" already registered`);
		this.handlers.set(kind, handler as ErasedOwnerOpHandler);
	}

	handler(kind: string): ErasedOwnerOpHandler | null {
		return this.handlers.get(kind) ?? null;
	}
}
