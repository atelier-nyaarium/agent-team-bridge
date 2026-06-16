import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { ChannelFile } from "../../shared/types.js";
import { routerPost } from "./helpers.js";

////////////////////////////////
//  Interfaces & Types

interface ReplyArgsBase {
	session_id: string;
	status?: string;
	respondAsMarkdownString?: string;
	respondAsStructuredData?: string;
	attachments?: string[];
}

// Advisory per-file cap on the agent side. The arbiter enforces the real backstop
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
	const buffer = await readFile(filePath);
	if (buffer.length > MAX_ATTACHMENT_BYTES) {
		throw new Error(
			`Attachment "${basename(filePath)}" is ${buffer.length} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`,
		);
	}
	const filename = basename(filePath);
	const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
	return { filename, mime, size: buffer.length, descriptiveKey: filename, base64: buffer.toString("base64") };
}

////////////////////////////////
//  Functions & Helpers

export function registerReplyTool<S extends z.ZodTypeAny>(
	mcpServer: McpServer,
	toolName: string,
	title: string,
	description: string,
	logPrefix: string,
	schema: S,
): void {
	mcpServer.registerTool(
		toolName,
		{
			title,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: schema as any,
		},
		async (args: unknown) => {
			try {
				const { session_id, status, respondAsMarkdownString, respondAsStructuredData, attachments, ...rest } =
					args as ReplyArgsBase & Record<string, unknown>;

				// A reply with no prose, no structured data, no attachments, and no status
				// produces an empty entry the consumer (the phone) silently skips - the exact
				// failure that let a wrong body-field name pass unnoticed for a whole session.
				// Reject it loudly instead of returning "Reply sent." over an empty message.
				if (
					!respondAsMarkdownString &&
					!respondAsStructuredData &&
					!(attachments && attachments.length > 0) &&
					status === undefined
				) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Empty reply rejected. Put your prose in "respondAsMarkdownString" (the human-facing body), or use "respondAsStructuredData"/"attachments". Unknown keys are silently dropped, so a mistyped field sends nothing.`,
							},
						],
						isError: true,
					};
				}

				const payload: Record<string, unknown> = { session_id, ...rest };
				if (status !== undefined) payload.status = status;

				if (attachments && attachments.length > 0) {
					try {
						payload.files = await Promise.all(attachments.map(readReplyAttachment));
					} catch (err) {
						return {
							content: [{ type: "text" as const, text: `Attachment error: ${(err as Error).message}` }],
							isError: true,
						};
					}
				}

				if (respondAsStructuredData) {
					try {
						payload.replyAsJson = JSON.parse(respondAsStructuredData);
					} catch {
						return {
							content: [{ type: "text" as const, text: "respondAsStructuredData must be a valid JSON string." }],
							isError: true,
						};
					}
				} else if (respondAsMarkdownString !== undefined) {
					payload.response = respondAsMarkdownString;
				}

				await routerPost("/respond", payload);
				const suffix = status ? ` (${status})` : "";
				console.error(`[${logPrefix}] ${toolName} sent${suffix} [${session_id}]`);
				return { content: [{ type: "text" as const, text: `Reply sent${suffix}.` }] };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to send reply: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
