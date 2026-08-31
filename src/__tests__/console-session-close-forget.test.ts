import { describe, expect, it } from "vitest";
import { SessionStore } from "../shared/session-store.js";
import { frame, makeTerminalHarness } from "./helpers/console.js";

describe("console terminal ops: rename / close / forget", () => {
	it("rename_session relabels the record and returns the applied label", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "old" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "rename_session", target: "recipe-app.scratch", sessionLabel: "New Name" }, "rn1"),
		);
		expect(reply.result).toEqual({ renamed: true, sessionLabel: "New Name" });
		expect(store.getByTeam("recipe-app.scratch")?.sessionLabel).toBe("New Name");
	});

	it("rename_session on a bare spawn-point is rejected", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "rename_session", target: "recipe-app", sessionLabel: "x" }, "rn2"),
		);
		expect(reply.ok).toBe(false);
	});

	it("rename_session refuses a foreign-Gateway target rather than hitting a same-named local record", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "keep" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame(
				{ kind: "rename_session", target: "other-domain.other-gw.recipe-app.scratch", sessionLabel: "hijack" },
				"rn3",
			),
		);
		expect(reply.ok).toBe(false);
		expect(store.getByTeam("recipe-app.scratch")?.sessionLabel).toBe("keep");
	});

	it("peek on an alias-served record (a user-launched session) is refused with no host op", async () => {
		const store = new SessionStore();
		store.adoptById("main", { spawn: "recipe-app" });
		// liveTeam under a DIFFERENT name than the record's own = an alias (user-launched) incarnation.
		store.confirm("recipe-app.main", { team: "recipe-app.other", subId: "s" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app.main" }, "pk-alias"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("user-launched");
		expect(h.hostOps).toHaveLength(0);
	});

	it("close_session kills the tmux but keeps the resume record (unlike forget)", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "keep" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "close_session", target: "recipe-app.scratch" }, "cl1"),
		);
		expect(reply.result).toEqual({ closed: true });
		expect(h.hostOps[0]).toMatchObject({
			kind: "killSession",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" },
		});
		// The record survives (the session stays listed as available for a re-wake).
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
	});

	it("close_session on a bare spawn-point is rejected before any host op", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "close_session", target: "recipe-app" }, "cl2"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("spawn-point");
		expect(h.hostOps).toHaveLength(0);
	});

	it("close_session on an alias-served (user-launched) record reports honestly, not a false closed", async () => {
		const store = new SessionStore();
		store.adoptById("main", { spawn: "recipe-app", sessionLabel: "keep" });
		// liveTeam under a DIFFERENT name than the record's own = a user-launched alias incarnation.
		store.confirm("recipe-app.main", { team: "recipe-app.other", subId: "s" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(frame({ kind: "close_session", target: "recipe-app.main" }, "cla"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("user-launched");
		expect(h.hostOps).toHaveLength(0);
		// The record survives (close never dropped it).
		expect(store.getByTeam("recipe-app.main")).toBeDefined();
	});

	it("close_session refuses while a wake is in flight (would no-op then resurrect)", async () => {
		const h = makeTerminalHarness(undefined, undefined, {
			isWakeInFlight: (team) => team === "recipe-app.scratch",
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "close_session", target: "recipe-app.scratch" }, "cl3"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("waking");
		expect(h.hostOps).toHaveLength(0);
	});

	it("a retried close_session with the same opId kills once (idempotent)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "close_session", target: "recipe-app.scratch" }, "cldup");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		expect(h.hostOps.filter((o) => o.kind === "killSession")).toHaveLength(1);
	});

	it("forget kills the tmux and drops the resume record", async () => {
		const dropped: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			dropSessionResume: (team) => dropped.push(team),
		});
		const reply = await h.handler.handleFrame(frame({ kind: "forget", target: "recipe-app.scratch" }, "f1"));
		// The disposition is echoed even when the request omitted it, so a console can tell an
		// applied "release" from a Gateway that stripped the field it did not know.
		expect(reply.result).toEqual({ killed: true, boardDisposition: "release" });
		expect(h.hostOps[0]).toMatchObject({ kind: "killSession" });
		expect(dropped).toEqual(["recipe-app.scratch"]);
	});

	it("forget still drops the resume record when the tmux kill itself fails", async () => {
		const dropped: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			relayFails: true,
			dropSessionResume: (team) => dropped.push(team),
		});
		const reply = await h.handler.handleFrame(frame({ kind: "forget", target: "recipe-app.scratch" }, "f2"));
		// A failed kill must never block the record drop - that's forget's actual contract.
		// The disposition is echoed even when the request omitted it, so a console can tell an
		// applied "release" from a Gateway that stripped the field it did not know.
		expect(reply.result).toEqual({ killed: true, boardDisposition: "release" });
		expect(dropped).toEqual(["recipe-app.scratch"]);
	});

	it("forget still drops the resume record when the project is unknown to the catalog (resolveTmuxTarget throws)", async () => {
		const dropped: string[] = [];
		const h = makeTerminalHarness(
			() => false, // No trusted catalog project after restart.
			undefined,
			{ dropSessionResume: (team) => dropped.push(team) },
		);
		const reply = await h.handler.handleFrame(frame({ kind: "forget", target: "recipe-app.scratch" }, "f3"));
		// The disposition is echoed even when the request omitted it, so a console can tell an
		// applied "release" from a Gateway that stripped the field it did not know.
		expect(reply.result).toEqual({ killed: true, boardDisposition: "release" });
		expect(h.hostOps).toHaveLength(0);
		expect(dropped).toEqual(["recipe-app.scratch"]);
	});

	it("forget on a bare spawn-point is rejected before any host op or record drop", async () => {
		const dropped: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			dropSessionResume: (team) => dropped.push(team),
		});
		const reply = await h.handler.handleFrame(frame({ kind: "forget", target: "recipe-app" }, "f4"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("spawn-point");
		expect(h.hostOps).toHaveLength(0);
		expect(dropped).toEqual([]);
	});
});
