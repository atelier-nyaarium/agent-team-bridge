import type { BoardEntry } from "../shared/console-protocol.js";
import type { CascadeChange } from "./board-cascade.js";

/** Refusals permanently retire queued console actions. The list is the type, so a reader that
 * validates one cannot drift from the writers that mint them. */
export const BOARD_REFUSALS = [
	"entry_missing",
	"parent_missing",
	"cycle",
	"held",
	"would_orphan",
	"board_full",
	"bad_rank",
	"attachment_missing",
	"session_missing",
	"durability_failure",
	"operation_id_reused",
] as const;

export type BoardRefusal = (typeof BOARD_REFUSALS)[number];

/** `cascaded` lists entries changed by the board. */
export type BoardResult =
	| { applied: true; cascaded?: readonly CascadeChange[] }
	| { applied: false; refused: BoardRefusal }
	// Deliberately NOT a BoardRefusal: a refusal retires a queued action permanently, and the fence
	// is a window the caller waits out.
	| { applied: false; migrating: true };

export type BoardDisposition = "release" | "cancel";

/** Every mutating call must provide an actor. */
export type BoardActor = { kind: "owner" } | { kind: "session"; sessionId: string };

/** Owner authority for console writes and sweeps. */
export const OWNER_ACTOR: BoardActor = { kind: "owner" };

/** Sessions may write only entries they hold and that are not trashed. */
export function mayWrite(entry: BoardEntry, actor: BoardActor): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	return entry.sessionId === actor.sessionId ? undefined : "held";
}

/** Claim and release require holder authority. */
export function mayTake(entry: BoardEntry, actor: BoardActor, next: string | undefined): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	if (entry.sessionId !== undefined && entry.sessionId !== actor.sessionId) return "held";
	return next === undefined || next === actor.sessionId ? undefined : "held";
}

/** Shared visibility rule for board reads and notices. */
export function visibleTo(entry: BoardEntry | undefined, sessionId: string): boolean {
	if (!entry || entry.trashedAt !== undefined) return false;
	return entry.sessionId === undefined || entry.sessionId === sessionId;
}

export function holds(entry: BoardEntry | undefined, sessionId: string): boolean {
	return entry !== undefined && mayWrite(entry, { kind: "session", sessionId }) === undefined;
}

/** Wire marker that retires a queued action. */
export const BOARD_REFUSED_PREFIX = "refused: ";

export function refusalError(refused: BoardRefusal): Error {
	return new Error(`${BOARD_REFUSED_PREFIX}${refused}`);
}
