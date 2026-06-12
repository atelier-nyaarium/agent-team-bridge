import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SttsProvidersSchema } from "../shared/stts-providers.js";

////////////////////////////////
//  Bundled STTS descriptor data
//
//  The asset ships in the APK but is schema-checked here on every push, so a
//  malformed provider edit fails CI instead of breaking Play silently on the
//  phone. Also asserts the template invariant the substitution engine relies
//  on: each request carries exactly one "$text" somewhere.

const ASSET = path.join(__dirname, "../../android/app/src/main/assets/stts-providers.json");

function countPlaceholder(node: unknown, marker: string): number {
	if (node === marker) return 1;
	if (Array.isArray(node)) return node.reduce<number>((sum, v) => sum + countPlaceholder(v, marker), 0);
	if (node && typeof node === "object") {
		return Object.values(node).reduce<number>((sum, v) => sum + countPlaceholder(v, marker), 0);
	}
	return 0;
}

describe("stts-providers.json", () => {
	const raw = JSON.parse(fs.readFileSync(ASSET, "utf8"));
	const parsed = SttsProvidersSchema.parse(raw);

	it("validates against the descriptor schema", () => {
		expect(parsed.providers.length).toBeGreaterThan(0);
	});

	it("has unique provider ids", () => {
		const ids = parsed.providers.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("each request template carries exactly one $text", () => {
		for (const p of parsed.providers) {
			expect(countPlaceholder(p.request, "$text"), `provider ${p.id}`).toBe(1);
		}
	});

	it("each request template carries exactly one $voice", () => {
		for (const p of parsed.providers) {
			expect(countPlaceholder(p.request, "$voice"), `provider ${p.id}`).toBe(1);
		}
	});

	it("ships the default Azure provider", () => {
		expect(parsed.providers.some((p) => p.id === "AZURE")).toBe(true);
	});
});
