import { describe, expect, it } from "vitest";
import { currentAgent, eventBase, setup, working } from "./helpers/codex-relay.js";

describe("Codex daemon event application", () => {
	it("settles the active turn on a completed terminal", () => {
		const context = working(setup());
		const applied = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "391" },
			20,
		);

		expect(applied.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.agentState).toBe("idle");
		expect(agent.activeTurnId).toBeUndefined();
		expect(agent.turns[0]).toMatchObject({ state: "completed", finalResponse: "391" });
		expect(agent.fence?.lastEventId).toBe(1);
	});

	it("retains commentary once per item and refuses a repeat of the same item", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "activity", itemId: "item-1", text: "reading" },
			20,
		);
		const repeat = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 2), kind: "activity", itemId: "item-1", text: "reading" },
			21,
		);

		expect(repeat.disposition).toBe("ignored");
		expect(currentAgent(context).turns[0]?.activities).toEqual([
			{ kind: "commentary", itemId: "item-1", text: "reading" },
		]);
	});

	it("ignores an event that does not advance the fence", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 3), kind: "activity", itemId: "item-1", text: "reading" },
			20,
		);
		const stale = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 3), kind: "activity", itemId: "item-2", text: "still reading" },
			21,
		);

		expect(stale.disposition).toBe("ignored");
		expect(currentAgent(context).turns[0]?.activities).toHaveLength(1);
	});

	it("asks for reconciliation rather than applying an event from another generation", () => {
		const context = working(setup());
		const foreign = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 1),
				generation: 2,
				kind: "terminal",
				state: "completed",
				finalResponse: "done",
			},
			20,
		);

		expect(foreign.disposition).toBe("reconcile");
		expect(currentAgent(context).agentState).toBe("working");
	});

	it("refuses an event naming a thread the agent does not hold", () => {
		const context = working(setup());
		const wrong = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 1),
				threadId: "thread-other",
				kind: "terminal",
				state: "completed",
				finalResponse: "done",
			},
			20,
		);

		expect(wrong.disposition).toBe("ignored");
		expect(currentAgent(context).agentState).toBe("working");
	});
});
