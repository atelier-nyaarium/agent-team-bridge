import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_OP_KIND_LIST } from "../federation-server/ownerOpRegistry.js";
import { CONSOLE_TOKEN_HEADER, ROUTER_PATHS, SIGNING_TAGS } from "../shared/wire-vocabulary.js";

const root = join(import.meta.dirname, "..");
const kotlinRoot = join(root, "..", "android/app/src/main/java/com/atelier_nyaarium/switchboard");
// httpRouter.ts serves the GATEWAY's own /health, which only spells the Router's path.
const tsExcluded = new Set(["wire-vocabulary.ts", "httpRouter.ts", "index.ts"]);
const schemaFile = (file: string) => file.startsWith("schemas") || file === "router-protocol.ts";
const stringLiteral = (value: string) => new RegExp(`["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);

function filesUnder(directory: string, suffix: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(path, suffix) : entry.name.endsWith(suffix) ? [path] : [];
	});
}

describe("wire vocabulary residue", () => {
	it("keeps protected TypeScript literals in the vocabulary module", () => {
		const files = filesUnder(root, ".ts").filter((file) => {
			const relative = file.slice(root.length + 1);
			return (
				!relative.startsWith("__tests__/") &&
				!relative.startsWith("testing/") &&
				!schemaFile(relative) &&
				!tsExcluded.has(relative.split("/").at(-1)!)
			);
		});
		const values = [
			...Object.values(ROUTER_PATHS).filter((value) => value !== ROUTER_PATHS.root),
			CONSOLE_TOKEN_HEADER,
			...Object.values(SIGNING_TAGS),
		];
		for (const value of values)
			for (const file of files)
				expect(stringLiteral(value).test(readFileSync(file, "utf8")), `${value} remains in ${file}`).toBe(
					false,
				);
	});

	it("keeps protected Kotlin literals in generated protocol references", () => {
		const files = filesUnder(kotlinRoot, ".kt").filter((file) => !file.endsWith("proto/Protocol.kt"));
		const values = [
			...Object.values(ROUTER_PATHS).filter((value) => value !== ROUTER_PATHS.root),
			CONSOLE_TOKEN_HEADER,
			...Object.values(SIGNING_TAGS),
			...OWNER_OP_KIND_LIST,
			"welcome",
			"inbox_rows",
			"plane",
			"refused",
			"pong",
		];
		for (const value of values)
			for (const file of files)
				expect(stringLiteral(value).test(readFileSync(file, "utf8")), `${value} remains in ${file}`).toBe(
					false,
				);
	});

	it("emits each vocabulary value once in Protocol Wire", () => {
		const protocol = readFileSync(join(kotlinRoot, "proto/Protocol.kt"), "utf8");
		const wire = protocol.match(/object Wire \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
		const values = [
			...Object.values(ROUTER_PATHS),
			CONSOLE_TOKEN_HEADER,
			...Object.values(SIGNING_TAGS),
			"Bearer ",
		];
		for (const value of values) {
			const count = [
				...wire.matchAll(
					new RegExp(`const val [A-Z0-9_]+: String = "${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"),
				),
			].length;
			expect(count, `${value} Wire declaration count`).toBe(1);
		}
	});
});
