import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { MAX_BLOB_BYTES } from "../../shared/evie-protocol.js";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBlob } from "../blobTransfer.js";
import { parseDsCard } from "../designer/dsCard.js";
import { routerPost } from "./helpers.js";

// Advisory and derived; the gateway holds the real backstop.
const MAX_ATTACHMENT_BYTES = MAX_BLOB_BYTES;

// A missing extension falls back to octet-stream, and both renderers classify on the prefix alone.
const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".apng": "image/apng",
	".avif": "image/avif",
	// TIFF and HEIC are absent: the transcript renders image/* as an <img>, which cannot decode them.
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain",
	".log": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
};

/** The marker leads the file, so this decides card-ness exactly. Only a late <title> is missed. */
const CARD_SNIFF_BYTES = 8192;

/** Compose-time is the one place allowed to read bytes for this, so an attached card docks like a
 * designer_push_card one. */
async function sniffDsCard(filePath: string, filename: string, mime: string): Promise<ReturnType<typeof parseDsCard>> {
	const html = mime.startsWith("text/html") || /\.html?$/i.test(filename);
	if (!html) return null;
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(CARD_SNIFF_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, CARD_SNIFF_BYTES, 0);
		return parseDsCard(buffer.subarray(0, bytesRead).toString("utf-8"));
	} finally {
		await handle.close();
	}
}

/** Unlike an inbound ChannelFile, this always names transferable bytes. */
export async function readReplyAttachment(filePath: string): Promise<ChannelFile> {
	if (!isAbsolute(filePath)) throw new Error(`Attachment path must be absolute: ${filePath}`);
	const filename = basename(filePath);
	const stats = await stat(filePath);
	// A FIFO stats as 0 and then blocks the read, wedging the call with no error.
	if (!stats.isFile()) throw new Error(`Attachment "${filename}" is not a regular file`);
	if (stats.size > MAX_ATTACHMENT_BYTES) {
		throw new Error(`Attachment "${filename}" is ${stats.size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`);
	}
	const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
	const card = await sniffDsCard(filePath, filename, mime);
	const blobId = await uploadBlob(filePath);
	// Narrows the stale-size gap; nothing locks the file across the two stats.
	const after = await stat(filePath).catch(() => stats);
	return {
		filename,
		mime,
		size: after.size,
		descriptiveKey: filename,
		// getTime(), not mtimeMs: the fraction fails the wire schema's integer check.
		...wireModifiedAt(after.mtime),
		blobId,
		// A literal, never an argument, except a marker-led html that declares itself a card.
		...(card ? { role: "design-card" as const, ...card } : { role: "attachment" as const }),
	};
}

/** Omission is a supported sender state; a null or NaN would fail the whole payload. */
export function wireModifiedAt(mtime: Date): { modifiedAt?: number } {
	const ms = mtime.getTime();
	return Number.isFinite(ms) ? { modifiedAt: ms } : {};
}

/** Sequential, against ONE budget: the per-file cap alone lets N files push an unbounded total, and
 * concurrency would multiply the live transfer buffers for no gain. */
export async function readReplyAttachments(paths: string[]): Promise<ChannelFile[]> {
	const out: ChannelFile[] = [];
	let total = 0;
	for (const path of paths) {
		const file = await readReplyAttachment(path);
		total += file.size;
		if (total > MAX_ATTACHMENT_BYTES) {
			throw new Error(`Attachments total over the ${MAX_ATTACHMENT_BYTES}-byte limit at "${file.filename}"`);
		}
		out.push(file);
	}
	return out;
}

////////////////////////////////
//  Functions & Helpers

export type ToolTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// A non-structural follow (a letter, as in a Windows path) is legitimate prose and passes.
const ESCAPE_HAZARD_RE = /\\n(?:\\n|- |\* |\+ |#|\||>)/;

/** A snippet around the first literal `\n` used as markdown structure, or null. The enforcing half
 * of the guard; REAL_NEWLINES_GUIDANCE in shared/schemas.ts is the visible half.
 *
 * Code is exempt, judged line by line per CommonMark's fence rules. Inline spans are BLANKED, not
 * deleted: deleting would glue their neighbors into an adjacency the author never wrote. */
export function literalEscapeHazard(text: string): string | null {
	let openFence: string | null = null;
	for (const line of text.split("\n")) {
		if (openFence) {
			if (new RegExp(`^\\s{0,3}${openFence}{3,}\\s*$`).test(line)) openFence = null;
			continue;
		}
		const opener = /^\s{0,3}(`{3}|~{3})/.exec(line)?.[1] ?? null;
		if (opener) {
			openFence = opener[0];
			continue;
		}
		const prose = line.replace(/(`+)(.*?)\1(?!`)/g, " ");
		const match = ESCAPE_HAZARD_RE.exec(prose);
		if (match) {
			return prose.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
		}
	}
	return null;
}

/** The `\\n` spellings are deliberate: the message must SHOW the sequence. The snippet rides in a
 * code span so an agent quoting this back does not trip the lint again. */
export function literalEscapeReject(toolName: string, field: string, snippet: string): string {
	const quotable = snippet.replace(/`/g, "'");
	return (
		`${toolName} rejected: "${field}" uses a literal \\n escape sequence as a line break near ` +
		`\`${quotable}\` - use REAL newlines; literal backslash-n renders as visible text on the console. ` +
		`Fix and resend. If the escape is intentional literal text (a printf/regex snippet), wrap it ` +
		`in a code span or fenced block - code is exempt from this check.`
	);
}

/** Reply-tool failures only. `connector/utils.ts` has its own for the connector subsystem. */
export function toolError(text: string): ToolTextResult {
	return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * The try/catch and tool-response shape every reply tool shares.
 *
 * Callers build `payload` explicitly rather than rest-spreading their args, since RespondBodySchema
 * is not `.strict()` and would silently drop a mistyped one.
 *
 * `files` is a THUNK, called only after the prose passes the lint, which is what makes "a refused
 * reply sends nothing" true for every tool at once rather than per call site.
 */
export async function postReply(
	payload: Record<string, unknown>,
	{
		toolName,
		logPrefix,
		responseFieldLabel = "response",
		files,
	}: {
		toolName: string;
		logPrefix: string;
		responseFieldLabel?: string;
		files?: () => Promise<ChannelFile[]>;
	},
): Promise<ToolTextResult> {
	// Absent fields are clean, so a replyAsJson-only payload needs no special-casing. A reject names
	// the TOOL-facing field, not the wire key it mapped to.
	for (const field of [...SPOKEN_TIER_FIELDS, "response"]) {
		const value = payload[field];
		if (typeof value !== "string") continue;
		const hazard = literalEscapeHazard(value);
		if (hazard) {
			const label = field === "response" ? responseFieldLabel : field;
			return toolError(literalEscapeReject(toolName, label, hazard));
		}
	}
	try {
		const staged = await files?.();
		await routerPost("/respond", staged?.length ? { ...payload, files: staged } : payload);
		console.error(`[${logPrefix}] ${toolName} sent [${payload.session_id}]`);
		return { content: [{ type: "text" as const, text: "Reply sent." }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return toolError(`Failed to send reply: ${message}`);
	}
}
