// Verifies the physical node_modules tree against bun.lock: every nested
// node_modules directory must correspond to a "parent/child" resolution key
// in the lock. bun install never prunes nested dirs the lock stopped
// sanctioning, and an unsanctioned dir silently shadows the hoisted (often
// security-override-pinned) version for both tsc and runtime.
//
// Run AFTER `rm -rf node_modules && bun install --frozen-lockfile` (a
// reinstall before the final manifest state just mints new residue).
// Exits 1 listing offenders; exits 0 on a sanctioned tree.
//
//   bun scripts/check-module-residue.ts [repo-root]

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

////////////////////////////////
//  Functions & Helpers

/** Package dir names directly inside a node_modules dir ("@scope/name" counts as one). */
function packageDirs(nodeModulesPath: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (entry.name.startsWith("@")) {
			const scopePath = join(nodeModulesPath, entry.name);
			for (const scoped of readdirSync(scopePath, { withFileTypes: true })) {
				if (scoped.isDirectory()) out.push(`${entry.name}/${scoped.name}`);
			}
		} else {
			out.push(entry.name);
		}
	}
	return out;
}

/** Walk every package under root's node_modules, collecting nested chains like "parent/child" or "a/b/c". */
function collectNestedChains(root: string): string[] {
	const chains: string[] = [];
	const walk = (nodeModulesPath: string, chain: string[]) => {
		for (const pkg of packageDirs(nodeModulesPath)) {
			const pkgPath = join(nodeModulesPath, pkg);
			const inner = join(pkgPath, "node_modules");
			if (existsSync(inner)) walk(inner, [...chain, pkg]);
			if (chain.length > 0) chains.push([...chain, pkg].join("/"));
		}
	};
	const top = join(root, "node_modules");
	if (existsSync(top)) walk(top, []);
	return chains;
}

/** Resolution keys from bun.lock's packages section ("name" and "parent/child" composites). */
function lockKeys(root: string): Set<string> {
	const lock = readFileSync(join(root, "bun.lock"), "utf8");
	const keys = new Set<string>();
	for (const match of lock.matchAll(/^\s{4}"([^"]+)":\s*\[/gm)) {
		keys.add(match[1]);
	}
	return keys;
}

export function lexiconScopeResidue(root: string): string[] {
	const scope = join(root, "node_modules", "@nyaa-lexicon");
	if (!existsSync(scope)) return [];
	const lexiconRoot = realpathSync(join(root, "lexicon"));
	const offenders: string[] = [];
	for (const entry of readdirSync(scope, { withFileTypes: true })) {
		const name = `@nyaa-lexicon/${entry.name}`;
		if (!entry.isSymbolicLink()) {
			offenders.push(name);
			continue;
		}
		let target: string;
		try {
			target = realpathSync(join(scope, entry.name));
		} catch {
			offenders.push(name);
			continue;
		}
		const escaped = relative(lexiconRoot, target);
		if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith("../")) offenders.push(name);
	}
	return offenders;
}

////////////////////////////////
//  Main

function main(): void {
	const root = resolve(process.argv[2] ?? ".");
	if (!existsSync(join(root, "bun.lock"))) {
		console.error(`No bun.lock at ${root}`);
		process.exit(2);
	}

	const keys = lockKeys(root);
	const offenders = [...lexiconScopeResidue(root), ...collectNestedChains(root).filter((chain) => !keys.has(chain))];

	if (offenders.length > 0) {
		console.error(`Unsanctioned nested node_modules residue (no matching bun.lock key):`);
		for (const chain of offenders) console.error(`  ${chain}`);
		console.error(
			`\nFix: rm -rf node_modules && bun install --frozen-lockfile (as the LAST step after manifest changes).`,
		);
		process.exit(1);
	}

	console.log(`node_modules residue check: clean (${keys.size} lock keys, no unsanctioned nesting).`);
}

if (basename(process.argv[1] ?? "") === "check-module-residue.ts") main();
