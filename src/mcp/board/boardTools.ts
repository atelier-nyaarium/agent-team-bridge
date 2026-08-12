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

const ID = z.string().min(1).max(64);

const ListInputSchema = {
	scope: z
		.enum(["unclaimed", "session", "all"])
		.optional()
		.describe(
			`
\`unclaimed\` - backlog only
\`session\` - this session's task board
\`all\` - both (default)
`.trim(),
		),
};

const ClaimInputSchema = {
	id: ID.describe(`Entry to take, along with its whole subtree.`),
};

const ReleaseInputSchema = {
	id: ID.describe(
		`
Entry and subtree to release to the backlog.

Use only for work you will not do.
`.trim(),
	),
};

const CreateInputSchema = {
	title: z.string().min(1).max(500).describe(`One line naming the work.`),
	assignTo: z.enum(["self", "backlog"]).describe(
		`
\`self\` - assign to this session
\`backlog\` - leave unassigned
`.trim(),
	),
	body: z.string().max(BOARD_BODY_MAX).optional().describe(`Optional details for the owner.`),
	parent: ID.optional().describe(
		`
Parent entry you hold. Claim a backlog entry first.

Omit for top level. No depth limit. Keep trees four levels deep or fewer.
`.trim(),
	),
};

const UpdateInputSchema = {
	id: ID.describe(`Entry to change. Must be one you hold.`),
	title: z.string().min(1).max(500).optional().describe(`Replaces the title.`),
	body: z.string().max(BOARD_BODY_MAX).nullable().optional().describe(`Replaces the body. \`null\` clears it.`),
	state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]).optional().describe(`Work state.`),
	// nullable AND optional: absent means leave the placement alone, null means move to top level.
	// Legal here because MCP inputs never pass through the Kotlin codegen.
	parent: ID.nullable()
		.optional()
		.describe(
			`
Parent entry you hold. Claim a backlog entry first.

Omit to keep the parent. \`null\` moves the entry to top level. No depth limit. Keep trees four levels deep or fewer.
`.trim(),
		),
};

const ClearInputSchema = {};

const FetchAttachmentsInputSchema = {
	id: ID.describe(`Entry whose attachments to fetch.`),
	filenames: z
		.array(z.string().min(1).max(255))
		.optional()
		.describe(`Attachment filenames from \`taskBoardList\`. Omit for all attachments.`),
};

////////////////////////////////
//  Functions & Helpers

const LIST_DESCRIPTION = `
# List Task Board Entries

List entries assigned to this session and unclaimed backlog entries.

Entries are flat with parent pointers. Rebuild the tree from them.
`.trim();

const CLAIM_DESCRIPTION = `
# Claim Backlog Entry

Claim a backlog entry and its subtree for this session.

## Subtask lists

If the entry's \`body\` lists subtasks:

- Create each as a child entry.
- Clear the source \`body\`.
- Improve each title and move remaining detail into its \`body\`.
`.trim();

const RELEASE_DESCRIPTION = `
# Release Task Board Entry

Release an entry and subtree to the backlog without changing its state, \`body\`, or tree position.

Release only work you will not do. Keep it after reporting or planning it.
`.trim();

const CREATE_DESCRIPTION = `
# Create Task Board Entry

Create a task board entry.

Set \`assignTo\` explicitly:

- \`self\` - work for this session
- \`backlog\` - unassigned work

Use \`self\` for every step of your own work, including unstarted steps.
`.trim();

const UPDATE_DESCRIPTION = `
# Update Task Board Entry

Update an entry on this session's task board. Omitted fields stay unchanged.

Claim a backlog entry before updating it.

## State cascades

Mark only the entry you actually finished.

- Finishing the last unfinished child finishes its parent.
- Finishing a parent finishes its descendants.
- Reopening work reopens finished ancestors.

The reply lists saved cascaded changes.
`.trim();

const CLEAR_DESCRIPTION = `
# Clear Task Board Entries

Trash this session's \`done\` and \`cancelled\` entries. The owner can restore them for 30 days.
`.trim();

const FETCH_ATTACHMENTS_DESCRIPTION = `
# Fetch Task Attachments

Download an entry's attachments and return local paths.

The owner attaches files from their phone. You can read them but cannot change them.

\`taskBoardList\` shows filenames. Set \`filenames\` to select files, or omit it for all.

## Attachment notices

- A \`changed\` notice names only the entry \`id\`. Re-read the entry to identify the change.
- Unclaimed entries send no notice. Check attachments when you claim one.
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

/** Wire shape of one auto-marked entry. Read defensively rather than parsed: the gateway updates on
 * its own trigger, so a plugin can be talking to one that has never heard of a cascade. */
type CascadeLine = { id?: unknown; title?: unknown; from?: unknown; to?: unknown; reason?: unknown };

const CASCADE_CAUSE: Record<string, string> = {
	children_finished: "everything under it is finished",
	parent_finished: "the entry above it was finished",
	child_reopened: "work under it went back to unfinished",
};

/**
 * What the board did on its own, as prose, because a bare list of ids reads as something the caller
 * has to act on. It does not: the change is already saved.
 *
 * Returns empty for anything that is not a populated array of usable rows, so an older gateway's
 * reply, or a newer one's field this does not understand, degrades to the plain JSON answer.
 */
export function cascadeProse(raw: unknown): string {
	if (!Array.isArray(raw) || raw.length === 0) return "";
	const lines: string[] = [];
	for (const row of raw as CascadeLine[]) {
		if (typeof row?.title !== "string" || typeof row.to !== "string") continue;
		const cause = typeof row.reason === "string" ? CASCADE_CAUSE[row.reason] : undefined;
		lines.push(`- "${row.title}" is now ${row.to}${cause ? `, because ${cause}` : ""}.`);
	}
	if (lines.length === 0) return "";
	const count = lines.length === 1 ? "one other entry" : `${lines.length} other entries`;
	return [
		"",
		`The board also moved ${count} to keep the tree consistent:`,
		...lines,
		"This is already saved and needs no follow-up write. Say so if the owner would want to know.",
	].join("\n");
}

async function post(
	body: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	try {
		const result = await postBoard(body);
		const prose = cascadeProse((result as { cascaded?: unknown })?.cascaded);
		return { content: [{ type: "text" as const, text: `${JSON.stringify(result, null, 2)}${prose}` }] };
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
