import { z } from "zod";
import { b64Field, displayField, SealedEnvelopeSchema } from "./crypto.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

const ConsoleApprovalJoinSchema = z
	.object({
		newSignPub: b64Field(),
		newBoxPub: b64Field(),
		joinSig: b64Field().optional(),
		device: displayField(64).optional(),
	})
	.meta({ id: "ConsoleApprovalJoin" });

export const ConsoleApprovalOpSchema = z
	.discriminatedUnion("step", [
		z.object({ step: z.literal("arm"), approvalId: b64Field(), nonce: b64Field() }),
		z.object({
			step: z.literal("join"),
			approvalId: b64Field(),
			nonce: b64Field(),
			newSignPub: b64Field(),
			newBoxPub: b64Field(),
			joinSig: b64Field().optional(),
			device: displayField(64).optional(),
		}),
		z.object({ step: z.literal("poll"), approvalId: b64Field() }),
		z.object({ step: z.literal("approve"), approvalId: b64Field(), sealed: SealedEnvelopeSchema }),
		z.object({ step: z.literal("fetch"), approvalId: b64Field(), nonce: b64Field() }),
		z.object({ step: z.literal("cancel"), approvalId: b64Field() }),
	])
	.meta({ id: "ConsoleApprovalOp" });

export const ConsoleApprovalResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		join: ConsoleApprovalJoinSchema.optional(),
		sealed: SealedEnvelopeSchema.optional(),
	})
	.meta({ id: "ConsoleApprovalResult" });

export type ConsoleApprovalOp = z.infer<typeof ConsoleApprovalOpSchema>;
export type ConsoleApprovalResult = z.infer<typeof ConsoleApprovalResultSchema>;

export function deviceJoinSigningBytes(
	approvalId: string,
	nonce: string,
	newSignPub: string,
	newBoxPub: string,
): Buffer {
	return Buffer.from([SIGNING_TAGS.deviceJoin, approvalId, nonce, newSignPub, newBoxPub].join("\n"), "utf8");
}
