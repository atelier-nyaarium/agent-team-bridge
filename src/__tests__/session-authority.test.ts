import { describe, expect, it } from "vitest";
import {
	createSessionAuthority,
	NOTHING_PRESENTED,
	presentedByRegister,
	presentedByRequest,
	presentedBySocket,
} from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";

function socket(boundToken?: string): { data: WsData } {
	return { readyState: 1, data: { boundToken, handshakeConfirmed: true } as WsData } as { data: WsData };
}

function setup() {
	const sessionStore = new SessionStore({ ambient: processAmbient() });
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	return { auth, sessionStore, registry };
}

function withToken(token: string): Request {
	return new Request("http://gateway/blob/put", { headers: { "x-session-token": token } });
}

function goLive(registry: TeamRegistry, sessionStore: SessionStore, team: string, ws: { data: WsData }): void {
	registry.set(team, new Map([["s1", ws as never]]));
	sessionStore.bindBySegment(team, { live: { team, subId: "s1" } });
}

describe("what the subject-less byte plane requires", () => {
	it("is open while no local session is bound, matching what an unbound name already allows", () => {
		// UNBOUND satisfies every claim, preserving tokenless launches.
		const { auth } = setup();

		expect(auth.mayUseLocalPlane(NOTHING_PRESENTED)).toBe(true);
	});

	it("refuses a caller presenting nothing once any session is bound", () => {
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);

		expect(auth.mayUseLocalPlane(NOTHING_PRESENTED)).toBe(false);
	});

	it("admits a caller holding any bound session's token, since a transfer names bytes, not a session", () => {
		const { auth, sessionStore } = setup();
		const mine = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(mine);
		sessionStore.activateBinding(mine);
		const other = sessionStore.mint({ spawn: "other-app" });
		sessionStore.ensureBindToken(other);
		sessionStore.activateBinding(other);

		expect(auth.mayUseLocalPlane(presentedByRequest(withToken(token)))).toBe(true);
		expect(auth.mayUseLocalPlane(presentedByRequest(withToken("not-a-real-token")))).toBe(false);
	});

	it("ignores a binding that was only minted, so a reattached session is not locked out", () => {
		// Minted but undelivered tokens cannot lock out the named session.
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		sessionStore.ensureBindToken(record);

		expect(auth.mayUseLocalPlane(NOTHING_PRESENTED)).toBe(true);
	});
});

describe("what a name requires", () => {
	it("requires nothing of a name no record holds", () => {
		const { auth } = setup();

		expect(auth.satisfies(auth.toClaim("recipe-app.abc123"), NOTHING_PRESENTED)).toBe(true);
	});

	it("requires nothing while a binding is only minted, since the session was never handed it", () => {
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		sessionStore.ensureBindToken(record);

		expect(auth.satisfies(auth.toClaim(sessionStore.teamOf(record)), NOTHING_PRESENTED)).toBe(true);
	});

	it("requires the binding once its session has presented it", () => {
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);

		expect(auth.satisfies(auth.toClaim(team), NOTHING_PRESENTED)).toBe(false);
		expect(auth.satisfies(auth.toClaim(team), presentedByRegister({ sessionToken: token }))).toBe(true);
		expect(auth.satisfies(auth.toClaim(team), presentedByRegister({ sessionToken: "wrong" }))).toBe(false);
	});
});

describe("what a socket requires", () => {
	it("requires nothing of an unbound socket, which is how an alias incarnation answers", () => {
		const { auth } = setup();

		expect(auth.satisfies(auth.toAnswerFor(socket()), NOTHING_PRESENTED)).toBe(true);
	});

	it("requires a bound socket's own binding, and rejects a sibling's", () => {
		const { auth } = setup();
		const mine = auth.toAnswerFor(socket("aaaa"));

		expect(auth.satisfies(mine, presentedBySocket(socket("aaaa")))).toBe(true);
		expect(auth.satisfies(mine, presentedBySocket(socket("bbbb")))).toBe(false);
		expect(auth.satisfies(mine, NOTHING_PRESENTED)).toBe(false);
	});

	it("requires nothing of an absent socket", () => {
		const { auth } = setup();

		expect(auth.satisfies(auth.toAnswerFor(undefined), NOTHING_PRESENTED)).toBe(true);
	});
});

describe("acting for whoever serves a name", () => {
	it("defers to the live session, so an alias serving a bound record answers unproven", () => {
		const { auth, sessionStore, registry } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);
		goLive(registry, sessionStore, team, socket());

		expect(auth.satisfies(auth.toActFor(team), NOTHING_PRESENTED)).toBe(true);
	});

	it("falls back to the record while the session is asleep, its easiest moment to forge into", () => {
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);

		expect(auth.satisfies(auth.toActFor(team), NOTHING_PRESENTED)).toBe(false);
		expect(auth.satisfies(auth.toActFor(team), presentedByRegister({ sessionToken: token }))).toBe(true);
	});
});

describe("resolving a caller-supplied name", () => {
	it("resolves every spelling that reaches a session to the same subject", () => {
		const { auth } = setup();

		expect(auth.localTeamKey("recipe-app.abc123")).toBe("recipe-app.abc123");
		expect(auth.localTeamKey("alice.sakura.recipe-app.abc123")).toBe("recipe-app.abc123");
		expect(auth.localTeamKey("recipe-app")).toBe("recipe-app.claude");
	});

	it("resolves nothing for a name that is not a local session, so a gate refuses rather than guesses", () => {
		const { auth } = setup();

		expect(auth.localTeamKey("recipe-app.abc123 ")).toBeNull();
		expect(auth.localTeamKey("RECIPE-APP.ABC123")).toBeNull();
		expect(auth.localTeamKey("bob.othergw.recipe-app.abc123")).toBeNull();
	});
});

describe("presentations", () => {
	it("reads the credential a request carries, and none from a synthetic in-process request", () => {
		const { auth } = setup();
		const need = auth.toAnswerFor(socket("aaaa"));
		const withHeader = new Request("http://gateway/x", { headers: { "x-session-token": "aaaa" } });

		expect(auth.satisfies(need, presentedByRequest(withHeader))).toBe(true);
		expect(auth.satisfies(need, presentedByRequest(new Request("http://gateway/x")))).toBe(false);
	});
});

describe("identity between principals", () => {
	it("treats two unbound principals as the same, and a bound one as distinct from unbound", () => {
		const { auth } = setup();

		expect(auth.sameAs(auth.toAnswerFor(socket()), auth.toAnswerFor(socket()))).toBe(true);
		expect(auth.sameAs(auth.toAnswerFor(socket("aaaa")), auth.toAnswerFor(socket()))).toBe(false);
		expect(auth.sameAs(auth.toAnswerFor(socket("aaaa")), auth.toAnswerFor(socket("aaaa")))).toBe(true);
	});
});

describe("confirmed managed callers", () => {
	it("resolves the exact confirmed record from its active request binding", () => {
		const { auth, sessionStore } = setup();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		sessionStore.confirm(sessionStore.teamOf(record));

		expect(auth.resolveConfirmedManagedSession(withToken(token))).toBe(record);
	});

	it("refuses missing, foreign, inactive, and unconfirmed bindings", () => {
		const { auth, sessionStore } = setup();
		const inactive = sessionStore.mint({ spawn: "inactive-app" });
		const inactiveToken = sessionStore.ensureBindToken(inactive);
		const unconfirmed = sessionStore.mint({ spawn: "unconfirmed-app" });
		const unconfirmedToken = sessionStore.ensureBindToken(unconfirmed);
		sessionStore.activateBinding(unconfirmed);

		expect(auth.resolveConfirmedManagedSession(new Request("http://gateway/codex"))).toBeNull();
		expect(auth.resolveConfirmedManagedSession(withToken("not-a-real-token"))).toBeNull();
		expect(auth.resolveConfirmedManagedSession(withToken(inactiveToken))).toBeNull();
		expect(auth.resolveConfirmedManagedSession(withToken(unconfirmedToken))).toBeNull();
	});

	it("refuses an ambiguous token from a malformed restored snapshot", () => {
		const { auth, sessionStore } = setup();
		const duplicate = {
			sessionLabel: "Work",
			bindToken: "duplicate-token",
			bindActiveAt: 10,
			confirmedAt: 10,
			lastSeen: 10,
		};
		sessionStore.restore({
			"first.aaa111": { ...duplicate, id: "aaa111", spawn: "first" },
			"second.bbb222": { ...duplicate, id: "bbb222", spawn: "second" },
		});

		expect(auth.resolveConfirmedManagedSession(withToken("duplicate-token"))).toBeNull();
	});
});
