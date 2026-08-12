import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBytes } from "../blobTransfer.js";
import { bridgeProjectName, postPluginAction } from "../bridge/helpers.js";
import { postReply, toolError } from "../bridge/replyTool.js";
import { parseDsCard } from "./dsCard.js";

////////////////////////////////
//  Schemas

const PushCardSchema = z
	.object({
		session_id: z.string().min(1).describe(`Channel \`session_id\` from the inbound \`<channel>\` tag.`),
		name: z
			.string()
			.min(1)
			.describe(
				`
Card filename, e.g. \`editor-form.html\`.

A duplicate \`name\` updates the card.
`.trim(),
			),
		html: z
			.string()
			.min(1)
			.describe(
				`
Self-contained \`HTML\` with inline \`CSS\` and \`SVG\`. No external assets.

The first line must be \`<!-- @dsCard group="..." width="..." height="..." -->\`.
`.trim(),
			),
		message: z.string().optional().describe(`Optional message displayed beside the card.`),
	})
	.strict();
type PushCardArgs = z.infer<typeof PushCardSchema>;

const DeleteCardSchema = z
	.object({
		fileName: z.string().min(1).describe(`Card \`fileName\` to delete.`),
	})
	.strict();
type DeleteCardArgs = z.infer<typeof DeleteCardSchema>;

////////////////////////////////
//  Functions & Helpers

const PUSH_DESCRIPTION = `
# Push Design Card

Push self-contained \`@dsCard\` \`HTML\` into the conversation's dock.

Attaching marked \`.html\` through \`channel_reply\` has the same effect.

A duplicate \`name\` updates the card.
`.trim();

const DELETE_DESCRIPTION = `
# Delete Design Card

Delete a card from the calling conversation's dock by \`fileName\`.

Cannot target another conversation.
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
			{ title: "Designer Push Card", description: `Disabled. Set \`PROJECT_NAME\` to enable.`, inputSchema: {} },
			async () => configError,
		);
		mcpServer.registerTool(
			"designer_delete_card",
			{
				title: "Designer Delete Card",
				description: `Disabled. Set \`PROJECT_NAME\` to enable.`,
				inputSchema: {},
			},
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
			const bytes = Buffer.from(html, "utf-8");
			// The tool call IS the declaration that this file is a card, so the role is unconditional;
			// the marker only enriches it. The console docks from these fields without opening the file.
			const card = parseDsCard(html) ?? {};
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
							role: "design-card",
							...card,
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
