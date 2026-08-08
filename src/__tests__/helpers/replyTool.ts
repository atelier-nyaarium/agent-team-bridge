////////////////////////////////
//  Interfaces & Types

export type ToolResultLike = { content: Array<{ type: string; text: string }>; isError?: boolean };

////////////////////////////////
//  Functions & Helpers

/** Captures registered tool handlers so a registrar's REAL closures are testable without an MCP
 * server. Returned handlers are invoked directly. */
export function captureTools(
	register: (server: never) => void,
): Record<string, (args: never) => Promise<ToolResultLike>> {
	const tools: Record<string, (args: never) => Promise<ToolResultLike>> = {};
	const fake = {
		registerTool: (name: string, _meta: unknown, handler: (args: never) => Promise<ToolResultLike>) => {
			tools[name] = handler;
		},
	};
	register(fake as never);
	return tools;
}
