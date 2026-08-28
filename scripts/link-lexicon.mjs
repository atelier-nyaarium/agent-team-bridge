// Links the lexicon submodule's packages into node_modules/@nyaa-lexicon for tsc and vitest, only
// when they are present: a workspaces entry would fail every consumer whose clone left it empty.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["protocol", "client"];

for (const name of PACKAGES) {
	const source = path.join(ROOT, "lexicon", name);
	if (!existsSync(path.join(source, "package.json"))) continue;

	const scope = path.join(ROOT, "node_modules", "@nyaa-lexicon");
	const link = path.join(scope, name);
	mkdirSync(scope, { recursive: true });
	// existsSync is false on a broken symlink while symlinkSync still throws EEXIST, so remove by lstat.
	try {
		lstatSync(link);
		rmSync(link, { recursive: true, force: true });
	} catch {}
	try {
		symlinkSync(source, link, "dir");
	} catch (error) {
		console.error(
			`link-lexicon: could not link ${link} -> ${source}: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}
	const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
	console.log(`link-lexicon: @nyaa-lexicon/${name}@${manifest.version} -> lexicon/${name}`);
}
