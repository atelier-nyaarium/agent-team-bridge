import type { BoardEntry } from "../shared/console-protocol.js";
import type { CascadeChange } from "./boardCascade.js";

////////////////////////////////
//  Interfaces & Types

/** Every way a board write can be told it will NEVER apply. This vocabulary is load-bearing: it is
 * the one signal that retires a queued console action, which means it permanently discards the
 * owner's edit. `session_missing` is detectable only at the console edge, but it is a refusal in
 * exactly the same sense, so it lives here rather than as a loose string there. */
export type BoardRefusal =
	| "entry_missing"
	| "parent_missing"
	| "cycle"
	| "held"
	| "would_orphan"
	| "board_full"
	| "bad_rank"
	| "session_missing";

/** `cascaded` names the entries the board moved on its own alongside the caller's write, so the
 * caller can say so rather than let a state change appear out of nowhere. Absent when nothing moved. */
export type BoardResult =
	| { applied: true; cascaded?: readonly CascadeChange[] }
	| { applied: false; refused: BoardRefusal };

/** What becomes of a session's unfinished entries when it ends. */
export type BoardDisposition = "release" | "cancel";

/** Who is writing. A VALUE every mutating call must supply, never an absence a caller can fall
 * into: omitting a session id used to mean "no scope check", so a route that forgot one wrote
 * unconditionally. The `sessionAuthority.ts` rule, applied to the board. */
export type BoardActor = { kind: "owner" } | { kind: "session"; sessionId: string };

////////////////////////////////
//  Functions & Helpers

/** The owner's own authority, for the console (their device) and the sweeps. Named rather than
 * spelled out at each site, so grepping it lists every place owner authority is claimed. */
export const OWNER_ACTOR: BoardActor = { kind: "owner" };

/**
 * May this actor touch this entry? The owner anything; a session only what it holds, and never
 * anything in the trash - that is the owner's own set-aside, and a session's list has already
 * stopped showing it.
 *
 * The SAME rule answers the entry being written and any parent it is attached to. Nesting was
 * briefly looser, allowing a session to hang work off a BACKLOG entry: that left the entry
 * advertised as unclaimed while `claim`'s subtree rule refused every other session, with nothing in
 * any list explaining why. A session breaking a backlog item down claims it first.
 */
export function mayWrite(entry: BoardEntry, actor: BoardActor): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	return entry.sessionId === actor.sessionId ? undefined : "held";
}

/** Whether a session's own default list would return this entry. The ONE owner of that rule: the
 * route filters with it and the notice classifier decides visibility with it, so a change to what a
 * session can see cannot leave the two disagreeing about what it is told. */
export function visibleTo(entry: BoardEntry | undefined, sessionId: string): boolean {
	if (!entry || entry.trashedAt !== undefined) return false;
	return entry.sessionId === undefined || entry.sessionId === sessionId;
}

/** Whether this session may write the entry, which is also what it means to hold it. */
export function holds(entry: BoardEntry | undefined, sessionId: string): boolean {
	return entry !== undefined && mayWrite(entry, { kind: "session", sessionId }) === undefined;
}

/** The wire marker the console retires an action on. Declared once, beside the vocabulary it
 * prefixes; a residue test keeps it that way, because any other throw whose message happens to
 * start with it would silently discard an owner's edit. */
export const BOARD_REFUSED_PREFIX = "refused: ";

/** The one way to raise a refusal from a throwing path. */
export function refusalError(refused: BoardRefusal): Error {
	return new Error(`${BOARD_REFUSED_PREFIX}${refused}`);
}
