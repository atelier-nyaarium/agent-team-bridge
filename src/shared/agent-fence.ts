// The fence algebra both agent families (Codex, Copilot) order their daemon traffic with. One home,
// because the verdicts derived from it decide whether the daemon may retire its only copy.

////////////////////////////////
//  Interfaces & Types

/** Which child spoke, and how far in: (supervisor instance, target, generation, high-water mark). */
export interface AgentFence {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	lastEventId: number;
}

////////////////////////////////
//  Functions & Helpers

/** The fence a fenced daemon message stands at. Its own event ID is the fence's high-water mark, so
 * a receipt and the events around it order against one another by construction. */
export function fenceOf(message: {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	eventId: number;
}): AgentFence {
	return {
		daemonInstanceId: message.daemonInstanceId,
		targetId: message.targetId,
		generation: message.generation,
		lastEventId: message.eventId,
	};
}

export function sameFence(left: AgentFence | undefined, right: AgentFence | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.daemonInstanceId === right.daemonInstanceId &&
		left.targetId === right.targetId &&
		left.generation === right.generation &&
		left.lastEventId === right.lastEventId
	);
}

/** The ACCEPTANCE-side rule: a record with no fence yet takes its first one from the acceptance,
 * so an unfenced current is an advance, never a hold. */
export function classifyAcceptanceFence(
	current: AgentFence | undefined,
	next: AgentFence,
): "advances" | "duplicate" | "foreign" {
	if (!current) return "advances";
	if (
		current.daemonInstanceId !== next.daemonInstanceId ||
		current.targetId !== next.targetId ||
		current.generation !== next.generation
	) {
		return "foreign";
	}
	return next.lastEventId > current.lastEventId ? "advances" : "duplicate";
}

/** True when [next] may land on a record currently at [current] via an acceptance. */
export function advancesFence(current: AgentFence | undefined, next: AgentFence): boolean {
	return classifyAcceptanceFence(current, next) === "advances";
}

/** The EVENT-side rule: an unfenced record cannot place an event at all (only reconciliation or an
 * acceptance installs a first fence), so `foreign` is the answer that holds it rather than noise. */
export function classifyEventFence(
	current: AgentFence | undefined,
	next: AgentFence,
): "advances" | "duplicate" | "foreign" {
	if (!current) return "foreign";
	return classifyAcceptanceFence(current, next);
}
