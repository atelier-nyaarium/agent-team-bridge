import type { BoardEntry } from "../shared/console-protocol.js";
import { stableHash } from "../shared/plane-registry.js";
import type { AwarenessObservation, AwarenessSubscriber, Change } from "./awarenessBank.js";
import { type BoardActor, holds, visibleTo } from "./boardAuthority.js";

////////////////////////////////
//  Interfaces & Types

/** `boardStore.ts`'s per-owner snapshot, restated structurally so the store's own declaration stays
 * private and the two modules do not cycle. */
type OwnerBoard = { revision: number; entries: Map<string, BoardEntry> };

/** What one net pair means to one session. Everything but an edit carries the title, since the id
 * stops resolving once the entry leaves that session's list and an arrival names work the session
 * may never have seen. An edit carries the id alone, because a re-read resolves it. */
type BoardClassification =
	| { kind: "changed" }
	| { kind: "arrived"; title: string }
	| { kind: "backlog"; title: string }
	| { kind: "gone"; title: string; how: "trashed" | "removed" | "reassigned" };

////////////////////////////////
//  Constants

/** Body bounds. One console tap can trash a subtree of thousands in one commit, and every line of it
 * would otherwise land in a session that asked for nothing. */
const MAX_LISTED_IDS = 20;
const MAX_NAMED_LINES = 20;

/** A title is 500 characters on the wire, and 20 of them at that length is a lot to hand a session
 * unasked. */
const MAX_TITLE_CHARS = 80;

////////////////////////////////
//  Functions & Helpers

/**
 * Who to tell about a write, with the entry as it was and as it is. Classification waits for the
 * flush, so a run of writes to one entry is judged on its net pair.
 *
 * Both holders are addressees. Reading only the pre-state would leave a session silent about work it
 * just gained.
 */
export function observationsFor(
	prev: OwnerBoard,
	next: OwnerBoard,
	touched: ReadonlySet<string>,
	writer: BoardActor,
): AwarenessObservation<BoardEntry>[] {
	const observations: AwarenessObservation<BoardEntry>[] = [];
	for (const identity of touched) {
		const pre = prev.entries.get(identity);
		const post = next.entries.get(identity);
		const parties = new Set(
			[pre?.sessionId, post?.sessionId].filter((session): session is string => session !== undefined),
		);
		for (const sessionKey of parties) {
			// mayWrite guarantees a session holds what it writes, so every route write is a self-echo
			// and the board's highest-volume writer would otherwise announce its own work to itself.
			if (writer.kind === "session" && writer.sessionId === sessionKey) continue;
			if (!holds(pre, sessionKey) && !holds(post, sessionKey)) continue;
			observations.push({ sessionKey, identity, pre, post });
		}
	}
	return observations;
}

function quoted(title: string): string {
	const oneLine = title.replace(/\s+/g, " ").trim();
	const cut = [...oneLine].slice(0, MAX_TITLE_CHARS).join("");
	return `"${cut}${cut.length < oneLine.length ? "..." : ""}"`;
}

/** Null when the pair is not news to this session: never held, or held throughout and unchanged. */
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

/** States what happened and stops: no suggested next step, and never that a released entry can be
 * claimed again. */
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

////////////////////////////////
//  Subscriber

/** Gone is the one case where continuing is wrong, so it is the one that may push on its own. A
 * release to the backlog is visible work the session simply no longer holds. */
export const boardAwarenessSubscriber: AwarenessSubscriber<BoardEntry> = {
	source: "task-board",
	act(sessionKey, pre, post) {
		return classify(sessionKey, pre, post)?.kind === "gone" ? "act_now" : "no_act";
	},
	render,
};
