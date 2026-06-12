import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PostResponsePart } from "../../shared/schemas.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { readReplyAttachment } from "../bridge/replyTool.js";

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

const NotifyHumanSchema = z.object({
	tiny: z.string().min(1).max(200).describe(`One phrase for the phone's notification bar (~60 chars).`),
	full: z
		.string()
		.optional()
		.describe(`Optional full markdown report (mermaid renders too). Shown as the message body on the phone.`),
	attachments: z
		.array(z.string())
		.optional()
		.describe(`Optional absolute file paths to attach (screenshots, logs). Images render inline on the phone.`),
});
type NotifyHumanArgs = z.infer<typeof NotifyHumanSchema>;

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

const NOTIFY_DESCRIPTION = `
Push a notification to the human's phone(s). Broadcasts to every registered phone device: \`tiny\` becomes the notification-bar line and \`full\` the message body, threaded under your team's name. Use for milestone reports (cycle ends, long-job completion, critical blockers) - not for conversational replies (use channel_reply / respond_to_human for those).
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
		wire.attachments = await Promise.all(part.attachments.map(readDiscordAttachment));
	}
	return wire;
}

// One capped reader for every attachment path: read through readReplyAttachment
// (absolute-path guard + 10MB advisory cap), then project down to the Discord
// wire shape, which carries only filename + base64.
async function readDiscordAttachment(filePath: string): Promise<{ filename: string; base64: string }> {
	const file = await readReplyAttachment(filePath);
	return { filename: file.filename, base64: file.base64 };
}

export function registerHumanTools(mcpServer: McpServer): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const respondSchema: any = RespondToHumanSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const transferSchema: any = TransferHumanToSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const notifySchema: any = NotifyHumanSchema;

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

	mcpServer.registerTool(
		"notify_human",
		{
			title: "Notify Human",
			description: NOTIFY_DESCRIPTION,
			inputSchema: notifySchema,
		},
		async (args: NotifyHumanArgs) => {
			const { tiny, full, attachments } = args;
			let files: ChannelFile[] | undefined;
			if (attachments?.length) {
				try {
					files = await Promise.all(attachments.map(readReplyAttachment));
				} catch (err) {
					return {
						content: [{ type: "text" as const, text: `Attachment error: ${(err as Error).message}` }],
						isError: true,
					};
				}
			}
			try {
				// routerPost parses the JSON and throws on any non-ok response with
				// the server's error message (including the 413 cap and 503 no-bridge).
				const result = (await routerPost("/human/notify", {
					from: bridgeProjectName() || "unknown",
					tiny,
					...(full ? { full } : {}),
					...(files ? { files } : {}),
				})) as { delivered?: number };
				const delivered = result.delivered ?? 0;
				return {
					content: [
						{
							type: "text" as const,
							text: `Notice delivered to ${delivered} phone(s).${delivered === 0 ? " No phones are currently registered; it was not queued." : ""}`,
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Notify failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}
