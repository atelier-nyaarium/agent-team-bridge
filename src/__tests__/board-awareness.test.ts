import { describe, expect, it } from "vitest";
import { boardAwarenessSubscriber, classifyBoardChange } from "../gateway/boardAwareness.js";
import type { BoardEntry } from "../shared/console-protocol.js";

const session = "proj.main";
const entry = (id: string, over: Partial<BoardEntry> = {}): BoardEntry => ({
	id,
	title: `t-${id}`,
	state: "open",
	rank: "m",
	...over,
});

describe("board awareness classification", () => {
	it.each([
		{
			name: "edit",
			pre: { sessionId: session },
			post: { sessionId: session, title: "new" },
			result: { kind: "changed" },
		},
		{ name: "arrival", pre: {}, post: { sessionId: session }, result: { kind: "arrived", title: "t-a" } },
		{ name: "backlog", pre: { sessionId: session }, post: {}, result: { kind: "backlog", title: "t-a" } },
		{
			name: "trash",
			pre: { sessionId: session },
			post: { trashedAt: 1 },
			result: { kind: "gone", title: "t-a", how: "trashed" },
		},
		{
			name: "reassignment",
			pre: { sessionId: session },
			post: { sessionId: "other" },
			result: { kind: "gone", title: "t-a", how: "reassigned" },
		},
		{
			name: "removal",
			pre: { sessionId: session },
			post: undefined,
			result: { kind: "gone", title: "t-a", how: "removed" },
		},
		{ name: "unchanged", pre: { sessionId: session }, post: { sessionId: session }, result: null },
		{ name: "unheld", pre: {}, post: { title: "new" }, result: null },
	])("classifies a net $name change", ({ pre, post, result }) => {
		expect(classifyBoardChange(session, entry("a", pre), post && entry("a", post))).toEqual(result);
	});

	it.each([
		{ pre: { sessionId: session }, post: { trashedAt: 1 }, act: "act_now" },
		{ pre: { sessionId: session }, post: { sessionId: "other" }, act: "act_now" },
		{ pre: { sessionId: session }, post: { sessionId: session, title: "edit" }, act: "no_act" },
		{ pre: {}, post: { sessionId: session }, act: "no_act" },
	])("assigns the subscriber recipient axis for a net change", ({ pre, post, act }) => {
		expect(boardAwarenessSubscriber.act(session, entry("a", pre), entry("a", post))).toBe(act);
	});
});
