import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { extname, join } from "node:path";
import { cleanupTmpDir } from "../../shared/tmp-files.js";
import type { ChannelFile } from "../../shared/types.js";
import { downloadBlob } from "../blobTransfer.js";

////////////////////////////////
//  Interfaces & Types

export interface MaterializeFilesParams {
	discordMessageId: string;
	files: ChannelFile[];
}

export interface MaterializedFile {
	descriptiveKey: string;
	path?: string;
	/** Both lack a path; only this one is worth retrying. */
	fetchFailed?: boolean;
	/** Printed beside the entry when it is not an ordinary attachment. */
	role?: string;
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
// Wider than any filesystem's granularity, far narrower than a clamp.
const MTIME_GRANULARITY_TOLERANCE_MS = 2_000;
const MAX_COLLISION_SUFFIX = 50;

////////////////////////////////
//  Functions & Helpers

/** Basename only, so traversal is defanged. Unicode and spaces are kept. */
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
 * Land an inbound message's files under /tmp/evie-files/<discordMessageId>/.
 *
 * Bytes stream a chunk at a time and are copied by the kernel, so any size costs fixed heap. A file
 * naming no bytes passes through as metadata-only. Expired buckets are swept at entry.
 */
export async function materializeFiles({
	discordMessageId,
	files,
}: MaterializeFilesParams): Promise<MaterializedFile[]> {
	mkdirSync(EVIE_FILES_DIR, { recursive: true });
	cleanupTmpDir({ dir: EVIE_FILES_DIR, maxAgeMs: EVIE_FILES_TTL_MS, mode: "dirs" });

	// A no-op for a snowflake, but stops another origin's id escaping via path.join.
	const bucket = join(EVIE_FILES_DIR, safeFilename(discordMessageId));
	const claimedLeaves = new Set<string>();
	const out: MaterializedFile[] = [];

	for (const file of files) {
		const meta: MaterializedFile = {
			descriptiveKey: file.descriptiveKey,
			...(file.role && file.role !== "attachment" ? { role: file.role } : {}),
		};

		// Presence, not truthiness: a zero-byte file still has to land.
		if (file.blobId !== undefined) {
			try {
				const source = await downloadBlob(file.blobId, file.blobGateway);
				mkdirSync(bucket, { recursive: true });
				const targetPath = resolveCollisionFreePath(bucket, file.filename, claimedLeaves);
				landAtomic(targetPath, (tmpPath) => copyFileSync(source, tmpPath));
				meta.path = targetPath;
				restoreModifiedAt(targetPath, file.modifiedAt);
			} catch (err) {
				// Collapsing this with metadata-only would abandon a recoverable transfer.
				meta.fetchFailed = true;
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
 * Snapshots exist for a console's code viewer; an agent reads paths off disk instead.
 *
 * A KNOWN-SET drop, never "anything with a role": a design card must still materialize, and an
 * unknown future role must fail toward showing.
 */
export function dropReferenceArtifacts(files: ChannelFile[]): ChannelFile[] {
	return files.filter((f) => f.role !== "ref-snapshot");
}

/** Materialized entries get `-> /path`; the rest say why they have none. */
export function renderFilesBlock({ discordMessageId, files }: RenderFilesBlockParams): string {
	if (files.length === 0) return "";

	const opener = discordMessageId ? `[FILES messageId="${discordMessageId}"]` : `[FILES]`;
	// Two separate notes: the agent's next move differs, and one sentence for both loses the
	// recoverable case.
	const failed = files.some((f) => !f.path && f.fetchFailed);
	const missing = files.some((f) => !f.path && !f.fetchFailed);
	const notes = [
		failed ? "Entries marked (fetch failed) were sent but could not be retrieved; ask for a re-send." : null,
		missing ? "Entries without a path carried no bytes." : null,
	].filter(Boolean);
	const instruction = `*Files with \`-> /path\` are on disk; Read them.${notes.length ? ` ${notes.join(" ")}` : ""}*`;
	const lines = files.map((f, i) => {
		// A sender-supplied newline would forge entries or an early [/FILES] in this block.
		const tag = f.role ? ` (sender-tagged: ${f.role.replace(/[\r\n]+/g, " ")})` : "";
		const head = `${i + 1}. ${f.descriptiveKey.replace(/[\r\n]+/g, " ")}${tag}`;
		if (f.path) return `${head} -> \`${f.path}\``;
		return f.fetchFailed ? `${head} (fetch failed)` : head;
	});

	return `${opener}\n${instruction}\n${lines.join("\n")}\n[/FILES]`;
}

/**
 * Dates, never numbers: `utimesSync` reads a bare number as epoch SECONDS, landing the file in 2446
 * and throwing nothing.
 *
 * Failing is not worth losing the file over, so the caller has already recorded the path.
 */
function restoreModifiedAt(targetPath: string, modifiedAt: number | undefined): void {
	if (modifiedAt === undefined) return;
	try {
		utimesSync(targetPath, new Date(), new Date(modifiedAt));
		// A stamp past the filesystem's ceiling is CLAMPED, not rejected, so only a read-back notices.
		const landed = statSync(targetPath).mtime.getTime();
		if (Math.abs(landed - modifiedAt) > MTIME_GRANULARITY_TOLERANCE_MS) {
			console.error(`[evie-files] mtime on "${targetPath}" landed at ${landed}, not the sent ${modifiedAt}`);
		}
	} catch (err) {
		console.error(`[evie-files] could not restore mtime on "${targetPath}": ${(err as Error).message}`);
	}
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

/** Rename is atomic on POSIX, so concurrent processes converge on identical bytes; last one wins. */
function landAtomic(targetPath: string, fill: (tmpPath: string) => void): void {
	const tmpPath = `${targetPath}.tmp.${process.pid}`;
	fill(tmpPath);
	renameSync(tmpPath, targetPath);
}
