import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Only the assemblers construct the bootstrap values. */
const ROOT = path.resolve(import.meta.dirname, "../..");

const FENCES = [
	{ dir: "src", ext: ".ts", pattern: /new GatewayBootstrap\(/, assembler: "src/gateway/boot.ts" },
	{
		dir: "src",
		ext: ".ts",
		pattern: /new RouterDomainBootstrap\(/,
		assembler: "src/federation-server/routerDomainBootstrap.ts",
	},
	{
		dir: "android/app/src",
		ext: ".kt",
		pattern: /(?<![\w.])PhoneBootstrap\(/,
		assembler: "android/app/src/main/java/com/atelier_nyaarium/switchboard/PhoneBootstrap.kt",
	},
];

function sources(dir: string, ext: string): string[] {
	return fs
		.readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(ext))
		.map((file) => path.join(dir, file));
}

function code(file: string): string {
	return fs
		.readFileSync(path.join(ROOT, file), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe("bootstrap values have one assembler each", () => {
	it.each(FENCES)("$assembler is the only construction site", ({ dir, ext, pattern, assembler }) => {
		const sites = sources(dir, ext).filter((file) => pattern.test(code(file)));
		expect(sites).toEqual([assembler]);
	});
});
