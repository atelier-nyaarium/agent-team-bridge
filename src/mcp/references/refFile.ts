import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What may be OPENED. artifactBuilder's cap bounds what is sent. */
const MAX_REF_SOURCE_BYTES = 8_000_000;

////////////////////////////////
//  Interfaces & Types

/** All hard tool errors: the resolution tier degrades, the file tier does not. */
export type FileFailure = "missing" | "unreadable" | "binary";

export interface LoadedFile {
	/** As written, kept for messages and manifest keys. */
	refPath: string;
	absolute: string;
	/** UTF-8. A UTF-16 source is transcoded, and every coordinate downstream refers to THIS. */
	text: string;
	bytes: number;
}

export type LoadResult = { ok: true; file: LoadedFile } | { ok: false; failure: FileFailure; detail: string };

////////////////////////////////
//  Functions & Helpers

/**
 * Shell-style: `/x` from root, `~/x` from home, anything else from the project root.
 *
 * `~user/x` is NOT expanded: half-supporting a shell-ism resolving to another account's home is
 * worse than treating it as the literal directory name it also legally is.
 */
function resolveRefPath(projectRoot: string, refPath: string): string {
	if (refPath === "~" || refPath.startsWith("~/")) return path.join(os.homedir(), refPath.slice(1));
	return path.resolve(projectRoot, refPath);
}

/** A UTF-16 BOM is checked FIRST: those files are full of NULs, which a UTF-8 sniff calls binary. */
function decodeText(buffer: Buffer): string | null {
	if (buffer.length >= 2) {
		if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
		if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.subarray(2).swap16().toString("utf16le");
	}

	// toString never fails, so a NUL is the reliable binary tell.
	const head = buffer.subarray(0, 8192);
	if (head.includes(0)) return null;

	const text = buffer.toString("utf8");
	// Round-tripping catches what toString silently replaced.
	return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}

/**
 * The project root is a base, not a fence: a snapshot only rides a reply to the OWNER's own console,
 * and an author meaning to disclose a file can paste it regardless.
 *
 * Refusals are loud, since a skipped ref would leave the author believing it went out.
 */
export function loadRefFile(projectRoot: string, refPath: string): LoadResult {
	if (refPath === "") return { ok: false, failure: "missing", detail: "a ref needs a path" };

	const root = fs.realpathSync(projectRoot);

	let absolute: string;
	try {
		absolute = fs.realpathSync(resolveRefPath(root, refPath));
	} catch {
		return { ok: false, failure: "missing", detail: `${refPath} does not exist` };
	}

	let buffer: Buffer;
	try {
		const stat = fs.statSync(absolute);
		if (!stat.isFile()) return { ok: false, failure: "unreadable", detail: `${refPath} is not a file` };
		// Sized BEFORE reading, or a huge file is already in memory.
		if (stat.size > MAX_REF_SOURCE_BYTES) {
			return {
				ok: false,
				failure: "unreadable",
				detail: `${refPath} is ${stat.size} bytes, over the ${MAX_REF_SOURCE_BYTES}-byte source limit`,
			};
		}
		buffer = fs.readFileSync(absolute);
	} catch (err) {
		return { ok: false, failure: "unreadable", detail: `${refPath}: ${(err as Error).message}` };
	}

	const text = decodeText(buffer);
	if (text === null) return { ok: false, failure: "binary", detail: `${refPath} is not text` };

	return { ok: true, file: { refPath, absolute, text, bytes: Buffer.byteLength(text, "utf8") } };
}
