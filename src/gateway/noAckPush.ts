import crypto from "node:crypto";
import type { ChannelPushPayload } from "../shared/types.js";
import type { BoardNotice } from "./boardStore.js";

////////////////////////////////
//  Interfaces & Types

/** THREE-valued on purpose: collapsing "waking" into "gone" drops a notice for a session that is
 * still coming up. */
export type SessionLiveness = "live" | "waking" | "gone";

export interface NoAckPushDeps {
	liveness(sessionKey: string): SessionLiveness;
	/** False when the socket went away between the liveness read and this call. */
	deliver(sessionKey: string, payload: ChannelPushPayload): boolean;
}

export interface NoAckPush {
	bank(notices: readonly BoardNotice[]): void;
	dropFor(sessionKey: string): void;
	tick(now?: number): void;
	stop(): void;
}

/** Keyed by entry, so a window's worth of writes to one entry is one fact. The later notice wins:
 * an entry edited and then trashed reads as trashed, which is the net truth the agent would have to
 * work out for itself otherwise. */
type Bank = { notices: Map<string, BoardNotice>; dueAt: number; heldSince: number };

////////////////////////////////
//  Constants

/** Names no job, so respond() must intercept it or a reply 404s at the agent. */
const NO_ACK_SESSION_PREFIX = "na-";

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

function mintNoAckSessionId(): string {
	return `${NO_ACK_SESSION_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

/** The console banks an owner's whole triage pass locally and drains it in one burst, so sending per
 * change would re-explode a batch the client already assembled. */
const FLUSH_WINDOW_MS = 3000;

/** How long a notice waits on a waking addressee. Matched to WAKE_TIMEOUT_MS, the gateway's own budget
 * for a wake to finish: a shorter hold discards notices for wakes that go on to succeed, and a
 * devcontainer cold start routinely runs past any small number. */
const MAX_HOLD_MS = 600_000;

/** Body bounds. A trash of a 5000-entry subtree is one commit, and every line of it would otherwise
 * be injected verbatim into a session that asked for nothing back. */
const MAX_LISTED_IDS = 20;
const MAX_NAMED_LINES = 20;

/** A title is capped at 500 on the wire, and 20 of them at that length is already a lot to hand a
 * session unasked. */
const MAX_TITLE_CHARS = 80;

////////////////////////////////
//  Functions & Helpers

function quoted(title: string): string {
	const oneLine = title.replace(/\s+/g, " ").trim();
	const cut = [...oneLine].slice(0, MAX_TITLE_CHARS).join("");
	return `"${cut}${cut.length < oneLine.length ? "..." : ""}"`;
}

/** States what happened and stops: no suggested next step, and never that a released entry can be
 * claimed again.
 *
 * Bounded, because one console tap walks a whole subtree and the board holds thousands of entries.
 * An unbounded body would land megabytes in the context of a session that asked for nothing. */
export function renderNoAckBody(notices: readonly BoardNotice[]): string {
	const lines: string[] = [];
	const changed = notices.filter((n) => n.kind === "changed").map((n) => n.entryId);
	if (changed.length === 1) lines.push(`The owner edited ${changed[0]}.`);
	else if (changed.length > 1) {
		const shown = changed.slice(0, MAX_LISTED_IDS);
		const rest = changed.length - shown.length;
		const tail = rest > 0 ? `, and ${rest} more` : "";
		lines.push(`The owner edited ${changed.length} entries you hold: ${shown.join(", ")}${tail}.`);
	}
	const named = notices.filter((n) => n.kind !== "changed");
	for (const n of named.slice(0, MAX_NAMED_LINES)) {
		if (n.kind === "arrived") lines.push(`${quoted(n.title)} is yours.`);
		else if (n.kind === "backlog") lines.push(`${quoted(n.title)} went back to the backlog.`);
		else lines.push(`${quoted(n.title)} was ${n.how}.`);
	}
	if (named.length > MAX_NAMED_LINES) lines.push(`And ${named.length - MAX_NAMED_LINES} more.`);
	return lines.join("\n");
}

export function createNoAckPush(deps: NoAckPushDeps): NoAckPush {
	const banks = new Map<string, Bank>();

	function send(sessionKey: string, notices: readonly BoardNotice[]): boolean {
		const body = renderNoAckBody(notices);
		if (!body) return true;
		return deps.deliver(sessionKey, {
			type: "channel_push",
			from: "task-board",
			body,
			session_id: mintNoAckSessionId(),
			no_ack: true,
		});
	}

	function flush(sessionKey: string, bank: Bank, now: number): void {
		const liveness = deps.liveness(sessionKey);
		if (liveness === "gone") {
			console.error(`[task-board] dropped ${bank.notices.size} notice(s) for ${sessionKey}: no live session`);
			banks.delete(sessionKey);
			return;
		}
		if (liveness === "waking") {
			if (now - bank.heldSince >= MAX_HOLD_MS) {
				console.error(
					`[task-board] dropped ${bank.notices.size} notice(s) for ${sessionKey}: wake never landed`,
				);
				banks.delete(sessionKey);
			} else bank.dueAt = now + FLUSH_WINDOW_MS;
			return;
		}
		banks.delete(sessionKey);
		const sent = send(sessionKey, [...bank.notices.values()]);
		console.error(`[task-board] ${sent ? "pushed" : "LOST"} ${bank.notices.size} notice(s) to ${sessionKey}`);
	}

	return {
		bank(notices) {
			const now = Date.now();
			for (const notice of notices) {
				let entry = banks.get(notice.sessionId);
				if (!entry) {
					entry = { notices: new Map(), dueAt: now + FLUSH_WINDOW_MS, heldSince: now };
					banks.set(notice.sessionId, entry);
				}
				entry.notices.set(notice.entryId, notice);
			}
		},
		dropFor(sessionKey) {
			banks.delete(sessionKey);
		},
		tick(now = Date.now()) {
			for (const [sessionKey, bank] of [...banks]) {
				if (bank.dueAt <= now) flush(sessionKey, bank, now);
			}
		},
		stop() {
			banks.clear();
		},
	};
}
