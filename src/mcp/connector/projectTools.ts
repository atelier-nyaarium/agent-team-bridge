import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cleanupTmpDir } from "../../shared/tmp-files.js";
import { invokeResolved } from "./listener.js";
import { registerStubTool, textResult } from "./utils.js";

const TAG = "[connector]";
const CONNECTOR_FILES_DIR = "/tmp/connector-files";
const FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

////////////////////////////////
//  Schemas

const ResponseFileSpec = z.object({
	encoding: z.enum(["base64"]),
	extension: z.string(),
});

const McpToolSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	schema: z.instanceof(z.ZodObject),
	responseFiles: z.record(z.string(), ResponseFileSpec).optional(),
});

type McpTool = z.infer<typeof McpToolSchema>;

////////////////////////////////
//  State

// biome-ignore lint/suspicious/noExplicitAny: Zod schema generic
const loadedToolSchemas = new Map<string, z.ZodObject<any>>();
const loadedResponseFiles = new Map<string, Record<string, z.infer<typeof ResponseFileSpec>>>();

////////////////////////////////
//  Functions & Helpers

export function getToolSchema(name: string): z.ZodObject<z.ZodRawShape> | undefined {
	return loadedToolSchemas.get(name);
}

function processResponseFiles(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
	const specs = loadedResponseFiles.get(toolName);
	if (!specs) return result;

	const processed = { ...result };
	for (const [field, spec] of Object.entries(specs)) {
		const value = processed[field];
		if (typeof value !== "string" || !value) continue;

		mkdirSync(CONNECTOR_FILES_DIR, { recursive: true });
		cleanupTmpDir({ dir: CONNECTOR_FILES_DIR, maxAgeMs: FILE_MAX_AGE_MS, mode: "files" });

		const fileName = `${toolName}-${Date.now()}.${spec.extension}`;
		const filePath = join(CONNECTOR_FILES_DIR, fileName);

		if (spec.encoding === "base64") {
			writeFileSync(filePath, Buffer.from(value, "base64"));
		}

		processed[field] = filePath;
	}
	return processed;
}

export function getLoadedToolNames(): string[] {
	return Array.from(loadedToolSchemas.keys());
}

export async function registerProjectTools(
	mcpServer: McpServer,
	projectName: string,
	connectorDir: string,
): Promise<void> {
	const schemaPath = `${connectorDir}/mcp-schema.js`;

	if (!existsSync(schemaPath)) {
		// mcpConnectorCreateSchema stub is handled by connectorTools.ts
		console.error(`${TAG} No schema at ${schemaPath}`);
		return;
	}

	let schema: { default?: unknown };
	try {
		schema = await import(schemaPath);
	} catch (error) {
		const err = error as Error;
		console.error(`${TAG} Failed to load schema from ${schemaPath}: ${err.message}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => `${err.message}\n${err.stack}`,
		);
		return;
	}

	const schemaFn = schema.default;
	if (typeof schemaFn !== "function") {
		const msg = `Schema must default export a function. Got: ${typeof schemaFn}`;
		console.error(`${TAG} ${msg}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => msg,
		);
		return;
	}

	let rawTools: unknown;
	try {
		rawTools = schemaFn(z);
	} catch (error) {
		const err = error as Error;
		console.error(`${TAG} Schema function threw: ${err.message}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => `${err.message}\n${err.stack}`,
		);
		return;
	}

	const parsed = z.array(McpToolSchema).safeParse(rawTools);
	if (!parsed.success) {
		const msg = `Schema function returned invalid tools: ${parsed.error.message}`;
		console.error(`${TAG} ${msg}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => msg,
		);
		return;
	}

	const tools: McpTool[] = parsed.data;

	// Store schemas and response file specs for validation by listener
	loadedToolSchemas.clear();
	loadedResponseFiles.clear();
	for (const tool of tools) {
		loadedToolSchemas.set(tool.name, tool.schema);
		if (tool.responseFiles) {
			loadedResponseFiles.set(tool.name, tool.responseFiles);
		}
	}

	for (const tool of tools) {
		const extendedShape = {
			clientId: z
				.string()
				.optional()
				.describe(`6-char client hash from mcpConnectorStatus. Use this or instance to target a client.`),
			instance: z
				.string()
				.optional()
				.describe(
					`Instance name (from ?instance= query param on connect). Use this or clientId to target a client.`,
				),
			...tool.schema.shape,
		};

		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
		const toolSchema: any = z.object(extendedShape);

		mcpServer.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: toolSchema,
			},
			async (args: Record<string, unknown>) => {
				try {
					const { clientId, instance, ...toolArgs } = args;

					if (!clientId && !instance) {
						return textResult(
							`Either clientId or instance is required. Call mcpConnectorStatus for connected clients.`,
							true,
						);
					}

					const rawResult = await invokeResolved(
						clientId as string | undefined,
						instance as string | undefined,
						tool.name,
						toolArgs,
					);
					const result = processResponseFiles(tool.name, rawResult as Record<string, unknown>);
					return textResult(JSON.stringify(result, null, 2));
				} catch (error) {
					return textResult(
						JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
						true,
					);
				}
			},
		);
	}

	console.error(`${TAG} Loaded ${tools.length} project tool(s) from ${projectName}`);
}
