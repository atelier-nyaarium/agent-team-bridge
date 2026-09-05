import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR_ENTRIES } from "../gateway/dataDirInventory.js";

const root = path.resolve(import.meta.dirname, "..");
const INVENTORY = "gateway/dataDirInventory.ts";

function sourcesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourcesUnder(full);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
	});
}

describe("data dir inventory", () => {
	const sources = [...sourcesUnder(path.join(root, "gateway")), ...sourcesUnder(path.join(root, "shared"))]
		.filter((file) => path.relative(root, file) !== INVENTORY)
		.map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") }));

	it("every durable store the gateway opens is in the inventory", () => {
		const opened = new Set<string>();
		for (const { text } of sources) {
			for (const match of text.matchAll(/openDurable\([^,]+,\s*"([a-z-]+)"/g)) opened.add(`${match[1]}.json`);
		}
		expect(opened.size).toBeGreaterThan(0);
		for (const name of opened) expect(DATA_DIR_ENTRIES.has(name), name).toBe(true);
	});

	it("every inventory entry is named by some opener", () => {
		for (const entry of DATA_DIR_ENTRIES) {
			const stem = entry.replace(/\.json$/, "");
			// A store names its file in quotes or at the end of a path template.
			const named = sources.some(({ text }) => new RegExp(`["'\`/]${stem}(\\.json)?["'\`]`).test(text));
			expect(named, entry).toBe(true);
		}
	});
});
