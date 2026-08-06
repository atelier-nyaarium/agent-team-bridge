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
Start a Codex agent: a second-model-family thread this session owns, for a
self-contained sub-task.

State its guardrails in the prompt. Switchboard sets none for you, and the
thread holds workspace-write and network access for its whole life whatever
you write, so the prompt is the only boundary that exists. Say plainly:
  - whether it may write at all, and if so which paths
  - whether it may reach the network
  - what done looks like

Codex is strong and it is literal. Given a goal and no edges, it will reach
that goal by whatever route works, including routes you would not have picked.
A narrow explicit scope gets excellent work out of it. An open brief gets
surprises. Code edits are fine when the scope is narrow and you can state it.

Reuse an agent rather than starting one per attempt. A thread that already
holds its own last three failures fixes the fourth; a fresh one relearns the
problem every time. Follow up with codexMessageAgent.

awaitResponse (default true) waits up to about four minutes. A longer turn is not
lost: it keeps running, and codexAwaitAgent picks it up. Pass false to return on
durable acceptance and collect later the same way - and always pass false when
you are running several at once.

model is optional and belongs here only, since it is fixed for the thread's life.
Leave it off unless you have a reason; an unoffered one is refused, not swapped.

The agent belongs to this session, not to its caller. If the caller dies,
codexListAgents still returns it with its full history.
`.trim();

const MESSAGE_DESCRIPTION = `
Send a follow-up prompt to a Codex agent this session owns.

Prefer this over starting a new agent. The thread keeps everything it has
already read, tried and got wrong, so a follow-up that says what failed is
worth far more than a fresh agent given the same brief.

If a turn is still running the prompt STEERS it, joining the work in flight
rather than queueing behind it. If the agent is idle it starts a new turn.
Guardrails do not carry over implicitly; restate any that still apply.

awaitResponse (default true) waits up to about four minutes; a longer turn keeps
running and codexAwaitAgent picks it up.
`.trim();

const AWAIT_DESCRIPTION = `
Wait for a Codex agent's current turn to finish and return its outcome.

Use after a call made with awaitResponse false, or to pick up an agent whose
earlier wait timed out. With nothing running it returns the latest settled
state immediately.
`.trim();

const STOP_DESCRIPTION = `
Ask a Codex agent to interrupt its current turn.

Asynchronous: it returns as soon as the request is durable, and the turn's real
ending arrives afterwards. That ending may still be a completion, if the turn
finished before the interrupt landed. Stopping an idle agent is a no-op.

This does NOT close the agent. Its thread stays reusable, so codexMessageAgent
still works afterwards. Nothing here reaches processes Codex started in the
background.
`.trim();

const LIST_DESCRIPTION = `
List this session's Codex agents with their full prompt and response history.

Scoped to this session, and to it alone. Agents outlive the caller that started
them, so this is how work is picked up after a subagent or workflow has ended.
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
		async (args: { prompt: string; awaitResponse?: boolean; model?: string }) =>
			post({
				kind: "start",
				operationId: operationId(),
				prompt: args.prompt,
				awaitResponse: args.awaitResponse ?? true,
				...(args.model ? { model: args.model } : {}),
			}),
	);

	mcpServer.registerTool(
		"codexMessageAgent",
		{ title: "Codex Message Agent", description: MESSAGE_DESCRIPTION, inputSchema: messageSchema },
		async (args: { agentId: string; prompt: string; awaitResponse?: boolean }) =>
			post({
				kind: "message",
				operationId: operationId(),
				agentId: args.agentId,
				prompt: args.prompt,
				awaitResponse: args.awaitResponse ?? true,
			}),
	);

	mcpServer.registerTool(
		"codexAwaitAgent",
		{ title: "Codex Await Agent", description: AWAIT_DESCRIPTION, inputSchema: awaitSchema },
		async (args: { agentId: string }) => post({ kind: "await", agentId: args.agentId }),
	);

	mcpServer.registerTool(
		"codexStopAgent",
		{ title: "Codex Stop Agent", description: STOP_DESCRIPTION, inputSchema: stopSchema },
		async (args: { agentId: string }) => post({ kind: "stop", operationId: operationId(), agentId: args.agentId }),
	);

	mcpServer.registerTool(
		"codexListAgents",
		// The strict schema rather than a bare `{}`: an empty literal registers in strip mode, so unknown
		// fields would be silently dropped where every sibling tool refuses them.
		{ title: "Codex List Agents", description: LIST_DESCRIPTION, inputSchema: listSchema },
		async () => post({ kind: "list" }),
	);
}
