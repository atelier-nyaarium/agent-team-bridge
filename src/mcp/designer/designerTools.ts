import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBytes } from "../blobTransfer.js";
import { bridgeProjectName, postPluginAction } from "../bridge/helpers.js";
import { postReply, toolError } from "../bridge/replyTool.js";
import { assertNotReservedName } from "../references/artifactNames.js";

////////////////////////////////
//  Schemas

const PushCardSchema = z
	.object({
		session_id: z
			.string()
			.min(1)
			.describe("The channel session_id this design belongs to (from the inbound <channel> tag)."),
		name: z
			.string()
			.min(1)
			.describe(
				'The card\'s filename, e.g. "editor-form.html". Pushing the same name again updates it in place.',
			),
		html: z
			.string()
			.min(1)
			.describe(
				'The card\'s full self-contained HTML (inline CSS/SVG, no external assets). First line must be the `<!-- @dsCard group="..." width="..." height="..." -->` marker.',
			),
		message: z.string().optional().describe("A short accompanying message shown alongside the card."),
	})
	.strict();
type PushCardArgs = z.infer<typeof PushCardSchema>;

const DeleteCardSchema = z
	.object({
		fileName: z.string().min(1).describe("The card's filename to delete, matching what it was pushed as."),
	})
	.strict();
type DeleteCardArgs = z.infer<typeof DeleteCardSchema>;

////////////////////////////////
//  Functions & Helpers

const PUSH_DESCRIPTION = `
Push a design card (a self-contained @dsCard-marked HTML file) into the dock of the given conversation. Same effect as attaching a marked .html file via channel_reply, but takes the HTML inline - no temp file needed. Pushing the same \`name\` again updates that card in place.
`.trim();

const DELETE_DESCRIPTION = `
Delete a design card from your own conversation's dock, by filename. Acts only on the calling conversation - there is no way to target a different one. Use when the human says something like "forget that design" or "that one was bad, remove it".
`.trim();

export function registerDesignerTools(mcpServer: McpServer): void {
	const projectName = bridgeProjectName();
	if (!projectName) {
		// Matches registerBridgeTools's own stub pattern: a misconfigured container (no PROJECT_NAME)
		// sees the real tool names with a clear reason, not a missing tool.
		const configError = {
			content: [
				{
					type: "text" as const,
					text: "Designer tools are not configured. The PROJECT_NAME environment variable is missing from this container's devcontainer config.",
				},
			],
			isError: true,
		};
		mcpServer.registerTool(
			"designer_push_card",
			{ title: "Designer Push Card", description: `[Disabled] ${PUSH_DESCRIPTION}`, inputSchema: {} },
			async () => configError,
		);
		mcpServer.registerTool(
			"designer_delete_card",
			{ title: "Designer Delete Card", description: `[Disabled] ${DELETE_DESCRIPTION}`, inputSchema: {} },
			async () => configError,
		);
		return;
	}

	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const pushSchema: any = PushCardSchema;
	mcpServer.registerTool(
		"designer_push_card",
		{ title: "Designer Push Card", description: PUSH_DESCRIPTION, inputSchema: pushSchema },
		async (args: PushCardArgs) => {
			const { session_id, name, html, message } = args;
			try {
				assertNotReservedName(name);
			} catch (err) {
				return toolError((err as Error).message);
			}
			const bytes = Buffer.from(html, "utf-8");
			return postReply(
				{ session_id, ...(message ? { response: message } : {}) },
				{
					toolName: "designer_push_card",
					logPrefix: "designer",
					responseFieldLabel: "message",
					files: async (): Promise<ChannelFile[]> => [
						{
							filename: name,
							mime: "text/html",
							size: bytes.length,
							descriptiveKey: name,
							blobId: await uploadBytes(bytes),
						},
					],
				},
			);
		},
	);

	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const deleteSchema: any = DeleteCardSchema;
	mcpServer.registerTool(
		"designer_delete_card",
		{ title: "Designer Delete Card", description: DELETE_DESCRIPTION, inputSchema: deleteSchema },
		async (args: DeleteCardArgs) => {
			try {
				// postPluginAction self-scopes to this MCP process's own identity - the ONLY identity
				// field the gateway's /plugin-action route reads to pick a target, so this can only ever
				// act on OUR OWN conversation.
				const result = await postPluginAction("designer", "delete-card", { fileName: args.fileName });
				return {
					content: [
						{
							type: "text" as const,
							text: result.delivered ? "Delete requested." : "Delete not delivered.",
						},
					],
				};
			} catch (err) {
				return toolError(`Delete failed: ${(err as Error).message}`);
			}
		},
	);
}
