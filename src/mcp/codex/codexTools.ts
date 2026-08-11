import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import crypto from "node:crypto";
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

Start a second-model-family thread this session owns, for a self-contained sub-task.

Waits for the turn. A turn outliving the wait budget keeps running and your harness returns it later. Issue several in one message to start them together.

## Guardrails

Switchboard sets none. State them in the prompt: what it may write, whether it may reach the network, what done looks like.

Codex brings its own sandbox. Its shape is not yours to assume, so have the agent probe and report rather than guess. Restricting what the sandbox already forbids buys nothing.

Codex is **very literal**. Given a goal and no edges, it reaches that goal by whatever route works. A narrow scope gets excellent work; an open brief gets surprises.

## Arguments

- \`model\` - optional, fixed for the thread's life. An unoffered one is refused, not swapped.
- \`cwd\` - where it runs. Fixed for the thread's life. Host sessions only.

Setting \`cwd\` does NOT grant write access. Only your session's own project is writable, plus the temp dir. A thread pointed at a sibling project can read it and run its tests; it cannot edit it. Delegate edits only within your own project.

A \`cwd\` that does not resolve falls back to your home directory rather than failing. Check the agent landed where you meant.

## Reuse

Reuse an agent rather than starting one per attempt. A thread holding its own last three failures fixes the fourth. Follow up with \`codexMessageAgent\`.

The agent belongs to this session, not to its caller. If the caller dies, \`codexListAgents\` still returns it with its full history.
`.trim();

const MESSAGE_DESCRIPTION = `
# Message Codex Agent

Send a follow-up prompt to a Codex agent this session owns.

Prefer this over starting a new agent. The thread keeps what it has already read, tried and got wrong, so a follow-up naming the failure beats a fresh agent given the same brief.

A running turn is STEERED, joining the work in flight rather than queueing. An idle agent starts a new turn.

Guardrails do not carry over. Restate any that still apply.

Waits for the turn. A turn outliving the wait budget keeps running and your harness returns it later.
`.trim();

const AWAIT_DESCRIPTION = `
# Await Codex Agent

Wait for a Codex agent's current turn to finish and return its outcome.

Use to pick up a turn previously reported as \`waitTimedOut\`. If nothing is running, it returns the latest settled state immediately.
`.trim();

const STOP_DESCRIPTION = `
# Stop Codex Agent

Ask a Codex agent to interrupt its current turn.

Asynchronous. It returns once the request is durable; the turn's real ending arrives afterwards, and may still be a completion if the turn finished first. Stopping an idle agent is a no-op.

Does NOT close the agent. The thread stays reusable via \`codexMessageAgent\`.

Does not reach processes Codex started in the background.
`.trim();

const LIST_DESCRIPTION = `
# List Codex Agents

List this session's Codex agents with their full prompt and response history.

Scoped to this session alone. Agents outlive the caller that started them, so this is how work is picked up after a subagent or workflow ends.
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
	args: { agentId?: string; prompt?: string; model?: string } = {},
): Record<string, unknown> {
	const mutating = kind === "start" || kind === "message" || kind === "stop";
	return {
		kind,
		...(mutating ? { operationId: operationId() } : {}),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && args.model ? { model: args.model } : {}),
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
