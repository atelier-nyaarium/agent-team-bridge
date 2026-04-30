import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PostResponsePart } from "../../shared/schemas.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Schemas

const RespondToHumanPartInputSchema = z.union([
	z.string(),
	z.object({
		text: z.string().optional().describe(`Optional message text for this Discord message.`),
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this Discord message. Discord auto-renders images inline; other files appear as download links.`,
			),
	}),
]);

const RespondToHumanSchema = z.object({
	session_id: z.string().describe(`Session id from the incoming channel_push.`),
	parts: z
		.array(RespondToHumanPartInputSchema)
		.min(1)
		.describe(
			`Message parts. Each part is sent as its own Discord message. Pass a string for plain text, or { text?, attachments?: [path, ...] } to include attachments. Absolute paths only.`,
		),
});
type RespondToHumanArgs = z.infer<typeof RespondToHumanSchema>;

const TransferHumanToSchema = z.object({
	session_id: z.string().describe(`Session id of the current conversation with the human.`),
	team: z.string().describe(`Team to transfer the line to. Use "host" for the host orchestrator.`),
	brief: z.string().min(1).describe(`Handoff brief pushed to the new holder as the first channel message.`),
});
type TransferHumanToArgs = z.infer<typeof TransferHumanToSchema>;

////////////////////////////////
//  Functions & Helpers

const RESPOND_DESCRIPTION = `
Reply to the human in the Discord channel the session is pinned to. Call multiple times to send multiple messages.

Only the current holder of the channel may call this. If the channel has no holder, calling this claims it for your team.

Each entry in \`parts\` becomes one Discord message. Pass a plain string for text-only messages, or \`{ text?, attachments?: [absolutePath, ...] }\` to attach files. Discord renders image attachments inline; other files appear as download links. Use this to send back screenshots, generated artifacts, or any file the agent has on disk.

If you are not the holder, ask the current holder via crosstalk_send with a message like "Can I have the phone for session <id>?" and let them call transfer_human_to.
`.trim();

const TRANSFER_DESCRIPTION = `
Transfer the Discord conversation to another team. Only the current holder may call this.

Arbiter will:
  1. Wake the target team if offline (rejects if wake fails).
  2. Post a system message announcing the new holder to the human.
  3. Flip the pin to the new team.
  4. Push your brief to the new team as a channel message.

Use "host" as the team to return the line to the host orchestrator.
`.trim();

/**
 * Resolve one user-supplied part into the wire shape sent to the arbiter.
 * Strings auto-wrap to `{ text }`. Attachments are read from disk, base64
 * encoded, and emitted as `{ filename, base64 }` records. Absolute paths are
 * required; the basename becomes the Discord-side filename.
 */
async function materializeWirePart(part: RespondToHumanArgs["parts"][number]): Promise<PostResponsePart> {
	if (typeof part === "string") return { text: part };

	const wire: PostResponsePart = {};
	if (part.text) wire.text = part.text;
	if (part.attachments && part.attachments.length > 0) {
		wire.attachments = await Promise.all(part.attachments.map(readAttachment));
	}
	return wire;
}

async function readAttachment(filePath: string): Promise<{ filename: string; base64: string }> {
	if (!isAbsolute(filePath)) {
		throw new Error(`Attachment path must be absolute: ${filePath}`);
	}
	const buffer = await readFile(filePath);
	return { filename: basename(filePath), base64: buffer.toString("base64") };
}

export function registerHumanTools(mcpServer: McpServer): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const respondSchema: any = RespondToHumanSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const transferSchema: any = TransferHumanToSchema;

	mcpServer.registerTool(
		"respond_to_human",
		{
			title: "Respond to Human",
			description: RESPOND_DESCRIPTION,
			inputSchema: respondSchema,
		},
		async (args: RespondToHumanArgs) => {
			try {
				const from = bridgeProjectName();
				const wireParts = await Promise.all(args.parts.map(materializeWirePart));
				// The arbiter `/human/respond` route re-validates via PostResponsePartsSchema,
				// and evie-bot validates again at ingress. No need to triple-check here.
				const result = (await routerPost("/human/respond", {
					from,
					session_id: args.session_id,
					parts: wireParts,
				})) as Record<string, unknown>;
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: String(result.error) }],
						isError: true,
					};
				}
				const partsSent = typeof result.partsSent === "number" ? result.partsSent : args.parts.length;
				return {
					content: [
						{
							type: "text" as const,
							text: `Sent ${partsSent} message part(s) to the human.`,
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `respond_to_human failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);

	mcpServer.registerTool(
		"transfer_human_to",
		{
			title: "Transfer Human To",
			description: TRANSFER_DESCRIPTION,
			inputSchema: transferSchema,
		},
		async (args: TransferHumanToArgs) => {
			try {
				const from = bridgeProjectName();
				const result = (await routerPost("/human/transfer", {
					from,
					session_id: args.session_id,
					team: args.team,
					brief: args.brief,
				})) as Record<string, unknown>;
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: String(result.error) }],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Line transferred to "${args.team}".`,
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `transfer_human_to failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}
