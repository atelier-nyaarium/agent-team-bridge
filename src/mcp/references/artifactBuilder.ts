import { MANIFEST_FILENAME, MANIFEST_MARKER, safeName, uniqueName } from "./artifactNames.js";
import type { Resolution } from "./refResolver.js";
import type { FoundRef } from "./refScanner.js";

////////////////////////////////
//  Interfaces & Types

/** A ref that resolved, ready to be filed into the manifest. */
export interface ResolvedRef {
	found: FoundRef;
	/** Path as written, which is also the snapshot's identity: one snapshot per file however many
	 * refs point into it. */
	refPath: string;
	text: string;
	resolution: Resolution;
}

/** One contiguous piece of a file, in ORIGINAL-file coordinates. */
export interface Segment {
	startLine: number;
	text: string;
}

export interface ManifestFileEntry {
	refPath: string;
	/** The name this file will actually land under on the device. */
	filename: string;
	mode: "full" | "snippet";
	/** Present only in snippet mode. Ordered, non-overlapping. */
	segments?: Segment[];
	totalLines: number;
}

/** A working entry. `snippetEligible` is a build-time decision, stripped before it ships. */
interface InternalEntry extends ManifestFileEntry {
	snippetEligible?: boolean;
}

export interface ManifestRefEntry {
	refPath: string;
	startLine: number;
	endLine: number;
	span?: Resolution["span"];
	quality: Resolution["quality"];
	reason?: string;
	ambiguous?: boolean;
	matchCount?: number;
}

/** What ships as the manifest file. Keyed by canonical ref key, which is what the console
 * recomputes from a tapped link. */
export interface Manifest {
	[MANIFEST_MARKER]: 1;
	files: ManifestFileEntry[];
	refs: Record<string, ManifestRefEntry>;
}

export interface BuiltArtifact {
	filename: string;
	/** UTF-8 text. The caller base64-encodes it into a ChannelFile. */
	content: string;
	mime: string;
}

export type BuildResult = { ok: true; artifacts: BuiltArtifact[]; manifest: Manifest } | { ok: false; error: string };

////////////////////////////////
//  Functions & Helpers

/** No single snapshot may exceed this. A file over it must be narrowed by the ref, not truncated,
 * since a truncated snapshot would silently not contain what the ref points at. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Everything one message may attach, decoded. Keeps a reply far below any transport ceiling. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Lines kept either side of a snippet, so a reader sees why the region looks like it does. */
const CONTEXT_LINES = 3;

function lineCount(text: string): number {
	return text.split("\n").length;
}

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Merge each file's ranges into as few segments as possible, with context.
 *
 * Coalescing is what keeps one copy per file no matter how many refs point into it. Overlapping
 * windows merge rather than shipping the same lines twice, which would let a handful of nearby refs
 * re-inflate a snippet past the very cap that produced it.
 */
function segmentsFor(text: string, ranges: Array<{ startLine: number; endLine: number }>): Segment[] {
	const lines = text.split("\n");
	const windows = ranges
		.map((r) => ({
			start: Math.max(1, r.startLine - CONTEXT_LINES),
			end: Math.min(lines.length, r.endLine + CONTEXT_LINES),
		}))
		.sort((a, b) => a.start - b.start);

	const merged: Array<{ start: number; end: number }> = [];
	for (const window of windows) {
		const last = merged[merged.length - 1];
		if (last && window.start <= last.end + 1) last.end = Math.max(last.end, window.end);
		else merged.push({ ...window });
	}

	return merged.map((w) => ({ startLine: w.start, text: lines.slice(w.start - 1, w.end).join("\n") }));
}

function entryBytes(entry: ManifestFileEntry, fullText: string): number {
	if (entry.mode === "full") return bytes(fullText);
	return (entry.segments ?? []).reduce((sum, s) => sum + bytes(s.text), 0);
}

/**
 * Assemble the manifest and snapshot artifacts for a message's refs.
 *
 * `existingNames` must be the agent's own attachment filenames, so snapshot naming dedupes across
 * the whole files array. A collision on the reserved manifest name is a hard error rather than a
 * rename: leaving the name claimable is what would let a crafted attachment be adopted as the
 * manifest.
 */
export function buildArtifacts(resolved: ResolvedRef[], existingNames: string[]): BuildResult {
	if (existingNames.some((n) => safeName(n) === MANIFEST_FILENAME)) {
		return { ok: false, error: `an attachment is named ${MANIFEST_FILENAME}, which is reserved` };
	}
	if (resolved.length === 0) return { ok: true, artifacts: [], manifest: emptyManifest() };

	// One entry per FILE, in first-referenced order.
	const byPath = new Map<string, ResolvedRef[]>();
	for (const ref of resolved) {
		const list = byPath.get(ref.refPath);
		if (list) list.push(ref);
		else byPath.set(ref.refPath, [ref]);
	}

	// Replay the device's own naming over the agent's attachments IN ORDER rather than collapsing
	// them into a set: it renames each colliding entry, so two attachments sharing a basename take
	// two names, and a snapshot must not be told it owns the one the second attachment will get.
	const used = new Set<string>();
	for (const name of existingNames) uniqueName(safeName(name), used);
	used.add(MANIFEST_FILENAME);

	const entries: InternalEntry[] = [];
	const texts = new Map<string, string>();

	for (const [refPath, refs] of byPath) {
		const text = refs[0].text;
		texts.set(refPath, text);

		// A ref covering the whole file pins its file to full mode: there is no narrower region to
		// degrade to, so it must not be counted as snippet-eligible later.
		const total = lineCount(text);
		const coversWholeFile = refs.some((r) => r.resolution.startLine <= 1 && r.resolution.endLine >= total);

		const entry: InternalEntry = {
			refPath,
			filename: uniqueName(safeName(refPath), used),
			mode: "full",
			totalLines: total,
		};

		if (bytes(text) > MAX_FILE_BYTES) {
			if (coversWholeFile) {
				return {
					ok: false,
					error: `${refPath} exceeds the ${Math.floor(MAX_FILE_BYTES / 1024)} KB snapshot cap; add a scope or #matcher to reference a region`,
				};
			}
			entry.mode = "snippet";
			entry.segments = segmentsFor(
				text,
				refs.map((r) => r.resolution),
			);
			if (entryBytes(entry, text) > MAX_FILE_BYTES) {
				return {
					ok: false,
					error: `the region referenced in ${refPath} alone exceeds the ${Math.floor(MAX_FILE_BYTES / 1024)} KB snapshot cap; reference a smaller region`,
				};
			}
		} else if (!coversWholeFile) {
			entry.snippetEligible = true;
		}

		entries.push(entry);
	}

	const budgeted = applyBudget(entries, byPath, texts);
	if (!budgeted.ok) return budgeted;

	const manifest: Manifest = {
		[MANIFEST_MARKER]: 1,
		files: entries.map(stripInternal),
		refs: Object.fromEntries(
			resolved.map((r) => [
				r.found.key,
				{
					refPath: r.refPath,
					startLine: r.resolution.startLine,
					endLine: r.resolution.endLine,
					...(r.resolution.span ? { span: r.resolution.span } : {}),
					quality: r.resolution.quality,
					...(r.resolution.reason ? { reason: r.resolution.reason } : {}),
					...(r.resolution.ambiguous ? { ambiguous: true, matchCount: r.resolution.matchCount } : {}),
				},
			]),
		),
	};

	// The manifest is placed FIRST, which the selection rule depends on: the plugin adopts the first
	// entry that bears the reserved name AND validates, so no later file can displace it.
	const artifacts: BuiltArtifact[] = [
		{ filename: MANIFEST_FILENAME, content: JSON.stringify(manifest), mime: "application/json" },
		...entries.map((entry) => ({
			filename: entry.filename,
			content:
				entry.mode === "full"
					? (texts.get(entry.refPath) ?? "")
					: (entry.segments ?? []).map((s) => s.text).join("\n"),
			mime: "text/plain",
		})),
	];

	return { ok: true, artifacts, manifest };
}

function stripInternal(entry: InternalEntry): ManifestFileEntry {
	const { snippetEligible: _ignored, ...rest } = entry;
	return rest;
}

/**
 * Bring the message under the aggregate budget, degrading before refusing.
 *
 * Largest first, and only files that CAN be narrowed. A file pinned to full mode by a whole-file ref
 * is left alone, since snippeting it would ship a region its own ref does not point at. When
 * everything eligible has been degraded and it is still over, the send fails naming what to narrow,
 * because the agent is right there and can rewrite the message.
 */
function applyBudget(
	entries: InternalEntry[],
	byPath: Map<string, ResolvedRef[]>,
	texts: Map<string, string>,
): { ok: true } | { ok: false; error: string } {
	const total = () => entries.reduce((sum, e) => sum + entryBytes(e, texts.get(e.refPath) ?? ""), 0);
	if (total() <= MAX_TOTAL_BYTES) return { ok: true };

	const eligible = entries
		.filter((e) => e.snippetEligible === true)
		.sort((a, b) => bytes(texts.get(b.refPath) ?? "") - bytes(texts.get(a.refPath) ?? ""));

	for (const entry of eligible) {
		const text = texts.get(entry.refPath) ?? "";
		entry.mode = "snippet";
		entry.segments = segmentsFor(
			text,
			(byPath.get(entry.refPath) ?? []).map((r) => r.resolution),
		);
		if (total() <= MAX_TOTAL_BYTES) return { ok: true };
	}

	const biggest = [...entries]
		.sort((a, b) => entryBytes(b, texts.get(b.refPath) ?? "") - entryBytes(a, texts.get(a.refPath) ?? ""))
		.slice(0, 3)
		.map((e) => e.refPath);
	return {
		ok: false,
		error: `the referenced files exceed the ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB message budget; narrow the refs into ${biggest.join(", ")}`,
	};
}

function emptyManifest(): Manifest {
	return { [MANIFEST_MARKER]: 1, files: [], refs: {} };
}
