import fs from "node:fs";
import path from "node:path";
import { isInsideContainer } from "../../shared/env.js";
import { parseSessionName } from "../../shared/session-id.js";
import type { ChannelFile } from "../../shared/types.js";
import { buildArtifacts, type ResolvedRef } from "./artifactBuilder.js";
import { loadRefFile } from "./refFile.js";
import { resolveRef } from "./refResolver.js";
import { scanRefs } from "./refScanner.js";

////////////////////////////////
//  Interfaces & Types

type ReplyFile = ChannelFile & { base64: string };

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
 * The directory refs resolve against, and the boundary they may not escape.
 *
 * A container serves one project under /workspace; elsewhere the session's own working directory is
 * the project. `REFERENCE_ROOT` overrides both, which is also what lets the tests point it at a
 * fixture tree.
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

	// Snapshots follow the agent's own attachments, and the manifest leads the snapshots. Its
	// selection rule only needs to be first among files bearing the reserved name, which nothing
	// else can be: a collision on that name was already refused above.
	return {
		ok: true,
		files: [
			...attachments,
			...built.artifacts.map((artifact) => ({
				filename: artifact.filename,
				mime: artifact.mime,
				size: Buffer.byteLength(artifact.content, "utf8"),
				descriptiveKey: artifact.filename,
				base64: Buffer.from(artifact.content, "utf8").toString("base64"),
			})),
		],
	};
}
