import type { BoardEntry } from "./console-protocol.js";

type BoardState = BoardEntry["state"];

export type CascadeReason = "children_finished" | "parent_finished" | "child_reopened";

export type CascadeChange = {
	id: string;
	title: string;
	from: BoardState;
	to: BoardState;
	reason: CascadeReason;
};

/** Queue item; `derive` permits state rederivation. */
type Step = { id: string; derive: boolean };

const TERMINAL: ReadonlySet<BoardState> = new Set<BoardState>(["done", "cancelled"]);

export function isTerminal(state: BoardState): boolean {
	return TERMINAL.has(state);
}

/** Cascades direct writes through live parent and child relationships. */
export function applyCascade(
	entries: Map<string, BoardEntry>,
	written: readonly string[],
	orphaned: readonly string[] = [],
): CascadeChange[] {
	const children = liveChildren(entries);
	const changes: CascadeChange[] = [];
	const queue: Step[] = [
		...written.map((id) => ({ id, derive: false })),
		...orphaned.map((id) => ({ id, derive: true })),
	];
	// Bounds traversal if corrupted data contains a cycle.
	let steps = 0;
	const ceiling = entries.size * 4 + 16;

	while (queue.length > 0 && steps++ < ceiling) {
		const step = queue.pop();
		if (step === undefined) continue;
		const entry = entries.get(step.id);
		if (!entry || entry.trashedAt !== undefined) continue;

		if (step.derive) {
			const settled = settledState(entry, children, entries);
			if (settled === undefined || settled === entry.state) continue;
			changes.push({
				id: entry.id,
				title: entry.title,
				from: entry.state,
				to: settled,
				reason: isTerminal(settled) ? "children_finished" : "child_reopened",
			});
			entry.state = settled;
			queue.push({ id: entry.id, derive: false });
			continue;
		}

		// Terminal parents propagate only to non-terminal descendants.
		if (isTerminal(entry.state)) {
			for (const childId of children.get(entry.id) ?? []) {
				const child = entries.get(childId);
				if (!child || isTerminal(child.state)) continue;
				changes.push({
					id: child.id,
					title: child.title,
					from: child.state,
					to: entry.state,
					reason: "parent_finished",
				});
				child.state = entry.state;
				queue.push({ id: child.id, derive: false });
			}
		}
		if (entry.parent !== undefined) queue.push({ id: entry.parent, derive: true });
	}
	return changes;
}

/** What a parent's own children say it should be, or undefined when they say nothing.
 *
 * A parent with no live children is left alone: a leaf is not something to auto-complete, and
 * trashing every child turns a parent back into one. Mixed done and cancelled reads as done, since
 * nothing is left to work on and at least some of it was actually finished.
 *
 * Children only ever FINISH a parent that was unfinished. They never move one terminal state to the
 * other, because which one it is was a deliberate choice: a cancelled parent keeping a done child
 * would otherwise turn itself into done the next time anything near it moved. Going back to
 * unfinished is the one exception, since that is the whole point of the reopen rule. */
function settledState(
	parent: BoardEntry,
	children: Map<string, string[]>,
	entries: Map<string, BoardEntry>,
): BoardState | undefined {
	const live = (children.get(parent.id) ?? []).map((id) => entries.get(id)).filter((e) => e !== undefined);
	if (live.length === 0) return undefined;
	if (live.every((c) => isTerminal(c.state))) {
		if (isTerminal(parent.state)) return undefined;
		return live.some((c) => c.state === "done") ? "done" : "cancelled";
	}
	return isTerminal(parent.state) ? "open" : undefined;
}

function liveChildren(entries: Map<string, BoardEntry>): Map<string, string[]> {
	const children = new Map<string, string[]>();
	for (const e of entries.values()) {
		if (e.parent === undefined || e.trashedAt !== undefined) continue;
		const list = children.get(e.parent);
		if (list) list.push(e.id);
		else children.set(e.parent, [e.id]);
	}
	return children;
}
