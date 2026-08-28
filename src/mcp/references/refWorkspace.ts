// The one owner of where a ref's path lands: the workspace root, the shell rule for a written
// path, and the lexical call of inside or outside. A residue keeps `os.homedir(`, `realpath` and
// `path.resolve` out of every other module under references/.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyWorkspaceRoot, currentHost } from "@nyaa-lexicon/client";
import { normalizeModulePath } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** The root every bare path resolves against, and whether the daemon would serve it. */
export type WorkspaceRoot = { root: string; admitted: true } | { root: string; admitted: false; reason: string };

/** Where a written path lands: a module the index keys by, or a file outside the root. */
export type ClassifiedPath =
	| { kind: "module"; absolute: string; module: string }
	| { kind: "outside"; absolute: string };

////////////////////////////////
//  Functions & Helpers

let captured: WorkspaceRoot | null = null;

function gitToplevel(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out === "" ? null : out;
	} catch {
		return null;
	}
}

/** `REFERENCE_ROOT`, else the git toplevel of the cwd, else the cwd; judged once per process. */
export function workspaceRoot(): WorkspaceRoot {
	if (captured !== null) return captured;
	const root = path.resolve(process.env.REFERENCE_ROOT || gitToplevel(process.cwd()) || process.cwd());
	const admission = classifyWorkspaceRoot(root, currentHost());
	captured = admission.admitted ? { root, admitted: true } : { root, admitted: false, reason: admission.reason };
	return captured;
}

/** Forgets the captured root, so a test can point at a fixture tree. */
export function resetWorkspaceRoot(): void {
	captured = null;
}

/** Shell-style: `/x` from the filesystem root, `~/x` from home, anything else from the root. `~user` stays literal. */
export function absolutePathOf(root: string, written: string): string {
	if (written === "~" || written.startsWith("~/")) return path.join(os.homedir(), written.slice(1));
	return path.resolve(root, written);
}

/** The file's real path, so two spellings of one file ship one snapshot; the name itself when it cannot be read. */
export function identityOf(absolute: string): string {
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/** Lexical, never through links: a tracked link inside the root is still the module the index lists. */
export function classifyPath(root: string, written: string): ClassifiedPath {
	const absolute = absolutePathOf(root, written);
	const relative = path.relative(root, absolute);
	if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		return { kind: "outside", absolute };
	}
	try {
		return { kind: "module", absolute, module: normalizeModulePath(relative.split(path.sep).join("/")) };
	} catch {
		// A name the id grammar cannot spell is outside the index's scope, and still a file.
		return { kind: "outside", absolute };
	}
}
