import fs from "node:fs";
import os from "node:os";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** Why a file cannot be referenced at all. Every one of these is a hard tool error: the resolution
 * tier degrades, the file tier does not. */
export type FileFailure = "missing" | "unreadable" | "binary" | "sensitive";

export interface LoadedFile {
	/** Path as written in the ref, kept for messages and manifest keys. */
	refPath: string;
	/** Absolute path actually read, after confinement. */
	absolute: string;
	/** UTF-8 text. A UTF-16 source is transcoded, and every coordinate downstream refers to THIS. */
	text: string;
	bytes: number;
}

export type LoadResult = { ok: true; file: LoadedFile } | { ok: false; failure: FileFailure; detail: string };

////////////////////////////////
//  Functions & Helpers

/**
 * Where a ref path points, read the way a shell reads a path: `/x` from the filesystem root, `~/x`
 * from the owner's home, anything else from the project root. `..` is ordinary and normalizes.
 *
 * `~user/x` is deliberately NOT expanded. Half-supporting a shell-ism that resolves to a different
 * account's home is worse than treating it as the literal directory name it also legally is.
 */
function resolveRefPath(projectRoot: string, refPath: string): string {
	if (refPath === "~" || refPath.startsWith("~/")) return path.join(os.homedir(), refPath.slice(1));
	return path.resolve(projectRoot, refPath);
}

/**
 * Whether the bytes are text, and in which encoding.
 *
 * A UTF-16 BOM is checked FIRST: those files are full of NUL bytes, so a UTF-8 sniff would call
 * every one of them binary and refuse a perfectly referenceable source file.
 */
function decodeText(buffer: Buffer): string | null {
	if (buffer.length >= 2) {
		if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
		if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.subarray(2).swap16().toString("utf16le");
	}

	// A NUL is the reliable binary tell; a decoder alone is not, since Buffer.toString happily
	// produces replacement characters for arbitrary bytes rather than reporting failure.
	const head = buffer.subarray(0, 8192);
	if (head.includes(0)) return null;

	const text = buffer.toString("utf8");
	// Round-tripping catches invalid UTF-8 that toString silently replaced.
	return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}

/**
 * Read a referenced file, resolving its path the way a shell would.
 *
 * The project root is the base for a bare path, not a fence: a ref may name anything the session can
 * read, because a snapshot only ever rides a reply to the OWNER's own console, and an author who
 * means to disclose a file can read it and paste it regardless. The one refusal that remains is the
 * secrets guardrail above, and it is loud rather than silent - a skipped ref would leave the author
 * believing the snapshot went out.
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
		buffer = fs.readFileSync(absolute);
	} catch (err) {
		return { ok: false, failure: "unreadable", detail: `${refPath}: ${(err as Error).message}` };
	}

	const text = decodeText(buffer);
	if (text === null) return { ok: false, failure: "binary", detail: `${refPath} is not text` };

	return { ok: true, file: { refPath, absolute, text, bytes: Buffer.byteLength(text, "utf8") } };
}
