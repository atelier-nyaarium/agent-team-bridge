import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { ChannelFile } from "../../shared/types.js";
import { routerPost } from "./helpers.js";

// Advisory per-file cap on the agent side, matching the gateway's own per-payload bucket
// (MAX_RESPONSE_FILE_BYTES) rather than a stricter sub-limit - a single file may use the
// whole bucket. The gateway enforces the real backstop (a buggy agent on a trusted machine
// is not the threat model, but a clear error beats a silent oversized push).
const MAX_ATTACHMENT_BYTES = 500_000_000;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain",
	".log": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
};

/** Read and base64 an absolute-path attachment with the 500MB advisory cap.
 * Shared by the reply tools and notify_human. Unlike inbound ChannelFiles
 * (which may be metadata-only), this always carries bytes. */
export async function readReplyAttachment(filePath: string): Promise<ChannelFile & { base64: string }> {
	if (!isAbsolute(filePath)) throw new Error(`Attachment path must be absolute: ${filePath}`);
	const { size } = await stat(filePath);
	if (size > MAX_ATTACHMENT_BYTES) {
		throw new Error(
			`Attachment "${basename(filePath)}" is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`,
		);
	}
	const buffer = await readFile(filePath);
	const filename = basename(filePath);
	const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
	return { filename, mime, size: buffer.length, descriptiveKey: filename, base64: buffer.toString("base64") };
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

/** POST a reply payload to the gateway, owning the try/catch and success/failure tool response
 * shape shared by every reply tool. `payload` must already carry the fields the caller wants on
 * the wire - callers build it explicitly rather than rest-spreading their args, so a renamed or
 * mistyped arg can never leak through unmapped (see the silent-strip footgun this guards against
 * in `RespondBodySchema`, which is not `.strict()`). */
export async function postReply(
	payload: Record<string, unknown>,
	{
		toolName,
		logPrefix,
		responseFieldLabel = "response",
	}: { toolName: string; logPrefix: string; responseFieldLabel?: string },
): Promise<ToolTextResult> {
	// Absent/non-string fields are clean by definition - that is what lets a structured reply's
	// replyAsJson-only payload and a title-less designer push pass with no per-tool special-casing.
	// A reject names the TOOL-facing field the agent filled in, not the wire key it mapped to
	// (channel_reply's `full` and designer_push_card's `message` both ride the wire as `response`).
	for (const field of ["title", "summary", "response"]) {
		const value = payload[field];
		if (typeof value !== "string") continue;
		const hazard = literalEscapeHazard(value);
		if (hazard) {
			const label = field === "response" ? responseFieldLabel : field;
			return toolError(literalEscapeReject(toolName, label, hazard));
		}
	}
	try {
		await routerPost("/respond", payload);
		console.error(`[${logPrefix}] ${toolName} sent [${payload.session_id}]`);
		return { content: [{ type: "text" as const, text: "Reply sent." }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return toolError(`Failed to send reply: ${message}`);
	}
}
