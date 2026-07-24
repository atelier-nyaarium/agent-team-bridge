import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createSessionAuthority,
	NOTHING_PRESENTED,
	presentedByRegister,
	presentedByRequest,
	presentedBySocket,
} from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";

////////////////////////////////
//  Functions & Helpers

function socket(boundToken?: string): { data: WsData } {
	return { readyState: 1, data: { boundToken, handshakeConfirmed: true } as WsData } as { data: WsData };
}

function setup() {
	const sessionStore = new SessionStore();
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

/** Put a socket in the registry under a team, the way a completed register does. */
function goLive(registry: TeamRegistry, sessionStore: SessionStore, team: string, ws: { data: WsData }): void {
	registry.set(team, new Map([["s1", ws as never]]));
	sessionStore.bindBySegment(team, { live: { team, subId: "s1" } });
}

////////////////////////////////
//  Tests

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

// The rule this whole module exists to enforce was previously written out at eight call sites and
// went wrong at three of them, each time by reading a credential field directly and deriving its own
// answer. Keeping those fields unreachable is what stops a ninth site inventing a ninth rule.
describe("no call site reaches around the authority", () => {
	// session-store owns the stored field, sessionAuthority owns every rule derived from it,
	// websocket declares WsData and performs the single write that stamps a proven credential onto a
	// socket, and the MCP bridge is the client end that SENDS the header rather than judging it.
	const ALLOWED = new Set([
		"shared/session-store.ts",
		"gateway/sessionAuthority.ts",
		"gateway/websocket.ts",
		"mcp/bridge/helpers.ts",
	]);

	function sourceFiles(dir: string, acc: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry !== "__tests__") sourceFiles(full, acc);
			} else if (entry.endsWith(".ts")) {
				acc.push(full);
			}
		}
		return acc;
	}

	it.each(["bindToken", "boundToken", "x-session-token"])("keeps %s out of every other module", (identifier) => {
		const root = path.join(import.meta.dirname, "..");
		const offenders = sourceFiles(root)
			.filter((f) => !ALLOWED.has(path.relative(root, f)))
			.filter((f) => readFileSync(f, "utf8").includes(identifier))
			.map((f) => path.relative(root, f));

		expect(offenders).toEqual([]);
	});
});
