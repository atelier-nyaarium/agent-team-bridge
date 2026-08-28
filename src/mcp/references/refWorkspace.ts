// The one owner of where a ref's path lands: the workspace root, the shell rule for a written
// path, and the lexical call of inside or outside. A residue keeps `os.homedir(`, `realpath` and
// `path.resolve` out of every other module under references/.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { classifyWorkspaceRoot, currentHost } from "@nyaa-lexicon/client";
import { normalizeModulePath } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** The root every bare path resolves against, and whether the daemon would serve it. */
export type WorkspaceRoot = { root: string; admitted: true } | { root: string; admitted: false; reason: string };

/** What the host said its workspace is; `pending` holds replies until the host has answered. */
type HostRoots =
	| { status: "pending"; settled: Promise<void>; settle: () => void }
	| { status: "settled"; roots: string[] };

////////////////////////////////
//  Constants

/** A host that never answers `roots/list` must not hold every reply; past this, cwd is the root. */
export const HOST_ROOTS_TIMEOUT_MS = 5_000;

/** Where a written path lands: a module the index keys by, or a file outside the root. */
export type ClassifiedPath =
	| { kind: "module"; absolute: string; module: string }
	| { kind: "outside"; absolute: string };

////////////////////////////////
//  Functions & Helpers

let captured: WorkspaceRoot | null = null;

let host: HostRoots = { status: "settled", roots: [] };

/** Called before the host initializes, so a reply that arrives first waits for `setHostRoots`. */
export function expectHostRoots(): void {
	let settle = (): void => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	host = { status: "pending", settled, settle };
	captured = null;
}

/** The host's `roots/list` answer; only `file:` URIs count, and null is a host that declares no roots. */
export function setHostRoots(uris: string[] | null): void {
	const roots: string[] = [];
	for (const uri of uris ?? []) {
		try {
			const parsed = new URL(uri);
			if (parsed.protocol === "file:") roots.push(fileURLToPath(parsed));
		} catch {
			// Not a URI at all: the host's problem, not a root.
		}
	}
	const previous = host;
	host = { status: "settled", roots };
	captured = null;
	if (previous.status === "pending") previous.settle();
}

/** Resolves once the host has answered or been found to declare no roots; immediate outside a host. */
export function hostRootsSettled(): Promise<void> {
	return host.status === "pending" ? host.settled : Promise.resolve();
}

let asked = 0;

/** Asks the host for its workspace once the session is up. No roots capability, or no answer in time, leaves cwd as the root. */
export async function adoptHostRoots(server: Server): Promise<void> {
	if (!server.getClientCapabilities()?.roots) {
		setHostRoots(null);
		return;
	}
	// Only the latest ask may answer: a slow first answer must not overwrite a `list_changed` one.
	const turn = ++asked;
	let uris: string[] | null = null;
	try {
		const { roots } = await server.listRoots(undefined, { timeout: HOST_ROOTS_TIMEOUT_MS });
		uris = roots.map((root) => root.uri);
	} catch (error) {
		console.error(
			`[refs] the host did not answer roots/list: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (turn === asked) setHostRoots(uris);
}

function hostRoot(): string | null {
	return host.status === "settled" ? (host.roots[0] ?? null) : null;
}

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

/** `REFERENCE_ROOT` as written; else the host's first root, else the cwd, each taken to its git toplevel. Judged once. */
export function workspaceRoot(): WorkspaceRoot {
	if (captured !== null) return captured;
	const start = hostRoot() ?? process.cwd();
	const root = path.resolve(process.env.REFERENCE_ROOT || gitToplevel(start) || start);
	const admission = classifyWorkspaceRoot(root, currentHost());
	captured = admission.admitted ? { root, admitted: true } : { root, admitted: false, reason: admission.reason };
	return captured;
}

/** Forgets the captured root and the host's roots, so a test can point at a fixture tree. */
export function resetWorkspaceRoot(): void {
	setHostRoots(null);
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
