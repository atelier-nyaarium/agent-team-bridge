import { z } from "zod";

////////////////////////////////
//  STTS provider descriptors
//
//  The VRCSTT text-to-speech service exposes one route per provider with a
//  per-provider request body. Rather than compile that database into the
//  Android client, it ships as bundled data (assets/stts-providers.json)
//  validated by this schema on both sides: vitest checks the asset on every
//  push, and the generated Kotlin descriptor type decodes it at runtime.
//
//  Adding or changing a provider is a data edit. The request body is a
//  TEMPLATE: a JSON tree whose string values "$text" and "$voice" are
//  substituted at synthesis time (whole-value match, never string splicing),
//  so nested shapes (ElevenLabs' RequestData, numeric voice_settings) and
//  renamed keys (Uberduck's `speech`) all express as plain data.

////////////////////////////////
//  Schemas

export const SttsVoiceSchema = z
	.object({
		id: z.string().min(1),
		label: z.string().optional(),
	})
	.meta({ id: "SttsVoice" });

export const SttsDefaultsSchema = z
	.object({
		// The voice substituted for "$voice" when the user leaves the field blank.
		voice: z.string(),
	})
	.meta({ id: "SttsDefaults" });

export const SttsProviderSchema = z
	.object({
		// Stable identity (the pref value); equals the legacy enum name (AZURE, ...).
		id: z.string().min(1),
		// Human label for the picker.
		label: z.string().min(1),
		// URL path segment: /TextToSpeech/<path>/{stream,sample}.
		path: z.string().min(1),
		// Whether the provider has a /sample route (else /sample falls back to /stream).
		hasSample: z.boolean(),
		// Audio container, when verified live. Absent = unverified; the player
		// sniffs the bytes regardless, so this is documentation, not a contract.
		container: z.enum(["mp3", "wav-stream"]).optional(),
		// Request-body template (see module header). $text/$voice are substituted.
		request: z.record(z.string(), z.unknown()),
		defaults: SttsDefaultsSchema,
		// Curated, non-exhaustive voice suggestions for the settings field.
		voices: z.array(SttsVoiceSchema),
		// One-line hint shown under the voice field.
		voiceHint: z.string(),
		// Optional caveat (e.g. unverified provider, needs a key).
		note: z.string().optional(),
	})
	.meta({ id: "SttsProvider" });

export const SttsProvidersSchema = z
	.object({
		providers: z.array(SttsProviderSchema),
	})
	.meta({ id: "SttsProviders" });

////////////////////////////////
//  Types

export type SttsVoice = z.infer<typeof SttsVoiceSchema>;
export type SttsProvider = z.infer<typeof SttsProviderSchema>;
export type SttsProviders = z.infer<typeof SttsProvidersSchema>;
