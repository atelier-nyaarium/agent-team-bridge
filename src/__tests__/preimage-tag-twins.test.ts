import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SIGNING_TAGS } from "../shared/wire-vocabulary.js";

const root = path.resolve(import.meta.dirname, "../..");
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
		const tags = Object.values(SIGNING_TAGS);
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
			KEYENVELOPE_V1: "Key envelope preimages are binary; the content-envelope corpus pins them base64",
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
