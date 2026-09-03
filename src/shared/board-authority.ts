import type { BoardEntry } from "../shared/console-protocol.js";
import type { CascadeChange } from "./board-cascade.js";

/** Refusal codes retire queued actions. */
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

export type BoardResult =
	| { applied: true; cascaded?: readonly CascadeChange[] }
	| { applied: false; refused: BoardRefusal }
	// Migration waits, not refusal.
	| { applied: false; migrating: true };

export type BoardDisposition = "release" | "cancel";

export type BoardActor = { kind: "owner" } | { kind: "session"; sessionId: string };

export const OWNER_ACTOR: BoardActor = { kind: "owner" };

/** Sessions write held, active entries. */
export function mayWrite(entry: BoardEntry, actor: BoardActor): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	return entry.sessionId === actor.sessionId ? undefined : "held";
}

/** Holder authority required. */
export function mayTake(entry: BoardEntry, actor: BoardActor, next: string | undefined): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	if (entry.sessionId !== undefined && entry.sessionId !== actor.sessionId) return "held";
	return next === undefined || next === actor.sessionId ? undefined : "held";
}

/** Shared visibility rule. */
export function visibleTo(entry: BoardEntry | undefined, sessionId: string): boolean {
	if (!entry || entry.trashedAt !== undefined) return false;
	return entry.sessionId === undefined || entry.sessionId === sessionId;
}

export function holds(entry: BoardEntry | undefined, sessionId: string): boolean {
	return entry !== undefined && mayWrite(entry, { kind: "session", sessionId }) === undefined;
}

export const BOARD_REFUSED_PREFIX = "refused: ";

export function refusalError(refused: BoardRefusal): Error {
	return new Error(`${BOARD_REFUSED_PREFIX}${refused}`);
}
