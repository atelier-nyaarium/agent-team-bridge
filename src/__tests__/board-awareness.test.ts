import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AwarenessObservation, createAwarenessBank } from "../gateway/awarenessBank.js";
import { boardAwarenessSubscriber } from "../gateway/boardAwareness.js";
import { BOARD_TRASH_TTL_MS, BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const owner = "owner";
const session = "proj.main";
type Observation = AwarenessObservation<BoardEntry>;
const entry = (id: string, over: Partial<BoardEntry> = {}): BoardEntry => ({
	id,
	title: `t-${id}`,
	state: "open",
	rank: "m",
	...over,
});

describe("board awareness subscriber", () => {
	let dir: string;
	let store: BoardStore;
	let observations: Observation[];

	function createObserver() {
		return (items: readonly Observation[]) => observations.push(...items);
	}

	function body() {
		return boardAwarenessSubscriber.render(session, observations);
	}

	function acts() {
		return observations.map(({ pre, post }) => boardAwarenessSubscriber.act(session, pre, post));
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "awareness-"));
		observations = [];
		store = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined, createObserver());
		store.upsert(owner, [entry("a")], OWNER_ACTOR);
		store.claim(owner, "a", session);
		observations = [];
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("announces an owner edit by id alone, since a re-read resolves it", () => {
		store.setTitle(owner, "a", "renamed", OWNER_ACTOR);
		expect(body()).toBe("The owner edited a.");
		expect(acts()).toEqual(["no_act"]);
	});

	it("keeps both sides of a reassignment", () => {
		store.setSession(owner, "a", "other");
		expect(new Set(observations.map((item) => item.sessionKey))).toEqual(new Set([session, "other"]));
		observations = [];
		store.setSession(owner, "a", session);
		expect(new Set(observations.map((item) => item.sessionKey))).toEqual(new Set([session, "other"]));
	});

	it("classifies backlog as no_act and gone states as act_now", () => {
		const before = entry("a", { sessionId: session });
		const backlog = entry("a");
		const trashed = entry("a", { trashedAt: 1 });
		expect(boardAwarenessSubscriber.act(session, before, backlog)).toBe("no_act");
		expect(boardAwarenessSubscriber.act(session, before, trashed)).toBe("act_now");
		expect(boardAwarenessSubscriber.act(session, before, undefined)).toBe("act_now");
	});

	it("coalesces edits into the net transition", () => {
		const before = entry("a", { sessionId: session });
		const edited = entry("a", { sessionId: session, title: "edited" });
		const trashed = entry("a", { sessionId: session, title: "edited", trashedAt: 1 });
		expect(boardAwarenessSubscriber.render(session, [{ identity: "a", pre: edited, post: trashed }])).toContain(
			"trashed",
		);
		expect(boardAwarenessSubscriber.render(session, [{ identity: "a", pre: before, post: before }])).toBe("");
	});

	it("flattens titles and bounds named facts", () => {
		const changes = Array.from({ length: 21 }, (_, i) => ({
			identity: `a${i}`,
			pre: entry(`a${i}`, { sessionId: session }),
			post: entry(`a${i}`, { sessionId: session, trashedAt: 1, title: `title ${i}\nnext` }),
		}));
		const body = boardAwarenessSubscriber.render(session, changes);
		expect(body.split("\n")).toHaveLength(21);
		expect(body).not.toContain('"title 20');
		expect(body).toContain("And 1 more.");
	});

	it("does not announce a holder's own write", () => {
		// Self-echo suppression keeps a session from hearing its own route write.
		observations = [];
		store.setState(owner, "a", "in_progress", { kind: "session", sessionId: session });
		expect(observations).toEqual([]);
	});

	it("renders a backlog release as no_act", () => {
		// Backlog work needs awareness but no urgent action.
		store.setSession(owner, "a", undefined);
		expect(body()).toContain("t-a");
		expect(body()).toContain("backlog");
		expect(acts()).toEqual(["no_act"]);
	});

	it("distinguishes trashed, removed, and reassigned as act_now", () => {
		// Gone work needs an urgent notice with its specific reason.
		store.setTrashed(owner, "a", true);
		expect(body()).toContain("trashed");
		expect(acts()).toEqual(["act_now"]);
		observations = [];
		store.setTrashed(owner, "a", false);
		store.setSession(owner, "a", "other");
		expect(body()).toContain("reassigned");
		expect(acts()).toContain("act_now");
		observations = [];
		store.setSession(owner, "a", session);
		observations = [];
		store.remove(owner, ["a"]);
		expect(body()).toContain("removed");
		expect(acts()).toEqual(["act_now"]);
	});

	it("observes every member touched by a subtree write", () => {
		// A subtree mutation must not leave a child holder stale.
		store.upsert(owner, [entry("a1", { parent: "a" })], OWNER_ACTOR);
		store.claim(owner, "a", session);
		observations = [];
		store.setSession(owner, "a", undefined);
		expect(observations.map(({ identity }) => identity).sort()).toEqual(["a", "a1"]);
	});

	it("does not observe refused or unchanged writes", () => {
		// Only committed changes belong in awareness.
		store.setTitle(owner, "a", "t-a", OWNER_ACTOR);
		expect(observations).toEqual([]);
		expect(store.claim(owner, "a", "other")).toEqual({ applied: false, refused: "held" });
		expect(observations).toEqual([]);
	});

	it("does not observe unheld entries", () => {
		// Unheld work has no session addressee.
		store.upsert(owner, [entry("loose")], OWNER_ACTOR);
		observations = [];
		store.setTitle(owner, "loose", "renamed", OWNER_ACTOR);
		expect(observations).toEqual([]);
	});

	it("does not observe session end or trash sweep", () => {
		// Lifecycle cleanup should not announce to the session being removed.
		store.sessionEnded(session, "release");
		expect(observations).toEqual([]);
		store.setSession(owner, "a", session);
		observations = [];
		store.setTrashed(owner, "a", true, 1_000);
		observations = [];
		store.sweepTrash(1_000 + BOARD_TRASH_TTL_MS + 1);
		expect(observations).toEqual([]);
	});

	it("renders an untrash as arrived", () => {
		// Restored work is an arrival, not a generic edit.
		store.setTrashed(owner, "a", true);
		observations = [];
		store.setTrashed(owner, "a", false);
		expect(body()).toBe('"t-a" is yours.');
		expect(acts()).toEqual(["no_act"]);
	});

	it("renders newly assigned work as arrived", () => {
		// A session must learn the title when an id was not in its list.
		store.upsert(owner, [entry("fresh")], OWNER_ACTOR);
		observations = [];
		store.setSession(owner, "fresh", session);
		expect(body()).toBe('"t-fresh" is yours.');
		expect(acts()).toEqual(["no_act"]);
	});

	it("renders each side of a reassignment with its own kind", () => {
		// Both the losing and gaining sessions need different facts.
		store.setSession(owner, "a", "other");
		expect(observations.find((item) => item.sessionKey === session)).toBeDefined();
		expect(
			boardAwarenessSubscriber.render(
				session,
				observations.filter((item) => item.sessionKey === session),
			),
		).toContain("reassigned");
		expect(boardAwarenessSubscriber.act(session, observations[0].pre, observations[0].post)).toBe("act_now");
		expect(
			boardAwarenessSubscriber.render(
				"other",
				observations.filter((item) => item.sessionKey === "other"),
			),
		).toContain("is yours");
	});

	it("coalesces edit and trash to the net trashed fact", () => {
		// Flush-time classification must discard intermediate edits.
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		store.setTitle(owner, "a", "edited", OWNER_ACTOR);
		observe(observations);
		observations = [];
		store.setTrashed(owner, "a", true);
		observe(observations);
		const riding = bank.takeFor(session);
		expect(riding?.body).toContain("trashed");
		expect(riding?.body).not.toContain("edited");
	});

	it("coalesces edit, trash, and untrash to nothing", () => {
		// Equal first and last snapshots are not awareness.
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		store.setTitle(owner, "a", "edited", OWNER_ACTOR);
		observe(observations);
		observations = [];
		store.setTrashed(owner, "a", true);
		observe(observations);
		observations = [];
		store.setTitle(owner, "a", "t-a", OWNER_ACTOR);
		observe(observations);
		observations = [];
		store.setTrashed(owner, "a", false);
		observe(observations);
		expect(bank.takeFor(session)).toBeNull();
	});

	it("coalesces a move and edits to one changed line", () => {
		// A commit burst should produce one fact per entry.
		const bank = createAwarenessBank({ liveness: () => "live", now: () => 0, deliver: () => true });
		const observe = bank.register(boardAwarenessSubscriber);
		store.upsert(owner, [entry("p")], OWNER_ACTOR);
		observations = [];
		expect(store.setParent(owner, "a", "p", "m", OWNER_ACTOR)).toEqual({ applied: true });
		expect(observations).toHaveLength(1);
		observe(observations);
		observations = [];
		for (const title of ["one", "two", "three"]) {
			store.setTitle(owner, "a", title, OWNER_ACTOR);
			observe(observations);
			observations = [];
		}
		expect(bank.takeFor(session)?.body).toBe("The owner edited a.");
	});

	it("flattens a multi-line title so a named fact stays one line", () => {
		// The rendered line is read one fact per line, by the agent and by the log.
		store.setTitle(owner, "a", "line one\nline two", OWNER_ACTOR);
		observations = [];
		store.setSession(owner, "a", undefined);
		expect(body().split("\n")).toHaveLength(1);
		expect(body()).toContain("line one line two");
	});

	it("collapses more than 20 changed ids through the store", () => {
		// The bounded changed-id line must hold for real store observations.
		const entries = Array.from({ length: 25 }, (_, i) => entry(`x${i}`));
		store.upsert(owner, entries, OWNER_ACTOR);
		observations = [];
		for (const item of entries) store.claim(owner, item.id, session);
		observations = [];
		for (const item of entries) store.setTitle(owner, item.id, `changed-${item.id}`, OWNER_ACTOR);
		expect(body()).toContain("25 entries you hold");
		expect(body()).toContain("and 5 more");
	});
});
