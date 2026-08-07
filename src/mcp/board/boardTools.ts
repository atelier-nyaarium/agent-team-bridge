import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOARD_BODY_MAX } from "../../shared/schemas.js";
import { postBoard } from "../bridge/helpers.js";

////////////////////////////////
//  Schemas

/** No depth limit is enforced anywhere; a refusal at depth five would fail a write the owner never
 * sees a reason for. The ask lives in the parameter text instead. The scope sentence does describe a
 * real refusal, so it has to be here - the tool text is the only place an agent reads it. */
const PARENT_TEXT =
	"Entry id to nest under, one you hold - claim a backlog entry first. Omit for top level. No depth limit, but keep trees 4 deep or under.";

const ID = z.string().min(1).max(64);

const ListInputSchema = {
	scope: z
		.enum(["unclaimed", "session", "all"])
		.optional()
		.describe("unclaimed = the backlog only, session = yours only, all = both. Default all."),
};

const ClaimInputSchema = {
	id: ID.describe("Entry to take, along with its whole subtree."),
};

const ReleaseInputSchema = {
	id: ID.describe("Entry to hand back, along with its whole subtree."),
};

const CreateInputSchema = {
	title: z.string().min(1).max(500).describe("One line naming the work."),
	assignTo: z
		.enum(["self", "backlog"])
		.describe("self = you work it now. backlog = the owner's backlog, for work you are not doing."),
	body: z.string().max(BOARD_BODY_MAX).optional().describe("Longer detail. The owner reads this."),
	parent: ID.optional().describe(PARENT_TEXT),
};

const UpdateInputSchema = {
	id: ID.describe("Entry to change. Must be one you hold."),
	title: z.string().min(1).max(500).optional().describe("Replaces the title."),
	body: z.string().max(BOARD_BODY_MAX).nullable().optional().describe("Replaces the body. null clears it."),
	state: z
		.enum(["open", "in_progress", "paused", "done", "cancelled"])
		.optional()
		.describe("open, in_progress, paused, done, cancelled."),
	// nullable AND optional: absent means leave the placement alone, null means move to top level.
	// Legal here because MCP inputs never pass through the Kotlin codegen.
	parent: ID.nullable().optional().describe(`${PARENT_TEXT} null moves it to top level.`),
};

const ClearInputSchema = {};

////////////////////////////////
//  Functions & Helpers

const LIST_DESCRIPTION = `
The owner's backlog and your own entries. Flat, with parent pointers - rebuild
the tree from those.
`.trim();

const CLAIM_DESCRIPTION = `
Take an unassigned entry, and everything under it, for this session.

Refuses when another session holds it, so repeating a claim whose reply you lost
is safe rather than a theft.
`.trim();

const RELEASE_DESCRIPTION = `
Hand an entry and its subtree back to the backlog, keeping its state, body and
place in the tree.
`.trim();

const CREATE_DESCRIPTION = `
Add an entry to the owner's board.

assignTo has no default on purpose: say whether this is work you are doing now
or work for the backlog.
`.trim();

const UPDATE_DESCRIPTION = `
Change an entry you hold. Omitted fields are left alone. Claim a backlog entry
before updating it.
`.trim();

const CLEAR_DESCRIPTION = `
Trash this session's done and cancelled entries. The owner can restore them for
30 days.
`.trim();

/**
 * One private ID per MUTATING tool invocation, minted before the call and reused across its HTTP
 * retries. This is what makes a retry a replay rather than a second write.
 *
 * Create additionally derives its entry id from it, so its replay is structural; the others rely on
 * the route's own record of the id. Deliberately never shown to Claude: a caller that could choose
 * it could also make two separate requests collide, and a fresh tool call is a new mutation even
 * when its text is identical.
 */
function operationId(): string {
	return crypto.randomUUID();
}

/** The actions that CHANGE something. A read is re-run freely; these are not. */
const MUTATING = new Set(["claim", "release", "create", "update", "clear"]);

/** What a tool invocation sends, built separately from the sending so it can be checked without a
 * server. An absent optional is OMITTED rather than sent as undefined, because the gateway's request
 * schema is strict. `from` is NOT here: postBoard supplies this process's own identity, so no tool
 * can name a different session. */
export function boardRequestBody(
	action: "list" | "claim" | "release" | "create" | "update" | "clear",
	args: {
		id?: string;
		scope?: string;
		title?: string;
		body?: string | null;
		state?: string;
		parent?: string | null;
		assignTo?: string;
	} = {},
): Record<string, unknown> {
	return {
		action,
		...(MUTATING.has(action) ? { operationId: operationId() } : {}),
		...(args.id === undefined ? {} : { id: args.id }),
		...(args.scope === undefined ? {} : { scope: args.scope }),
		...(args.title === undefined ? {} : { title: args.title }),
		...(args.body === undefined ? {} : { body: args.body }),
		...(args.state === undefined ? {} : { state: args.state }),
		...(args.parent === undefined ? {} : { parent: args.parent }),
		...(args.assignTo === undefined ? {} : { assignTo: args.assignTo }),
	};
}

async function post(
	body: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	try {
		const result = await postBoard(body);
		return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// A failure here cannot say whether the write landed and the reply was lost. Calling the tool
		// again would mint a NEW operation id, so a create that did land would double; list first.
		const text = `Task board request failed: ${message}. It may still have applied - run taskBoardList before retrying.`;
		return { content: [{ type: "text" as const, text }], isError: true };
	}
}

////////////////////////////////
//  Registration

export function registerBoardTools(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"taskBoardList",
		{ title: "Task Board List", description: LIST_DESCRIPTION, inputSchema: ListInputSchema },
		async (args: { scope?: string }) => post(boardRequestBody("list", args)),
	);

	mcpServer.registerTool(
		"taskBoardClaim",
		{ title: "Task Board Claim", description: CLAIM_DESCRIPTION, inputSchema: ClaimInputSchema },
		async (args: { id: string }) => post(boardRequestBody("claim", args)),
	);

	mcpServer.registerTool(
		"taskBoardRelease",
		{ title: "Task Board Release", description: RELEASE_DESCRIPTION, inputSchema: ReleaseInputSchema },
		async (args: { id: string }) => post(boardRequestBody("release", args)),
	);

	mcpServer.registerTool(
		"taskBoardCreate",
		{ title: "Task Board Create", description: CREATE_DESCRIPTION, inputSchema: CreateInputSchema },
		async (args: { title: string; assignTo: string; body?: string; parent?: string }) =>
			post(boardRequestBody("create", args)),
	);

	mcpServer.registerTool(
		"taskBoardUpdate",
		{ title: "Task Board Update", description: UPDATE_DESCRIPTION, inputSchema: UpdateInputSchema },
		async (args: { id: string; title?: string; body?: string | null; state?: string; parent?: string | null }) =>
			post(boardRequestBody("update", args)),
	);

	mcpServer.registerTool(
		"taskBoardClear",
		{ title: "Task Board Clear", description: CLEAR_DESCRIPTION, inputSchema: ClearInputSchema },
		async () => post(boardRequestBody("clear")),
	);
}
