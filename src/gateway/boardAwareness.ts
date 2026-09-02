import type { AwarenessSubscriber, Change } from "../shared/awareness-types.js";
import { holds, visibleTo } from "../shared/board-authority.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { stableHash } from "../shared/plane-registry.js";

/** Edits use ids; arrivals and removals include titles. */
type BoardClassification =
	| { kind: "changed" }
	| { kind: "arrived"; title: string }
	| { kind: "backlog"; title: string }
	| { kind: "gone"; title: string; how: "trashed" | "removed" | "reassigned" };

const MAX_LISTED_IDS = 20;
const MAX_NAMED_LINES = 20;

const MAX_TITLE_CHARS = 80;

function quoted(title: string): string {
	const oneLine = title.replace(/\s+/g, " ").trim();
	const cut = [...oneLine].slice(0, MAX_TITLE_CHARS).join("");
	return `"${cut}${cut.length < oneLine.length ? "..." : ""}"`;
}

function classify(
	sessionKey: string,
	pre: BoardEntry | undefined,
	post: BoardEntry | undefined,
): BoardClassification | null {
	const held = holds(pre, sessionKey);
	const holdsNow = holds(post, sessionKey);
	if (!held && !holdsNow) return null;
	const title = (holdsNow ? post?.title : pre?.title) ?? "";
	if (!held) return { kind: "arrived", title };
	if (!holdsNow) {
		if (post === undefined) return { kind: "gone", title, how: "removed" };
		if (visibleTo(post, sessionKey)) return { kind: "backlog", title };
		if (post.trashedAt !== undefined) return { kind: "gone", title, how: "trashed" };
		return { kind: "gone", title, how: "reassigned" };
	}
	return stableHash(pre) === stableHash(post) ? null : { kind: "changed" };
}

function lineFor(c: Exclude<BoardClassification, { kind: "changed" }>): string {
	if (c.kind === "arrived") return `${quoted(c.title)} is yours.`;
	if (c.kind === "backlog") return `${quoted(c.title)} went back to the backlog.`;
	return `${quoted(c.title)} was ${c.how}.`;
}

function render(sessionKey: string, changes: readonly Change<BoardEntry>[]): string {
	const lines: string[] = [];
	const changed: string[] = [];
	const named: string[] = [];
	for (const change of changes) {
		const c = classify(sessionKey, change.pre, change.post);
		if (c === null) continue;
		if (c.kind === "changed") changed.push(change.identity);
		else named.push(lineFor(c));
	}
	if (changed.length === 1) lines.push(`The owner edited ${changed[0]}.`);
	else if (changed.length > 1) {
		const shown = changed.slice(0, MAX_LISTED_IDS);
		const rest = changed.length - shown.length;
		const tail = rest > 0 ? `, and ${rest} more` : "";
		lines.push(`The owner edited ${changed.length} entries you hold: ${shown.join(", ")}${tail}.`);
	}
	lines.push(...named.slice(0, MAX_NAMED_LINES));
	if (named.length > MAX_NAMED_LINES) lines.push(`And ${named.length - MAX_NAMED_LINES} more.`);
	return lines.join("\n");
}

/** Only disappearance arms an unsolicited push. */
export const boardAwarenessSubscriber: AwarenessSubscriber<BoardEntry> = {
	source: "task-board",
	act(sessionKey, pre, post) {
		return classify(sessionKey, pre, post)?.kind === "gone" ? "act_now" : "no_act";
	},
	render,
};
