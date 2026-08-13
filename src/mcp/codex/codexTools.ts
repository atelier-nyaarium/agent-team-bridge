import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	CodexAwaitAgentInputSchema,
	CodexListAgentsInputSchema,
	CodexMessageAgentInputSchema,
	CodexStartAgentInputSchema,
	CodexStopAgentInputSchema,
} from "../../shared/codex-thinking.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

const START_DESCRIPTION = `
# Start Codex Agent

Start a session-owned Codex agent for a self-contained subtask.

Waits for the turn. A turn beyond the wait budget keeps running and is returned later.

## Prompt

State allowed writes, network access, and completion criteria.

## Options

- \`model\` - optional and fixed for the agent's lifetime
- \`cwd\` - host-session working directory, fixed for the agent's lifetime

\`cwd\` does not grant write access. Agents can write only this session's project and the temp directory. An unresolved \`cwd\` falls back to the home directory.

## Reuse

Reuse an agent with \`codexMessageAgent\` instead of starting one per attempt. The thread retains its history.

Agents belong to this session, not their caller. Use \`codexListAgents\` to resume work after a caller ends.
`.trim();

const MESSAGE_DESCRIPTION = `
# Message Codex Agent

Send a follow-up prompt to a session-owned Codex agent.

A follow-up keeps the agent's history. Repeat any guardrails that still apply.

A running turn is steered. An idle agent starts a new turn.

Waits for the turn. A turn beyond the wait budget keeps running and is returned later.
`.trim();

const AWAIT_DESCRIPTION = `
# Await Codex Agent

Wait for a Codex agent's current turn to finish and return its outcome.

Use after \`waitTimedOut\`. If no turn is running, returns the latest settled state.
`.trim();

const STOP_DESCRIPTION = `
# Stop Codex Agent

Ask a Codex agent to interrupt its current turn.

Returns after the interrupt request is durable. The settled outcome arrives later. Stopping an idle agent is a no-op.

The agent stays reusable with \`codexMessageAgent\`.

Does not stop background processes started by Codex.
`.trim();

const LIST_DESCRIPTION = `
# List Codex Agents

List this session's Codex agents with their prompt and response history.

Agents outlive their callers. Use this to resume work after a subagent or workflow ends.
`.trim();

/**
 * One private ID per tool invocation, minted before the call and reused across its HTTP retries.
 *
 * This is what makes a retry a replay rather than a second delegated task. It is deliberately never
 * shown to Claude: a caller that could choose it could also make two separate requests collide, and
 * a fresh tool call is a new mutation even when its text is identical.
 */
function operationId(): string {
	return crypto.randomUUID();
}

/** What a tool invocation actually sends, built separately from the sending so it can be checked
 * without a server. An absent optional is OMITTED rather than sent as undefined, because the
 * gateway's request schemas are strict. */
export function codexRequestBody(
	kind: "start" | "message" | "await" | "stop" | "list",
	args: { agentId?: string; prompt?: string; model?: string; cwd?: string } = {},
): Record<string, unknown> {
	const mutating = kind === "start" || kind === "message" || kind === "stop";
	return {
		kind,
		...(mutating ? { operationId: operationId() } : {}),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && args.model !== undefined ? { model: args.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
	};
}

async function post(body: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	try {
		const result = await routerPost("/codex", body);
		return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text" as const, text: `Codex request failed: ${message}` }] };
	}
}

////////////////////////////////
//  Registration

export function registerCodexTools(mcpServer: McpServer): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const startSchema: any = CodexStartAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const messageSchema: any = CodexMessageAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const awaitSchema: any = CodexAwaitAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const stopSchema: any = CodexStopAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const listSchema: any = CodexListAgentsInputSchema;

	mcpServer.registerTool(
		"codexStartAgent",
		{ title: "Codex Start Agent", description: START_DESCRIPTION, inputSchema: startSchema },
		async (args: { prompt: string; model?: string; cwd?: string }) => post(codexRequestBody("start", args)),
	);

	mcpServer.registerTool(
		"codexMessageAgent",
		{ title: "Codex Message Agent", description: MESSAGE_DESCRIPTION, inputSchema: messageSchema },
		async (args: { agentId: string; prompt: string }) => post(codexRequestBody("message", args)),
	);

	mcpServer.registerTool(
		"codexAwaitAgent",
		{ title: "Codex Await Agent", description: AWAIT_DESCRIPTION, inputSchema: awaitSchema },
		async (args: { agentId: string }) => post(codexRequestBody("await", args)),
	);

	mcpServer.registerTool(
		"codexStopAgent",
		{ title: "Codex Stop Agent", description: STOP_DESCRIPTION, inputSchema: stopSchema },
		async (args: { agentId: string }) => post(codexRequestBody("stop", args)),
	);

	mcpServer.registerTool(
		"codexListAgents",
		// The strict schema rather than a bare `{}`: an empty literal registers in strip mode, so unknown
		// fields would be silently dropped where every sibling tool refuses them.
		{ title: "Codex List Agents", description: LIST_DESCRIPTION, inputSchema: listSchema },
		async () => post(codexRequestBody("list")),
	);
}
