import type { BoardEntry } from "../shared/console-protocol.js";
import { stableHash } from "../shared/plane-registry.js";
import { type BoardActor, holds, visibleTo } from "./boardAuthority.js";

////////////////////////////////
//  Interfaces & Types

/** `boardStore.ts`'s per-owner snapshot, restated structurally so the store's own declaration stays
 * private and the two modules do not cycle; the store's `mutate` call site type-checks this copy. */
type OwnerBoard = { revision: number; entries: Map<string, BoardEntry> };

/** What a session is told about a write to board work it holds, or is about to. Everything except an
 * edit carries the TITLE: the id stops resolving once the entry leaves that session's list, and an
 * arrival names work the session may never have seen. An edit does not, since a re-read resolves it. */
export type BoardNotice = { sessionId: string; entryId: string } & (
	| { kind: "changed" }
	// One wording for both an assignment and something coming back out of the trash: a reassign made
	// WHILE trashed leaves the pre-state already naming the new session, so the two are not
	// distinguishable from pre/post alone, and "is yours" is true either way.
	| { kind: "arrived"; title: string }
	| { kind: "backlog"; title: string }
	| { kind: "gone"; title: string; how: "trashed" | "removed" | "reassigned" }
);

////////////////////////////////
//  Functions & Helpers

/**
 * Classified per entry from pre/post against `mayWrite` and `visibleTo`, never from which method ran,
 * so a method gaining a caller cannot change what is announced.
 *
 * BOTH holders are addressees. Reading only the pre-state would leave a session silent about work it
 * just gained, and would let a take-away sit in its bank uncorrected when the owner immediately
 * undoes one: the arrival overwrites that bank entry, which is the whole reason the bank keys on id.
 */
export function noticesFor(
	prev: OwnerBoard,
	next: OwnerBoard,
	touched: ReadonlySet<string>,
	writer: BoardActor,
): BoardNotice[] {
	const notices: BoardNotice[] = [];
	for (const entryId of touched) {
		const pre = prev.entries.get(entryId);
		const post = next.entries.get(entryId);
		const parties = new Set([pre?.sessionId, post?.sessionId].filter((s) => s !== undefined));
		for (const sessionId of parties) {
			// mayWrite guarantees a session holds what it writes, so every route write is a self-echo and
			// the board's highest-volume writer would otherwise announce its own work to itself.
			if (writer.kind === "session" && writer.sessionId === sessionId) continue;
			const held = holds(pre, sessionId);
			const holdsNow = holds(post, sessionId);
			if (!held && !holdsNow) continue;
			const title = (holdsNow ? post?.title : pre?.title) ?? "";
			if (!held) {
				notices.push({ sessionId, entryId, kind: "arrived", title });
			} else if (!holdsNow) {
				if (post === undefined) notices.push({ sessionId, entryId, kind: "gone", title, how: "removed" });
				else if (visibleTo(post, sessionId)) notices.push({ sessionId, entryId, kind: "backlog", title });
				else if (post.trashedAt !== undefined)
					notices.push({ sessionId, entryId, kind: "gone", title, how: "trashed" });
				else notices.push({ sessionId, entryId, kind: "gone", title, how: "reassigned" });
			} else if (stableHash(pre) !== stableHash(post)) {
				// A commit spanning many entries reaches here for each; a value-identical one is not news.
				notices.push({ sessionId, entryId, kind: "changed" });
			}
		}
	}
	return notices;
}
