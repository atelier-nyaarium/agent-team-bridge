import { z } from "zod";
import { slugField } from "./crypto.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

const targetShape = {
	domainId: slugField(),
	gatewayId: slugField(),
	sessionId: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[^/\r\n]+$/),
};

export const ScheduledTargetSchema = z.object(targetShape).meta({ id: "ScheduledTarget" });

export const ScheduledRecordSchema = z
	.object({
		target: ScheduledTargetSchema,
		fireAt: z.number().int().nonnegative(),
		createdAt: z.number().int().nonnegative(),
		opId: z.string().min(1).max(128),
		sender: z
			.object({ conversationId: z.string().min(1).max(128), device: z.string().min(1).max(64) })
			.meta({ id: "ScheduledSender" }),
		files: z.array(z.string()).max(64),
		body: ContentEnvelopeSchema,
		state: z.enum(["armed", "firing", "fired", "error", "cancelled"]),
		attempts: z.number().int().nonnegative(),
		version: z.number().int().positive(),
	})
	.meta({ id: "ScheduledRecord" });

export const ScheduleSendValueSchema = z
	.object({
		kind: z.literal("schedule_send").meta({ catalog: "owner-op-kind" }),
		target: ScheduledTargetSchema,
		fireAt: z.number().int().nonnegative(),
		opId: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[^/\r\n]+$/),
		files: z.array(z.string()).max(64),
		body: ContentEnvelopeSchema,
		expectedVersion: z.number().int().positive().optional(),
	})
	.meta({ id: "ScheduleSendValue" });

export const ScheduleCancelValueSchema = z
	.object({
		kind: z.literal("schedule_cancel"),
		target: ScheduledTargetSchema,
		expectedVersion: z.number().int().positive(),
	})
	.meta({ id: "ScheduleCancelValue" });

export const ScheduleListValueSchema = z.object({ kind: z.literal("schedule_list") }).meta({ id: "ScheduleListValue" });

export const ScheduledResultRowSchema = z
	.object({
		opId: z.string().min(1).max(128),
		outcome: z.enum(["pending", "sent", "failed"]),
		seq: z.number().int().positive().optional(),
		body: ContentEnvelopeSchema,
	})
	.meta({ id: "ScheduledResultRow" });

export type ScheduledTarget = z.infer<typeof ScheduledTargetSchema>;
export type ScheduledRecord = z.infer<typeof ScheduledRecordSchema>;
export type ScheduleSendValue = z.infer<typeof ScheduleSendValueSchema>;
export type ScheduleCancelValue = z.infer<typeof ScheduleCancelValueSchema>;
export type ScheduledResultRow = z.infer<typeof ScheduledResultRowSchema>;
