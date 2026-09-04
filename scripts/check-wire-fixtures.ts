import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WireFixtureSchema, WireManifestSchema } from "../src/shared/schemasWireFixture.js";

const expected = path.resolve(import.meta.dirname, "../tests/fixtures/wire/ts");
const kotlin = path.resolve(import.meta.dirname, "../tests/fixtures/wire/kotlin");
// Only these peers replay.
const KOTLIN_PEERS = new Set(["router.handle", "router.upgrade"]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-fixtures-check-"));
const result = spawnSync("bun", ["scripts/gen-wire-fixtures.ts"], {
	cwd: path.resolve(import.meta.dirname, ".."),
	env: { ...process.env, WIRE_FIXTURE_DIR: temp },
	encoding: "utf8",
});
if (result.status !== 0) process.exit(result.status ?? 1);
const files = (dir: string): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? files(full).map((file) => path.join(entry.name, file)) : [entry.name];
	});
const fixtureFiles = (dir: string) => files(dir).filter((file) => file !== "_manifest.json");
const parseTree = (dir: string): string[] => {
	const issues: string[] = [];
	const manifestFile = path.join(dir, "_manifest.json");
	let manifest: ReturnType<typeof WireManifestSchema.parse>;
	try {
		manifest = WireManifestSchema.parse(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
	} catch (error) {
		return [`_manifest.json: ${error instanceof Error ? error.message : String(error)}`];
	}
	const manifestFiles = new Set<string>();
	for (const entry of manifest.fixtures) {
		if (manifestFiles.has(entry.file)) issues.push(`${entry.file}: duplicate manifest entry`);
		manifestFiles.add(entry.file);
		const file = path.join(dir, entry.file);
		if (!fs.existsSync(file)) {
			issues.push(`${entry.file}: manifest file missing`);
			continue;
		}
		try {
			const fixture = WireFixtureSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
			const peer =
				fixture.producer === "ts" && fixture.phone ? "phone" : fixture.producer === "ts" ? "router" : undefined;
			if (fixture.composer !== entry.composer || fixture.case !== entry.case || (peer && peer !== entry.peer))
				issues.push(`${entry.file}: manifest does not match fixture`);
			if (fixture.producer === "kotlin" && !KOTLIN_PEERS.has(entry.peer))
				issues.push(`${entry.file}: peer ${entry.peer} never replays`);
		} catch (error) {
			issues.push(`${entry.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const file of fixtureFiles(dir)) {
		if (!manifestFiles.has(file)) issues.push(`${file}: no manifest entry`);
	}
	return issues;
};
let failed = false;
for (const [label, dir] of [
	["committed", expected],
	["generated", temp],
	["kotlin", kotlin],
] as const) {
	const issues = parseTree(dir);
	for (const issue of issues) console.error(`${label}: ${issue}`);
	if (issues.length) failed = true;
}
const all = [...new Set([...files(expected), ...files(temp)])].sort();
for (const file of all) {
	const left = fs.existsSync(path.join(expected, file)) ? fs.readFileSync(path.join(expected, file)) : null;
	const right = fs.existsSync(path.join(temp, file)) ? fs.readFileSync(path.join(temp, file)) : null;
	if (!left || !right || !left.equals(right)) {
		console.error(file);
		failed = true;
	}
}
fs.rmSync(temp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
