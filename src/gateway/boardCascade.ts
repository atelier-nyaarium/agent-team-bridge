import type { BoardEntry } from "../shared/console-protocol.js";

////////////////////////////////
//  Interfaces & Types

type BoardState = BoardEntry["state"];

/** Why an entry moved on its own. The tool turns these into the prose the agent reads. */
export type CascadeReason =
	/** Every live child finished, so the parent did too. */
	| "children_finished"
	/** An ancestor finished, so this one did too. */
	| "parent_finished"
	/** A descendant went back to unfinished, so this one reopened. */
	| "child_reopened";

export type CascadeChange = {
	id: string;
	title: string;
	from: BoardState;
	to: BoardState;
	reason: CascadeReason;
};

/** One entry to look at. `derive` says whether its OWN state is up for rederivation.
 *
 * False for anything the caller wrote or the cascade has already decided: that state is settled, and
 * rederiving it would undo the write. Reopening a parent whose children are all done is the case
 * that proves it, since rule one would close it again in the same breath and the owner could never
 * reopen anything. */
type Step = { id: string; derive: boolean };

////////////////////////////////
//  Functions & Helpers

const TERMINAL: ReadonlySet<BoardState> = new Set<BoardState>(["done", "cancelled"]);

export function isTerminal(state: BoardState): boolean {
	return TERMINAL.has(state);
}

/**
 * Bring a board back into agreement with itself after a direct write, in place.
 *
 * The rules run in BOTH directions and feed each other, so this is a work queue rather than a pass:
 * finishing a parent finishes its descendants, and finishing the last child finishes the parent,
 * which may in turn finish ITS parent.
 *
 * `written` are ids the caller set; their own state is authoritative, so each one only pushes down
 * and asks its parent to look again. `orphaned` are parents that LOST a live child to a trash, a
 * move or a delete. Those have to rederive themselves, and nothing else would ask them to: the
 * child is gone or elsewhere, so no walk up from it passes through here any more.
 *
 * A trashed entry is not a child for any purpose, which is what lets trashing the last unfinished
 * child complete its parent.
 *
 * The caller has already checked that IT was allowed to write the seeds. Nothing below is re-checked
 * against an actor, because a cascade is authored by the board, not by whoever moved the seed. The
 * alternative is a rule that fires or does not depending on who holds an entry the writer cannot
 * even see, which reports a subtly wrong board instead of an honest one.
 */
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
	// A board holding a parent cycle would otherwise walk forever. `wouldCycle` rejects one at the
	// write, so this is a backstop rather than the guard.
	let steps = 0;
	const ceiling = entries.size * 4 + 16;

	while (queue.length > 0 && steps++ < ceiling) {
		const step = queue.pop();
		if (step === undefined) continue;
		const entry = entries.get(step.id);
		if (!entry || entry.trashedAt !== undefined) continue;

		if (step.derive) {
			const settled = settledState(entry, children, entries);
			// An entry that does not move ends the walk: everything above it reads only this state.
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

		// A finished entry finishes what hangs off it. Already-terminal descendants keep the state they
		// have, since cancelling is a deliberate act that done should not overwrite.
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
 * nothing is left to work on and at least some of it was actually finished. */
function settledState(
	parent: BoardEntry,
	children: Map<string, string[]>,
	entries: Map<string, BoardEntry>,
): BoardState | undefined {
	const live = (children.get(parent.id) ?? []).map((id) => entries.get(id)).filter((e) => e !== undefined);
	if (live.length === 0) return undefined;
	if (live.every((c) => isTerminal(c.state))) {
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
