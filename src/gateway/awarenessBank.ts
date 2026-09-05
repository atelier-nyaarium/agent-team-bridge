import type { Ambient } from "../shared/ambient.js";
import type { AwarenessObservation, AwarenessSubscriber, Change } from "../shared/awareness-types.js";
import type { ActAxis, ChannelPushPayload, RidingAwareness } from "../shared/types.js";

export type { ActAxis, RidingAwareness } from "../shared/types.js";

/** Waking sessions remain eligible for delivery. */
export type SessionLiveness = "live" | "waking" | "gone";

export interface AwarenessBank {
	register<S>(subscriber: AwarenessSubscriber<S>): (observations: readonly AwarenessObservation<S>[]) => void;
	takeFor(sessionKey: string): RidingAwareness | null;
	dropFor(sessionKey: string): void;
	tick(now?: number): void;
	stop(): void;
}

export interface AwarenessBankDeps {
	liveness(sessionKey: string): SessionLiveness;
	deliver(sessionKey: string, payload: ChannelPushPayload): boolean;
	ambient: Pick<Ambient, "now" | "randomBytes">;
}

type Entry = {
	subscriber: AwarenessSubscriber<unknown>;
	changes: Map<string, Change<unknown>>;
};

type SessionBank = {
	entries: Map<string, Entry>;
	heldSince?: number;
	dueAt?: number;
};

/** No-ack replies are absorbed by `respond()`. */
const NO_ACK_SESSION_PREFIX = "na-";

/** Hold window for riding an act-now message. */
export const ACT_NOW_HOLD_MS = 60_000;

/** Maximum wait for a waking session. */
export const MAX_HOLD_MS = 600_000;

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

export function mintNoAckSessionId(ambient: Pick<Ambient, "randomBytes">): string {
	return `${NO_ACK_SESSION_PREFIX}${ambient.randomBytes(8).toString("hex")}`;
}

export function createAwarenessBank(deps: AwarenessBankDeps): AwarenessBank {
	const sessions = new Map<string, SessionBank>();
	const clock = () => deps.ambient.now();

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

	/** Renders current net changes. */
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

	/** Pushes when a deadline is due. */
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
			session_id: mintNoAckSessionId(deps.ambient),
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
