import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";
import { createMockWs } from "./helpers/websocket.js";

// resolveLiveIncarnation is the ONE record -> live-socket resolver shared by presence listing, send
// routing, and wake suppression: canonical pane (confirmed-preferred) else the alias liveTeam probe.
describe("resolveLiveIncarnation", () => {
	function mk(confirmed: boolean): ServerWebSocket<WsData> {
		const ws = createMockWs();
		ws.data.handshakeConfirmed = confirmed;
		return ws;
	}

	it("returns the canonical pane, preferring a confirmed sub over an unconfirmed one", () => {
		const registry: TeamRegistry = new Map();
		const confirmed = mk(true);
		registry.set(
			"host.abc",
			new Map([
				["s1", mk(false)],
				["s2", confirmed],
			]),
		);
		expect(resolveLiveIncarnation(registry, new SessionStore(), "host.abc")).toBe(confirmed);
	});

	it("falls back to the alias liveTeam socket when no canonical pane is registered", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("abc", { spawn: "host" });
		store.confirm("host.abc", { team: "host.xyz", subId: "s1" });
		const aliasWs = mk(true);
		registry.set("host.xyz", new Map([["s1", aliasWs]]));
		expect(resolveLiveIncarnation(registry, store, "host.abc")).toBe(aliasWs);
	});

	it("returns undefined when neither the canonical pane nor an alias is live", () => {
		const store = new SessionStore();
		store.adoptById("abc", { spawn: "host" });
		expect(resolveLiveIncarnation(new Map(), store, "host.abc")).toBeUndefined();
	});

	it("a confirmed alias wins over an unconfirmed socket squatting the canonical name", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("dev", { spawn: "proj-a" });
		store.confirm("proj-a.dev", { team: "proj-a.alias", subId: "s1" });
		const aliasWs = mk(true);
		registry.set("proj-a.alias", new Map([["s1", aliasWs]]));
		registry.set("proj-a.dev", new Map([["evil", mk(false)]]));
		expect(resolveLiveIncarnation(registry, store, "proj-a.dev")).toBe(aliasWs);
	});

	it("returns an unconfirmed canonical socket only when no confirmed lead exists (verifying)", () => {
		const registry: TeamRegistry = new Map();
		const verifying = mk(false);
		registry.set("proj-a.dev", new Map([["s1", verifying]]));
		expect(resolveLiveIncarnation(registry, new SessionStore(), "proj-a.dev")).toBe(verifying);
	});

	it("does not resolve an unconfirmed socket that re-took the alias slot", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("dev", { spawn: "proj-a" });
		store.confirm("proj-a.dev", { team: "proj-a.alias", subId: "s1" });
		registry.set("proj-a.alias", new Map([["s1", mk(false)]]));
		expect(resolveLiveIncarnation(registry, store, "proj-a.dev")).toBeUndefined();
	});
});
