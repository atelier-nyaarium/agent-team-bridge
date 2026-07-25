// The single bump ritual for every place this project states its own version.
//
//   bun run bump patch|minor|major        # bump package.json, set it everywhere else
//   bun run bump minor --dry-run          # print what would change, write nothing
//
// package.json is the source of truth. It is the one file that gets BUMPED; every other target is
// SET to whatever it now says, so the targets can never drift apart or be bumped by different
// amounts. Set package.json by hand first if you want a version this arithmetic would not produce.
//
// Two sites DERIVE the version at build time rather than storing a copy: the APK's `versionName`
// reads package.json, and the MCP server declares `packageJson.version`. Those are verified here
// instead of written, so a refactor that hard-codes either one fails this script rather than
// silently shipping a stale version to the marketplace or the board's version chip.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export type BumpKind = "patch" | "minor" | "major";

////////////////////////////////
//  Functions & Helpers

const ROOT = path.join(import.meta.dirname, "..");
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_FIELD_RE = /"version"\s*:\s*"[^"]*"/g;

/** The console's baked-in plugins, whose manifests ship inside the APK. */
const PLUGIN_MANIFEST_DIR = path.join("android", "app", "src", "main", "assets", "plugins");

/** A site that recomputes the version from package.json at build time, named by a string that must
 * still appear in it. The point is not to parse the file, it is to fail the moment somebody
 * replaces the derivation with a literal - which reads as correct right up until the next bump. */
const DERIVED_SITES = [
	{
		file: path.join("android", "app", "build.gradle.kts"),
		needle: 'rootProject.file("../package.json")',
		what: "the APK versionName",
	},
	{
		file: path.join("src", "mcp", "index.ts"),
		needle: "version: packageJson.version",
		what: "the MCP server's declared version",
	},
];

export function nextVersion(current: string, kind: BumpKind): string {
	const parts = SEMVER_RE.exec(current);
	if (!parts) throw new Error(`${current} is not a plain major.minor.patch version`);
	const [major, minor, patch] = parts.slice(1, 4).map(Number);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Rewrite a file's `"version"` field in place, leaving every other byte alone.
 *
 * Textual rather than parse-and-restringify: these files are hand-formatted (tabs, key order that
 * reads top-down), and reformatting all of them on every bump would bury the one line that actually
 * changed. Exactly one occurrence is required - a file with two version fields is one this cannot
 * edit unambiguously, and picking the first would be wrong in a way nobody notices until a release.
 */
export function setVersion(text: string, version: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) {
		throw new Error(`expected exactly one "version" field, found ${found.length}`);
	}
	return text.replace(VERSION_FIELD_RE, `"version": "${version}"`);
}

export function readVersion(text: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) throw new Error(`expected exactly one "version" field, found ${found.length}`);
	return found[0].split('"')[3];
}

/** Every file this script writes: package.json first (it is the one being bumped), then the copies. */
export function versionTargets(root: string): string[] {
	const pluginsDir = path.join(root, PLUGIN_MANIFEST_DIR);
	if (!existsSync(pluginsDir)) {
		throw new Error(`${PLUGIN_MANIFEST_DIR} is gone; this script's target list is out of date`);
	}
	const manifests = readdirSync(pluginsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(PLUGIN_MANIFEST_DIR, entry.name, "manifest.json"))
		.filter((file) => existsSync(path.join(root, file)))
		.sort();
	return [path.join("package.json"), path.join(".claude-plugin", "plugin.json"), ...manifests];
}

/** Throws unless every derived site still recomputes the version from package.json. */
export function checkDerivedSites(root: string): void {
	for (const site of DERIVED_SITES) {
		const text = readFileSync(path.join(root, site.file), "utf8");
		if (text.includes(site.needle)) continue;
		throw new Error(
			`${site.file} no longer derives ${site.what} from package.json (looked for ${site.needle}).\n` +
				`Either restore the derivation or add the file to this script's target list.`,
		);
	}
}

function main(argv: string[]): void {
	const dryRun = argv.includes("--dry-run");
	const kind = argv.find((arg) => !arg.startsWith("-"));
	if (kind !== "patch" && kind !== "minor" && kind !== "major") {
		console.error("usage: bun run bump [--dry-run] patch|minor|major");
		process.exit(2);
	}

	// Before writing anything: a broken derivation means the bump would be incomplete, and half a
	// bump is worse than none (the marketplace updates, the running server reports the old version).
	checkDerivedSites(ROOT);

	const targets = versionTargets(ROOT);
	const current = readVersion(readFileSync(path.join(ROOT, targets[0]), "utf8"));
	const next = nextVersion(current, kind);

	for (const target of targets) {
		const file = path.join(ROOT, target);
		const text = readFileSync(file, "utf8");
		const was = readVersion(text);
		if (!dryRun) writeFileSync(file, setVersion(text, next));
		console.log(`${dryRun ? "would set" : "set"} ${target}: ${was} -> ${next}`);
	}

	for (const site of DERIVED_SITES) console.log(`derives ${site.what} from package.json: ${site.file}`);

	if (dryRun) console.log(`\ndry run: nothing written. ${current} -> ${next}`);
	else console.log(`\n${current} -> ${next}. Commit, push, then reload plugins.`);
}

////////////////////////////////
//  Main

if (path.basename(process.argv[1] ?? "") === "bump-version.ts") main(process.argv.slice(2));
