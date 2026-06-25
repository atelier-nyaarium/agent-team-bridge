import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Allowlist } from "../gateway/federation/allowlist.js";
import { type CrossDomainPeer, CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { createGatewayRelayHandler, type RelayShareState } from "../gateway/federation/gatewayRelay.js";
import { createSealer, type Sealer } from "../gateway/federation/sealer.js";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity, type Identity, type SealedEnvelope } from "../shared/crypto.js";
import {
	type FederatedOp,
	FederatedOpSchema,
	signXDomainLink,
	type XDomainLink,
} from "../shared/federation-protocol.js";
import type { CrossDomainBinding } from "../shared/pending-job-store.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { SessionId, TeamAddress } from "../shared/session-id.js";
import type { ResponsePayload } from "../shared/types.js";

////////////////////////////////
//  Harness

// Two admitted Gateways: each seals to the other (the allowlist resolution is mocked
// to the peer's keys; the trust model itself is tested in admission.test.ts).
const A = generateIdentity();
const B = generateIdentity();
function sealerFor(self: Identity, localGatewayId: string, peers: Record<string, Identity>): Sealer {
	const allowlist = {
		resolveGateway: (h: string) => (peers[h] ? { signPub: peers[h].sign.pub, boxPub: peers[h].box.pub } : null),
	} as unknown as Allowlist;
	// These Gateways are same-Domain (the local v1 path); an empty cross-Domain set
	// (never written - no `add` here) keeps resolution on the allowlist.
	const noCrossPeers = new CrossDomainPeers(path.join(os.tmpdir(), "federation-test-no-peers"));
	return createSealer(self, allowlist, localGatewayId, noCrossPeers, "alice");
}
const sealerA = sealerFor(A, "hosta", { hostb: B });
const sealerB = sealerFor(B, "hostb", { hosta: A });

interface FakeEvie {
	client: NonNullable<RoutesDeps["evieClient"]>;
	calls: { action: string; params: Record<string, unknown> }[];
}

/** A mock evie that, for gateway_relay, plays the DESTINATION Gateway: opens the sealed
 * op with the destination's sealer, runs `handle`, and seals the result back. */
function fakeEvie(opts: {
	destSealer?: Sealer;
	srcGateway?: string;
	handle?: (op: FederatedOp) => unknown;
	onCall?: (action: string, params: Record<string, unknown>) => unknown;
}): FakeEvie {
	const calls: { action: string; params: Record<string, unknown> }[] = [];
	const client = {
		isConnected: () => true,
		stop: () => {},
		callTool: async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			if (action === "gateway_relay" && opts.destSealer && opts.srcGateway && opts.handle) {
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const op = FederatedOpSchema.parse(opts.destSealer.open(opts.srcGateway, sealed));
				const result = opts.handle(op);
				return { callId: "fake", result: { ok: true, result: opts.destSealer.seal(opts.srcGateway, result) } };
			}
			// Await so an async onCall (a destination that runs an async gated handler)
			// resolves to its reply object, not a Promise.
			return { callId: "fake", result: (await opts.onCall?.(action, params)) ?? { ok: true } };
		},
	} as unknown as NonNullable<RoutesDeps["evieClient"]>;
	return { client, calls };
}

function makeCtx(localGatewayId: string, over: Partial<RoutesDeps> = {}): RoutesDeps {
	return {
		registry: new Map() as RoutesDeps["registry"],
		conversationRegistry: new Map() as RoutesDeps["conversationRegistry"],
		store: new PendingJobStore<ResponsePayload>(),
		config: { LOG_PATH: "/tmp/fed-test.log", RESPONSE_TIMEOUT_MS: 500, localGatewayId, localDomainId: "alice" },
		tryWakeTeam: () => Promise.resolve(false),
		offlineCatalog: new Map(),
		knownTeamPaths: new Map(),
		...over,
	};
}

function channelWs(pushed: Record<string, unknown>[]) {
	return { readyState: 1, data: { mode: "channel" }, send: (d: string) => pushed.push(JSON.parse(d)) };
}
function registryWith(entries: Record<string, unknown>): RoutesDeps["registry"] {
	const registry = new Map() as RoutesDeps["registry"];
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}

////////////////////////////////
//  Tests

describe("federation routing (E2E sealed)", () => {
	it("ORIGIN: seals a cross-Gateway send with the return-route and keeps a local anchor", async () => {
		let seen: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				seen = op;
				return { session_id: "conv:conv-1:hostb/api", status: "running" };
			},
		});
		const ctx = makeCtx("hosta", { evieClient: evie.client, sealer: sealerA });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "recipe-app",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "status?",
			channelOnly: true,
		});
		const json = await res.json();
		expect(json.session_id).toBe("conv:conv-1:hostb/api");
		// The destination decrypted exactly the op we sealed (proves the E2E seal).
		expect(seen).toMatchObject({
			kind: "send",
			to: "api",
			from: "hosta/recipe-app",
			returnRoute: { srcGateway: "hosta", srcSession: "conv:conv-1:hostb/api" },
		});
		// evie only ever saw an opaque sealed envelope, never the op.
		const relay = evie.calls.find((c) => c.action === "gateway_relay");
		expect((relay?.params.payload as { sealed: SealedEnvelope }).sealed.ciphertext).toBeTruthy();
		expect(JSON.stringify(relay?.params.payload)).not.toContain("recipe-app");
		expect(ctx.store.has("conv:conv-1:hostb/api")).toBe(true);
	});

	it("ORIGIN: 503 when the Router is unavailable", async () => {
		const evie = fakeEvie({});
		(evie.client as { isConnected: () => boolean }).isConnected = () => false;
		const { send } = createRoutes(makeCtx("hosta", { evieClient: evie.client, sealer: sealerA }));
		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "x",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "hi",
			channelOnly: true,
		});
		expect(res.status).toBe(503);
	});

	it("DESTINATION: an inbound federated send lands locally and seals its reply back to the origin", async () => {
		let pinned: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerA,
			srcGateway: "hostb",
			handle: (op) => {
				pinned = op;
				return { ok: true };
			},
		});
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("hostb", {
			evieClient: evie.client,
			sealer: sealerB,
			registry: registryWith({ api: channelWs(pushed) }),
		});
		const routes = createRoutes(ctx);
		const handler = createGatewayRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam, localGatewayId: "hostb" });

		const srcSession = "conv:conv-1:hostb/api";
		// A same-Domain relay (srcDomainId null): the share gate is not consulted.
		const result = (await handler.handleOp(
			{
				kind: "send",
				from: "hosta/recipe-app",
				to: "api",
				body: "status?",
				returnRoute: { srcGateway: "hosta", srcConversationId: "conv-1", srcSession },
			},
			"hosta",
			null,
		)) as { session_id: string };
		expect(result.session_id).toBe(srcSession);
		expect(pushed[0]).toMatchObject({ type: "channel_push", from: "hosta/recipe-app", session_id: srcSession });

		const respondRes = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: srcSession,
			status: "completed",
			response: "all good",
		});
		expect((await respondRes.json()).federated).toBe(true);
		// The reply-pin was sealed back to hosta and decrypts to the response_push.
		expect(pinned).toMatchObject({ kind: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DESTINATION: a response_push pinned to the origin delivers to the origin conversation", async () => {
		const senderPushes: Record<string, unknown>[] = [];
		const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
		conversationRegistry.set("conv-1", channelWs(senderPushes) as never);
		const ctx = makeCtx("hosta", { conversationRegistry });
		const srcSession = "conv:conv-1:hostb/api";
		ctx.store.create(srcSession, "recipe-app", "hostb/api", { persistent: true, fromConversationId: "conv-1" });
		const routes = createRoutes(ctx);
		const handler = createGatewayRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam, localGatewayId: "hosta" });

		const result = (await handler.handleOp(
			{ kind: "response_push", session_id: srcSession, status: "completed", response: "all good" },
			"hostb",
			null,
		)) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(senderPushes[0]).toMatchObject({ type: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DISCOVERY: fans out a sealed list_teams over the evie roster and merges", async () => {
		const evie = fakeEvie({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: () => ({
				teams: [
					{
						team: "api",
						gatewayId: "hostb",
						displayName: "Carol's Lab",
						status: "online",
						mode: "channel",
						queue_depth: 0,
					},
				],
			}),
			onCall: (action) =>
				action === "list_gateways" ? { gateways: [{ gatewayId: "hostb", online: true }] } : { ok: true },
		});
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			sealer: sealerA,
			registry: registryWith({ "recipe-app": channelWs([]) }),
			knownTeamPaths: new Map([["recipe-app", "/x"]]),
			displayName: () => "My Lab",
		});
		const { discover } = createRoutes(ctx);

		const teams = (await (await discover()).json()) as {
			team: string;
			gatewayId?: string;
			displayName?: string;
		}[];
		expect(teams.find((t) => t.team === "recipe-app")?.gatewayId).toBe("hosta");
		// The local Gateway stamps its own display name on its sessions.
		expect(teams.find((t) => t.team === "recipe-app")?.displayName).toBe("My Lab");
		// A peer's display name rides through the merge unchanged (the peer Gateway is the
		// authoritative source of its own self-set display name).
		expect(teams.find((t) => t.team === "api")?.gatewayId).toBe("hostb");
		expect(teams.find((t) => t.team === "api")?.displayName).toBe("Carol's Lab");
	});
});

////////////////////////////////
//  Destination-enforced scoped crosstalk
//
//  The relay handler is the security boundary: a cross-Domain op may only reach a
//  shared session of kind devcontainer|loose, and a cross-Domain list_teams sees only
//  the sessions shared to its Domain. A same-Domain relay (srcDomainId null) is
//  unaffected. These handler-level tests drive handleOp directly with a teams mock and
//  an in-memory share state - no crypto needed (the seal/open is exercised below).

/** An in-memory RelayShareState recording touches, so a test can assert a permitted
 * delivery refreshed the share. */
function memShareState(shared: Array<[string, string]> = []): RelayShareState & { touched: string[] } {
	const set = new Set(shared.map(([s, d]) => `${s}|${d}`));
	const touched: string[] = [];
	return {
		isSharedTo: (sessionTarget, domainId) => set.has(`${sessionTarget}|${domainId}`),
		sharesFor: (domainId) => [...set].filter((k) => k.endsWith(`|${domainId}`)).map((k) => k.split("|")[0]),
		touch: (sessionTarget) => touched.push(sessionTarget),
		touched,
	};
}

/** A REAL CrossDomainShareState (the unlink path needs dropDomain/all, which the
 * RelayShareState mock above does not have) in a fresh tmp dir, seeded with shares. */
function memShareStateStore(shared: Array<[string, string]> = []): CrossDomainShareState {
	const s = new CrossDomainShareState(path.join(os.tmpdir(), `fed-xd-share-${Math.random().toString(36).slice(2)}`));
	for (const [sessionTarget, domainId] of shared) s.share(sessionTarget, { kind: "domain", domainId });
	return s;
}

/** An in-memory crossDomainBinding lookup, the relay handler's window into the
 * PendingJobStore. A recorded session maps to its `{dstDomainId, keyGateway, returnGateway}`
 * binding (the verified Domain + gateways the local Gateway stamped at create); an unknown
 * session returns undefined (no such job). */
function memBinding(
	rows: Record<string, { dstDomainId: string | null; keyGateway?: string | null; returnGateway?: string | null }>,
): (sessionId: string) => CrossDomainBinding | undefined {
	return (sessionId) => {
		const r = rows[sessionId];
		if (!r) return undefined;
		return {
			dstDomainId: r.dstDomainId,
			keyGateway: r.keyGateway ?? null,
			returnGateway: r.returnGateway ?? null,
		};
	};
}

/** A routes stub exposing only teams() (the gate + filter read it) and a send/respond
 * that record their calls, so a test can assert the op DID or did NOT land. */
function gateRoutes(teams: TeamInfoLite[]) {
	const sendCalls: Record<string, unknown>[] = [];
	const respondCalls: Record<string, unknown>[] = [];
	const routes = {
		teams: () => new Response(JSON.stringify(teams), { headers: { "content-type": "application/json" } }),
		send: async (_req: Request, body: Record<string, unknown>) => {
			sendCalls.push(body);
			return new Response(JSON.stringify({ session_id: body.sessionId ?? "s", status: "running" }), {
				headers: { "content-type": "application/json" },
			});
		},
		respond: (_req: Request, body: Record<string, unknown>) => {
			respondCalls.push(body);
			return new Response(JSON.stringify({ delivered: true }), {
				headers: { "content-type": "application/json" },
			});
		},
	};
	return { routes, sendCalls, respondCalls };
}

type TeamInfoLite = {
	team: string;
	gatewayId?: string;
	domainId?: string;
	status: string;
	kind?: string;
	queue_depth: number;
};

// The bare teams a routes.teams() stub returns. gw matches the handler's localGatewayId
// (routes.teams() always stamps the local gateway id), so the list_teams share filter -
// which keys by each team's canonical gateway/name - lines up with the share records.
function lib(gw = "hostb"): TeamInfoLite {
	return { team: "lib", gatewayId: gw, status: "online", kind: "devcontainer", queue_depth: 0 };
}
function scratch(gw = "hostb"): TeamInfoLite {
	return { team: "scratch", gatewayId: gw, status: "online", kind: "loose", queue_depth: 0 };
}
function gatewayAgent(gw = "hostb"): TeamInfoLite {
	return { team: "gateway", gatewayId: gw, status: "online", kind: "gateway", queue_depth: 0 };
}
function consoleTeam(gw = "hostb"): TeamInfoLite {
	return { team: "pixel", gatewayId: gw, status: "online", kind: "console", queue_depth: 0 };
}

const crossSend = (to: string): FederatedOp => ({
	kind: "send",
	from: "alice/app",
	to,
	body: "collab?",
	returnRoute: { srcGateway: "alice-gw", srcConversationId: "c1", srcSession: `conv:c1:hostb/${to}` },
});

describe("Phase D destination gate (cross-Domain relay handleOp)", () => {
	it("DENIES a cross-Domain send to a session NOT shared to the caller's Domain", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		// lib exists and is a devcontainer, but it is shared to "carol", not "alice".
		const share = memShareState([["hostb/lib", "carol"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		await expect(handleOp(crossSend("lib"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0); // never reached routes.send
	});

	it("ALLOWS a cross-Domain send to a shared devcontainer and touches the share", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		const share = memShareState([["hostb/lib", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		const result = (await handleOp(crossSend("lib"), "alice-gw", "alice")) as { status: string };
		expect(result.status).toBe("running");
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]).toMatchObject({ to: "lib", from: "alice/app", channelOnly: true });
		// A permitted delivery refreshed the share so a live thread does not auto-forget.
		expect(share.touched).toEqual(["hostb/lib"]);
	});

	it("ALLOWS a cross-Domain send to a shared LOOSE session", async () => {
		const { routes, sendCalls } = gateRoutes([scratch()]);
		const share = memShareState([["hostb/scratch", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		await handleOp(crossSend("scratch"), "alice-gw", "alice");
		expect(sendCalls).toHaveLength(1);
	});

	it("HARD-DENIES a cross-Domain send to the host-agent (kind gateway), even if 'shared'", async () => {
		// A crafted share record for the host-agent must not open it: the kind gate is the
		// hard boundary (agents-only), checked before the share lookup.
		const { routes, sendCalls } = gateRoutes([gatewayAgent()]);
		const share = memShareState([["hostb/gateway", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		await expect(handleOp(crossSend("gateway"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
	});

	it("HARD-DENIES a cross-Domain send to a console-kind session", async () => {
		const { routes, sendCalls } = gateRoutes([consoleTeam()]);
		const share = memShareState([["hostb/pixel", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		await expect(handleOp(crossSend("pixel"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
	});

	it("DENIES a cross-Domain send to an unknown session name", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		const share = memShareState([["hostb/ghost", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		await expect(handleOp(crossSend("ghost"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
	});

	// The denial must be an identical, name-free and kind-free error for an unshared-but-existing
	// session and for a nonexistent one. Distinct messages are an existence oracle: a friend could
	// probe which session names and kinds exist, defeating the shared-only list_teams filter.
	it("the denial for an unshared-existing session is byte-identical to a nonexistent one", async () => {
		const { routes } = gateRoutes([lib()]); // lib exists (devcontainer), shared to nobody
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: memShareState(), // nothing shared to alice
		});
		const existsUnshared = await handleOp(crossSend("lib"), "alice-gw", "alice").catch((e: Error) => e.message);
		const nonexistent = await handleOp(crossSend("ghost"), "alice-gw", "alice").catch((e: Error) => e.message);
		const wrongKind = await handleOp(crossSend("lib"), "alice-gw", "alice").catch((e: Error) => e.message);
		expect(existsUnshared).toBe(nonexistent);
		expect(existsUnshared).toBe(wrongKind);
		// And the message leaks neither the name nor the kind nor the Domain.
		expect(existsUnshared).not.toMatch(/lib|ghost|devcontainer|loose|alice/);
	});

	it("a cross-Domain WAKE is gated like a send (only a shared devcontainer/loose may wake)", async () => {
		const { routes } = gateRoutes([lib()]);
		let woke = false;
		const share = memShareState([["hostb/lib", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: async () => {
				woke = true;
				return true;
			},
			localGatewayId: "hostb",
			shareState: share,
		});
		// Unshared wake denied, no wake fired.
		await expect(handleOp({ kind: "wake", team: "scratch" }, "alice-gw", "alice")).rejects.toThrow(/denied/);
		expect(woke).toBe(false);
		// Shared wake allowed.
		expect(await handleOp({ kind: "wake", team: "lib" }, "alice-gw", "alice")).toEqual({ ok: true });
		expect(woke).toBe(true);
	});

	// A reply gate keyed on the job's RECORDED, verified target Domain (not the bare,
	// friend-controlled gateway id in the session string). alice's anchor for
	// `conv:c1:bob-gw/lib` records dstDomainId "bob": a reply lands only when the VERIFIED
	// sender is Domain "bob" AND gateway "bob-gw" (the gateway in the job's own origin-set key).
	const aliceAnchors = memBinding({ "conv:c1:bob-gw/lib": { dstDomainId: "bob", keyGateway: "bob-gw" } });

	it("DELIVERS a cross-Domain response_push from the friend the send was routed to (no local team needed)", async () => {
		// The origin has NO local 'lib' team (lib lives on bob-gw); the reply must still land.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "alice-gw",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		const r = (await handleOp(
			{ kind: "response_push", session_id: "conv:c1:bob-gw/lib", status: "completed", response: "done" },
			"bob-gw",
			"bob",
		)) as { ok: boolean };
		expect(r.ok).toBe(true);
		expect(respondCalls[0]).toMatchObject({ session_id: "conv:c1:bob-gw/lib", response: "done" });
	});

	it("DENIES a cross-Domain response_push from a DIFFERENT linked friend than the one targeted", async () => {
		// carol is a linked friend too, but the anchor recorded the send went to Domain "bob",
		// so carol (Domain "carol") must not be able to deliver a reply into bob's thread.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "alice-gw",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		await expect(
			handleOp(
				{ kind: "response_push", session_id: "conv:c1:bob-gw/lib", status: "completed", response: "x" },
				"carol-gw",
				"carol",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("DENIES a cross-Domain response_push for a session with no recorded anchor at all", async () => {
		// No anchor for this session id (the friend invented it): deny rather than deliver.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "alice-gw",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		await expect(
			handleOp(
				{ kind: "response_push", session_id: "conv:c1:eve-gw/lib", status: "completed", response: "x" },
				"eve-gw",
				"eve",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("SAME-DOMAIN (srcDomainId null) is unchanged: no share gate, host-agent reachable", async () => {
		// A same-Domain relay never consults the share state. Even the host-agent name lands
		// (the share/kind gate is cross-Domain only); intra-Domain trust is the existing model.
		const { routes, sendCalls } = gateRoutes([gatewayAgent()]);
		const share = memShareState(); // empty - must not be consulted
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		const r = (await handleOp(crossSend("gateway"), "hostb-peer", null)) as { status: string };
		expect(r.status).toBe("running");
		expect(sendCalls).toHaveLength(1);
		expect(share.touched).toEqual([]); // never touched on a same-Domain op
	});
});

describe("Phase D list_teams share filter (cross-Domain caller)", () => {
	const allKinds = [lib(), scratch(), gatewayAgent(), consoleTeam()];

	it("a cross-Domain caller sees ONLY the sessions shared to its Domain", async () => {
		const { routes } = gateRoutes(allKinds);
		// lib + scratch shared to alice; the host-agent + console are never shareable anyway.
		const share = memShareState([
			["hostb/lib", "alice"],
			["hostb/scratch", "alice"],
		]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "alice-gw", "alice")) as { teams: TeamInfoLite[] };
		expect(teams.map((t) => t.team).sort()).toEqual(["lib", "scratch"]);
	});

	it("a cross-Domain caller in a DIFFERENT Domain sees only ITS shares (never another Domain's)", async () => {
		const { routes } = gateRoutes(allKinds);
		const share = memShareState([
			["hostb/lib", "alice"],
			["hostb/scratch", "carol"],
		]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: share,
		});
		const carol = (await handleOp({ kind: "list_teams" }, "carol-gw", "carol")) as { teams: TeamInfoLite[] };
		expect(carol.teams.map((t) => t.team)).toEqual(["scratch"]);
	});

	it("a cross-Domain caller with NO shares sees an empty list (never leaks names)", async () => {
		const { routes } = gateRoutes(allKinds);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: memShareState(),
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "alice-gw", "alice")) as { teams: TeamInfoLite[] };
		expect(teams).toEqual([]);
	});

	it("a SAME-DOMAIN caller (srcDomainId null) still gets the FULL list (today's behavior)", async () => {
		const { routes } = gateRoutes(allKinds);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "hostb",
			shareState: memShareState(), // empty - same-Domain ignores it
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "peer", null)) as { teams: TeamInfoLite[] };
		expect(teams.map((t) => t.team).sort()).toEqual(["gateway", "lib", "pixel", "scratch"]);
	});
});

////////////////////////////////
//  Multi-owner cross-Domain trust regressions (the reply + return-route attacks)
//
//  These drive the relay handler against a REAL PendingJobStore (its crossDomainBinding is
//  the production lookup), so the gates are exercised exactly as wired. The common root cause
//  the fixes close: replies and return-routes were keyed on the BARE, collidable,
//  friend-controlled gateway id instead of the cryptographically-VERIFIED sending Domain.

describe("Fix 1: response_push reply gate binds to the job's verified target Domain", () => {
	// Two linked friends, bob and carol, who happen to run the SAME bare gateway id "dev"
	// (gateway ids are not unique across Domains). alice sent a job to bob's dev; carol must
	// NOT be able to forge a reply into it just because her gateway id also matches.
	function aliceHandler(store: PendingJobStore<ResponsePayload>) {
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "alice-gw",
			shareState: memShareState(),
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId, "alice-gw"),
		});
		return { handleOp, respondCalls };
	}

	it("a friend sharing the target's bare gateway id CANNOT deliver into another friend's job", async () => {
		// alice's origin anchor: a send routed to bob (Domain "bob", gateway "dev"). The store
		// records dstDomainId "bob" and the key gateway "dev".
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv:c1:dev/lib", "alice/app", "dev/lib", {
			persistent: true,
			fromConversationId: "c1",
			dstDomainId: "bob",
		});
		const { handleOp, respondCalls } = aliceHandler(store);

		// carol (Domain "carol", gateway "dev") forges a reply into alice's bob-bound job. Her
		// verified srcGateway "dev" MATCHES the key gateway, but her Domain does not.
		await expect(
			handleOp(
				{ kind: "response_push", session_id: "conv:c1:dev/lib", status: "completed", response: "pwned" },
				"dev",
				"carol",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);

		// The legitimate friend bob (Domain "bob", gateway "dev") still delivers.
		const ok = (await handleOp(
			{ kind: "response_push", session_id: "conv:c1:dev/lib", status: "completed", response: "real" },
			"dev",
			"bob",
		)) as { ok: boolean };
		expect(ok.ok).toBe(true);
		expect(respondCalls[0]).toMatchObject({ session_id: "conv:c1:dev/lib", response: "real" });
	});

	it("a friend whose GATEWAY_ID equals the local gateway id CANNOT deliver into a LOCAL job", async () => {
		// A purely LOCAL channel job (no dstDomainId, no returnRoute), keyed under the local
		// gateway id "alice-gw". A friend who named its own gateway "alice-gw" must not reach it.
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv:owner1:alice-gw/secret", "alice/app", "secret", {
			persistent: true,
			fromConversationId: "owner1",
		});
		const { handleOp, respondCalls } = aliceHandler(store);

		await expect(
			handleOp(
				{
					kind: "response_push",
					session_id: "conv:owner1:alice-gw/secret",
					status: "completed",
					response: "pwned",
				},
				"alice-gw",
				"mallory",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("a LOCAL /send cannot stamp a Domain binding from the request body (local-job hard-deny holds)", async () => {
		// A local container POSTs /send for a local channel team but tries to smuggle a
		// dstDomainId in the body, hoping to make the resulting local job accept a cross-Domain
		// reply. The route must ignore it (only an inbound federated send stamps the binding), so
		// the local job's binding stays null and the response_push gate hard-denies any friend.
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("alice-gw", { registry: registryWith({ app: channelWs(pushed) }) });
		const { send } = createRoutes(ctx);
		await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "owner1",
			to: "app",
			body: "local",
			channelOnly: true,
			dstDomainId: "carol", // spoof attempt
		});
		const jobKey = SessionId.channel("owner1", TeamAddress.local("alice-gw", "app")).key;
		expect(ctx.store.crossDomainBinding(jobKey, "alice-gw")?.dstDomainId).toBeNull();
	});
});

describe("Fix 2: inbound cross-Domain send validates the attacker-controlled returnRoute", () => {
	// bob (the verified sender, Domain "bob", gateway "bob-gw") sends to alice's shared lib.
	// alice is the destination here; lib is shared to bob.
	function destHandler(store: PendingJobStore<ResponsePayload>, sharedTo: string[] = ["bob"]) {
		const sendCalls: Record<string, unknown>[] = [];
		const routes = {
			teams: () =>
				new Response(JSON.stringify([lib("alice-gw")]), { headers: { "content-type": "application/json" } }),
			// A faithful-enough send: it lands the job in the REAL store with the returnRoute +
			// dstDomainId the handler passes, so a follow-up collision check sees a real entry.
			send: async (_req: Request, body: Record<string, unknown>) => {
				sendCalls.push(body);
				store.create(body.sessionId as string, body.from as string, "lib", {
					persistent: true,
					returnRoute: body.returnRoute as never,
					dstDomainId: body.dstDomainId as string | undefined,
				});
				return new Response(JSON.stringify({ session_id: body.sessionId, status: "running" }), {
					headers: { "content-type": "application/json" },
				});
			},
			respond: (_req: Request, _body: Record<string, unknown>) =>
				new Response(JSON.stringify({ delivered: true }), { headers: { "content-type": "application/json" } }),
		};
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "alice-gw",
			shareState: memShareState(sharedTo.map((d) => ["alice-gw/lib", d] as [string, string])),
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId, "alice-gw"),
		});
		return { handleOp, sendCalls };
	}

	it("REJECTS a send whose returnRoute.srcGateway is not the verified sender (no exfil to a third friend)", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store);
		// bob is verified (srcGateway "bob-gw", Domain "bob"), but he points the return-route at
		// a THIRD friend's gateway "carol-gw" so the reply would seal + relay to carol.
		await expect(
			handleOp(
				{
					kind: "send",
					from: "bob/app",
					to: "lib",
					body: "collab?",
					returnRoute: {
						srcGateway: "carol-gw",
						srcConversationId: "c1",
						srcSession: "conv:c1:alice-gw/lib",
					},
				},
				"bob-gw",
				"bob",
			),
		).rejects.toThrow(/return-route does not point back to the sending Gateway/);
		expect(sendCalls).toHaveLength(0); // never landed, never relayed
		expect(store.has("conv:c1:alice-gw/lib")).toBe(false);
	});

	it("a send whose returnRoute.srcSession collides with an UNRELATED job does NOT overwrite it", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A pre-existing, unrelated job: a LOCAL channel job at this key (returnRoute null). Its
		// reply must keep routing locally; a friend must not be able to repoint it.
		store.create("conv:victim:alice-gw/lib", "alice/app", "lib", {
			persistent: true,
			fromConversationId: "victim",
		});
		const { handleOp, sendCalls } = destHandler(store);

		// bob (verified) crafts a send whose srcSession is the victim job's key, trying to make
		// create() overwrite its returnRoute with his (hijacking the victim's reply route).
		await expect(
			handleOp(
				{
					kind: "send",
					from: "bob/app",
					to: "lib",
					body: "hijack",
					returnRoute: {
						srcGateway: "bob-gw",
						srcConversationId: "victim",
						srcSession: "conv:victim:alice-gw/lib",
					},
				},
				"bob-gw",
				"bob",
			),
		).rejects.toThrow(/session collides with an unrelated job/);
		expect(sendCalls).toHaveLength(0);
		// The victim job is untouched: still a local job, no returnRoute grafted on.
		const binding = store.crossDomainBinding("conv:victim:alice-gw/lib", "alice-gw");
		expect(binding?.dstDomainId).toBeNull();
		expect(binding?.returnGateway).toBeNull();
	});

	it("ALLOWS a legitimate cross-Domain send + an idempotent re-send from the SAME friend", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store);
		const send = {
			kind: "send" as const,
			from: "bob/app",
			to: "lib",
			body: "collab?",
			returnRoute: { srcGateway: "bob-gw", srcConversationId: "c1", srcSession: "conv:c1:alice-gw/lib" },
		};
		await handleOp(send, "bob-gw", "bob");
		// A re-send from the same verified friend reuses its own job (idempotent), not a hijack.
		await handleOp(send, "bob-gw", "bob");
		expect(sendCalls).toHaveLength(2);
		const binding = store.crossDomainBinding("conv:c1:alice-gw/lib", "alice-gw");
		expect(binding?.dstDomainId).toBe("bob");
		expect(binding?.returnGateway).toBe("bob-gw");
	});

	it("a DIFFERENT friend sharing bob's bare gateway id still cannot hijack bob's job (Domain-qualified)", async () => {
		// lib is shared to BOTH bob and carol, so carol clears the share gate and the collision
		// guard is what must stop her (this isolates the Domain-qualified collision check).
		const store = new PendingJobStore<ResponsePayload>();
		const { handleOp, sendCalls } = destHandler(store, ["bob", "carol"]);
		// bob lands his job first.
		await handleOp(
			{
				kind: "send",
				from: "bob/app",
				to: "lib",
				body: "collab?",
				returnRoute: { srcGateway: "bob-gw", srcConversationId: "c1", srcSession: "conv:c1:alice-gw/lib" },
			},
			"bob-gw",
			"bob",
		);
		expect(sendCalls).toHaveLength(1);

		// carol runs a gateway whose bare id is ALSO "bob-gw" (collision), is linked + shares the
		// same lib, and reuses bob's session key. The return-route srcGateway matches by string,
		// but her VERIFIED Domain "carol" differs from bob's recorded binding, so it is refused.
		await expect(
			handleOp(
				{
					kind: "send",
					from: "carol/app",
					to: "lib",
					body: "hijack",
					returnRoute: { srcGateway: "bob-gw", srcConversationId: "c1", srcSession: "conv:c1:alice-gw/lib" },
				},
				"bob-gw",
				"carol",
			),
		).rejects.toThrow(/session collides with an unrelated job/);
		expect(sendCalls).toHaveLength(1); // carol's send never landed
		// bob's binding is intact.
		const binding = store.crossDomainBinding("conv:c1:alice-gw/lib", "alice-gw");
		expect(binding?.dstDomainId).toBe("bob");
	});
});

////////////////////////////////
//  Cross-Domain send flow (real crypto, two Domains)
//
//  alice-gw (Domain "alice") sends to bob-gw/lib (Domain "bob"). The seal MUST be v2
//  (resolved by the (domainId, gatewayId) pair from the disjoint peer set), evie stays
//  content-blind, and the op lands at bob's destination share gate. The local seal path
//  is untouched (covered by the same-Domain tests above).

const aliceOwner = generateIdentity();
const bobOwner = generateIdentity();
const aliceGw = generateIdentity();
const bobGw = generateIdentity();

function soloAllowlist(o: Identity, gwId: string, id: Identity): Allowlist {
	const a = new Allowlist(path.join(os.tmpdir(), `fed-xd-${gwId}-${Math.random().toString(36).slice(2)}`));
	a.setOwner(o.sign.pub);
	a.addAdmission(
		signAdmission(
			{ kind: "gateway", signPub: id.sign.pub, boxPub: id.box.pub, gatewayId: gwId, issuedAt: 1, nonce: "bg==" },
			o.sign.priv,
			o.sign.pub,
		),
	);
	return a;
}

function xdPeer(
	friendOwner: Identity,
	friendDomainId: string,
	friendGatewayId: string,
	friend: Identity,
	myOwner: Identity,
): CrossDomainPeer {
	const link: XDomainLink = {
		myOwnerSignPub: friendOwner.sign.pub,
		peerOwnerSignPub: myOwner.sign.pub,
		peerDomainId: friendDomainId,
		peerGatewayId: friendGatewayId,
		peerSignPub: friend.sign.pub,
		peerBoxPub: friend.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
	};
	return {
		friendOwnerSignPub: friendOwner.sign.pub,
		friendDomainId,
		friendGatewayId,
		friendSignPub: friend.sign.pub,
		friendBoxPub: friend.box.pub,
		link: signXDomainLink(link, friendOwner.sign.priv, friendOwner.sign.pub),
	};
}

function peersOf(...peers: CrossDomainPeer[]): CrossDomainPeers {
	const s = new CrossDomainPeers(path.join(os.tmpdir(), `fed-xd-peers-${Math.random().toString(36).slice(2)}`));
	for (const p of peers) s.add(p);
	return s;
}

describe("Phase D cross-Domain send flow (E2E sealed v2)", () => {
	it("seals a cross-Domain send v2 to the right peer and lands it at the destination share gate", async () => {
		// bob's peer set knows alice; bob shares lib to alice. bob's relay handler opens the
		// v2 frame, gates it (shared devcontainer), and lands the send.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes, sendCalls } = gateRoutes([lib()]);
		const bobShare = memShareState([["bob-gw/lib", "alice"]]);
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "bob-gw",
			shareState: bobShare,
		});

		let landed: FederatedOp | undefined;
		// The evie mock plays bob-gw: it opens the v2 frame with bob's sealer (asserting v2 +
		// the resolved Domain), runs bob's gated handler, and seals the reply back.
		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				expect(opened.srcDomainId).toBe("alice"); // resolved by the (domain, gateway) pair, not bare id
				const op = FederatedOpSchema.parse(opened.body);
				landed = op;
				// Run it through bob's real gated handler (async), then seal the reply back to alice.
				return (async () => {
					const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
					return { ok: true, result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result) };
				})();
			},
		});

		// alice's side: it knows bob as a cross-Domain peer, so the send resolves v2.
		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			evieClient: evie.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "c1",
			to: "bob-gw/lib",
			body: "collab?",
			channelOnly: true,
		});
		const json = await res.json();
		expect(json.session_id).toBe("conv:c1:bob-gw/lib");
		expect(ctx.store.has("conv:c1:bob-gw/lib")).toBe(true);

		// The op crossed sealed (evie saw only ciphertext, never the body), landed gated.
		const relay = evie.calls.find((c) => c.action === "gateway_relay");
		expect(relay?.params.srcDomain).toBe("alice");
		expect(JSON.stringify(relay?.params.payload)).not.toContain("collab");
		expect(landed).toMatchObject({ kind: "send", to: "lib", from: "alice-gw/app" });
		expect(sendCalls).toHaveLength(1); // bob's gate permitted it (lib is shared to alice)
		expect(bobShare.touched).toEqual(["bob-gw/lib"]);
	});

	it("a cross-Domain send to an UNSHARED friend session fails (bob's gate denies, no land)", async () => {
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes, sendCalls } = gateRoutes([lib()]);
		const bobShare = memShareState(); // lib is NOT shared to alice
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "bob-gw",
			shareState: bobShare,
		});

		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				const op = FederatedOpSchema.parse(opened.body);
				return (async () => {
					try {
						const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
						return {
							ok: true,
							result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result),
						};
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				})();
			},
		});

		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			evieClient: evie.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "c1",
			to: "bob-gw/lib",
			body: "collab?",
			channelOnly: true,
		});
		// The destination gate denied it, so the origin gets a 502 and keeps NO dangling anchor.
		expect(res.status).toBe(502);
		expect((await res.json()).error).toMatch(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
		expect(ctx.store.has("conv:c1:bob-gw/lib")).toBe(false);
	});

	it("DISCOVERY merges a linked peer's shared sessions (the peer's gate filters them)", async () => {
		// alice discovers: her local team + bob's shared sessions. evie's roster (same-Domain)
		// is empty here; the cross-Domain leg queries bob, whose handler returns only shares.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		const { routes: bobRoutes } = gateRoutes([lib("bob-gw"), scratch("bob-gw"), gatewayAgent("bob-gw")]);
		const bobShare = memShareState([["bob-gw/lib", "alice"]]); // only lib shared to alice
		const bobHandler = createGatewayRelayHandler({
			routes: bobRoutes as never,
			tryWakeTeam: () => Promise.resolve(false),
			localGatewayId: "bob-gw",
			shareState: bobShare,
		});

		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action === "list_gateways") return { gateways: [] }; // no same-Domain peers
				if (action !== "gateway_relay") return { ok: true };
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const opened = bobSealer.openWithSource("alice-gw", sealed, params.srcDomain as string);
				const op = FederatedOpSchema.parse(opened.body);
				return (async () => {
					const result = await bobHandler.handleOp(op, "alice-gw", opened.srcDomainId);
					return { ok: true, result: bobSealer.seal({ domainId: "alice", gatewayId: "alice-gw" }, result) };
				})();
			},
		});

		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const ctx = makeCtx("alice-gw", {
			evieClient: evie.client,
			sealer: aliceSealer,
			crossDomainPeers: alicePeers,
			registry: registryWith({ app: channelWs([]) }),
			knownTeamPaths: new Map([["app", "/x"]]),
		});
		ctx.config.localDomainId = "alice";
		const { discover } = createRoutes(ctx);

		const teams = (await (await discover()).json()) as TeamInfoLite[];
		// alice's own app (local) + bob's shared lib; bob's scratch + host-agent are NOT shared.
		expect(teams.map((t) => t.team).sort()).toEqual(["app", "lib"]);
		const libEntry = teams.find((t) => t.team === "lib");
		expect(libEntry?.gatewayId).toBe("bob-gw");
		// The cross-Domain entry is tagged with the PEER's Domain id (bob), authoritative from
		// alice's own peer set, so the console groups it under bob even if bob's build stamped no
		// domainId. alice's local app carries her own Domain id.
		expect(libEntry?.domainId).toBe("bob");
		expect(teams.find((t) => t.team === "app")?.domainId).toBe("alice");
	});
});

////////////////////////////////
//  Cross-Domain unlink: the gateway-local cleanup (the cross_domain_unlink op's dep)
//
//  The unlink dep wires the three local primitives - CrossDomainPeers.removeByDomain,
//  CrossDomainShareState.dropDomain, PendingJobStore.expireByDomain - over the REAL stores.
//  After it runs, the sealer can no longer resolve the unlinked peer, so an inbound open
//  (and a would-be outbound seal) to that Domain fails closed with no sealer change.

describe("cross-Domain unlink local cleanup (the dep over the real stores)", () => {
	// The dep exactly as index.ts composes it: drop the peers, shares, and in-flight jobs of a
	// friend Domain and report the counts.
	function unlinkDep(
		peers: CrossDomainPeers,
		shares: CrossDomainShareState,
		store: PendingJobStore<ResponsePayload>,
	) {
		return (domainId: string) => ({
			peersRemoved: peers.removeByDomain(domainId),
			sharesDropped: shares.dropDomain(domainId),
			jobsExpired: store.expireByDomain(domainId),
		});
	}

	it("drops the peers, shares, and in-flight jobs of the Domain and returns the counts", () => {
		// bob has alice as a cross-Domain peer, two shares offered to alice, and two in-flight
		// jobs bound to alice (created with dstDomainId "alice").
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const shares = memShareStateStore([
			["bob-gw/lib", "alice"],
			["bob-gw/api", "alice"],
		]);
		const store = new PendingJobStore<ResponsePayload>();
		store.create("conv:c1:alice-gw/lib", "alice-gw/lib", "alice-gw", { persistent: true, dstDomainId: "alice" });
		store.create("conv:c2:alice-gw/api", "alice-gw/api", "alice-gw", { persistent: true, dstDomainId: "alice" });
		// A DIFFERENT Domain's job must survive the alice unlink.
		store.create("conv:c3:carol-gw/docs", "carol-gw/docs", "carol-gw", { persistent: true, dstDomainId: "carol" });

		const counts = unlinkDep(peers, shares, store)("alice");
		expect(counts).toEqual({ peersRemoved: 1, sharesDropped: 2, jobsExpired: 2 });
		// The peer set, the shares to alice, and alice's jobs are gone; carol's job is untouched.
		expect(peers.all()).toHaveLength(0);
		expect(shares.all()).toHaveLength(0);
		expect(store.has("conv:c1:alice-gw/lib")).toBe(false);
		expect(store.has("conv:c3:carol-gw/docs")).toBe(true);
	});

	it("unlinking an unknown / already-unlinked Domain is a clean zero-count no-op", () => {
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const shares = memShareStateStore([["bob-gw/lib", "alice"]]);
		const store = new PendingJobStore<ResponsePayload>();
		const dep = unlinkDep(peers, shares, store);

		// A Domain that was never linked.
		expect(dep("ghost")).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
		// And a SECOND unlink of alice (idempotent: the first already forgot everything).
		expect(dep("alice")).toEqual({ peersRemoved: 1, sharesDropped: 1, jobsExpired: 0 });
		expect(dep("alice")).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
	});

	it("after unlink the sealer no longer resolves the peer: an inbound open fails closed", () => {
		// bob's peer set knows alice; bob's sealer resolves alice's frames against it.
		const bobPeers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const bobSealer = createSealer(bobGw, soloAllowlist(bobOwner, "bob-gw", bobGw), "bob-gw", bobPeers, "bob");
		// alice's sealer knows bob, so she can seal a v2 frame addressed to bob's Domain.
		const alicePeers = peersOf(xdPeer(bobOwner, "bob", "bob-gw", bobGw, aliceOwner));
		const aliceSealer = createSealer(
			aliceGw,
			soloAllowlist(aliceOwner, "alice-gw", aliceGw),
			"alice-gw",
			alicePeers,
			"alice",
		);
		const sealed = aliceSealer.seal({ domainId: "bob", gatewayId: "bob-gw" }, { hello: "world" });

		// Before unlink: bob opens alice's frame, resolving the peer by the (domain, gateway) pair.
		const opened = bobSealer.openWithSource("alice-gw", sealed, "alice");
		expect(opened.srcDomainId).toBe("alice");

		// The unlink cleanup forgets alice on bob's side (the gateway-local effect).
		const shares = memShareStateStore();
		const store = new PendingJobStore<ResponsePayload>();
		unlinkDep(bobPeers, shares, store)("alice");

		// After unlink: the verify-key resolution finds no peer, so the open throws BEFORE unseal -
		// in-flight frames from the unlinked Domain drop at key resolution (fail closed). A fresh
		// frame (re-sealed by alice) is rejected the same way; the captured one above is too.
		const fresh = aliceSealer.seal({ domainId: "bob", gatewayId: "bob-gw" }, { hello: "again" });
		expect(() => bobSealer.openWithSource("alice-gw", fresh, "alice")).toThrow(/not admitted/);
		expect(() => bobSealer.openWithSource("alice-gw", sealed, "alice")).toThrow(/not admitted/);
	});
});

////////////////////////////////
//  sealTargetFor is local-first (a local/friend gateway-id collision)
//
//  sealer.open resolves a peer local-first; the SEND side (sealTargetFor) must match, or a
//  cross-gateway send to your OWN local Gateway whose id COLLIDES with a friend's gateway id
//  is sealed v2 to the FRIEND. sealTargetFor consults `resolvesLocalGateway` before scanning the
//  cross-Domain peer set, so a local target always seals v1 to the local Domain.

const localOwner = generateIdentity();
const senderGw = generateIdentity(); // the sending Gateway, in Domain "alice"
const localGw1 = generateIdentity(); // a SECOND local Gateway, id "gw1"
const friendOwner = generateIdentity();
const friendGw1 = generateIdentity(); // a FRIEND Gateway, ALSO id "gw1", in Domain "friend"

/** A local allowlist that admits BOTH the sender and a second local gateway "gw1", so the
 * sender can seal local-to-local. */
function localAllowlistWithGw1(): Allowlist {
	const a = new Allowlist(path.join(os.tmpdir(), `fed-local-${Math.random().toString(36).slice(2)}`));
	a.setOwner(localOwner.sign.pub);
	a.addAdmission(
		signAdmission(
			{
				kind: "gateway",
				signPub: senderGw.sign.pub,
				boxPub: senderGw.box.pub,
				gatewayId: "sender-gw",
				issuedAt: 1,
				nonce: "c2VuZA==",
			},
			localOwner.sign.priv,
			localOwner.sign.pub,
		),
	);
	a.addAdmission(
		signAdmission(
			{
				kind: "gateway",
				signPub: localGw1.sign.pub,
				boxPub: localGw1.box.pub,
				gatewayId: "gw1",
				issuedAt: 1,
				nonce: "Z3cx",
			},
			localOwner.sign.priv,
			localOwner.sign.pub,
		),
	);
	return a;
}

describe("sealTargetFor local-first (gateway-id collision)", () => {
	it("a send to the LOCAL gw1 seals v1 to the local Domain, NOT v2 to the friend that also runs gw1", async () => {
		const localAllowlist = localAllowlistWithGw1();
		// The sender ALSO has a linked friend Domain whose gateway id collides ("gw1").
		const senderPeers = peersOf(xdPeer(friendOwner, "friend", "gw1", friendGw1, localOwner));
		const senderSealer = createSealer(senderGw, localAllowlist, "sender-gw", senderPeers, "alice");

		// Capture the sealed payload + the srcDomain evie was handed. The local gw1 opens it; the
		// friend's gw1 must NOT be able to (proving it was sealed to the local Domain, not the friend).
		let sealedToOpen: SealedEnvelope | undefined;
		let srcDomainSent: unknown;
		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				sealedToOpen = (params.payload as { sealed: SealedEnvelope }).sealed;
				srcDomainSent = params.srcDomain;
				// The local gw1 opens the v1 frame (local path -> srcDomainId null), runs nothing,
				// and seals an empty reply back so the origin's open succeeds.
				const localGw1Sealer = createSealer(
					localGw1,
					// gw1's view: the same local Domain, admitting the sender so it can verify it.
					(() => {
						const a = new Allowlist(
							path.join(os.tmpdir(), `fed-gw1-${Math.random().toString(36).slice(2)}`),
						);
						a.setOwner(localOwner.sign.pub);
						a.addAdmission(
							signAdmission(
								{
									kind: "gateway",
									signPub: senderGw.sign.pub,
									boxPub: senderGw.box.pub,
									gatewayId: "sender-gw",
									issuedAt: 1,
									nonce: "c2VuZA==",
								},
								localOwner.sign.priv,
								localOwner.sign.pub,
							),
						);
						return a;
					})(),
					"gw1",
					new CrossDomainPeers(
						path.join(os.tmpdir(), `fed-gw1-nopeers-${Math.random().toString(36).slice(2)}`),
					),
					"alice",
				);
				const opened = localGw1Sealer.openWithSource("sender-gw", sealedToOpen);
				// v1 / local: the destination resolved the sender as a LOCAL peer, not cross-Domain.
				expect(opened.srcDomainId).toBeNull();
				return { ok: true, result: localGw1Sealer.seal("sender-gw", { ok: true }) };
			},
		});

		const ctx = makeCtx("sender-gw", {
			evieClient: evie.client,
			sealer: senderSealer,
			crossDomainPeers: senderPeers,
			resolvesLocalGateway: (gatewayId) => localAllowlist.resolveGateway(gatewayId) !== null,
		});
		ctx.config.localDomainId = "alice";
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "c1",
			to: "gw1/team",
			body: "local please",
			channelOnly: true,
		});
		expect(res.status).toBe(200);
		// The v1 local path sends NO srcDomain-keyed cross routing (the relay still stamps
		// localDomainId, but the SEAL is v1: the friend's gw1 cannot open it).
		expect(srcDomainSent).toBe("alice");
		expect(sealedToOpen).toBeDefined();

		// Hard proof it went to the LOCAL Domain, not to the friend: the friend's gw1 sealer (the colliding
		// peer) cannot open the envelope - the local target sealed to the LOCAL gw1's box key.
		const friendGw1Sealer = createSealer(
			friendGw1,
			(() => {
				const a = new Allowlist(path.join(os.tmpdir(), `fed-friend-${Math.random().toString(36).slice(2)}`));
				a.setOwner(friendOwner.sign.pub);
				return a;
			})(),
			"gw1",
			peersOf(xdPeer(localOwner, "alice", "sender-gw", senderGw, friendOwner)),
			"friend",
		);
		expect(() => friendGw1Sealer.openWithSource("sender-gw", sealedToOpen as SealedEnvelope, "alice")).toThrow();
	});
});

////////////////////////////////
//  sealTargetFor (domainId, gatewayId): the same-id-two-Domains disambiguation
//
//  Two LINKED friend Domains may run an identically-named gateway. A bare-gatewayId send is
//  ambiguous (the sealer refuses rather than guess); a send carrying the selected session's
//  Domain resolves the right peer by the full (domainId, gatewayId) pair and seals v2 to it.

describe("sealTargetFor (domainId, gatewayId) disambiguation", () => {
	const senderOwner = generateIdentity();
	const senderGw = generateIdentity();
	const friend1Owner = generateIdentity();
	const friend1Gw = generateIdentity(); // gateway id "shared-gw" in Domain "friend1"
	const friend2Owner = generateIdentity();
	const friend2Gw = generateIdentity(); // gateway id "shared-gw" in Domain "friend2"

	// The sender links BOTH friends, whose gateway ids collide ("shared-gw").
	function senderCtx(over: Partial<RoutesDeps> = {}) {
		const senderPeers = peersOf(
			xdPeer(friend1Owner, "friend1", "shared-gw", friend1Gw, senderOwner),
			xdPeer(friend2Owner, "friend2", "shared-gw", friend2Gw, senderOwner),
		);
		const senderSealer = createSealer(
			senderGw,
			soloAllowlist(senderOwner, "sender-gw", senderGw),
			"sender-gw",
			senderPeers,
			"alice",
		);
		const ctx = makeCtx("sender-gw", { sealer: senderSealer, crossDomainPeers: senderPeers, ...over });
		ctx.config.localDomainId = "alice";
		return { ctx, senderPeers };
	}

	it("a bare cross-Domain send to a gateway id shared by two linked Domains is ambiguous (no seal)", async () => {
		const { ctx } = senderCtx({ evieClient: fakeEvie({}).client });
		const { send } = createRoutes(ctx);
		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "c1",
			to: "shared-gw/lib",
			body: "collab?",
			channelOnly: true,
		});
		expect(res.status).toBe(502);
		expect((await res.json()).error).toMatch(/ambiguous across linked Domains/);
		expect(ctx.store.has("conv:c1:shared-gw/lib")).toBe(false);
	});

	it("a send carrying targetDomainId resolves the right peer and seals v2 to that Domain", async () => {
		// friend2's gateway opens the frame; only friend2's box key can, proving the send went
		// to friend2 (not friend1, which shares the gateway id) once the Domain disambiguated it.
		let openedByFriend2: { srcDomainId: string | null } | undefined;
		const friend2Sealer = createSealer(
			friend2Gw,
			soloAllowlist(friend2Owner, "shared-gw", friend2Gw),
			"shared-gw",
			peersOf(xdPeer(senderOwner, "alice", "sender-gw", senderGw, friend2Owner)),
			"friend2",
		);
		const evie = fakeEvie({
			onCall: (action, params) => {
				if (action !== "gateway_relay") return { ok: true };
				expect(params.srcDomain).toBe("alice");
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				openedByFriend2 = friend2Sealer.openWithSource("sender-gw", sealed, "alice");
				expect(openedByFriend2.srcDomainId).toBe("alice");
				return {
					ok: true,
					result: friend2Sealer.seal({ domainId: "alice", gatewayId: "sender-gw" }, { ok: true }),
				};
			},
		});
		const { ctx } = senderCtx({ evieClient: evie.client });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://gateway/send", { method: "POST" }), {
			from: "app",
			fromConversationId: "c1",
			to: "shared-gw/lib",
			targetDomainId: "friend2",
			body: "collab?",
			channelOnly: true,
		});
		expect(res.status).toBe(200);
		expect((await res.json()).session_id).toBe("conv:c1:shared-gw/lib");
		expect(openedByFriend2).toBeDefined();
		// The anchor records the resolved target Domain so a reply is bound to friend2.
		expect(ctx.store.crossDomainBinding("conv:c1:shared-gw/lib", "sender-gw")?.dstDomainId).toBe("friend2");
	});
});

////////////////////////////////
//  Share auto-forget sweep wiring (the production-shaped sweep + isLive)
//
//  crossDomainShareState.sweep is unit-tested in cross-domain-share-state.test.ts; this
//  proves the GATEWAY wiring: the same isLive predicate the gateway builds (a live
//  persistent cross-Domain pending-job for the session) suppresses a live share's forget
//  while a stale, thread-less share is dropped.

describe("share auto-forget wiring (isLive predicate + sweep)", () => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

	// The exact predicate the gateway wires in startGateway(): a live persistent cross-Domain
	// thread (a pending job with a returnRoute whose origin Gateway is a linked friend peer)
	// for the canonical session target.
	function isLiveFor(
		store: PendingJobStore<ResponsePayload>,
		peers: CrossDomainPeers,
		localGatewayId: string,
		now: number = Date.now(),
	) {
		return (sessionTarget: string): boolean =>
			store.hasLiveCrossDomainThread(
				sessionTarget,
				(gatewayId) => peers.all().some((p) => p.friendGatewayId === gatewayId),
				localGatewayId,
				THIRTY_DAYS_MS,
				now,
			);
	}

	/** Create a persistent cross-Domain anchor whose createdAt is PINNED to `at` (so a test can
	 * make a thread look recent or long-dead independent of the wall clock). */
	function anchorAt(store: PendingJobStore<ResponsePayload>, id: string, srcGateway: string, at: number): void {
		const realNow = Date.now;
		Date.now = () => at;
		try {
			store.create(id, "alice/app", "lib", {
				persistent: true,
				fromConversationId: "c1",
				returnRoute: { srcGateway, srcConversationId: "c1", srcSession: id },
			});
		} finally {
			Date.now = realNow;
		}
	}

	it("the wired sweep DROPS a stale share but isLive SUPPRESSES a live one", () => {
		const share = new CrossDomainShareState(
			path.join(os.tmpdir(), `fed-sweep-${Math.random().toString(36).slice(2)}`),
		);
		share.share("bob-gw/lib", { kind: "domain", domainId: "alice" }); // will be kept by a RECENTLY-ACTIVE thread
		share.share("bob-gw/old", { kind: "domain", domainId: "alice" }); // stale, thread-less -> dropped

		// Sweep far in the future so BOTH shares are past their absence TTL. The live thread's
		// anchor is pinned recent relative to that sweep instant (ongoing traffic refreshes
		// createdAt), so it counts as live; bob-gw/old has no thread at all.
		const sweepNow = Date.now() + THIRTY_DAYS_MS + 1;
		const store = new PendingJobStore<ResponsePayload>();
		anchorAt(store, "conv:c1:bob-gw/lib", "alice-gw", sweepNow);
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const isLive = isLiveFor(store, peers, "bob-gw", sweepNow);

		const dropped = share.sweep(sweepNow, THIRTY_DAYS_MS, isLive);
		expect(dropped).toBe(1); // bob-gw/old only
		expect(share.isSharedTo("bob-gw/lib", "alice", () => true)).toBe(true); // recent thread kept it
		expect(share.isSharedTo("bob-gw/old", "alice", () => true)).toBe(false); // stale, forgotten
	});

	// isLive must mean RECENTLY ACTIVE, not "ever touched": a single long-dead anchor must not
	// pin a share forever. A thread idle past the recency window stops suppressing the forget.
	it("a share whose ONLY cross-Domain anchor is older than the recency window IS swept", () => {
		const base = Date.now();
		// Two full windows past `base`, so both the share's absence TTL and the anchor's recency
		// window are comfortably exceeded (no off-by-ms ambiguity with the live `share()` clock).
		const sweepNow = base + THIRTY_DAYS_MS * 2;
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));

		const share = new CrossDomainShareState(
			path.join(os.tmpdir(), `fed-stale-${Math.random().toString(36).slice(2)}`),
		);
		share.share("bob-gw/lib", { kind: "domain", domainId: "alice" }); // lastSeenAt ~= base, so it is past TTL at sweepNow

		// A persistent cross-Domain anchor that last saw traffic at `base` (its createdAt), so by
		// sweepNow it is older than the recency window: it must NOT suppress the forget.
		const store = new PendingJobStore<ResponsePayload>();
		anchorAt(store, "conv:c1:bob-gw/lib", "alice-gw", base);
		expect(isLiveFor(store, peers, "bob-gw", sweepNow)("bob-gw/lib")).toBe(false);
		const dropped = share.sweep(sweepNow, THIRTY_DAYS_MS, isLiveFor(store, peers, "bob-gw", sweepNow));
		expect(dropped).toBe(1);
		expect(share.isSharedTo("bob-gw/lib", "alice", () => true)).toBe(false);

		// Contrast: an anchor touched recently (createdAt at sweepNow) still suppresses the forget.
		const live = new PendingJobStore<ResponsePayload>();
		anchorAt(live, "conv:c1:bob-gw/lib", "alice-gw", sweepNow);
		expect(isLiveFor(live, peers, "bob-gw", sweepNow)("bob-gw/lib")).toBe(true);
	});

	it("isLive is false for a job whose returnRoute origin is NOT a linked peer (same-Domain federated)", () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A federated job, but its origin Gateway is a SAME-Domain peer (not in the cross set).
		store.create("conv:c1:bob-gw/lib", "x", "lib", {
			persistent: true,
			returnRoute: { srcGateway: "local-peer", srcConversationId: "c1", srcSession: "conv:c1:bob-gw/lib" },
		});
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		const isLive = isLiveFor(store, peers, "bob-gw");
		expect(isLive("bob-gw/lib")).toBe(false);
	});

	it("isLive is false for a local (non-returnRoute) persistent job targeting the session", () => {
		const store = new PendingJobStore<ResponsePayload>();
		// A plain local channel job (no returnRoute) must not count as a cross-Domain thread.
		store.create("conv:c1:bob-gw/lib", "x", "lib", { persistent: true, fromConversationId: "c1" });
		const peers = peersOf(xdPeer(aliceOwner, "alice", "alice-gw", aliceGw, bobOwner));
		expect(isLiveFor(store, peers, "bob-gw")("bob-gw/lib")).toBe(false);
	});
});

////////////////////////////////
//  Per-session un-share enforced on the destination reply forward (response_push)
//
//  The leak: B shares lib to Domain A; A sends to B/lib (accepted, B creates a destination
//  job bound to A, returnRoute to the origin, dstDomainId A); B un-shares lib from A; B's agent's
//  in-flight reply must NOT still forward to the origin, because the share is gone. routes.respond
//  re-reads the share on the cross-Domain reply forward and DROPS it when no longer shared.

describe("destination reply forward re-checks the per-session share (cross-Domain)", () => {
	const SRC_SESSION = "conv:c1:hostb/lib"; // B's own gateway id in the origin-set key
	const RETURN_ROUTE = { srcGateway: "hosta", srcConversationId: "c1", srcSession: SRC_SESSION };

	/** Seed a DESTINATION job on B exactly as the cross-Domain inbound send path does: id is
	 * the origin-set canonical session key, `to` the bare local name, with the verified friend
	 * Domain + return-route pinned. */
	function seedDestJob(store: PendingJobStore<ResponsePayload>): void {
		store.create(SRC_SESSION, "alice/app", "lib", {
			persistent: true,
			fromConversationId: "c1",
			returnRoute: RETURN_ROUTE,
			dstDomainId: "alice",
		});
	}

	function respondOnB(isShared: boolean) {
		// Records gateway_relay so we can assert the response_push DID or did NOT forward.
		const evie = fakeEvie({ onCall: () => ({ ok: true }) });
		const ctx = makeCtx("hostb", {
			evieClient: evie.client,
			sealer: sealerB,
			isSharedToForReply: (sessionTarget, domainId) =>
				isShared && sessionTarget === "hostb/lib" && domainId === "alice",
		});
		seedDestJob(ctx.store);
		const routes = createRoutes(ctx);
		return { routes, evie };
	}

	it("DROPS the response_push for a session that was un-shared (does not forward to the origin)", async () => {
		const { routes, evie } = respondOnB(false);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "leaked?",
		});
		const json = await res.json();
		expect(json).toEqual({ delivered: false, dropped: "unshared" });
		// Let any (erroneous) background relay attempt flush, then assert NONE happened.
		await new Promise((r) => setTimeout(r, 0));
		expect(evie.calls.find((c) => c.action === "gateway_relay")).toBeUndefined();
	});

	it("FORWARDS the response_push normally for a session that is still shared", async () => {
		const { routes, evie } = respondOnB(true);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "all good",
		});
		expect((await res.json()).federated).toBe(true);
		// The forward is fire-and-forget; let it run, then assert it relayed to the origin.
		await new Promise((r) => setTimeout(r, 0));
		expect(evie.calls.find((c) => c.action === "gateway_relay")).toBeDefined();
	});

	it("a SAME-DOMAIN federated reply (dstDomainId null) is never gated, even with no share", async () => {
		// The reply gate fires only on a cross-Domain job (dstDomainId set). A same-Domain
		// federated job has a returnRoute but null Domain binding, so it forwards unchanged.
		const evie = fakeEvie({ onCall: () => ({ ok: true }) });
		const ctx = makeCtx("hostb", {
			evieClient: evie.client,
			sealer: sealerB,
			isSharedToForReply: () => false, // would drop IF consulted
		});
		ctx.store.create(SRC_SESSION, "peer/app", "lib", {
			persistent: true,
			fromConversationId: "c1",
			returnRoute: RETURN_ROUTE,
			// no dstDomainId -> same-Domain federated
		});
		const routes = createRoutes(ctx);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "all good",
		});
		expect((await res.json()).federated).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(evie.calls.find((c) => c.action === "gateway_relay")).toBeDefined();
	});
});
