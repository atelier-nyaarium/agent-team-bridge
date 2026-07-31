import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { MAX_BLOB_BYTES } from "../../shared/evie-protocol.js";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBlob } from "../blobTransfer.js";
import { parseDsCard } from "../designer/dsCard.js";
import { routerPost } from "./helpers.js";

// Advisory per-file cap on the agent side, DERIVED from the one size limit rather than restating
// it - a private copy is how the previous four caps drifted apart. The gateway enforces the real
// backstop (a buggy agent on a trusted machine is not the threat model, but a clear error here
// beats a silent oversized push).
const MAX_ATTACHMENT_BYTES = MAX_BLOB_BYTES;

// An extension missing here falls back to octet-stream, and both renderers classify on the mime
// prefix alone without re-sniffing, so the file gets a bare row instead of a thumbnail or player.
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
	// TIFF and HEIC are deliberately absent: the transcript renders anything image/* as an <img>,
	// which the WebView cannot decode for either, so octet-stream and a file row is the better fall.
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

/** Bytes of prefix sniffed from a hand-attached html file for the @dsCard marker. The marker must
 * lead the file, so the prefix decides card-ness exactly; only a <title> past this bound is missed,
 * and the console then falls back to the filename stem. */
const CARD_SNIFF_BYTES = 8192;

/** A hand-attached html file's declared card fields, or null when it is not a card. Compose-time is
 * the one place allowed to read bytes to answer this, so an attached card docks exactly like a
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

/** Stage an absolute-path attachment on the blob plane and describe it, under the shared advisory
 * cap. Shared by the reply tools and notify_human. Unlike an inbound ChannelFile (which may be
 * metadata-only), this always names transferable bytes. */
export async function readReplyAttachment(filePath: string): Promise<ChannelFile> {
	if (!isAbsolute(filePath)) throw new Error(`Attachment path must be absolute: ${filePath}`);
	const filename = basename(filePath);
	const stats = await stat(filePath);
	// A FIFO stats as size 0 and then blocks the ingest read until a writer appears, wedging the tool
	// call with no error and no timeout.
	if (!stats.isFile()) throw new Error(`Attachment "${filename}" is not a regular file`);
	if (stats.size > MAX_ATTACHMENT_BYTES) {
		throw new Error(`Attachment "${filename}" is ${stats.size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`);
	}
	const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
	const card = await sniffDsCard(filePath, filename, mime);
	// The bytes go to the blob store a chunk at a time; the message carries only the reference, so
	// this function no longer holds the file and its base64 at once.
	const blobId = await uploadBlob(filePath);
	// Stat again after the upload: the guard stat has to precede it, but by then it describes bytes
	// that may already be stale. This narrows the gap rather than closing it, since nothing locks
	// the file across the two calls.
	const after = await stat(filePath).catch(() => stats);
	return {
		filename,
		mime,
		size: after.size,
		descriptiveKey: filename,
		// getTime(), not mtimeMs: the latter carries sub-millisecond precision as a fraction, which
		// the wire schema's integer check rejects. An mtime outside the Date range yields NaN, which
		// serializes to null and would have the gateway reject the whole message over one odd file.
		...wireModifiedAt(after.mtime),
		blobId,
		// An operator file is an ordinary attachment BY CONSTRUCTION - the role is a literal here,
		// never an argument - except a marker-led html, which declares itself a card the same way a
		// designer_push_card does.
		...(card ? { role: "design-card" as const, ...card } : { role: "attachment" as const }),
	};
}

/** The wire field for a file's mtime, or nothing at all when the clock cannot be represented.
 * Omission is a supported sender state; a null or NaN is not, and would fail the whole payload. */
export function wireModifiedAt(mtime: Date): { modifiedAt?: number } {
	const ms = mtime.getTime();
	return Number.isFinite(ms) ? { modifiedAt: ms } : {};
}

/** Stage a whole attachment list, sequentially, against ONE budget. The per-file cap alone lets N
 * files each under it push an unbounded total onto the gateway, and running them concurrently would
 * multiply the transfer buffers live at once for no gain on a link this short. */
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

// Literal backslash-n followed by markdown structure (another \n, a list marker, heading, table
// pipe, or quote) - the signature of an author who meant line breaks. A non-structural follow
// (a letter, as in a Windows path) is legitimate prose and passes.
const ESCAPE_HAZARD_RE = /\\n(?:\\n|- |\* |\+ |#|\||>)/;

/** The first spot where [text] contains a literal `\n` escape sequence used as markdown structure
 * (a snippet around the match), or null when clean. The enforcing half of the escaped-newline
 * guard - the always-visible half is REAL_NEWLINES_GUIDANCE on the prose-field describes in
 * shared/schemas.ts (schemas cannot import from mcp/, so the two halves live apart). Code is
 * exempt, judged line by line in document order the way the renderer parses it, per CommonMark's
 * fence rules: an opener at a line start (backtick or tilde, info string allowed - never
 * rendered) is closed only by a line holding the MATCHING delimiter and nothing but whitespace; a
 * delimiter line with trailing text inside a fence is ordinary code content, and an unterminated
 * fence runs to end-of-string. On prose lines, inline code spans are blanked to a space,
 * run-length aware (`` ``x`` `` closes only on an equal backtick run). Blanking (not deleting)
 * matters: deletion would glue the span's neighbors together and manufacture a \n-plus-structure
 * adjacency the author never wrote. */
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

/** The reject text every enforcement point returns for a literalEscapeHazard hit. The `\\n`
 * spellings are deliberate: the message must SHOW the two-character sequence, so a raw newline
 * escape here would demonstrate the very bug it describes. The snippet rides inside a code span
 * (its own backticks swapped out) so an agent quoting this reject back to the human verbatim
 * does not trip the lint a second time. */
export function literalEscapeReject(toolName: string, field: string, snippet: string): string {
	const quotable = snippet.replace(/`/g, "'");
	return (
		`${toolName} rejected: "${field}" uses a literal \\n escape sequence as a line break near ` +
		`\`${quotable}\` - use REAL newlines; literal backslash-n renders as visible text on the console. ` +
		`Fix and resend. If the escape is intentional literal text (a printf/regex snippet), wrap it ` +
		`in a code span or fenced block - code is exempt from this check.`
	);
}

/** The error shape every reply-tool handler returns. Scoped to this file's own callers rather than
 * the similar `textResult` in `connector/utils.ts` - that one serves the unrelated connector
 * subsystem and always sets `isError`, where this one is dedicated to reply-tool failures. */
export function toolError(text: string): ToolTextResult {
	return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * POST a reply payload to the gateway, owning the try/catch and success/failure tool response
 * shape shared by every reply tool.
 *
 * `payload` must already carry the fields the caller wants on the wire - callers build it
 * explicitly rather than rest-spreading their args, so a renamed or mistyped arg can never leak
 * through unmapped (see the silent-strip footgun this guards against in `RespondBodySchema`, which
 * is not `.strict()`).
 *
 * `files` is a THUNK, called only once the prose has passed the lint. Staging an attachment puts
 * its bytes on the gateway, so building the list eagerly would leave a rejected call's uploads
 * sitting there unreferenced. Deferring it is what makes "a refused reply sends nothing" true for
 * every tool at once, rather than something each one has to remember at its own call site.
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
	// Absent/non-string fields are clean by definition - that is what lets a structured reply's
	// replyAsJson-only payload and a title-less designer push pass with no per-tool special-casing.
	// A reject names the TOOL-facing field the agent filled in, not the wire key it mapped to
	// (channel_reply's `full` and designer_push_card's `message` both ride the wire as `response`).
	// The spoken trio comes from the shared field list; `response` is this wire's body field name.
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
