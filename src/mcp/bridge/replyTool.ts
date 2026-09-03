import crypto from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBlob } from "../blobTransfer.js";
import { parseDsCard } from "../designer/dsCard.js";
import { opLedgerRefusal, routerPost, unansweredHandshakeId } from "./helpers.js";

// Gateway enforces the backstop.
const MAX_ATTACHMENT_BYTES = MAX_BLOB_BYTES;

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

const CARD_SNIFF_BYTES = 8192;

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
	const after = await stat(filePath).catch(() => stats);
	return {
		filename,
		mime,
		size: after.size,
		descriptiveKey: filename,
		// getTime(), not mtimeMs: the fraction fails the wire schema's integer check.
		...wireModifiedAt(after.mtime),
		blobId,
		...(card ? { role: "design-card" as const, ...card } : { role: "attachment" as const }),
	};
}

/** Omit invalid timestamps. */
export function wireModifiedAt(mtime: Date): { modifiedAt?: number } {
	const ms = mtime.getTime();
	return Number.isFinite(ms) ? { modifiedAt: ms } : {};
}

/** Sequential transfer under one budget. */
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

export type ToolTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ESCAPE_HAZARD_RE = /\\n(?:\\n|- |\* |\+ |#|\||>)/;

/** Find literal newline escapes outside code. */
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

/** Explain the literal newline error. */
export function literalEscapeReject(toolName: string, field: string, snippet: string): string {
	const quotable = snippet.replace(/`/g, "'");
	return (
		`${toolName} rejected: "${field}" uses a literal \\n escape sequence as a line break near ` +
		`\`${quotable}\` - use REAL newlines; literal backslash-n renders as visible text on the console. ` +
		`Fix and resend. If the escape is intentional literal text (a printf/regex snippet), wrap it ` +
		`in a code span or fenced block - code is exempt from this check.`
	);
}

export function toolError(text: string): ToolTextResult {
	return { content: [{ type: "text" as const, text }], isError: true };
}

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
	for (const field of [...SPOKEN_TIER_FIELDS, "response"]) {
		const value = payload[field];
		if (typeof value !== "string") continue;
		const hazard = literalEscapeHazard(value);
		if (hazard) {
			const label = field === "response" ? responseFieldLabel : field;
			return toolError(literalEscapeReject(toolName, label, hazard));
		}
	}
	const refusal = opLedgerRefusal();
	if (refusal) return toolError(`Cannot reply: ${refusal}`);
	try {
		const staged = await files?.();
		const withOpId = { opId: crypto.randomUUID(), ...payload };
		await routerPost("/respond", staged?.length ? { ...withOpId, files: staged } : withOpId);
		console.error(`[${logPrefix}] ${toolName} sent [${payload.session_id}]`);
		return { content: [{ type: "text" as const, text: `Reply sent.` }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return toolError(`Failed to send reply: ${message}${handshakeHint(message)}`);
	}
}

function handshakeHint(message: string): string {
	if (!/handshake/i.test(message)) return "";
	const hsId = unansweredHandshakeId();
	if (!hsId) return "";
	return `\n\nThe handshake this session owes is \`${hsId}\`. Answer it with channel_reply_structured (session_id \`${hsId}\`, responseData \`{ "isMainOrLead": true }\` if you are the primary session, false if you are a worker), then resend this reply.`;
}
