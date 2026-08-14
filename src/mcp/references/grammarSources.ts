import { existsSync } from "node:fs";
import path from "node:path";
import { moduleDir, pluginRoot } from "../../shared/plugin-root.js";

////////////////////////////////
//  Interfaces & Types

/** `subdir` is for a package shipping several grammars. */
export interface GrammarSource {
	/** The wasm basename, and the key everything else uses. */
	id: string;
	package: string;
	subdir?: string;
}

////////////////////////////////
//  Functions & Helpers

/**
 * A file outside this set still resolves, through the fuzzy tier.
 *
 * TSX is its own entry: the grammars disagree on whether `<T>` opens a type assertion or an element.
 */
export const GRAMMAR_SOURCES: GrammarSource[] = [
	{ id: "typescript", package: "tree-sitter-typescript", subdir: "typescript" },
	{ id: "tsx", package: "tree-sitter-typescript", subdir: "tsx" },
	{ id: "javascript", package: "tree-sitter-javascript" },
	{ id: "cpp", package: "tree-sitter-cpp" },
	{ id: "c_sharp", package: "tree-sitter-c-sharp" },
	{ id: "python", package: "tree-sitter-python" },
	{ id: "gdscript", package: "tree-sitter-gdscript" },
];

/** The committed grammar wasms. */
export function grammarsDir(): string {
	return path.join(pluginRoot(), "grammars");
}

/** The build copies it beside the bundle; the package is the source-run fallback. */
export function treeSitterWasmPath(): string {
	const beside = path.join(moduleDir(import.meta.url), "web-tree-sitter.wasm");
	if (existsSync(beside)) return beside;
	return path.join(pluginRoot(), "node_modules", "web-tree-sitter", "web-tree-sitter.wasm");
}

export function manifestFile(): string {
	return path.join(grammarsDir(), "manifest.json");
}

// Explicit, not derived: `.h` is C++ here by convention, not by anything the extension states.
const BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".h": "cpp",
	".c": "cpp",
	".cs": "c_sharp",
	".py": "python",
	".pyi": "python",
	".gd": "gdscript",
};

/** The grammar id for a path, or null when nothing whitelisted parses it. */
export function grammarForPath(filePath: string): string | null {
	return BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

/** The wasm file for a grammar id. */
export function grammarWasmPath(id: string): string {
	return path.join(grammarsDir(), `${id}.wasm`);
}
