import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOARD_BODY_MAX } from "../../shared/schemas.js";
import { sweepStaging } from "../blobTransfer.js";
import { postBoard } from "../bridge/helpers.js";
import { CHANNEL_FILES_DIR, materializeFiles, safeFilename } from "../channel/channelFiles.js";

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
	// null moves to top level, absent leaves it alone. Legal here: never reaches Kotlin codegen.
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

/** Minted once per invocation, reused across HTTP retries, so a retry replays rather than writes
 * twice. Never shown to Claude: a caller-chosen id could collide two separate requests. */
function operationId(): string {
	return crypto.randomUUID();
}

/** The actions that CHANGE something. A read is re-run freely; these are not. */
const MUTATING = new Set(["claim", "release", "create", "update", "clear"]);

/** Absent is OMITTED, since the gateway's schema is strict. `from` is NOT here: postBoard supplies
 * this process's own identity. */
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
 * Two hops, neither needing its own gate: `/task-board` resolves filenames to blobIds and already
 * filters on what this session may see, and `/blob/get` moves the bytes, chunked and verified. The
 * blobIds live only here; what comes back is paths.
 */
async function fetchAttachments(args: { id: string; filenames?: string[] }): Promise<string> {
	// Not in MUTATING, so this mints no operation id, or a replay would hand back stale blobIds.
	const answer = (await postBoard(boardRequestBody("attachments", { id: args.id }))) as {
		attachments?: Array<{ blobId: string; blobGateway: string; filename: string; mime: string; size: number }>;
	};
	const all = answer.attachments ?? [];
	const wanted = args.filenames ? all.filter((a) => args.filenames?.includes(a.filename)) : all;

	if (all.length === 0) return `Entry ${args.id} has no attachments.`;
	if (wanted.length === 0) {
		return `None of those names are on entry ${args.id}. It has: ${all.map((a) => a.filename).join(", ")}`;
	}

	// Before the transfer, or a big fetch lands on whatever the last one left.
	sweepStaging();
	// REPLACED, not added to, or a re-read grows shot-2.png, shot-3.png forever.
	rmSync(join(CHANNEL_FILES_DIR, safeFilename(args.id)), { recursive: true, force: true });
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

/** Read defensively: an older gateway has never heard of a cascade. */
type CascadeLine = { id?: unknown; title?: unknown; from?: unknown; to?: unknown; reason?: unknown };

const CASCADE_CAUSE: Record<string, string> = {
	children_finished: "everything under it is finished",
	parent_finished: "the entry above it was finished",
	child_reopened: "work under it went back to unfinished",
};

/** As prose, so it does not read as something the caller must act on; the change is already saved.
 * Empty for anything not a usable row array, degrading to the plain JSON answer. */
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
		// A retry mints a NEW operation id, so a create that landed would double; list first.
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
				// Mints no operation id, unlike the mutating tools, so a retry is a fresh read.
				const text = `Could not fetch attachments for ${args.id}: ${message}. Retrying is safe.`;
				return { content: [{ type: "text" as const, text }], isError: true };
			}
		},
	);
}
