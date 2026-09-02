import { z } from "zod";
import { CrossDomainShareTargetSchema } from "./schemasConsoleOp.js";

const sessionTarget = z
	.string()
	.min(7)
	.max(128)
	.regex(/^[^|/\r\n]+\.[^|/\r\n]+\.[^|/\r\n]+\.[^|/\r\n]+$/);
const domainId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[^|/\r\n]+$/);

export const ShareJobLiveParamsSchema = z
	.object({
		incarnation: z.number().int().positive(),
		sessionTarget,
		jobIds: z.array(z.string().min(1).max(128)),
		observedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "ShareJobLiveParams" });

export const UnlinkFrameSchema = z
	.object({
		type: z.literal("unlink"),
		domainId,
	})
	.meta({ id: "UnlinkFrame" });

export const CrossDomainShareValueSchema = z
	.object({ sessionTarget, target: CrossDomainShareTargetSchema })
	.meta({ id: "CrossDomainShareValue" });

export const CrossDomainUnshareValueSchema = z
	.object({ sessionTarget, target: CrossDomainShareTargetSchema })
	.meta({ id: "CrossDomainUnshareValue" });

export const CrossDomainUnlinkValueSchema = z.object({ domainId }).meta({ id: "CrossDomainUnlinkValue" });

export const CrossDomainListSharesValueSchema = z.object({}).meta({ id: "CrossDomainListSharesValue" });

export type ShareJobLiveParams = z.infer<typeof ShareJobLiveParamsSchema>;
export type UnlinkFrame = z.infer<typeof UnlinkFrameSchema>;
