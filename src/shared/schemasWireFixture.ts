import { z } from "zod";

export const WireFrameSchema = z
	.object({ name: z.string().min(1), params: z.record(z.string(), z.unknown()) })
	.meta({ id: "WireFrame" });

export const WireRequestSchema = z
	.object({
		method: z.string().min(1),
		path: z.string().min(1),
		headers: z.record(z.string(), z.string()),
		body: z.string(),
	})
	.meta({ id: "WireRequest" });

/** One sealed envelope the peer must open. */
export const WireSealedSchema = z
	.object({
		/** Dotted path from the sealed root: `frame.params` (TS), `inputs.op` (Kotlin). */
		path: z.string().min(1),
		/** AAD kind, or `key` for a key envelope. */
		aadKind: z.string().min(1),
		/** Plaintext class name. */
		decodeAs: z.string().min(1).optional(),
		/** Input the plaintext must equal. */
		plaintextOf: z.string().min(1).optional(),
		/** Subset the opened JSON must match. */
		expectJson: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "WireSealed" });

export const WirePhoneDecodeSchema = z
	.object({ decodeAs: z.string().min(1), sealed: z.array(WireSealedSchema) })
	.meta({ id: "WirePhoneDecode" });

const wireBase = {
	composer: z.string().min(1),
	case: z.string().min(1),
	clock: z.number().int().nonnegative(),
	inputs: z.record(z.string(), z.unknown()),
	/** Peer answer subset. */
	expect: z.record(z.string(), z.unknown()),
};

export const WireFixtureTsSchema = z.object({
	producer: z.literal("ts"),
	...wireBase,
	frame: WireFrameSchema,
	phone: WirePhoneDecodeSchema.optional(),
});

export const WireFixtureKotlinSchema = z.object({
	producer: z.literal("kotlin"),
	...wireBase,
	request: WireRequestSchema,
	sealed: z.array(WireSealedSchema).optional(),
});

export const WireFixtureSchema = z
	.discriminatedUnion("producer", [WireFixtureTsSchema, WireFixtureKotlinSchema])
	.meta({ id: "WireFixture" });

export const WireFixtureEntrySchema = z
	.object({
		file: z.string().min(1),
		composer: z.string().min(1),
		case: z.string().min(1),
		peer: z.enum(["router", "phone", "router.handle", "router.upgrade"]),
	})
	.meta({ id: "WireFixtureEntry" });

export const WireManifestSchema = z
	.object({ _comment: z.string(), fixtures: z.array(WireFixtureEntrySchema) })
	.meta({ id: "WireManifest" });

export type WireFrame = z.infer<typeof WireFrameSchema>;
export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WirePhoneDecode = z.infer<typeof WirePhoneDecodeSchema>;
export type WireSealed = z.infer<typeof WireSealedSchema>;
export type WireFixture = z.infer<typeof WireFixtureSchema>;
export type WireFixtureEntry = z.infer<typeof WireFixtureEntrySchema>;
export type WireManifest = z.infer<typeof WireManifestSchema>;
