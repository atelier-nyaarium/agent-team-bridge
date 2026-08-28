import fs from "node:fs";
import path from "node:path";
import { connect, type Session } from "@nyaa-lexicon/client";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBytes } from "../blobTransfer.js";
import type { ToolTextResult } from "../bridge/replyTool.js";
import { buildArtifacts } from "./artifactBuilder.js";
import { loadRefFile } from "./refFile.js";
import { resolveRefs } from "./refResolve.js";
import { scanRefs } from "./refScanner.js";
import { workspaceRoot } from "./refWorkspace.js";

////////////////////////////////
//  Interfaces & Types

/** Bytes ride the blob plane, named by `blobId`. */
type ReplyFile = ChannelFile;

/** `notices` are what drifted without blocking the send, one line per cause, for the tool's text. */
export type AttachResult = { ok: true; files: ReplyFile[]; notices: string[] } | { ok: false; error: string };

////////////////////////////////
//  Constants

/** Under the MCP SDK's 60 s request timeout, which the caller applies and this server cannot lengthen. */
export const REPLY_PATIENCE_MS = 45_000;

////////////////////////////////
//  Functions & Helpers

let enabled = false;

/** Set once at startup, so a session with no console able to render one never builds one. */
export function setReferencesEnabled(on: boolean): void {
	enabled = on;
}

/** The submodule's checkout, for the client's `lexiconRoot` when a test points at it; otherwise the install record. */
let lexiconRootOverride: string | undefined;

export function setLexiconRoot(root: string | undefined): void {
	lexiconRootOverride = root;
}

let sessionPromise: Promise<Session> | null = null;
let sessionFactory: (() => Promise<Session>) | null = null;

/** Test seam: a fake session in place of a daemon. Null restores the real one. */
export function setSessionFactory(factory: (() => Promise<Session>) | null): void {
	sessionFactory = factory;
	sessionPromise = null;
}

/** One socket per process, opened on the first chain ref inside the root and shared by replies in flight. */
function sessionFor(): Promise<Session> {
	if (sessionPromise === null) {
		const open = sessionFactory ?? (() => connect({ workspaceRoot: workspaceRoot().root, ...connectOptions() }));
		// Cleared on failure: an install can appear mid-session, and a stale daemon heals on its own.
		sessionPromise = open().catch((error: unknown) => {
			sessionPromise = null;
			throw error;
		});
	}
	return sessionPromise;
}

function connectOptions(): { patience: number; lexiconRoot?: string } {
	return {
		patience: REPLY_PATIENCE_MS,
		...(lexiconRootOverride === undefined ? {} : { lexiconRoot: lexiconRootOverride }),
	};
}

/** The daemon is shared, so this only drops this process's socket; nothing is stopped. */
export async function closeReferenceSession(): Promise<void> {
	const pending = sessionPromise;
	sessionPromise = null;
	if (pending === null) return;
	try {
		(await pending).close();
	} catch {
		// A session that never opened has nothing to close.
	}
}

/** A sent reply's text, with what drifted printed after it; an error result is left as it is. */
export function withNotices(result: ToolTextResult, notices: string[]): ToolTextResult {
	if (result.isError === true || notices.length === 0) return result;
	const [first, ...rest] = result.content;
	if (first === undefined) return result;
	return { ...result, content: [{ ...first, text: `${first.text}\n\n${notices.join("\n")}` }, ...rest] };
}

/**
 * The failure split, in one place. A file that cannot be snapshotted, a chain that names nothing
 * or several things, and a matcher that finds nothing are HARD errors the agent can still fix.
 * Only lexicon's absence degrades, shipping a text match with a banner and a notice.
 */
export async function appendRefArtifacts(body: string, attachments: ReplyFile[]): Promise<AttachResult> {
	if (!enabled) return { ok: true, files: attachments, notices: [] };

	const { refs: found, problems } = scanRefs(body);
	// The agent is right here to fix its own typo.
	if (problems.length > 0) {
		const first = problems[0];
		return { ok: false, error: `${first.raw}: ${first.message} (at offset ${first.offset})` };
	}
	if (found.length === 0) return { ok: true, files: attachments, notices: [] };

	const workspace = workspaceRoot();
	if (!fs.existsSync(workspace.root)) {
		return { ok: false, error: `the workspace root ${workspace.root} does not exist, so refs cannot be resolved` };
	}

	const outcome = await resolveRefs(found, {
		workspace,
		session: sessionFor,
		load: loadRefFile,
		deadline: Date.now() + REPLY_PATIENCE_MS,
	});
	if (!outcome.ok) return outcome;

	const built = buildArtifacts(
		outcome.resolved,
		attachments.map((f) => path.basename(f.filename)),
	);
	if (!built.ok) return { ok: false, error: built.error };

	// A literal, never derived from the caller: only what this loop built is a snapshot.
	const snapshots: ReplyFile[] = [];
	for (const artifact of built.artifacts) {
		const bytes = Buffer.from(artifact.content, "utf8");
		snapshots.push({
			filename: artifact.filename,
			mime: artifact.mime,
			size: bytes.length,
			descriptiveKey: artifact.filename,
			blobId: await uploadBytes(bytes),
			role: "ref-snapshot",
			ref: artifact.ref,
		});
	}

	return { ok: true, files: [...attachments, ...snapshots], notices: outcome.notices };
}
