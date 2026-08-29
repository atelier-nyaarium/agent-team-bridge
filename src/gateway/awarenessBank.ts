import crypto from "node:crypto";
import type { ActAxis, ChannelPushPayload, RidingAwareness } from "../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export type { ActAxis, RidingAwareness } from "../shared/types.js";

/** Three values on purpose. A session that is still coming up is not gone, and folding the two
 * together drops a notice for a wake that goes on to succeed. */
export type SessionLiveness = "live" | "waking" | "gone";

/** One identity's net change since the bank was last drained: the first pre seen and the last post.
 * Everything in between is folded away, so a run of edits and moves is one pair. */
export interface Change<S> {
	identity: string;
	pre: S | undefined;
	post: S | undefined;
}

export interface AwarenessObservation<S> {
	sessionKey: string;
	identity: string;
	pre: S | undefined;
	post: S | undefined;
}

/** A source of changes. It owns what an identity is, what a pair means, and how a batch reads. The
 * bank and the delivery never look inside a pair. */
export interface AwarenessSubscriber<S> {
	readonly source: string;
	/** Asked per observation to decide whether a deadline is armed, and again per net pair at flush to
	 * stamp the push. */
	act(sessionKey: string, pre: S | undefined, post: S | undefined): ActAxis;
	/** Empty string means nothing worth saying, and the bank sends nothing for it. */
	render(sessionKey: string, changes: readonly Change<S>[]): string;
}

export interface AwarenessBank {
	register<S>(subscriber: AwarenessSubscriber<S>): (observations: readonly AwarenessObservation<S>[]) => void;
	/** The piggyback. Drains everything banked for the session, rendered, and cancels its deadline. */
	takeFor(sessionKey: string): RidingAwareness | null;
	dropFor(sessionKey: string): void;
	/** Fires deadlines only. A bank with no deadline waits for `takeFor`. */
	tick(now?: number): void;
	stop(): void;
}

export interface AwarenessBankDeps {
	liveness(sessionKey: string): SessionLiveness;
	/** False when the socket went away between the liveness read and this call. */
	deliver(sessionKey: string, payload: ChannelPushPayload): boolean;
	now?: () => number;
}

type Entry = {
	subscriber: AwarenessSubscriber<unknown>;
	changes: Map<string, Change<unknown>>;
};

/** `heldSince` is when the first act_now landed and `dueAt` is when the bank pushes on its own.
 * Both stay unset for a bank holding only no_act content. */
type SessionBank = {
	entries: Map<string, Entry>;
	heldSince?: number;
	dueAt?: number;
};

////////////////////////////////
//  Constants

/** A no_ack session id names no job, so `respond()` absorbs a reply to one instead of 404ing. */
const NO_ACK_SESSION_PREFIX = "na-";

/** How long an act_now bank waits for a message to ride before pushing on its own. A message inside
 * the window carries the content for free; the push is the fallback. */
export const ACT_NOW_HOLD_MS = 60_000;

/** How long a due push waits on a waking session. Matches WAKE_TIMEOUT_MS, the gateway's own budget
 * for a wake to finish. Shorter drops notices for wakes that succeed. */
export const MAX_HOLD_MS = 600_000;

////////////////////////////////
//  Functions & Helpers

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

export function mintNoAckSessionId(): string {
	return `${NO_ACK_SESSION_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

export function createAwarenessBank(deps: AwarenessBankDeps): AwarenessBank {
	const sessions = new Map<string, SessionBank>();
	const clock = deps.now ?? Date.now;

	function changeCount(bank: SessionBank): number {
		return [...bank.entries.values()].reduce((count, entry) => count + entry.changes.size, 0);
	}

	function bankFor(sessionKey: string): SessionBank {
		let bank = sessions.get(sessionKey);
		if (!bank) {
			bank = { entries: new Map() };
			sessions.set(sessionKey, bank);
		}
		return bank;
	}

	/** Renders every subscriber with something to say. The act is read from the NET pairs, not from
	 * whichever observation armed the deadline, so a take-away the owner undid is not urgent. */
	function content(sessionKey: string, bank: SessionBank): RidingAwareness | null {
		const rendered: { from: string; body: string; act: ActAxis }[] = [];
		for (const entry of bank.entries.values()) {
			const changes = [...entry.changes.values()];
			const body = entry.subscriber.render(sessionKey, changes);
			if (!body) continue;
			const urgent = changes.some((c) => entry.subscriber.act(sessionKey, c.pre, c.post) === "act_now");
			rendered.push({ from: entry.subscriber.source, body, act: urgent ? "act_now" : "no_act" });
		}
		if (rendered.length === 0) return null;
		return {
			// One source speaks under its own name. Several share a neutral one.
			from: rendered.length === 1 ? rendered[0].from : "awareness",
			body: rendered.map((item) => item.body).join("\n\n"),
			act: rendered.some((item) => item.act === "act_now") ? "act_now" : "no_act",
		};
	}

	function drain(sessionKey: string): RidingAwareness | null {
		const bank = sessions.get(sessionKey);
		if (!bank) return null;
		sessions.delete(sessionKey);
		return content(sessionKey, bank);
	}

	/** The fallback push, once a deadline is due. A waking session is re-checked every tick rather
	 * than dropped, up to MAX_HOLD_MS. */
	function deadline(sessionKey: string, bank: SessionBank, now: number): void {
		const liveness = deps.liveness(sessionKey);
		if (liveness === "gone") {
			console.error(`[awareness] dropped ${changeCount(bank)} change(s) for ${sessionKey}: no live session`);
			sessions.delete(sessionKey);
			return;
		}
		if (liveness === "waking") {
			if (bank.heldSince !== undefined && now - bank.heldSince >= MAX_HOLD_MS) {
				console.error(
					`[awareness] dropped ${changeCount(bank)} change(s) for ${sessionKey}: wake never landed`,
				);
				sessions.delete(sessionKey);
			} else bank.dueAt = now + 1000;
			return;
		}
		const awareness = drain(sessionKey);
		if (!awareness) return;
		const sent = deps.deliver(sessionKey, {
			type: "channel_push",
			from: awareness.from,
			body: awareness.body,
			session_id: mintNoAckSessionId(),
			no_ack: true,
			act: awareness.act,
		});
		console.error(`[awareness] ${sent ? "pushed" : "LOST"} content to ${sessionKey}`);
	}

	return {
		register<S>(subscriber: AwarenessSubscriber<S>) {
			const erased = subscriber as unknown as AwarenessSubscriber<unknown>;
			return (observations) => {
				for (const observation of observations) {
					const bank = bankFor(observation.sessionKey);
					let entry = bank.entries.get(erased.source);
					if (!entry) {
						entry = { subscriber: erased, changes: new Map() };
						bank.entries.set(erased.source, entry);
					}
					const previous = entry.changes.get(observation.identity);
					entry.changes.set(observation.identity, {
						identity: observation.identity,
						pre: previous?.pre ?? observation.pre,
						post: observation.post,
					});
					// The deadline is set once, by the first act_now, and later ones do not push it out.
					// Otherwise a steady stream of take-aways could hold the push off indefinitely.
					if (
						subscriber.act(observation.sessionKey, observation.pre as S, observation.post as S) ===
						"act_now"
					) {
						if (bank.heldSince === undefined) bank.heldSince = clock();
						bank.dueAt = bank.heldSince + ACT_NOW_HOLD_MS;
					}
				}
			};
		},
		takeFor(sessionKey) {
			return drain(sessionKey);
		},
		dropFor(sessionKey) {
			sessions.delete(sessionKey);
		},
		tick(now = clock()) {
			for (const [sessionKey, bank] of [...sessions]) {
				if (bank.dueAt !== undefined && bank.dueAt <= now) deadline(sessionKey, bank, now);
			}
		},
		stop() {
			sessions.clear();
		},
	};
}
