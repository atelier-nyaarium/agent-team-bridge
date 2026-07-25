import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** Why a file cannot be referenced at all. Every one of these is a hard tool error: the resolution
 * tier degrades, the file tier does not. */
export type FileFailure = "missing" | "unreadable" | "binary" | "escapes-project";

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
 * Whether a ref path may be joined to the project root at all, judged BEFORE touching the disk.
 *
 * Absolute paths and `..` are rejected outright rather than normalized, because normalizing accepts
 * a path whose written form already said it wanted out. The realpath check below is the second
 * layer, for the escape a path alone cannot show (a symlink).
 */
function isJoinable(refPath: string): boolean {
	if (refPath === "" || path.isAbsolute(refPath) || /^[a-zA-Z]:/.test(refPath)) return false;
	return !refPath.split(/[/\\]/).includes("..");
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
 * Read a referenced file, confined to the project root.
 *
 * Confinement is not a nicety here. Refs are scanned out of a full message body, and a message can
 * carry text relayed from somewhere else, so an unconfined resolver would be a way to make an agent
 * attach any file its process can read. An escape is therefore a hard error, never a silent skip:
 * a skip would leave the agent believing the snapshot went out.
 */
export function loadRefFile(projectRoot: string, refPath: string): LoadResult {
	if (!isJoinable(refPath)) {
		return { ok: false, failure: "escapes-project", detail: `${refPath} is not a project-relative path` };
	}

	const root = fs.realpathSync(projectRoot);
	const joined = path.resolve(root, refPath);

	let absolute: string;
	try {
		absolute = fs.realpathSync(joined);
	} catch {
		return { ok: false, failure: "missing", detail: `${refPath} does not exist` };
	}

	// After realpath, so a symlink pointing out of the project is caught by where it LANDS rather
	// than by how it was spelled. The separator guard stops a sibling directory sharing the root's
	// name prefix from passing.
	if (absolute !== root && !absolute.startsWith(root + path.sep)) {
		return { ok: false, failure: "escapes-project", detail: `${refPath} resolves outside the project` };
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
