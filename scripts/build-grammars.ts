#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GRAMMAR_SOURCES, GRAMMARS_DIR, MANIFEST_FILE } from "../src/mcp/references/grammarSources.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Build every tree-sitter grammar wasm from the pinned sources in node_modules.
 *
 * The wasms are COMMITTED and this script is how they are regenerated. Building rather than
 * harvesting the prebuilt wasms several of these packages ship is deliberate: web-tree-sitter's
 * 0.26 line will not load a wasm produced by an older CLI, and a grammar package's own prebuilt was
 * cut whenever its author last released. Building them all with one pinned CLI is the only way the
 * set is known to agree with the runtime that loads it.
 *
 * Run `bun scripts/build-grammars.ts` after changing any pinned version, and commit the result.
 */
function packageVersion(pkg: string): string {
	const manifest = path.join("node_modules", pkg, "package.json");
	return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
}

function build(): void {
	fs.mkdirSync(GRAMMARS_DIR, { recursive: true });

	const grammars: Record<string, { package: string; version: string; bytes: number }> = {};
	for (const source of GRAMMAR_SOURCES) {
		const out = path.join(GRAMMARS_DIR, `${source.id}.wasm`);
		const dir = path.join("node_modules", source.package, source.subdir ?? "");
		process.stderr.write(`[grammars] building ${source.id} from ${dir}\n`);

		const result = spawnSync("bunx", ["tree-sitter", "build", "--wasm", "-o", out, dir], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		if (result.status !== 0) throw new Error(`${source.id}: tree-sitter build exited ${result.status}`);

		grammars[source.id] = {
			package: source.package,
			version: packageVersion(source.package),
			bytes: fs.statSync(out).size,
		};
	}

	// The versions are recorded beside the artifacts because a wasm is opaque: without this there is
	// no way to tell which CLI produced a committed file, which is the one thing that decides whether
	// the runtime can load it.
	fs.writeFileSync(
		MANIFEST_FILE,
		`${JSON.stringify(
			{
				treeSitterCli: packageVersion("tree-sitter-cli"),
				webTreeSitter: packageVersion("web-tree-sitter"),
				grammars,
			},
			null,
			"\t",
		)}\n`,
	);
	process.stderr.write(`[grammars] wrote ${MANIFEST_FILE}\n`);
}

build();
