import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR_ENTRIES } from "../gateway/dataDirInventory.js";

const root = path.resolve(import.meta.dirname, "..");
const INVENTORY = "gateway/dataDirInventory.ts";

/** Every way a gateway module creates an entry under DATA_DIR; the capture is the entry's stem. */
const OPENERS: Array<{ pattern: RegExp; entry: (stem: string) => string }> = [
	{ pattern: /openDurable\([^,]+,\s*"([a-z-]+)"/g, entry: (stem) => `${stem}.json` },
	{
		pattern: /new DurableStore\(\s*(?:this\.|deps\.|dirs\.)?dataDir\s*,\s*"([a-z-]+)"/g,
		entry: (stem) => `${stem}.json`,
	},
	{ pattern: /new DurableStore\(\s*path\.join\((?:this\.)?dataDir,\s*"([a-z-]+)"\)/g, entry: (stem) => stem },
	{ pattern: /new BlobStore\(\s*`\$\{dataDir\}\/([a-z-]+)`/g, entry: (stem) => stem },
];

function sourcesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourcesUnder(full);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
	});
}

/** Comments name files too; only code counts. */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("data dir inventory", () => {
	const sources = [...sourcesUnder(path.join(root, "gateway")), ...sourcesUnder(path.join(root, "shared"))]
		.filter((file) => path.relative(root, file) !== INVENTORY)
		.map((file) => ({ file: path.relative(root, file), text: withoutComments(fs.readFileSync(file, "utf8")) }));

	it("every store the gateway opens is in the inventory", () => {
		const opened = new Map<string, string>();
		for (const { file, text } of sources) {
			for (const { pattern, entry } of OPENERS) {
				for (const match of text.matchAll(pattern)) opened.set(entry(match[1]), file);
			}
		}
		expect(opened.size).toBeGreaterThanOrEqual(10);
		for (const [name, file] of opened) expect(DATA_DIR_ENTRIES.has(name), `${name} opened in ${file}`).toBe(true);
	});

	it("every inventory entry is named by code", () => {
		for (const entry of DATA_DIR_ENTRIES) {
			const stem = entry.replace(/\.json$/, "");
			// A store names its file in quotes or at the end of a path template.
			const named = sources.some(({ text }) => new RegExp(`["'\`/]${stem}(\\.json)?["'\`]`).test(text));
			expect(named, entry).toBe(true);
		}
	});
});
