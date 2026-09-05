import { describe, expect, it } from "vitest";
import { HandshakeGate } from "../gateway/handshakeGate.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import {
	HANDSHAKE_PENDING_TTL_MS,
	HANDSHAKE_REPUSH_DEDUPE_MS,
	HANDSHAKE_REPUSH_MAX_ATTEMPTS,
} from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const WINDOW = HANDSHAKE_REPUSH_DEDUPE_MS;
const TTL = HANDSHAKE_PENDING_TTL_MS;

/** The handshake rules, exercised without a socket: id ownership, throttles, caps, lead memory. */
describe("HandshakeGate", () => {
	function makeGate() {
		let now = 1_000_000;
		const gate = new HandshakeGate(fakeAmbient({ now: () => now }));
		return {
			gate,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	/** Drive one successful repush (decide must answer send; the caller's send succeeded). */
	function repushOnce(gate: HandshakeGate, team: string, subId: string) {
		const d = gate.decideRepush(team, subId);
		expect(d.kind).toBe("send");
		if (d.kind === "send") d.commit();
		return d;
	}

	it("a re-mint for the same coordinates leaves exactly one resolvable id", () => {
		const { gate } = makeGate();
		const first = gate.mint("app.dev", "s1");
		const second = gate.mint("app.dev", "s1");
		expect(gate.pendingOf(first.hsId)).toBeUndefined();
		expect(gate.pendingOf(second.hsId)).toBeDefined();
		expect(gate.pendingIdFor("app.dev", "s1")).toBe(second.hsId);
	});

	it("a read does not consume the entry; only consume does", () => {
		const { gate } = makeGate();
		const { hsId } = gate.mint("app.dev", "s1");
		expect(gate.pendingOf(hsId)).toBeDefined();
		expect(gate.pendingOf(hsId)).toBeDefined();
		gate.consume(hsId);
		expect(gate.pendingOf(hsId)).toBeUndefined();
	});

	it("a re-push reuses the minted id byte-identically, and a failed send charges nothing", () => {
		const { gate, advance } = makeGate();
		const minted = gate.mint("app.dev", "s1");
		// Same-instant double-trigger collapses even on a first attempt.
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("throttled");

		advance(WINDOW);
		const d = gate.decideRepush("app.dev", "s1");
		expect(d.kind).toBe("send");
		if (d.kind !== "send") return;
		expect(d.hsId).toBe(minted.hsId);
		expect(d.push).toBe(minted.push);
		expect(d.attempt).toBe(1);
		// The send failed, so nothing was committed: the same first attempt is still owed.
		const retry = gate.decideRepush("app.dev", "s1");
		expect(retry.kind === "send" && retry.attempt === 1).toBe(true);
	});

	it("the team-wide window gates only an entry's second attempt onward", () => {
		const { gate, advance } = makeGate();
		gate.mint("app.dev", "s1");
		gate.mint("app.dev", "s2");
		advance(WINDOW);
		repushOnce(gate, "app.dev", "s1");
		// A sibling's FIRST shot lands inside the team window the commit above just opened.
		expect(gate.decideRepush("app.dev", "s2").kind).toBe("send");
	});

	it("an entry's second attempt waits out the team window a sibling moved", () => {
		const { gate, advance } = makeGate();
		gate.mint("app.dev", "s1");
		advance(WINDOW);
		repushOnce(gate, "app.dev", "s1"); // s1 now has one committed attempt
		advance(WINDOW);
		gate.mint("app.dev", "s2");
		advance(WINDOW);
		repushOnce(gate, "app.dev", "s2"); // the team window reopens NOW
		advance(WINDOW - 1);
		// s1's own window has long elapsed; only the team-wide gate can be holding it.
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("throttled");
		// A sweep before the window elapses is pure cleanup and must not lift the throttle.
		expect(gate.sweep()).toBe(0);
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("throttled");
		advance(1);
		// The window elapsed: the entry now throttles nothing and the sweep reclaims it.
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("send");
		expect(gate.sweep()).toBe(1);
	});

	it("caps a single entry's attempts for good", () => {
		const { gate, advance } = makeGate();
		gate.mint("app.dev", "s1");
		for (let i = 0; i < HANDSHAKE_REPUSH_MAX_ATTEMPTS; i++) {
			advance(WINDOW);
			repushOnce(gate, "app.dev", "s1");
		}
		advance(WINDOW);
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("capped");
	});

	it("a capped entry stops BLOCKING once its TTL passes, so the lockout self-heals (issue #251)", () => {
		// The two bounds have different jobs: the attempt cap stops pushing, the TTL stops blocking.
		// Without the second, a session that missed all five prompts was refused for the life of its
		// socket, told to restart, with no way to learn its own hs- id.
		const { gate, advance } = makeGate();
		gate.mint("app.dev", "s1");
		for (let i = 0; i < HANDSHAKE_REPUSH_MAX_ATTEMPTS; i++) {
			advance(WINDOW);
			repushOnce(gate, "app.dev", "s1");
		}
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("capped");
		// Still enforced right up to the TTL: the last push it received is answerable until then.
		expect(gate.pendingIdFor("app.dev", "s1")).toBeDefined();

		advance(TTL);
		// Now the BLOCKING readers treat it as absent, which is the gate's own fail-open case.
		expect(gate.pendingIdFor("app.dev", "s1")).toBeUndefined();
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("no-pending");
	});

	it("an expired handshake stops blocking but stays ANSWERABLE, so a late answer still confirms", () => {
		// Expiry ends what the entry may do to OTHERS, never what its own socket may do with it: the
		// challenge's authenticity does not decay, and refusing a late answer would trade the old
		// lockout for a session stuck "verifying" until reconnect. Boundedness needs no sweep - the
		// map is held to live unconfirmed sockets by forget() on close.
		const { gate, advance } = makeGate();
		const { hsId } = gate.mint("app.dev", "s1");

		advance(TTL);
		expect(gate.pendingIdFor("app.dev", "s1")).toBeUndefined();
		expect(gate.pendingOf(hsId)).toBeDefined();
		gate.consume(hsId);
		expect(gate.pendingOf(hsId)).toBeUndefined();
	});

	it("forget drops the coordinates' pending entry so a repush finds nothing", () => {
		const { gate } = makeGate();
		gate.mint("app.dev", "s1");
		gate.forget("app.dev", "s1");
		expect(gate.decideRepush("app.dev", "s1").kind).toBe("no-pending");
		expect(gate.pendingIdFor("app.dev", "s1")).toBeUndefined();
	});

	it("remembers which binding confirmed a team's lead, opaquely", () => {
		const { gate } = makeGate();
		// A real binding value from the sole authority; the gate passes it through untouched.
		const auth = createSessionAuthority({
			sessionStore: new SessionStore({ ambient: processAmbient() }),
			registry: new Map(),
			resolveLive: () => undefined,
			localDomainId: () => "local",
			localGatewayId: "test-host",
		});
		const binding = auth.toAnswerFor(undefined);
		expect(gate.confirmedBy("app.dev")).toBeUndefined();
		gate.confirmLead("app.dev", binding);
		expect(gate.confirmedBy("app.dev")).toBe(binding);
	});

	it("accepts structured claims and exact legacy tokens only", () => {
		expect(HandshakeGate.leadClaim({ isMainOrLead: true })).toBe(true);
		expect(HandshakeGate.leadClaim({ isMainOrLead: false }, "true")).toBe(false);
		expect(HandshakeGate.leadClaim(undefined, " true ")).toBe(true);
		expect(HandshakeGate.leadClaim(undefined, "I am the lead: TRUE")).toBeUndefined();
		expect(HandshakeGate.leadClaim()).toBeUndefined();
	});
});
