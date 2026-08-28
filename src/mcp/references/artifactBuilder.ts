import { REF_META_MAX_KEYS, REF_META_MAX_SEGMENTS, type RefFileMeta } from "../../shared/channel-file.js";
import { safeName, uniqueName } from "./artifactNames.js";
import type { Resolution } from "./refCoordinates.js";
import type { FoundRef } from "./refScanner.js";

////////////////////////////////
//  Interfaces & Types

/** A ref that resolved, ready to become snapshot metadata. */
export interface ResolvedRef {
	found: FoundRef;
	/** Also the snapshot's identity: one per file however many refs point into it. */
	refPath: string;
	text: string;
	resolution: Resolution;
}

/** One contiguous piece of a file, in ORIGINAL-file coordinates. */
export interface Segment {
	startLine: number;
	text: string;
}

/** Never ships. The wire form is the `ref` block, derived at the end. */
interface InternalEntry {
	refPath: string;
	filename: string;
	mode: "full" | "snippet";
	segments?: Segment[];
	snippetEligible?: boolean;
}

export interface BuiltArtifact {
	filename: string;
	/** UTF-8 text. The caller stages it onto the blob plane. */
	content: string;
	mime: string;
	/** The content IS these segments joined with newlines, so the line ranges partition it exactly. */
	ref: RefFileMeta;
}

export type BuildResult = { ok: true; artifacts: BuiltArtifact[] } | { ok: false; error: string };

////////////////////////////////
//  Functions & Helpers

/** Narrowed by the ref, never truncated: a truncated snapshot would not hold what the ref points
 * at. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Everything one message may attach, decoded. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const CONTEXT_LINES = 3;

function lineCount(text: string): number {
	return text.split("\n").length;
}

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Overlapping windows merge, or nearby refs would re-inflate a snippet past the cap that produced
 * it. */
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

function entryBytes(entry: InternalEntry, fullText: string): number {
	if (entry.mode === "full") return bytes(fullText);
	return (entry.segments ?? []).reduce((sum, s) => sum + bytes(s.text), 0);
}

/** `existingNames` is the agent's own attachments, so naming dedupes across the whole files array.
 * Naming is display-only: the console pairs a ref through the `ref` block. */
export function buildArtifacts(resolved: ResolvedRef[], existingNames: string[]): BuildResult {
	if (resolved.length === 0) return { ok: true, artifacts: [] };

	// One entry per FILE, in first-referenced order.
	const byPath = new Map<string, ResolvedRef[]>();
	for (const ref of resolved) {
		const list = byPath.get(ref.refPath);
		if (list) list.push(ref);
		else byPath.set(ref.refPath, [ref]);
	}

	// Replayed IN ORDER, not collapsed to a set: two attachments sharing a basename take two names.
	const used = new Set<string>();
	for (const name of existingNames) uniqueName(safeName(name), used);

	const entries: InternalEntry[] = [];
	const texts = new Map<string, string>();

	for (const [refPath, refs] of byPath) {
		const text = refs[0].text;
		texts.set(refPath, text);

		// A whole-file ref pins full mode: there is no narrower region to degrade to.
		const total = lineCount(text);
		const coversWholeFile = refs.some((r) => r.resolution.startLine <= 1 && r.resolution.endLine >= total);

		const entry: InternalEntry = {
			refPath,
			filename: uniqueName(safeName(refPath), used),
			mode: "full",
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

	// Refused loudly: a dropped key would be a ref that taps dead with no error anywhere.
	const artifacts: BuiltArtifact[] = [];
	for (const entry of entries) {
		const refs = byPath.get(entry.refPath) ?? [];
		// Last write wins on a duplicate canonical key, preserving the old keyed-record semantics.
		const keyed = new Map<string, ResolvedRef>();
		for (const r of refs) keyed.set(r.found.key, r);
		if (keyed.size > REF_META_MAX_KEYS) {
			return {
				ok: false,
				error: `${entry.refPath} is referenced by ${keyed.size} distinct refs, over the ${REF_META_MAX_KEYS} cap`,
			};
		}
		const segments = entry.mode === "snippet" ? (entry.segments ?? []) : undefined;
		if (segments && segments.length > REF_META_MAX_SEGMENTS) {
			return {
				ok: false,
				error: `${entry.refPath} needs ${segments.length} snippet segments, over the ${REF_META_MAX_SEGMENTS} cap; reference fewer regions`,
			};
		}
		artifacts.push({
			filename: entry.filename,
			content:
				entry.mode === "full"
					? (texts.get(entry.refPath) ?? "")
					: (segments ?? []).map((s) => s.text).join("\n"),
			mime: "text/plain",
			ref: {
				refPath: entry.refPath,
				...(segments
					? {
							segments: segments.map((s) => ({
								startLine: s.startLine,
								lineCount: s.text.split("\n").length,
							})),
						}
					: {}),
				keys: [...keyed.values()].map((r) => ({
					key: r.found.key,
					startLine: r.resolution.startLine,
					endLine: r.resolution.endLine,
					...(r.resolution.span ? { span: r.resolution.span } : {}),
					quality: r.resolution.quality,
					...(r.resolution.reason ? { reason: r.resolution.reason } : {}),
				})),
			},
		});
	}

	return { ok: true, artifacts };
}

/**
 * Degrade before refusing: largest first, and only files that CAN be narrowed.
 *
 * Once everything eligible is degraded and it is still over, the send fails naming what to narrow,
 * since the agent is right there and can rewrite the message.
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
