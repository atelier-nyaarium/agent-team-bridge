// Normalize each provider's native voice-list export into the bundled STTS
// catalog (android/app/src/main/assets/stts-providers.json). Each TTS provider
// publishes its voice catalog in its OWN shape, so there is no single format to hand-transcribe ids
// from. Instead, drop a provider's raw export into data/stts-voices/<provider>.json and run this
// script: it maps the
// native shape to the catalog's { id, label } voices, in place, leaving every
// other descriptor field untouched.
//
// Refresh flow:
//   1. Fetch the provider's voice list (its native list endpoint) into
//      data/stts-voices/<provider>.json, replacing the old file verbatim.
//   2. bun scripts/import-stts-voices.ts
//   3. Commit the updated data file and stts-providers.json together.
//
// Determinism matters: CI re-runs this and fails on any diff, so the committed
// catalog always matches the source dumps. Providers without a dump file
// (ElevenLabs, Uberduck, xAI) keep their hand-curated voices.

import fs from "node:fs";
import path from "node:path";
import { SttsProvidersSchema, type SttsVoice } from "../src/shared/stts-providers.js";

////////////////////////////////
//  Interfaces & Types

interface VoiceAdapter {
	// Source dump under data/stts-voices/, and the map to { id, label }.
	file: string;
	map: (raw: unknown[]) => SttsVoice[];
}

////////////////////////////////
//  Functions & Helpers

const DATA_DIR = path.join(import.meta.dir, "../data/stts-voices");
const ASSET = path.join(import.meta.dir, "../android/app/src/main/assets/stts-providers.json");

// en-US first, then other English locales, then everything else by locale, then
// by id. Puts the most likely picks at the top and is stable for the drift check.
function localeRank(locale: string | undefined): number {
	if (locale?.startsWith("en-US")) return 0;
	if (locale?.startsWith("en")) return 1;
	return 2;
}

function sortVoices(voices: Array<SttsVoice & { locale?: string }>): SttsVoice[] {
	return [...voices]
		.sort((a, b) => {
			const rank = localeRank(a.locale) - localeRank(b.locale);
			if (rank !== 0) return rank;
			const loc = (a.locale ?? "").localeCompare(b.locale ?? "");
			if (loc !== 0) return loc;
			return a.id.localeCompare(b.id);
		})
		.map(({ id, label }) => (label ? { id, label } : { id }));
}

function joinLabel(name: string, ...parts: Array<string | undefined>): string {
	const detail = parts.filter((p): p is string => !!p && p.length > 0).join(", ");
	return detail ? `${name} (${detail})` : name;
}

const ADAPTERS: Record<string, VoiceAdapter> = {
	IBM: {
		file: "ibm.json",
		map: (raw) => {
			const rows = raw as Array<Record<string, string>>;
			return sortVoices(
				rows.map((v) => {
					// The friendly name leads the description ("Lisa: American English...").
					const friendly = v.description?.split(":")[0]?.trim() || v.name;
					return { id: v.name, label: joinLabel(friendly, v.language, v.gender), locale: v.language };
				}),
			);
		},
	},
	OPENAI: {
		file: "openai.json",
		// The export repeats the same handful of voices once per language; collapse
		// to the distinct voice ids.
		map: (raw) => {
			const rows = raw as Array<Record<string, string>>;
			const byId = new Map<string, SttsVoice>();
			for (const v of rows) {
				if (!byId.has(v.Id)) byId.set(v.Id, { id: v.Id, label: v.Name || v.Id });
			}
			return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
		},
	},
};

////////////////////////////////
//  Main

function main(): void {
	const catalog = SttsProvidersSchema.parse(JSON.parse(fs.readFileSync(ASSET, "utf8")));
	const summary: string[] = [];

	for (const provider of catalog.providers) {
		const adapter = ADAPTERS[provider.id];
		if (!adapter) continue; // hand-curated provider, leave its voices alone
		const dumpPath = path.join(DATA_DIR, adapter.file);
		if (!fs.existsSync(dumpPath)) {
			throw new Error(`missing voice dump for ${provider.id}: ${dumpPath}`);
		}
		const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
		if (!Array.isArray(dump)) throw new Error(`${adapter.file} is not a JSON array`);
		provider.voices = adapter.map(dump);
		summary.push(`${provider.id}: ${provider.voices.length} voices`);
	}

	// Re-validate the whole catalog (the imported voices must satisfy the schema)
	// before writing, so a bad adapter fails here instead of in CI or on the phone.
	const out = SttsProvidersSchema.parse(catalog);
	fs.writeFileSync(ASSET, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`[import-stts-voices] wrote ${ASSET}`);
	for (const line of summary) console.log(`  ${line}`);
}

main();
