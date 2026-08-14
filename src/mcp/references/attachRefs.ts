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

/** Bytes ride the blob plane, named by `blobId`. */
type ReplyFile = ChannelFile;

export type AttachResult = { ok: true; files: ReplyFile[] } | { ok: false; error: string };

////////////////////////////////
//  Functions & Helpers

let enabled = false;

/** Set once at startup, so a session with no console able to render one never builds one. */
export function setReferencesEnabled(on: boolean): void {
	enabled = on;
}

/**
 * What a bare ref path resolves against. Not a boundary: an absolute or `~/` path is read as written.
 *
 * The cwd fallback is a GUESS, wrong whenever a session was launched outside the repo it works in.
 * `REFERENCE_ROOT` overrides it, and points the tests at a fixture tree.
 */
export function referenceRoot(): string {
	if (process.env.REFERENCE_ROOT) return process.env.REFERENCE_ROOT;
	if (isInsideContainer() && process.env.PROJECT_NAME) {
		return path.join("/workspace", parseSessionName(process.env.PROJECT_NAME).project);
	}
	return process.cwd();
}

/**
 * The failure split, in one place. A file that cannot be snapshotted at all is a HARD error the
 * agent can still fix. RESOLUTION degrades instead, shipping with a banner, because refusing to send
 * over a stale pointer is worse than opening roughly in the right place.
 */
export async function appendRefArtifacts(body: string, attachments: ReplyFile[]): Promise<AttachResult> {
	if (!enabled) return { ok: true, files: attachments };

	const { refs: found, problems } = scanRefs(body);
	// The agent is right here to fix its own typo.
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

	return { ok: true, files: [...attachments, ...snapshots] };
}
