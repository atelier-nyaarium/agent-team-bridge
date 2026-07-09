import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { ChannelFile } from "../../shared/types.js";
import { routerPost } from "./helpers.js";

// Advisory per-file cap on the agent side. The gateway enforces the real backstop
// (a buggy agent on a trusted machine is not the threat model, but a clear error
// beats a silent 10 MB push).
const MAX_ATTACHMENT_BYTES = 10_000_000;

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

/** Read and base64 an absolute-path attachment with the 10MB advisory cap.
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
	{ toolName, logPrefix }: { toolName: string; logPrefix: string },
): Promise<ToolTextResult> {
	try {
		await routerPost("/respond", payload);
		console.error(`[${logPrefix}] ${toolName} sent [${payload.session_id}]`);
		return { content: [{ type: "text" as const, text: "Reply sent." }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return toolError(`Failed to send reply: ${message}`);
	}
}
