import fs from "node:fs";
import path from "node:path";
import { isInsideContainer } from "../../shared/env.js";
import { parseSessionName } from "../../shared/session-id.js";
import type { ChannelFile } from "../../shared/types.js";
import { uploadBytes } from "../blobTransfer.js";
import { buildArtifacts, type ResolvedRef } from "./artifactBuilder.js";
import { loadRefFile } from "./refFile.js";
import { resolveRef } from "./refResolver.js";
import { scanRefs } from "./refScanner.js";

////////////////////////////////
//  Interfaces & Types

/** A file on a reply. Its bytes ride the blob plane, named by `blobId`, whether the agent attached
 * them or this module generated them. */
type ReplyFile = ChannelFile;

export type AttachResult = { ok: true; files: ReplyFile[] } | { ok: false; error: string };

////////////////////////////////
//  Functions & Helpers

let enabled = false;

/**
 * Turn ref snapshotting on for this session. Called once at startup from the capability union, so a
 * session whose owner has no console able to render a code viewer never pays to build one.
 */
export function setReferencesEnabled(on: boolean): void {
	enabled = on;
}

/**
 * The directory a bare (project-relative) ref path resolves against. Not a boundary: an absolute or
 * `~/` path is read as written (see refFile.ts).
 *
 * A container serves one project under /workspace; elsewhere the session's own working directory
 * stands in for the project. That last one is a GUESS, and a wrong one whenever a session was
 * launched outside the repo it works in - the process cwd is the launch directory, and nothing tells
 * this process where the author actually is. `REFERENCE_ROOT` overrides both, which is both the fix
 * for that case and what lets the tests point at a fixture tree.
 */
export function referenceRoot(): string {
	if (process.env.REFERENCE_ROOT) return process.env.REFERENCE_ROOT;
	if (isInsideContainer() && process.env.PROJECT_NAME) {
		return path.join("/workspace", parseSessionName(process.env.PROJECT_NAME).project);
	}
	return process.cwd();
}

/**
 * Find the refs a message links, snapshot what they point at, and return the reply's full file list.
 *
 * The failure split is the whole design in one place. A file that cannot be snapshotted at all
 * (missing, binary, escaping the project, too big to narrow) is a HARD error, returned to the agent
 * so it can fix the message while it is still there to fix. Everything about RESOLUTION degrades
 * instead: a renamed class or a moved line ships anyway with a banner saying so, because refusing to
 * send a message over a stale pointer is worse than opening the reader in roughly the right place.
 */
export async function appendRefArtifacts(body: string, attachments: ReplyFile[]): Promise<AttachResult> {
	if (!enabled) return { ok: true, files: attachments };

	const { refs: found, problems } = scanRefs(body);
	// A malformed ref is the agent's own typo, and the agent is right here to fix it. Reporting the
	// position beats silently attaching a snapshot for a ref it did not write.
	if (problems.length > 0) {
		const first = problems[0];
		return { ok: false, error: `${first.raw}: ${first.message} (at offset ${first.offset})` };
	}
	if (found.length === 0) return { ok: true, files: attachments };

	const root = referenceRoot();
	if (!fs.existsSync(root)) {
		return { ok: false, error: `the project root ${root} does not exist, so refs cannot be resolved` };
	}

	const resolved: ResolvedRef[] = [];
	for (const entry of found) {
		const load = loadRefFile(root, entry.ref.path);
		if (!load.ok) return { ok: false, error: `${entry.raw}: ${load.detail}` };

		resolved.push({
			found: entry,
			refPath: entry.ref.path,
			text: load.file.text,
			resolution: await resolveRef(entry.ref.path, load.file.text, entry.ref),
		});
	}

	const built = buildArtifacts(
		resolved,
		attachments.map((f) => f.filename),
	);
	if (!built.ok) return { ok: false, error: built.error };

	// The role is a literal here, never derived from anything the caller passed: an artifact is one
	// this loop built, and nothing else on the message can become one.
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

	return { ok: true, files: [...attachments, ...snapshots] };
}
