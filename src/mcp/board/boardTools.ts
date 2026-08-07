import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOARD_BODY_MAX } from "../../shared/schemas.js";
import { sweepStaging } from "../blobTransfer.js";
import { postBoard } from "../bridge/helpers.js";
import { EVIE_FILES_DIR, materializeFiles, safeFilename } from "../channel/evieFiles.js";

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
		.describe("unclaimed = the backlog only, session = your taskboard only, all = both. Default all."),
};

const ClaimInputSchema = {
	id: ID.describe("Entry to take, along with its whole subtree."),
};

const ReleaseInputSchema = {
	id: ID.describe("Entry to give up, along with its whole subtree. Only for work you are not going to do."),
};

const CreateInputSchema = {
	title: z.string().min(1).max(500).describe("One line naming the work."),
	assignTo: z
		.enum(["self", "backlog"])
		.describe("self = onto your taskboard, you work it. backlog = the owner's backlog, work you are not doing."),
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

const FetchAttachmentsInputSchema = {
	id: ID.describe("Entry whose attachments to fetch."),
	filenames: z
		.array(z.string().min(1).max(255))
		.optional()
		.describe("Only these files, by the names the list showed. Omit for all of them."),
};

////////////////////////////////
//  Functions & Helpers

const LIST_DESCRIPTION = `
Two halves, and the names matter when you talk about them: entries assigned to
this session are YOUR TASKBOARD ("my taskboard"), and unassigned ones are THE
BACKLOG (the owner's, not yours). Flat, with parent pointers - rebuild the tree
from those.
`.trim();

const CLAIM_DESCRIPTION = `
Move an entry, and everything under it, from the backlog onto your taskboard.

Refuses when another session holds it, so repeating a claim whose reply you lost
is safe rather than a theft.

When what you just claimed is one entry whose BODY is a list of subtasks, explode
it: create each item as a nested entry under it, then clear the body you took them
from. A list living in prose cannot be given a state, held by anyone, or counted,
so leaving it there costs the owner every one of those. Word each title better
than the source line rather than copying it verbatim, and keep any detail that
does not fit a title in that child's own body.
`.trim();

const RELEASE_DESCRIPTION = `
Give an entry and its subtree up, back to the backlog, keeping its state, body
and place in the tree.

Only for work you are NOT going to do. Finishing a plan, writing entries up, or
handing a report to the owner are none of them a reason to release: the work is
still yours, so it stays on your taskboard. If in doubt, keep it.
`.trim();

const CREATE_DESCRIPTION = `
Add an entry to the board.

assignTo has no default on purpose: say whether this lands on your taskboard
because you are doing it, or in the backlog because you are not. Breaking your
own work into steps is "self" every time, including the steps you have not
started.
`.trim();

const UPDATE_DESCRIPTION = `
Change an entry on your taskboard. Omitted fields are left alone. Claim a
backlog entry before updating it.
`.trim();

const CLEAR_DESCRIPTION = `
Trash your taskboard's done and cancelled entries. The owner can restore them
for 30 days.
`.trim();

const FETCH_ATTACHMENTS_DESCRIPTION = `
Download an entry's attachments and return the paths they landed at.

The owner attaches these from their phone; you can read them but never add,
change or remove one. taskBoardList shows each entry's filenames, so name the
ones you want ("mellisa-render.png") or omit filenames for all of them.

Two things the list cannot tell you. A "changed" notice carries the entry id
alone, so a new picture looks exactly like an edited title - re-read the entry
to find out. And an entry nobody holds announces nothing at all, so a picture
the owner adds to a backlog item arrives silently: look when you claim it.
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
	action: "list" | "claim" | "release" | "create" | "update" | "clear" | "attachments",
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

/**
 * A fetch is TWO hops, and neither needs a gate of its own.
 *
 * Hop one resolves filenames to blobIds on `/task-board`, which already refuses an impersonated
 * sender and filters on what this session may see. Hop two moves the bytes through `/blob/get`,
 * already chunked, resumable and digest-verified. The blobIds live only in here: what comes back is
 * paths, so the plumbing never reaches the model's context and cannot be replayed out of it.
 */
async function fetchAttachments(args: { id: string; filenames?: string[] }): Promise<string> {
	// Through the same builder as every other action, so "not in MUTATING" is what keeps this read
	// from minting an operation id. A minted one would have the route record this answer and replay
	// it verbatim, handing back blobIds for pictures the owner has since swapped.
	const answer = (await postBoard(boardRequestBody("attachments", { id: args.id }))) as {
		attachments?: Array<{ blobId: string; blobGateway: string; filename: string; mime: string; size: number }>;
	};
	const all = answer.attachments ?? [];
	const wanted = args.filenames ? all.filter((a) => args.filenames?.includes(a.filename)) : all;

	if (all.length === 0) return `Entry ${args.id} has no attachments.`;
	if (wanted.length === 0) {
		return `None of those names are on entry ${args.id}. It has: ${all.map((a) => a.filename).join(", ")}`;
	}

	// Before the transfer, not after: the staging root is byte-bounded and this is the first download
	// path that sweeps it at all, so a big fetch would otherwise land on whatever the last one left.
	sweepStaging();
	// The entry's folder is REPLACED, not added to. Collision-free naming is right for a message,
	// where each one's files are distinct, and wrong here: re-reading an entry would otherwise land
	// shot-2.png, shot-3.png and so on, and leave behind files the owner has since removed.
	rmSync(join(EVIE_FILES_DIR, safeFilename(args.id)), { recursive: true, force: true });
	const landed = await materializeFiles({
		discordMessageId: args.id,
		files: wanted.map((a) => ({
			filename: a.filename,
			mime: a.mime,
			size: a.size,
			descriptiveKey: a.filename,
			blobId: a.blobId,
			blobGateway: a.blobGateway,
			role: "attachment" as const,
		})),
	});

	const lines = landed.map((f) =>
		f.path ? `${f.descriptiveKey} -> ${f.path}` : `${f.descriptiveKey} (could not be fetched)`,
	);
	return lines.join("\n");
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

	mcpServer.registerTool(
		"taskBoardFetchAttachments",
		{
			title: "Task Board Fetch Attachments",
			description: FETCH_ATTACHMENTS_DESCRIPTION,
			inputSchema: FetchAttachmentsInputSchema,
		},
		async (args: { id: string; filenames?: string[] }) => {
			try {
				return { content: [{ type: "text" as const, text: await fetchAttachments(args) }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Safe to re-run, unlike the mutating tools: this mints no operation id, so a retry is a
				// fresh read rather than a replay of a stale one.
				const text = `Could not fetch attachments for ${args.id}: ${message}. Retrying is safe.`;
				return { content: [{ type: "text" as const, text }], isError: true };
			}
		},
	);
}
