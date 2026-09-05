import { describe, expect, it } from "vitest";
import { PresenceFacade, type TeamRegistry } from "../gateway/presence.js";
import { processAmbient } from "../shared/ambient.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { SessionStore } from "../shared/session-store.js";

function makeRegistry(entries: Record<string, unknown>): TeamRegistry {
	const registry = new Map() as TeamRegistry;
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}

function makeFacade(opts: { registry?: TeamRegistry; offlineCatalog?: Map<string, string>; now?: () => number } = {}) {
	const sessionStore = new SessionStore({ ambient: { now: opts.now ?? Date.now } });
	const registry = opts.registry ?? (new Map() as TeamRegistry);
	const offlineCatalog = opts.offlineCatalog ?? new Map<string, string>();
	const facade = new PresenceFacade({
		sessionStore,
		registry,
		offlineCatalog,
		localGatewayId: "gw-1",
		localDomainId: () => "dom-1",
		displayName: () => null,
		isAdminDomain: () => null,
	});
	const planeRegistry = new PlaneRegistry(processAmbient());
	facade.attach(planeRegistry);
	facade.registerPlane();
	return { facade, registry, planeRegistry };
}

describe("PresenceFacade snapshot status derivation", () => {
	it("a confirmed live session reads online", () => {
		const registry = makeRegistry({
			"proj.main": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true, version: "1.2.3" } },
		});
		const { facade } = makeFacade({ registry });
		facade.adoptById("main", { spawn: "proj" });
		const row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.status).toBe("online");
		expect(row?.version).toBe("1.2.3");
	});

	it("an unconfirmed live session reads verifying", () => {
		const registry = makeRegistry({
			"proj.main": { readyState: 1, data: { mode: "channel", handshakeConfirmed: false } },
		});
		const { facade } = makeFacade({ registry });
		facade.adoptById("main", { spawn: "proj" });
		const row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.status).toBe("verifying");
	});

	it("no live incarnation but a wake in flight reads verifying, not available", () => {
		const { facade } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		facade.wakeStart("proj.main");
		const row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.status).toBe("verifying");
	});

	it("no live incarnation and no wake in flight reads available", () => {
		const { facade } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		const row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.status).toBe("available");
	});

	it("a wake-failure end transitions verifying back to available (the lap-2 wake-in-flight fix)", () => {
		const { facade } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		facade.wakeStart("proj.main");
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.status).toBe("verifying");
		facade.wakeEnd("proj.main");
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.status).toBe("available");
	});
});

describe("PresenceFacade working/needsLogin", () => {
	it("setWorking surfaces on the row; absence means the field is omitted, not false", () => {
		const { facade } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		let row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.working).toBeUndefined();

		facade.setWorking("proj.main", { working: true });
		row = facade.snapshot().find((r) => r.team === "proj.main");
		expect(row?.working).toBe(true);
	});

	it("clearWorkingFor clears only that session, not others", () => {
		const { facade } = makeFacade();
		facade.adoptById("a", { spawn: "proj" });
		facade.adoptById("b", { spawn: "proj" });
		facade.setWorking("proj.a", { working: true });
		facade.setWorking("proj.b", { working: true });
		facade.clearWorkingFor("proj.a");
		const rows = facade.snapshot();
		expect(rows.find((r) => r.team === "proj.a")?.working).toBeUndefined();
		expect(rows.find((r) => r.team === "proj.b")?.working).toBe(true);
	});

	it("clearAllWorking clears every session (daemon-disconnect semantics)", () => {
		const { facade } = makeFacade();
		facade.adoptById("a", { spawn: "proj" });
		facade.adoptById("b", { spawn: "proj" });
		facade.setWorking("proj.a", { working: true });
		facade.setWorking("proj.b", { needsLogin: true });
		facade.clearAllWorking();
		const rows = facade.snapshot();
		expect(rows.find((r) => r.team === "proj.a")?.working).toBeUndefined();
		expect(rows.find((r) => r.team === "proj.b")?.needsLogin).toBeUndefined();
	});

	it("clearLive clears working/needsLogin in the same write as the live-pointer drop (sleep semantics)", () => {
		const { facade } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		facade.confirm("proj.main", { team: "proj.main", subId: "sub-1" });
		facade.setWorking("proj.main", { working: true });
		facade.clearLive("proj.main", "sub-1");
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.working).toBeUndefined();
	});
});

describe("PresenceFacade offline catalog", () => {
	it("a catalog project appears as a spawn-point row when it has no session record", () => {
		const offlineCatalog = new Map([["proj", "/path/to/proj"]]);
		const { facade } = makeFacade({ offlineCatalog });
		const row = facade.snapshot().find((r) => r.team === "proj");
		expect(row?.kind).toBe("devcontainer");
		expect(row?.status).toBe("available");
	});

	it("a catalog project's bare row coexists with its nested session rows (SpawnPointHeader + chats)", () => {
		const offlineCatalog = new Map([["proj", "/path/to/proj"]]);
		const { facade } = makeFacade({ offlineCatalog });
		facade.adoptById("main", { spawn: "proj" });
		const rows = facade.snapshot();
		expect(rows.find((r) => r.team === "proj")?.kind).toBe("devcontainer"); // the spawn-point header
		expect(rows.find((r) => r.team === "proj.main")?.kind).toBe("loose"); // the nested session
	});

	it("seen guards only an exact same-name collision, never a project-vs-its-sessions pairing", () => {
		// A live loose session whose team name happens to literally equal a catalog project's bare
		// name must not double-list - the one real case `seen` exists for.
		const registry = makeRegistry({ proj: { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } } });
		const offlineCatalog = new Map([["proj", "/path/to/proj"]]);
		const { facade } = makeFacade({ registry, offlineCatalog });
		facade.adoptById("proj", { spawn: "proj" }); // pathological: a non-composite name never surfaces as a row anyway
		const rows = facade.snapshot().filter((r) => r.team === "proj");
		expect(rows).toHaveLength(1);
	});
});

describe("PresenceFacade rows are sorted by team", () => {
	it("returns rows in stable team order regardless of creation order", () => {
		const { facade } = makeFacade();
		facade.adoptById("zebra", { spawn: "proj" });
		facade.adoptById("alpha", { spawn: "proj" });
		const teams = facade.snapshot().map((r) => r.team);
		expect(teams).toEqual([...teams].sort());
	});
});

describe("PresenceFacade class-kill lock: every mutator bumps the plane", () => {
	it("mint/adoptById, rename, forget, clearLive, wake/create start+end, setWorking, clearWorkingFor, clearAllWorking each advance the counter", () => {
		const { facade, planeRegistry } = makeFacade();
		let last = planeRegistry.version("presence")!.counter;
		const expectBumped = () => {
			const cur = planeRegistry.version("presence")!.counter;
			expect(cur).toBeGreaterThan(last);
			last = cur;
		};

		facade.adoptById("main", { spawn: "proj" });
		expectBumped();
		facade.mint({ spawn: "proj" });
		expectBumped();
		facade.rename("proj.main", "renamed");
		expectBumped();
		facade.adoptById("other", { spawn: "proj" }); // exists first, so its wake-in-flight flip is visible
		expectBumped();
		facade.wakeStart("proj.other");
		expectBumped();
		facade.wakeEnd("proj.other");
		expectBumped();
		facade.createStart("proj.other");
		expectBumped();
		facade.createEnd("proj.other");
		expectBumped();
		facade.setWorking("proj.main", { working: true });
		expectBumped();
		facade.clearWorkingFor("proj.main");
		expectBumped();
		facade.setWorking("proj.main", { working: true });
		expectBumped();
		facade.clearAllWorking();
		expectBumped();
		facade.establishOnConfirm("proj.fresh", { live: { team: "proj.fresh", subId: "s1" } });
		expectBumped();
		facade.forget("proj.main");
		expectBumped();
	});

	it("adoptOrReattach bumps on a genuine create but not on a reattach of the same id", () => {
		const { facade, planeRegistry } = makeFacade();
		const before = planeRegistry.version("presence")!.counter;
		const created = facade.adoptOrReattach("dup", { spawn: "proj" });
		expect(created?.created).toBe(true);
		const afterCreate = planeRegistry.version("presence")!.counter;
		expect(afterCreate).toBeGreaterThan(before);

		const reattached = facade.adoptOrReattach("dup", { spawn: "proj" });
		expect(reattached?.created).toBe(false);
		expect(planeRegistry.version("presence")!.counter).toBe(afterCreate); // no bump on reattach
	});

	it("mintOrReattach bumps on a genuine mint but not on a reattach by mintedFrom", () => {
		const { facade, planeRegistry } = makeFacade();
		const before = planeRegistry.version("presence")!.counter;
		const minted = facade.mintOrReattach({ spawn: "proj", mintedFrom: "retry-key-1" });
		expect(minted.created).toBe(true);
		const afterMint = planeRegistry.version("presence")!.counter;
		expect(afterMint).toBeGreaterThan(before);

		const reattached = facade.mintOrReattach({ spawn: "proj", mintedFrom: "retry-key-1" });
		expect(reattached.created).toBe(false);
		expect(planeRegistry.version("presence")!.counter).toBe(afterMint); // no bump on reattach
	});

	it("clearLive bumps when it actually drops a live pointer that was set (an alias re-incarnation ending)", () => {
		const registry = makeRegistry({
			"proj.alias": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
		});
		const { facade, planeRegistry } = makeFacade({ registry });
		facade.adoptById("main", { spawn: "proj" });
		facade.confirm("proj.main", { team: "proj.alias", subId: "sub-1" });
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.status).toBe("online");

		const before = planeRegistry.version("presence")!.counter;
		// clearLive is keyed by the DISCONNECTING socket's own (team, subId) - the alias's, not the
		// record's - matching close()/evictSocket()'s own call shape (sessionStore.clearLive(teamName, subId)
		// for whichever socket just dropped).
		facade.clearLive("proj.alias", "sub-1");
		expect(planeRegistry.version("presence")!.counter).toBeGreaterThan(before);
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.status).toBe("available");
	});

	it("clearLive is a genuine no-op (no bump) when no matching live pointer was ever set", () => {
		const { facade, planeRegistry } = makeFacade();
		facade.adoptById("main", { spawn: "proj" });
		const before = planeRegistry.version("presence")!.counter;
		facade.clearLive("proj.main", "sub-1"); // nothing was ever live under this (team, subId)
		expect(planeRegistry.version("presence")!.counter).toBe(before);
	});

	it("an idempotent wakeEnd/createEnd on a team not in flight does NOT spuriously bump", () => {
		const { facade, planeRegistry } = makeFacade();
		const before = planeRegistry.version("presence")!.counter;
		facade.wakeEnd("never-started");
		facade.createEnd("never-started");
		expect(planeRegistry.version("presence")!.counter).toBe(before);
	});

	it("wakeStart alone (no record) marks dirty but produces no visible bump - nothing to show yet", () => {
		// This is the pre-mint window doWakeTeam describes: a wake attempt in flight for a
		// send-triggered creation whose record does not exist until the host connectivity check
		// passes. Nothing regresses - there is genuinely no tile to render until then.
		const { facade, planeRegistry } = makeFacade();
		const before = planeRegistry.version("presence")!.counter;
		facade.wakeStart("proj.brand-new");
		expect(planeRegistry.version("presence")!.counter).toBe(before);
		expect(facade.snapshot().find((r) => r.team === "proj.brand-new")).toBeUndefined();
	});

	it("confirm bumps when it produces a visible status change (a manual --resume re-incarnation)", () => {
		// confirm()'s liveTeam alias is only consulted by resolveLiveIncarnation when there is no
		// CANONICAL (directly registered) confirmed socket for the team - the manual `claude
		// --resume` re-incarnation case (confirm's own doc comment). Registering the alias's own
		// (team, subId) socket as confirmed makes the alias path resolvable, exercising the real
		// effect confirm() exists for rather than a no-op call with no matching live registry entry.
		const registry = makeRegistry({
			"proj.alias": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
		});
		const { facade, planeRegistry } = makeFacade({ registry });
		facade.adoptById("main", { spawn: "proj" });
		const before = planeRegistry.version("presence")!.counter;
		facade.confirm("proj.main", { team: "proj.alias", subId: "sub-1" });
		expect(planeRegistry.version("presence")!.counter).toBeGreaterThan(before);
		expect(facade.snapshot().find((r) => r.team === "proj.main")?.status).toBe("online");
	});
});

describe("PresenceFacade ambient field exclusion", () => {
	it("lastActive alone changing does not bump the plane (identity excludes it)", () => {
		const nowFn = { value: 1000 };
		const { facade, planeRegistry } = makeFacade({ now: () => nowFn.value });
		facade.adoptById("main", { spawn: "proj" }); // settles the plane against the post-creation state
		const before = planeRegistry.version("presence")!.counter;

		nowFn.value = 999_999; // record.lastSeen is frozen at creation time regardless (no mutator ran)
		facade.markDirty(); // simulates a tripwire-style recheck with only the clock having moved
		expect(planeRegistry.version("presence")!.counter).toBe(before);
	});
});
