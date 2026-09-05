import { appendAgentActivity } from "../shared/agent-record.js";
import {
	COPILOT_ACTIVITY_MAX_ITEMS,
	type CopilotPersistedAgent,
	type CopilotResolvedTarget,
} from "../shared/copilot-agent.js";
import { CopilotTransitionError } from "./copilotAgentTypes.js";

export function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0)
		throw new CopilotTransitionError("invalid_input", "invalid transition timestamp");
	return at;
}

export function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

export function sameResolvedTarget(left: CopilotResolvedTarget, right: CopilotResolvedTarget): boolean {
	return left.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

export function resolvedTargetMatchesRequest(
	requested: CopilotPersistedAgent["requestedTarget"],
	resolved: CopilotResolvedTarget,
): boolean {
	if (requested.kind !== resolved.kind) return false;
	if (requested.kind === "host") return resolved.targetId === "host";
	return resolved.targetId === `container:${requested.project}` && resolved.cwd === `/workspace/${requested.project}`;
}

export function appendActivity(
	activities: CopilotPersistedAgent["turns"][number]["activities"],
	itemId: string,
	text: string,
): CopilotPersistedAgent["turns"][number]["activities"] {
	// Keep this cap aligned with the shared append rule.
	const next = appendAgentActivity(activities, itemId, text, COPILOT_ACTIVITY_MAX_ITEMS);
	// Null means unchanged because this caller has no commit-skip branch.
	return (next as CopilotPersistedAgent["turns"][number]["activities"] | null) ?? activities;
}
