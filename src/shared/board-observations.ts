import type { AwarenessObservation } from "./awareness-types.js";
import { type BoardActor, holds } from "./board-authority.js";
import type { BoardEntry } from "./console-protocol.js";

type OwnerBoard = { revision: number; entries: Map<string, BoardEntry> };

/** Classify net entry changes for prior and new holders. */
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
			if (writer.kind === "session" && writer.sessionId === sessionKey) continue;
			if (!holds(pre, sessionKey) && !holds(post, sessionKey)) continue;
			observations.push({ sessionKey, identity, pre, post });
		}
	}
	return observations;
}
