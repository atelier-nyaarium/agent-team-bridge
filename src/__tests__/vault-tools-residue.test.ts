import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8").split("\n");

describe("vault tools residue", () => {
	it("the tool hands a value only to the child, and never answers one", () => {
		const lines = read("mcp/vault/vaultTools.ts");
		for (const [index, line] of lines.entries()) {
			const at = `vaultTools.ts:${index + 1}`;
			if (line.includes("data.value")) expect(line, at).toContain("deps.run(");
			if (/\bvalue:/.test(line)) expect(/deps\.(run|post)\(/.test(line), at).toBe(true);
		}
	});

	it("the run result carries scrubbed streams and no value", () => {
		const source = read("mcp/vault/vaultRun.ts").join("\n");
		const block = /export interface VaultRunResult \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
		expect(block).toContain("stdout: string");
		expect(block).not.toMatch(/\bvalue\??:/);
	});

	it("the helper writes the value to stdout alone, and its notes never carry it", () => {
		const lines = read("main-vault-askpass.ts");
		expect(lines.some((line) => line.includes("outcome.value"))).toBe(true);
		for (const [index, line] of lines.entries()) {
			const at = `main-vault-askpass.ts:${index + 1}`;
			if (line.includes("outcome.value")) expect(line, at).toContain("process.stdout.write");
			if (line.includes("console.error")) expect(line, at).not.toMatch(/\.value\b/);
		}
	});
});
