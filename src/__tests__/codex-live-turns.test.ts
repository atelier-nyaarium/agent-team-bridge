import { describe, expect, it } from "vitest";
import type { TurnBinding } from "../mcp/devcontainer/codexDaemonTypes.js";
import { CodexLiveTurns } from "../mcp/devcontainer/codexLiveTurns.js";

////////////////////////////////
//  Functions & Helpers

const TURN = "turn-1";
const SILENCE = 1_000;

function bindingOn(threadId: string, agentId = "codex_0123456789abcdef0123456789abcdef"): TurnBinding {
	return { ownerKey: "recipe-app.work", agentId, threadId };
}

function turnsAt(start = 1_000) {
	let clock = start;
	const turns = new CodexLiveTurns(() => clock);
	return { turns, advance: (ms: number) => (clock += ms) };
}

////////////////////////////////
//  Tests

/** The defect class: a turn's clock or warning reachable without the thread that owns it. */
describe("a turn's liveness belongs to the turn and its thread", () => {
	it("takes no frame from another thread as this turn working", () => {
		const { turns, advance } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));

		advance(SILENCE);
		turns.saw("thread-2", TURN);

		expect(turns.overdue(SILENCE).map((entry) => entry.turnId)).toEqual([TURN]);
	});

	it("takes a frame from its own thread as this turn working", () => {
		const { turns, advance } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));

		advance(SILENCE);
		turns.saw("thread-1", TURN);

		expect(turns.overdue(SILENCE)).toEqual([]);
	});

	it("answers for a turn only on the thread that holds it", () => {
		const { turns } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));

		expect(turns.bindingOn("thread-1", TURN)).toMatchObject({ threadId: "thread-1" });
		expect(turns.bindingOn("thread-2", TURN)).toBeUndefined();
	});

	it("keeps a warning when the same thread is bound again", () => {
		const { turns, advance } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));
		advance(SILENCE);
		turns.warn(TURN);

		// The gateway asking again buys no second chance.
		turns.bind(TURN, bindingOn("thread-1"));
		advance(SILENCE);

		expect(turns.overdue(SILENCE)).toMatchObject([{ warned: true }]);
	});

	it("starts a turn rebound onto another thread with neither the silence nor the warning", () => {
		const { turns, advance } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));
		advance(SILENCE);
		turns.warn(TURN);

		turns.bind(TURN, bindingOn("thread-2"));

		// A different thread is a different identity, and inherits nothing from the one it replaced.
		expect(turns.overdue(SILENCE)).toEqual([]);
		advance(SILENCE);
		expect(turns.overdue(SILENCE)).toMatchObject([{ warned: false }]);
	});

	it("forgets a turn outright, so nothing of it can be overdue", () => {
		const { turns, advance } = turnsAt();
		turns.bind(TURN, bindingOn("thread-1"));

		turns.forget(TURN);
		advance(SILENCE);

		expect(turns.size).toBe(0);
		expect(turns.overdue(SILENCE)).toEqual([]);
		expect(turns.bindingOn("thread-1", TURN)).toBeUndefined();
	});
});
