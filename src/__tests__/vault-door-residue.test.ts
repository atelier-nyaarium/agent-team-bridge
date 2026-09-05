import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gatewayRoot = path.resolve(import.meta.dirname, "../gateway");
const DOOR = "router/vaultClient.ts";

function sourcesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? sourcesUnder(full) : entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("vault door residue", () => {
	it("the vault client is the only gateway module that seals or opens a vault field", () => {
		expect(fs.readFileSync(path.join(gatewayRoot, DOOR), "utf8")).toMatch(/vaultAadKind\(/);
		for (const file of sourcesUnder(gatewayRoot)) {
			const relative = path.relative(gatewayRoot, file);
			if (relative === DOOR) continue;
			const source = fs.readFileSync(file, "utf8");
			expect(source, relative).not.toMatch(
				/vaultAadKind|VAULT_(PUBLIC|PRIVATE|VALUE|GATEWAYS|TYPED)_[A-Z_]*KIND/,
			);
		}
	});
});
