import { z } from "zod";
import { CapabilitySnapshotSchema, EnabledPluginSchema } from "./schemasCapability.js";
import { ReadAnchorsVersionSchema, ReadAnchorWireEntrySchema } from "./schemasPresence.js";

export const CapabilitiesReportSchema = z
	.object({
		kind: z.literal("capabilities_report"),
		capabilities: z.array(EnabledPluginSchema).max(500).optional(),
		clientVersion: z.string().max(64).optional(),
	})
	.meta({ id: "CapabilitiesReport" });

export const CapabilitiesReadSchema = z
	.object({ kind: z.literal("capabilities_read") })
	.meta({ id: "CapabilitiesRead" });

export const ReportReadSchema = z
	.object({
		kind: z.literal("report_read"),
		team: z.string().min(1).max(128),
		epoch: z.number().int().nonnegative().max(0x7fffffff),
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "ReportRead" });

export const ReadAnchorsReadSchema = z.object({ kind: z.literal("read_anchors_read") }).meta({ id: "ReadAnchorsRead" });

export const CapabilitySnapshotWireSchema = CapabilitySnapshotSchema.meta({ id: "CapabilitySnapshot" });

export const ReadAnchorsResultSchema = z
	.object({
		version: ReadAnchorsVersionSchema,
		anchors: z.array(ReadAnchorWireEntrySchema),
	})
	.meta({ id: "ReadAnchorsResult" });
