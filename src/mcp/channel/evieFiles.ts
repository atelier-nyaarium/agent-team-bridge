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
	/** The sender staged bytes and this side could not fetch them, as opposed to a file that named
	 * no bytes in the first place. Both lack a path; only this one is worth retrying. */
	fetchFailed?: boolean;
	/** The sender's own classification, printed beside the entry when it is anything but an
	 * ordinary attachment, so an agent can see a file is machinery and skip it. */
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
// Wider than any real filesystem's timestamp granularity (FAT's 2s is the coarsest in practice) and
// far narrower than a clamp, which lands centuries out.
const MTIME_GRANULARITY_TOLERANCE_MS = 2_000;
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
 * Land an inbound message's files under /tmp/evie-files/<discordMessageId>/.
 *
 * A file's bytes are named by its `blobId` and pulled down a chunk at a time, then copied into
 * place by the kernel, so an attachment of any size costs a fixed amount of heap. The copy lands
 * through tmp + atomic rename. A file naming no bytes at all passes through as metadata-only, and
 * the renderer lists it with no `-> /path`. Expired buckets are swept at entry.
 */
export async function materializeFiles({
	discordMessageId,
	files,
}: MaterializeFilesParams): Promise<MaterializedFile[]> {
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
			...(file.role && file.role !== "attachment" ? { role: file.role } : {}),
		};

		// Presence, not truthiness: a zero-byte file still has to land, or the recipient is told it
		// was not transferred while the sender was told it sent.
		if (file.blobId !== undefined) {
			try {
				const source = await downloadBlob(file.blobId, file.blobGateway);
				mkdirSync(bucket, { recursive: true });
				const targetPath = resolveCollisionFreePath(bucket, file.filename, claimedLeaves);
				landAtomic(targetPath, (tmpPath) => copyFileSync(source, tmpPath));
				meta.path = targetPath;
				restoreModifiedAt(targetPath, file.modifiedAt);
			} catch (err) {
				// Distinct from a file that named no bytes at all. The sender staged these and the
				// fetch failed, which is worth asking about; a metadata-only file never had bytes to
				// get. Collapsing the two would have the agent give up on a recoverable transfer.
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
 * Drop `ref://` snapshot artifacts from a file list.
 *
 * Snapshots exist so a console can render a code viewer, and they ride every reply whose author
 * wrote a ref, regardless of who is receiving it. An agent reads paths off disk instead, so
 * materializing them would hand it source copies it never asked for.
 *
 * A pure read of the sender-declared role. Deliberately a KNOWN-SET drop, never "anything with a
 * role": a design-card reaching an agent has no dock to land in and must still materialize as a
 * readable file, and an unknown future role must fail toward showing. Works on a stored payload
 * too, where the bytes have been stripped but the role survives.
 */
export function dropReferenceArtifacts(files: ChannelFile[]): ChannelFile[] {
	return files.filter((f) => f.role !== "ref-snapshot");
}

/**
 * Render the unified [FILES] sentinel block for the channel notification.
 * Materialized entries get `-> /path`; the rest are described by why they have none.
 */
export function renderFilesBlock({ discordMessageId, files }: RenderFilesBlockParams): string {
	if (files.length === 0) return "";

	const opener = discordMessageId ? `[FILES messageId="${discordMessageId}"]` : `[FILES]`;
	// A file with no path failed one of two ways, and the agent's next move differs: bytes the
	// sender never staged are gone for good, while a failed fetch is worth asking to have re-sent.
	// One sentence for both would have the agent give up on the recoverable case.
	const failed = files.some((f) => !f.path && f.fetchFailed);
	const missing = files.some((f) => !f.path && !f.fetchFailed);
	const notes = [
		failed ? "Entries marked (fetch failed) were sent but could not be retrieved; ask for a re-send." : null,
		missing ? "Entries without a path carried no bytes." : null,
	].filter(Boolean);
	const instruction = `*Files with \`-> /path\` are on disk; Read them.${notes.length ? ` ${notes.join(" ")}` : ""}*`;
	const lines = files.map((f, i) => {
		// descriptiveKey is sender-supplied and this block is line-structured, so a newline in it
		// would let a filename forge entries or an early [/FILES] terminator. The role tag gets the
		// same defanging for the same reason.
		const tag = f.role ? ` (sender-tagged: ${f.role.replace(/[\r\n]+/g, " ")})` : "";
		const head = `${i + 1}. ${f.descriptiveKey.replace(/[\r\n]+/g, " ")}${tag}`;
		if (f.path) return `${head} -> \`${f.path}\``;
		return f.fetchFailed ? `${head} (fetch failed)` : head;
	});

	return `${opener}\n${instruction}\n${lines.join("\n")}\n[/FILES]`;
}

/**
 * Stamp a materialized file with the sender's mtime, so a file that arrives keeps its real age.
 *
 * Dates, never numbers: `utimesSync` reads a bare number as epoch SECONDS, so passing the
 * millisecond field lands the file in the year 2446 and throws nothing. The Date form is also the
 * only way to set mtime alone, since atime is required and belongs at now.
 *
 * Failing is not worth losing the file over, so the caller has already recorded the path.
 */
function restoreModifiedAt(targetPath: string, modifiedAt: number | undefined): void {
	if (modifiedAt === undefined) return;
	try {
		utimesSync(targetPath, new Date(), new Date(modifiedAt));
		// A stamp past the filesystem's own ceiling is CLAMPED, not rejected, so the exception path
		// never sees it. Reading the result back is the only way to notice. The tolerance keeps a
		// filesystem with coarser-than-millisecond timestamps from reporting every single file.
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

/**
 * Fill <target>.tmp.<pid> then rename. Rename is atomic on POSIX, so concurrent host MCP processes
 * handling the same channel_push converge on identical bytes at the target; last rename wins.
 */
function landAtomic(targetPath: string, fill: (tmpPath: string) => void): void {
	const tmpPath = `${targetPath}.tmp.${process.pid}`;
	fill(tmpPath);
	renameSync(tmpPath, targetPath);
}
