import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
const ALLOWLIST = new Map([["blob-store.ts", "partial and ingest files are resumable transfer state"]]);
// A rename reached through `fs.` or `fs.promises.` is always a file rename. A bare `rename(` is one
// only when the file imports it from node:fs; otherwise it is a method on some other object, a
// definition of one, or a word in a comment. A module alias other than `fs` is not caught.
const fsRenameCall = new RegExp(["\\bfs\\.(?:promises\\.)?", "rename", "(?:Sync)?\\s*\\("].join(""));
const bareRenameCall = new RegExp(["(?<![.\\w])", "rename", "(?:Sync)?\\s*\\("].join(""));
const importsFsRename =
	/import\s*(?:type\s*)?\{[^}]*\brename(?:Sync)?\b[^}]*\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/;
const tempPattern = new RegExp(["\\.tmp\\.", "\\s*\\$\\{process\\.pid\\}"].join(""));

function hasResidue(source: string): boolean {
	if (tempPattern.test(source) || fsRenameCall.test(source)) return true;
	return importsFsRename.test(source) && bareRenameCall.test(source);
}

describe("atomic write ownership", () => {
	it("has no hand-built atomic writes outside the shared owner", () => {
		const offenders = filesUnder(SRC).filter((file) => {
			// The owner, and this file, whose positive controls spell the offending forms on purpose.
			if (path.basename(file) === "atomic-write.ts" || file === import.meta.filename) return false;
			if (ALLOWLIST.has(path.basename(file))) return false;
			return hasResidue(readFileSync(file, "utf8"));
		});
		expect(offenders).toEqual([]);
	});

	it("matches both the owner pattern and a hand-built offending line", () => {
		const fromFs = 'import { renameSync } from "node:fs";\n';
		expect(hasResidue(["fs.rename", "Sync(temp, target)"].join(""))).toBe(true);
		expect(hasResidue(["await fs.promises.", "rename(temp, target)"].join(""))).toBe(true);
		expect(hasResidue([fromFs, "rename", "Sync(temp, target);"].join(""))).toBe(true);
		expect(hasResidue(["const temp = `", "$", "{file}.tmp.", "$", "{process.pid}`;"].join(""))).toBe(true);
		expect(hasResidue("writeFileAtomic(target, data)")).toBe(false);
		// Some other object's rename, a definition of one, or the word in a comment is not a file rename.
		expect(hasResidue("this.sessionStore.rename(team, label)")).toBe(false);
		expect(hasResidue("\trename(team: string, label: string): string | null {")).toBe(false);
		expect(hasResidue("/** a rename (same conversation) still delivers */")).toBe(false);
	});
});
