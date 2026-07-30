import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cleanupTmpDir } from "../../shared/tmp-files.js";
import type { ChannelFile } from "../../shared/types.js";
import { MANIFEST_FILENAME } from "../references/artifactNames.js";

////////////////////////////////
//  Interfaces & Types

export interface MaterializeFilesParams {
	discordMessageId: string;
	files: ChannelFile[];
}

export interface MaterializedFile {
	descriptiveKey: string;
	path?: string;
}

export interface RenderFilesBlockParams {
	discordMessageId?: string;
	files: MaterializedFile[];
}

////////////////////////////////
//  Constants

export const EVIE_FILES_DIR = "/tmp/evie-files";
export const EVIE_FILES_TTL_MS = 60 * 60 * 1000;

const MAX_LEAF_BYTES = 200;
// Discord caps a message at 10 attachments; this bound is generous.
const MAX_COLLISION_SUFFIX = 50;

////////////////////////////////
//  Functions & Helpers

/**
 * Sanitize a Discord-supplied filename into a safe leaf: basename only (defangs
 * traversal), no leading dots or ASCII control chars, unicode and spaces kept.
 * Capped at 200 bytes (UTF-8) so ext4 / tmpfs accept it.
 */
export function safeFilename(name: string): string {
	let safe = name.split(/[/\\]/).pop() ?? "";
	safe = safe.replace(/^\.+/, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping is the point
	safe = safe.replace(/[\x00-\x1f\x7f]/g, "");
	if (!safe) safe = "file";

	while (Buffer.byteLength(safe, "utf8") > MAX_LEAF_BYTES) {
		safe = safe.slice(0, -1);
	}
	return safe;
}

/**
 * Materialize Discord-bridge files to /tmp/evie-files/<discordMessageId>/.
 * Files with a `base64` payload are written via tmp + atomic rename; files
 * without it pass through as metadata-only so the renderer lists them with no
 * `-> /path`. Expired buckets are swept at entry.
 */
export function materializeFiles({ discordMessageId, files }: MaterializeFilesParams): MaterializedFile[] {
	mkdirSync(EVIE_FILES_DIR, { recursive: true });
	cleanupTmpDir({ dir: EVIE_FILES_DIR, maxAgeMs: EVIE_FILES_TTL_MS, mode: "dirs" });

	// safeFilename is a no-op for real Discord snowflakes (pure digits) but stops
	// a non-Discord id (tests, future origins) from escaping EVIE_FILES_DIR via path.join.
	const bucket = join(EVIE_FILES_DIR, safeFilename(discordMessageId));
	const claimedLeaves = new Set<string>();
	const out: MaterializedFile[] = [];

	for (const file of files) {
		const meta: MaterializedFile = {
			descriptiveKey: file.descriptiveKey,
		};

		if (file.base64) {
			try {
				mkdirSync(bucket, { recursive: true });
				const targetPath = resolveCollisionFreePath(bucket, file.filename, claimedLeaves);
				writeAtomic(targetPath, Buffer.from(file.base64, "base64"));
				meta.path = targetPath;
			} catch (err) {
				console.error(
					`[evie-files] failed to materialize "${file.filename}" for msg ${discordMessageId}: ${(err as Error).message}`,
				);
			}
		}

		out.push(meta);
	}

	return out;
}

/**
 * Drop `ref://` snapshot artifacts from a file list.
 *
 * Snapshots exist so a console can render a code viewer, and they ride every reply whose author
 * wrote a ref, regardless of who is receiving it. An agent reads paths off disk instead, so
 * materializing them would hand it source copies it never asked for.
 *
 * The split is POSITIONAL, not by content: `appendRefArtifacts` emits the author's own attachments
 * first and then its artifacts, manifest first, so the reserved name marks where generated files
 * begin. Reading the manifest instead would mean trusting a remote sender's JSON to say which of
 * its own files are real, and a genuine attachment that happened to be a captured manifest would
 * delete itself and everything it named. `assertNotReservedName` refuses the name in every producer
 * of an outbound ChannelFile, which is what makes the position trustworthy. Works on a stored
 * payload too, where the bytes have been stripped and there is nothing to parse.
 */
export function dropReferenceArtifacts(files: ChannelFile[]): ChannelFile[] {
	const start = files.findIndex((f) => f.filename === MANIFEST_FILENAME);
	return start === -1 ? files : files.slice(0, start);
}

/**
 * Render the unified [FILES] sentinel block for the channel notification.
 * Materialized entries get `-> /path`; metadata-only entries do not.
 */
export function renderFilesBlock({ discordMessageId, files }: RenderFilesBlockParams): string {
	if (files.length === 0) return "";

	const opener = discordMessageId ? `[FILES messageId="${discordMessageId}"]` : `[FILES]`;
	// Console files always arrive with bytes and are materialized. A metadata-only
	// entry (no bytes) has no re-fetch path, so it is surfaced as not-transferred.
	const hasMetadataOnly = files.some((f) => !f.path);
	const instruction = hasMetadataOnly
		? `*Files with \`-> /path\` are on disk; Read them. Entries without a path were not transferred.*`
		: `*Files with \`-> /path\` are on disk; Read them.*`;
	const lines = files.map((f, i) => {
		// descriptiveKey is sender-supplied and this block is line-structured, so a newline in it
		// would let a filename forge entries or an early [/FILES] terminator.
		const head = `${i + 1}. ${f.descriptiveKey.replace(/[\r\n]+/g, " ")}`;
		return f.path ? `${head} -> \`${f.path}\`` : head;
	});

	return `${opener}\n${instruction}\n${lines.join("\n")}\n[/FILES]`;
}

function resolveCollisionFreePath(bucket: string, requestedLeaf: string, claimedLeaves: Set<string>): string {
	const safe = safeFilename(requestedLeaf);
	const ext = extname(safe);
	const base = ext ? safe.slice(0, safe.length - ext.length) : safe;

	for (let suffix = 0; suffix < MAX_COLLISION_SUFFIX; suffix++) {
		const candidate = suffix === 0 ? safe : `${base}-${suffix + 1}${ext}`;
		const path = join(bucket, candidate);
		if (!claimedLeaves.has(candidate) && !existsSync(path)) {
			claimedLeaves.add(candidate);
			return path;
		}
	}

	throw new Error(`Too many collisions resolving safe filename for "${requestedLeaf}"`);
}

/**
 * Write to <target>.tmp.<pid> then rename. Rename is atomic on POSIX, so
 * concurrent host MCP processes handling the same channel_push converge on
 * identical bytes at the target; last rename wins.
 */
function writeAtomic(targetPath: string, buffer: Buffer): void {
	const tmpPath = `${targetPath}.tmp.${process.pid}`;
	writeFileSync(tmpPath, buffer);
	renameSync(tmpPath, targetPath);
}
