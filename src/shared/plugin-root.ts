import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

////////////////////////////////
//  Functions & Helpers

/**
 * The directory this project's committed runtime assets sit under: `android/` for the console's
 * vendored markdown parser.
 *
 * Searched rather than counted in `".."`, because the modules that need it run from two depths: their
 * own place under `src/`, and the bundled `dist/main-mcp.js`. A fixed count is right for exactly one.
 *
 * `import.meta.dirname` is deliberately not used to find the starting point. It is undefined before
 * Node 20, bun supports it, and the bundle runs under whatever node the plugin host happens to have,
 * so a module that reads it works from source and throws at import time once bundled.
 */
export function pluginRoot(): string {
	if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
	const here = path.dirname(fileURLToPath(import.meta.url));
	let dir = here;
	for (;;) {
		if (existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		// Nothing above us is a package. Name the module's own directory, the most useful of the misses.
		if (parent === dir) return here;
		dir = parent;
	}
}

/** The directory the running module sits in, safe on every Node version and after bundling. */
export function moduleDir(importMetaUrl: string): string {
	return path.dirname(fileURLToPath(importMetaUrl));
}
