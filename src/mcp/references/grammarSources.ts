import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** One grammar's pinned npm source. `subdir` is for a package shipping several grammars. */
export interface GrammarSource {
	/** The wasm basename, and the key everything else in the reference engine uses. */
	id: string;
	package: string;
	subdir?: string;
}

////////////////////////////////
//  Functions & Helpers

/**
 * The languages the reference engine can resolve a scope chain in. A file outside this set is still
 * referenceable, it just resolves through the fuzzy line-match tier instead of an AST.
 *
 * TSX is its own entry because plain TypeScript cannot parse it: the two grammars disagree on
 * whether `<T>` opens a type assertion or an element, so one cannot stand in for the other.
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

export const GRAMMARS_DIR = path.join(import.meta.dirname, "..", "..", "..", "grammars");

export const MANIFEST_FILE = path.join(GRAMMARS_DIR, "manifest.json");

/**
 * Which grammar parses a given file, by extension. Explicit rather than derived: `.ts` and `.tsx`
 * differ by grammar, not by dialect, and a header like `.h` is C++ here by convention rather than
 * by anything the extension states.
 */
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
	return path.join(GRAMMARS_DIR, `${id}.wasm`);
}
