// The pipeline from a found ref to a resolution, in one order: the file tier, then the index with
// the answer bound to the file's bytes. Refusal for what an author can fix, with the fix to paste;
// degradation only for what lexicon cannot answer, and then the reply says so.

import type { ChainAnswer, ChainCandidate, Session } from "@nyaa-lexicon/client";
import { DaemonError, Incompatible, NotInstalled } from "@nyaa-lexicon/client";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { ResolvedRef } from "./artifactBuilder.js";
import { lineCount, lineOf, linesOf, offsetsOf, type Resolution, type Span, spanAt, spanOf } from "./refCoordinates.js";
import type { LoadResult } from "./refFile.js";
import { canonicalKey, type Matcher, type Ref } from "./refGrammar.js";
import { type DegradeCause, noticeFor, type Refusal, reasonFor, renderRefusal } from "./refNotices.js";
import type { FoundRef } from "./refScanner.js";
import { classifyPath, identityOf, type WorkspaceRoot } from "./refWorkspace.js";

////////////////////////////////
//  Interfaces & Types

export interface ResolveDeps {
	workspace: WorkspaceRoot;
	/** Lazy: a message with no chain inside the root never opens a session. */
	session: () => Promise<Session>;
	load: (absolute: string, written: string) => LoadResult;
	/** Epoch ms after which no ref waits on the index; the reply as a whole stays under the caller's timeout. */
	deadline: number;
}

/** The first spelling seen for a file's identity, so two spellings of one file ship one snapshot. */
type Spelling = (absolute: string, written: string) => string;

export type ResolveOutcome = { ok: true; resolved: ResolvedRef[]; notices: string[] } | { ok: false; error: string };

type Notice = { cause: DegradeCause; text: string };

type OneOutcome = { kind: "resolved"; ref: ResolvedRef; notice?: Notice } | { kind: "refused"; refusal: Refusal };

type MatcherOutcome = { ok: true; resolution: Partial<Resolution> } | { ok: false; error: string };

/** The reply's budget ran out before the index answered; the ref degrades as warming. */
class BudgetSpent extends Error {}

/** Every ask of the daemon runs against what is left of the reply's budget, never past it. */
async function withinBudget<T>(deadline: number, work: () => Promise<T>): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new BudgetSpent();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BudgetSpent()), remaining);
	});
	try {
		return await Promise.race([work(), expiry]);
	} finally {
		clearTimeout(timer);
	}
}

////////////////////////////////
//  Functions & Helpers

/** Every ref is resolved before any refusal, so one reply's problems arrive together. */
export async function resolveRefs(found: FoundRef[], deps: ResolveDeps): Promise<ResolveOutcome> {
	const resolved: ResolvedRef[] = [];
	const refusals: string[] = [];
	const notices = new Map<DegradeCause, string>();
	const spellings = new Map<string, string>();
	const spelling: Spelling = (absolute, written) => {
		const identity = identityOf(absolute);
		const first = spellings.get(identity);
		if (first !== undefined) return first;
		spellings.set(identity, written);
		return written;
	};
	for (const entry of found) {
		const one = await resolveOne(entry, deps, spelling);
		if (one.kind === "refused") {
			refusals.push(`${entry.raw}: ${renderRefusal(one.refusal)}`);
			continue;
		}
		resolved.push(one.ref);
		if (one.notice !== undefined) notices.set(one.notice.cause, one.notice.text);
	}
	if (refusals.length > 0) return { ok: false, error: refusals.join("\n") };
	return { ok: true, resolved, notices: [...notices.values()] };
}

/** The `#text` spelling of this ref, offered wherever a chain cannot be answered. */
function textForm(ref: Ref): string {
	const hint = ref.matcher ?? { kind: "text" as const, text: ref.segments.at(-1) ?? "text" };
	return canonicalKey({ path: ref.path, segments: [], matcher: hint });
}

function chainOf(ref: Ref): string {
	return canonicalKey({ path: ref.path, segments: ref.segments, matcher: null });
}

async function resolveOne(entry: FoundRef, deps: ResolveDeps, spelling: Spelling): Promise<OneOutcome> {
	const { ref } = entry;
	const place = classifyPath(deps.workspace.root, ref.path);
	const loaded = deps.load(place.absolute, ref.path);
	if (!loaded.ok) return { kind: "refused", refusal: { kind: "file", detail: loaded.detail } };
	let text = loaded.file.text;
	const refPath = spelling(place.absolute, ref.path);

	const done = (resolution: Resolution, notice?: Notice): OneOutcome => ({
		kind: "resolved",
		ref: { found: entry, refPath, text, resolution },
		...(notice === undefined ? {} : { notice }),
	});

	// No chain: the whole file, or a matcher over it. The daemon is never touched.
	if (ref.segments.length === 0) {
		const whole: Resolution = { startLine: 1, endLine: lineCount(text), quality: "exact" };
		if (ref.matcher === null) return done(whole);
		const matched = applyMatcher(text, 0, text.length, ref.matcher);
		if (matched.ok) return done({ ...whole, ...matched.resolution });
		return { kind: "refused", refusal: { kind: "matcher", detail: matched.error } };
	}

	if (place.kind === "outside") {
		return {
			kind: "refused",
			refusal: { kind: "outsideChain", root: deps.workspace.root, textForm: textForm(ref) },
		};
	}
	if (!deps.workspace.admitted) {
		return done(...degraded(text, ref, "noWorkspace", deps.workspace.reason));
	}

	const { module } = place;
	try {
		const session = await withinBudget(deps.deadline, deps.session);
		const chain = () => withinBudget(deps.deadline, () => session.resolveChain(module, ref.segments));
		let answer = await chain();

		// Bound to the bytes: the snapshot and the answer must describe one version of the file. The
		// index behind the disk is brought up once; a file that moved under the reply is read again
		// once; a file still moving after that is one to send again.
		let snapshot = hashContent(text);
		let broughtUp = false;
		let reread = false;
		while (bearsContent(answer) && answer.contentHash !== snapshot) {
			if (answer.diskHash === snapshot && !broughtUp) {
				broughtUp = true;
				await withinBudget(deps.deadline, () => session.awaitIndexed(module));
				answer = await chain();
			} else if (answer.diskHash !== null && answer.diskHash !== snapshot && !reread) {
				reread = true;
				const again = deps.load(place.absolute, ref.path);
				if (!again.ok) return { kind: "refused", refusal: { kind: "file", detail: again.detail } };
				text = again.file.text;
				snapshot = hashContent(text);
				answer = await chain();
			} else break;
		}
		if (bearsContent(answer) && answer.kind !== "none" && answer.contentHash !== snapshot) {
			return { kind: "refused", refusal: { kind: "disagree", path: ref.path, textForm: textForm(ref) } };
		}

		if (answer.kind === "none") return noneOutcome(answer, ref, text, done);
		if (answer.kind === "ambiguous") {
			const resolveTo = (segments: string[]) =>
				withinBudget(deps.deadline, () => session.resolveChain(module, segments));
			return await ambiguousOutcome(answer.candidates, ref, resolveTo);
		}
		return exactOutcome(answer.candidate, ref, text, done);
	} catch (error) {
		const cause = causeOf(error);
		if (cause === null) throw error;
		return done(...degraded(text, ref, cause.cause, cause.detail));
	}
}

/** Whether the answer's hashes speak for the file: a refusal of the file itself carries none. */
function bearsContent(answer: ChainAnswer): boolean {
	if (answer.kind !== "none") return true;
	return answer.reason === "noMatch" || answer.reason === "parseFailed" || answer.reason === "unread";
}

function exactOutcome(
	candidate: ChainCandidate,
	ref: Ref,
	text: string,
	done: (resolution: Resolution) => OneOutcome,
): OneOutcome {
	const lines = linesOf(candidate.range);
	// A parameter list has no name of its own, so its whole range lights.
	const span: Span = spanOf(candidate.selectionRange ?? candidate.range);
	const base: Resolution = { ...lines, span, quality: "exact" };
	if (ref.matcher === null) return done(base);

	const scope = offsetsOf(text, candidate.range);
	const matched = applyMatcher(text, scope.start, scope.end, ref.matcher);
	if (!matched.ok) {
		return {
			kind: "refused",
			refusal: { kind: "matcher", detail: matched.error, scope: { chain: chainOf(ref), ...lines } },
		};
	}
	const { span: _span, ...withoutSpan } = base;
	return done({ ...withoutSpan, ...matched.resolution });
}

/** Each candidate is offered as a ref that resolves to it alone, and only after it has been seen to. */
async function ambiguousOutcome(
	candidates: ChainCandidate[],
	ref: Ref,
	resolveTo: (segments: string[]) => Promise<ChainAnswer>,
): Promise<OneOutcome> {
	const offers: string[] = [];
	for (const candidate of candidates) {
		const again = await resolveTo(candidate.segments);
		if (again.kind !== "exact") continue;
		offers.push(canonicalKey({ path: ref.path, segments: candidate.segments, matcher: ref.matcher }));
	}
	return {
		kind: "refused",
		refusal: { kind: "ambiguous", chain: chainOf(ref), count: candidates.length, offers, textForm: textForm(ref) },
	};
}

function noneOutcome(
	answer: Extract<ChainAnswer, { kind: "none" }>,
	ref: Ref,
	text: string,
	done: (resolution: Resolution, notice?: Notice) => OneOutcome,
): OneOutcome {
	const refused = (refusal: Refusal): OneOutcome => ({ kind: "refused", refusal });
	switch (answer.reason) {
		case "missing":
			return refused({ kind: "vanished", path: ref.path });
		case "unclaimed":
			return refused({ kind: "unclaimed", path: ref.path, detail: answer.detail, textForm: textForm(ref) });
		case "parseFailed":
			return refused({ kind: "parseFailed", path: ref.path, detail: answer.detail, textForm: textForm(ref) });
		case "binary":
		case "tooLarge":
			return done(...degraded(text, ref, "indexRefused", answer.detail));
		case "unread":
			return done(...degraded(text, ref, "warming", answer.detail));
		case "noMatch":
			return refused(noMatchRefusal(answer, ref));
	}
}

/** How far the chain got and what is declared there, so the refusal carries the fix. */
function noMatchRefusal(answer: Extract<ChainAnswer, { kind: "none" }>, ref: Ref): Refusal {
	const failing = ref.segments[answer.matched.consumed] ?? ref.segments.at(-1) ?? "";
	const where =
		answer.matched.consumed === 0 || answer.matched.containerPaths.length === 0
			? `in ${ref.path}`
			: `under ${answer.matched.containerPaths.map((path) => path.join(":")).join(" or ")}`;
	return {
		kind: "noMatch",
		failing,
		where,
		count: answer.matched.count,
		available: answer.available,
		availableTotal: answer.availableTotal,
		textForm: textForm(ref),
	};
}

/** The text tier, only ever reached when lexicon could not answer: the last segment's first occurrence, else the whole file. */
function degraded(text: string, ref: Ref, cause: DegradeCause, detail?: string): [Resolution, Notice] {
	const notice: Notice = { cause, text: noticeFor(cause, detail) };
	for (let i = ref.segments.length - 1; i >= 0; i--) {
		const segment = (ref.segments[i] ?? "").replace(/\[\d+\]$/, "");
		if (segment === "" || segment === "arguments") continue;
		const at = text.indexOf(segment);
		if (at === -1) continue;
		const line = lineOf(text, at);
		return [
			{
				startLine: line,
				endLine: line,
				span: spanAt(text, at, segment.length),
				quality: "fuzzy",
				reason: reasonFor(cause, detail, `matched ${JSON.stringify(segment)} by text`),
			},
			notice,
		];
	}
	return [
		{
			startLine: 1,
			endLine: lineCount(text),
			quality: "unresolved",
			reason: reasonFor(cause, detail, `no segment matched by text`),
		},
		notice,
	];
}

/** The closed causes lexicon's own errors map to; anything else is not lexicon's absence and propagates. */
function causeOf(error: unknown): { cause: DegradeCause; detail?: string } | null {
	if (error instanceof BudgetSpent) {
		return { cause: "warming", detail: `the reply's budget ran out before the index answered` };
	}
	if (error instanceof NotInstalled) return { cause: "notInstalled", detail: error.message };
	if (error instanceof Incompatible) return { cause: "incompatible", detail: error.message };
	if (error instanceof DaemonError) {
		if (error.waitingFor !== undefined) return { cause: "warming", detail: `waiting on ${error.waitingFor}` };
		if (error.cause === "connectionLost") return { cause: "connectionLost", detail: error.message };
		return { cause: "daemonError", detail: error.message };
	}
	return null;
}

////////////////////////////////
//  Matchers

/** The occurrence of `needle` nearest before `pivot`, or -1. */
function nearestBefore(text: string, needle: string, pivot: number): number {
	return needle === "" ? -1 : text.lastIndexOf(needle, Math.max(0, pivot - needle.length));
}

/** A miss is the author's to fix, so it refuses with what was not found. */
function applyMatcher(text: string, scopeStart: number, scopeEnd: number, matcher: Matcher): MatcherOutcome {
	const scope = text.slice(scopeStart, scopeEnd);
	const absolute = (local: number) => scopeStart + local;
	const first = (needle: string, from = 0) => (needle === "" ? -1 : scope.indexOf(needle, from));

	switch (matcher.kind) {
		case "text": {
			const at = first(matcher.text);
			if (at === -1) return { ok: false, error: `no match for ${JSON.stringify(matcher.text)}` };
			return {
				ok: true,
				resolution: { span: spanAt(text, absolute(at), matcher.text.length), quality: "exact" },
			};
		}
		case "before":
		case "after": {
			const anchorAt = first(matcher.anchor);
			if (anchorAt === -1) return { ok: false, error: `anchor ${JSON.stringify(matcher.anchor)} not found` };
			const at =
				matcher.kind === "before"
					? nearestBefore(scope, matcher.text, anchorAt)
					: first(matcher.text, anchorAt + matcher.anchor.length);
			if (at === -1) {
				return {
					ok: false,
					error: `no ${JSON.stringify(matcher.text)} ${matcher.kind} ${JSON.stringify(matcher.anchor)}`,
				};
			}
			return {
				ok: true,
				resolution: { span: spanAt(text, absolute(at), matcher.text.length), quality: "exact" },
			};
		}
		case "range": {
			const fromAt = first(matcher.from);
			if (fromAt === -1) return { ok: false, error: `no match for ${JSON.stringify(matcher.from)}` };
			const toAt = first(matcher.to, fromAt + matcher.from.length);
			if (toAt === -1) {
				return {
					ok: false,
					error: `range end ${JSON.stringify(matcher.to)} not found after ${JSON.stringify(matcher.from)}`,
				};
			}
			return {
				ok: true,
				resolution: {
					startLine: lineOf(text, absolute(fromAt)),
					endLine: lineOf(text, absolute(toAt + matcher.to.length)),
					quality: "exact",
				},
			};
		}
	}
}
