import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const shared = path.join(root, "src/shared");
const kotlin = path.join(root, "android/app/src/main");
const fixtures = path.join(root, "tests/fixtures");

function filesUnder(dir: string, suffix?: string): string[] {
	const result: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) result.push(...filesUnder(file, suffix));
		else if (!suffix || entry.name.endsWith(suffix)) result.push(file);
	}
	return result;
}

describe("shared preimage tags", () => {
	it("has Android and fixture twins", () => {
		const source = filesUnder(shared, ".ts")
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const tags = [...new Set([...source.matchAll(/(?:["'`])([A-Z][A-Z_]*_V1)(?:["'`])/g)].map((m) => m[1]))];
		const kotlinText = filesUnder(kotlin, ".kt")
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const manifest = fs.readFileSync(path.join(fixtures, "_signing-vectors-manifest.json"), "utf8");
		const vectors = filesUnder(fixtures, "vectors.json")
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const allowlist: Record<string, string> = {
			CODEX_AGENT_V1: "Codex delegation is gateway-only",
			COPILOT_AGENT_V1: "Copilot delegation is gateway-only",
			ADMISSION_V1: "Admission vectors predate the shared corpus",
			DEVICE_JOIN_V1: "Device join vectors predate the shared corpus",
			INBOXROW_V1: "Inbox rows have no cross-runtime corpus",
			REGISTER_V1: "Gateway registration is gateway-only",
			REVOCATION_V1: "Revocation vectors predate the shared corpus",
		};
		for (const tag of tags) {
			if (allowlist[tag]) continue;
			expect(kotlinText, tag).toContain(tag);
			expect(manifest + vectors, tag).toContain(tag);
		}
	});
});
