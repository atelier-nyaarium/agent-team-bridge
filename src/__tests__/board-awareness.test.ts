import { describe, expect, it } from "vitest";
import { createAwarenessBank } from "../gateway/awarenessBank.js";
import { boardAwarenessSubscriber } from "../gateway/boardAwareness.js";
import type { AwarenessObservation } from "../shared/awareness-types.js";
import type { BoardEntry } from "../shared/console-protocol.js";

const session = "proj.main";
const entry = (id: string, over: Partial<BoardEntry> = {}): BoardEntry => ({
	id,
	title: `t-${id}`,
	state: "open",
	rank: "m",
	...over,
});
const change = (id: string, pre?: BoardEntry, post?: BoardEntry): AwarenessObservation<BoardEntry> => ({
	identity: id,
	sessionKey: session,
	pre,
	post,
});

describe("board awareness subscriber", () => {
	it("announces edits by id alone", () => {
		expect(
			boardAwarenessSubscriber.render(session, [
				change("a", entry("a", { sessionId: session }), entry("a", { sessionId: session, title: "renamed" })),
			]),
		).toBe("The owner edited a.");
	});

	it("renders arrivals, backlog, and disappearances", () => {
		expect(
			boardAwarenessSubscriber.render(session, [change("a", entry("a"), entry("a", { sessionId: session }))]),
		).toBe('"t-a" is yours.');
		expect(
			boardAwarenessSubscriber.render(session, [change("a", entry("a", { sessionId: session }), entry("a"))]),
		).toContain("backlog");
		expect(boardAwarenessSubscriber.act(session, entry("a", { sessionId: session }), undefined)).toBe("act_now");
	});

	it("classifies trash and reassignment as act-now", () => {
		expect(
			boardAwarenessSubscriber.act(session, entry("a", { sessionId: session }), entry("a", { trashedAt: 1 })),
		).toBe("act_now");
		expect(
			boardAwarenessSubscriber.act(
				session,
				entry("a", { sessionId: session }),
				entry("a", { sessionId: "other" }),
			),
		).toBe("act_now");
	});

	it("classifies edits, backlog, untrash, and arrival as no-act", () => {
		const held = entry("a", { sessionId: session });
		expect(boardAwarenessSubscriber.act(session, held, entry("a", { sessionId: session, title: "edited" }))).toBe(
			"no_act",
		);
		expect(boardAwarenessSubscriber.act(session, held, entry("a"))).toBe("no_act");
		expect(boardAwarenessSubscriber.act(session, entry("a", { trashedAt: 1 }), held)).toBe("no_act");
		expect(boardAwarenessSubscriber.act(session, entry("a"), held)).toBe("no_act");
	});

	it("renders reassignment and removal as distinct act-now facts", () => {
		expect(
			boardAwarenessSubscriber.render(session, [
				change("a", entry("a", { sessionId: session }), entry("a", { sessionId: "other" })),
			]),
		).toBe('"t-a" was reassigned.');
		expect(
			boardAwarenessSubscriber.render(session, [change("a", entry("a", { sessionId: session }), undefined)]),
		).toBe('"t-a" was removed.');
	});

	it("ignores unchanged and unheld entries", () => {
		const same = entry("a", { sessionId: session });
		expect(boardAwarenessSubscriber.render(session, [change("a", same, same)])).toBe("");
		expect(
			boardAwarenessSubscriber.render(session, [change("a", entry("a"), entry("a", { title: "renamed" }))]),
		).toBe("");
		expect(boardAwarenessSubscriber.act(session, entry("a"), entry("a", { title: "renamed" }))).toBe("no_act");
	});

	it("coalesces changed ids and bounds output", () => {
		const changes = Array.from({ length: 21 }, (_, i) =>
			change(
				`a${i}`,
				entry(`a${i}`, { sessionId: session }),
				entry(`a${i}`, { sessionId: session, title: `title ${i}` }),
			),
		);
		const body = boardAwarenessSubscriber.render(session, changes);
		expect(body).toContain("21 entries you hold");
		expect(body).toContain("and 1 more");
	});

	it("coalesces edit and trash to one trashed notification", () => {
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		observe([change("a", entry("a", { sessionId: session }), entry("a", { sessionId: session, title: "edited" }))]);
		observe([change("a", entry("a", { sessionId: session, title: "edited" }), entry("a", { trashedAt: 1 }))]);
		expect(bank.takeFor(session)?.body).toBe('"t-a" was trashed.');
	});

	it("coalesces edit, trash, edit, and untrash to no notification", () => {
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		observe([change("a", entry("a", { sessionId: session }), entry("a", { sessionId: session, title: "edited" }))]);
		observe([change("a", entry("a", { sessionId: session, title: "edited" }), entry("a", { trashedAt: 1 }))]);
		observe([change("a", entry("a", { trashedAt: 1 }), entry("a", { trashedAt: 1, title: "restored" }))]);
		observe([change("a", entry("a", { trashedAt: 1, title: "restored" }), entry("a", { sessionId: session }))]);
		expect(bank.takeFor(session)).toBeNull();
	});

	it("coalesces a move and several edits to one changed line", () => {
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		observe([change("a", entry("a", { sessionId: session }), entry("a", { sessionId: session, parent: "p" }))]);
		for (const title of ["one", "two", "three"]) {
			observe([
				change(
					"a",
					entry("a", { sessionId: session, parent: "p" }),
					entry("a", { sessionId: session, parent: "p", title }),
				),
			]);
		}
		expect(bank.takeFor(session)?.body).toBe("The owner edited a.");
	});

	it("bounds named changes and flattens titles", () => {
		const changes = Array.from({ length: 21 }, (_, i) =>
			change(
				`a${i}`,
				entry(`a${i}`, { sessionId: session, title: `title ${i}\nnext` }),
				entry(`a${i}`, { title: `title ${i}\nnext`, trashedAt: 1 }),
			),
		);
		const body = boardAwarenessSubscriber.render(session, changes);
		expect(body.split("\n")).toHaveLength(21);
		expect(body).not.toContain('"title 20 next"');
		expect(body).toContain("And 1 more.");
		expect(body).toContain('"title 0 next"');
	});
});
