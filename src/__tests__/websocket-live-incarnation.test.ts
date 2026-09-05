import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";

// The one record-to-socket resolver: the canonical pane, confirmed first, else the alias liveTeam.
describe("resolveLiveIncarnation", () => {
	const socket = (confirmed: boolean): ServerWebSocket<WsData> =>
		({ readyState: 1, data: { handshakeConfirmed: confirmed } }) as unknown as ServerWebSocket<WsData>;
	const registry = (
		entries: Array<[team: string, sockets: Array<[string, ServerWebSocket<WsData>]>]>,
	): TeamRegistry => new Map(entries.map(([team, sockets]) => [team, new Map(sockets)]));
	const aliased = (canonical: string, spawn: string, id: string, alias: string): SessionStore => {
		const store = new SessionStore();
		store.adoptById(id, { spawn });
		store.confirm(canonical, { team: alias, subId: "s1" });
		return store;
	};

	it("prefers a confirmed canonical socket, and answers an unconfirmed one only when no lead exists", () => {
		const confirmed = socket(true);
		const verifying = socket(false);
		expect(
			resolveLiveIncarnation(
				registry([
					[
						"host.abc",
						[
							["s1", socket(false)],
							["s2", confirmed],
						],
					],
				]),
				new SessionStore(),
				"host.abc",
			),
		).toBe(confirmed);
		expect(
			resolveLiveIncarnation(registry([["proj-a.dev", [["s1", verifying]]]]), new SessionStore(), "proj-a.dev"),
		).toBe(verifying);
	});

	it("falls back to the confirmed alias, over a squatter on the canonical name", () => {
		const alias = socket(true);
		const store = aliased("proj-a.dev", "proj-a", "dev", "proj-a.alias");
		expect(resolveLiveIncarnation(registry([["proj-a.alias", [["s1", alias]]]]), store, "proj-a.dev")).toBe(alias);
		expect(
			resolveLiveIncarnation(
				registry([
					["proj-a.alias", [["s1", alias]]],
					["proj-a.dev", [["evil", socket(false)]]],
				]),
				store,
				"proj-a.dev",
			),
		).toBe(alias);
	});

	it("answers nothing when no pane is live, and never an unconfirmed re-taken alias", () => {
		const store = aliased("proj-a.dev", "proj-a", "dev", "proj-a.alias");
		expect(resolveLiveIncarnation(new Map(), store, "proj-a.dev")).toBeUndefined();
		expect(
			resolveLiveIncarnation(registry([["proj-a.alias", [["s1", socket(false)]]]]), store, "proj-a.dev"),
		).toBeUndefined();
	});
});
