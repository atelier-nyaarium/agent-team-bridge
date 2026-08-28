import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentHttpPath } from "../../shared/agent-backend.js";
import {
	CodexAwaitAgentInputSchema,
	CodexListAgentsInputSchema,
	CodexMessageAgentInputSchema,
	CodexStartAgentInputSchema,
	CodexStopAgentInputSchema,
} from "../../shared/codex-agent.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

const START_DESCRIPTION = `
# Start Codex Agent

Start a session-owned Codex agent for a self-contained subtask.

Waits for the turn. A turn beyond the wait budget keeps running and is returned later.

Models:
- gpt-5.6-sol - Flagship for the hardest reasoning and coding. Ask permission first.
- gpt-5.6-terra - Balanced workhorse for strong everyday reasoning and implementation.
- gpt-5.6-luna - Efficient for long-running exploration, audits, and implementation. Use it by default.

## Prompt

State allowed writes, network access, and completion criteria.

## Options

- \`model\` - optional and fixed for the agent's lifetime
- \`cwd\` - host-session working directory, fixed for the agent's lifetime

\`cwd\` does not grant write access. Agents can write only this session's project and the temp directory. An unresolved \`cwd\` falls back to the home directory.

## Reuse

To retain history, reuse an agent with \`codexMessageAgent\` instead of starting one per turn.

Agents belong to this whole session, not the caller. Use \`codexListAgents\` to resume work after a caller ends.
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

/** Minted once per call, reused across retries, so a retry replays rather than delegates twice.
 * Never shown to Claude: a caller-chosen id could collide two separate requests. */
function operationId(): string {
	return crypto.randomUUID();
}

/** Absent is OMITTED, since the gateway's schemas are strict. */
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

export const gatewayDispatch: AgentDispatch = (body) => routerPost(agentHttpPath("codex"), body);

function post(
	dispatch: AgentDispatch,
	body: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	return dispatch(body).then(
		(result) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: `Codex request failed: ${message}` }] };
		},
	);
}

////////////////////////////////
//  Registration

export function registerCodexTools(mcpServer: McpServer, dispatch: AgentDispatch = gatewayDispatch): void {
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
		{ title: `Codex Start Agent`, description: START_DESCRIPTION, inputSchema: startSchema },
		async (args: { prompt: string; model?: string; cwd?: string }) =>
			post(dispatch, codexRequestBody("start", args)),
	);

	mcpServer.registerTool(
		"codexMessageAgent",
		{ title: `Codex Message Agent`, description: MESSAGE_DESCRIPTION, inputSchema: messageSchema },
		async (args: { agentId: string; prompt: string }) => post(dispatch, codexRequestBody("message", args)),
	);

	mcpServer.registerTool(
		"codexAwaitAgent",
		{ title: `Codex Await Agent`, description: AWAIT_DESCRIPTION, inputSchema: awaitSchema },
		async (args: { agentId: string }) => post(dispatch, codexRequestBody("await", args)),
	);

	mcpServer.registerTool(
		"codexStopAgent",
		{ title: `Codex Stop Agent`, description: STOP_DESCRIPTION, inputSchema: stopSchema },
		async (args: { agentId: string }) => post(dispatch, codexRequestBody("stop", args)),
	);

	mcpServer.registerTool(
		"codexListAgents",
		// Strict, not a bare `{}`: a literal registers in strip mode and silently drops unknown fields.
		{ title: `Codex List Agents`, description: LIST_DESCRIPTION, inputSchema: listSchema },
		async () => post(dispatch, codexRequestBody("list")),
	);
}
