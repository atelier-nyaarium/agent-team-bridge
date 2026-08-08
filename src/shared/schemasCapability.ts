import { z } from "zod";

////////////////////////////////
//  Capability Schema
//
//  One capability a console or the host daemon has enabled. Declared above the
//  register schemas because both of them carry a list of these.

export const EnabledPluginSchema = z
	.object({
		// The manifest's own composite id: `<author>.<content_id>`, or a bare `<content_id>` when
		// authorless (first-party). Dotted, so this cannot reuse the dotless slug field.
		id: z
			.string()
			.min(1)
			.max(129)
			.refine((v) => v.split(".").every((seg) => /^[a-z0-9][a-z0-9-]*$/.test(seg)), "each segment must be a slug")
			.describe("The plugin's globally unique id, as its manifest declares it."),
		// A plugin's guidance is a whole section of an agent's instructions, not a sentence. The
		// first real one shipped at 2304 characters against an earlier 2000 cap, which the wire
		// then refused and the store discarded, so the capability vanished with no error anywhere.
		instructions: z
			.string()
			.max(16_000)
			.optional()
			.describe("Agent-facing usage guidance for this capability, surfaced to the session."),
	})
	.meta({ id: "EnabledPlugin" });

/** What one source says about the ids it alone owns. `known: false` is no opinion, which a consumer
 * must not read as an assertion that the source has nothing. */
export const CapabilitySnapshotSchema = z.object({
	known: z.boolean(),
	capabilities: z.array(EnabledPluginSchema),
	clientVersions: z.array(z.string()),
});

/**
 * What `/capabilities` serves: every source's answer, kept apart.
 *
 * Sections rather than one merged list, because a consumer deciding what to keep from its own last
 * answer has to ask whether the source that owns an id spoke this round. A flattened list cannot
 * answer that, and every attempt to work around it has silently dropped or resurrected a capability.
 *
 * Hand-named fields rather than a map: there are two sources, they are shaped differently, and a
 * third costs one field.
 */
export const CapabilityBundleSchema = z.object({
	console: CapabilitySnapshotSchema,
	daemon: CapabilitySnapshotSchema,
});
