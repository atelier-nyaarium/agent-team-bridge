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

Waits for the turn. A turn outliving the wait budget keeps running; your harness
backgrounds the call and returns the result when it lands. Issue several in one
message to start them together.

model is optional and belongs here only, since it is fixed for the thread's life.
Leave it off unless you have a reason; an unoffered one is refused, not swapped.

cwd is where the thread runs, and it is what the thread may WRITE: that directory
and the temp dir, nothing else on the machine. It defaults to your own session's
project, so an agent asked to work on a sibling project can read it and cannot
change it. Set cwd to that project when you mean the agent to edit it, and prefer
that over having it stage edits somewhere else, which costs it the ability to run
the project's own tests on its work. Fixed for the thread's life, like model, and
host sessions only. A path that does not resolve to a directory falls back to your
home directory rather than failing, so check the agent landed where you meant.

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

Waits for the turn. A turn outliving the wait budget keeps running; your harness
backgrounds the call and returns the result when it lands.
`.trim();

const AWAIT_DESCRIPTION = `
Wait for a Codex agent's current turn to finish and return its outcome.

Use to pick up a turn reported as waitTimedOut. With nothing running it returns the
latest settled state immediately.
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
