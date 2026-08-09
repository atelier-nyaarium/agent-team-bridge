import os from "node:os";
import path from "node:path";
import { Allowlist } from "../../gateway/federation/allowlist.js";
import { type CrossDomainPeer, CrossDomainPeers } from "../../gateway/federation/crossDomainPeers.js";
import { CrossDomainShareState } from "../../gateway/federation/crossDomainShareState.js";
import type { RelayShareState } from "../../gateway/federation/gatewayRelay.js";
import { createSealer, type Sealer } from "../../gateway/federation/sealer.js";
import { PresenceFacade } from "../../gateway/presence.js";
import type { RoutesDeps } from "../../gateway/routes.js";
import { signAdmission } from "../../shared/admission.js";
import { generateIdentity, type Identity, type SealedEnvelope } from "../../shared/crypto.js";
import {
	type FederatedOp,
	FederatedOpSchema,
	signXDomainLink,
	type XDomainLink,
} from "../../shared/federation-protocol.js";
import type { CrossDomainBinding } from "../../shared/pending-job-store.js";
import { PendingJobStore } from "../../shared/pending-job-store.js";
import { PlaneRegistry } from "../../shared/plane-registry.js";
import { parseSessionName } from "../../shared/session-id.js";
import { SessionStore } from "../../shared/session-store.js";
import type { ResponsePayload } from "../../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface FakeEvie {
	client: NonNullable<RoutesDeps["evieClient"]>;
	calls: { action: string; params: Record<string, unknown> }[];
}

export type TeamInfoLite = {
	team: string;
	gatewayId?: string;
	domainId?: string;
	status: string;
	kind?: string;
	queue_depth: number;
};

export const TEST_REQ = new Request("http://gateway/test");

////////////////////////////////
//  Harness: two admitted same-Domain Gateways

// Two admitted Gateways: each seals to the other (the allowlist resolution is mocked
// to the peer's keys; the trust model itself is tested in admission.test.ts).
export const A = generateIdentity();
export const B = generateIdentity();
export function sealerFor(self: Identity, localGatewayId: string, peers: Record<string, Identity>): Sealer {
	const allowlist = {
		resolveGateway: (h: string) => (peers[h] ? { signPub: peers[h].sign.pub, boxPub: peers[h].box.pub } : null),
	} as unknown as Allowlist;
	// These Gateways are same-Domain (the local v1 path); an empty cross-Domain set
	// (never written - no `add` here) keeps resolution on the allowlist.
	const noCrossPeers = new CrossDomainPeers(path.join(os.tmpdir(), "federation-test-no-peers"));
	return createSealer(self, allowlist, localGatewayId, noCrossPeers, "alice");
}
export const sealerA = sealerFor(A, "hosta", { hostb: B });
export const sealerB = sealerFor(B, "hostb", { hosta: A });

/** A mock evie that, for gateway_relay, plays the DESTINATION Gateway: opens the sealed
 * op with the destination's sealer, runs `handle`, and seals the result back. */
export function fakeEvie(opts: {
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

/** RoutesDeps plus the values makeCtx needs to BUILD a presence facade. These are presence's
 * construction inputs, not the route table's, so they are not part of RoutesDeps. */
export type FederationCtxOverrides = Partial<RoutesDeps> & {
	offlineCatalog?: Map<string, string>;
	displayName?: (() => string | null | undefined) | null;
	isAdminDomain?: (() => boolean | null) | null;
};

export function makeCtx(localGatewayId: string, over: FederationCtxOverrides = {}): RoutesDeps {
	const registry = over.registry ?? (new Map() as RoutesDeps["registry"]);
	const offlineCatalog = over.offlineCatalog ?? new Map<string, string>();
	const config = { localGatewayId, localDomainId: "alice", ...over.config };
	return {
		registry,
		conversationRegistry: new Map() as RoutesDeps["conversationRegistry"],
		store: new PendingJobStore<ResponsePayload>(),
		config,
		tryWakeTeam: () => Promise.resolve({ ok: false }),
		// teams()/discover() defer entirely to presence.snapshot() - wire a real facade over
		// the same registry/offlineCatalog/sessionStore this context uses so discovery tests see
		// the local Gateway's own sessions, not an empty list.
		presence:
			over.presence ??
			(() => {
				const facade = new PresenceFacade({
					sessionStore: over.sessionStore ?? new SessionStore(),
					registry,
					offlineCatalog,
					localGatewayId,
					localDomainId: () => config.localDomainId,
					displayName: over.displayName ?? (() => null),
					isAdminDomain: over.isAdminDomain ?? (() => null),
				});
				facade.attach(new PlaneRegistry());
				facade.registerPlane();
				return facade;
			})(),
		...over,
	};
}

export function channelWs(pushed: Record<string, unknown>[]) {
	return { readyState: 1, data: { mode: "channel" }, send: (d: string) => pushed.push(JSON.parse(d)) };
}
export function registryWith(entries: Record<string, unknown>): RoutesDeps["registry"] {
	const registry = new Map() as RoutesDeps["registry"];
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}
// A session is visible only if it has a store record, so a discovery test seeds one per local
// composite session it expects teams() to list.
export function storeWith(...composites: string[]): SessionStore {
	const store = new SessionStore();
	for (const c of composites) {
		const { project, session } = parseSessionName(c);
		store.adoptById(session, { spawn: project });
	}
	return store;
}

////////////////////////////////
//  Harness: destination-enforced scoped crosstalk (share gate)
//
//  The relay handler is the security boundary: a cross-Domain op may only reach a
//  shared session of kind devcontainer|loose, and a cross-Domain list_teams sees only
//  the sessions shared to its Domain. A same-Domain relay (srcDomainId null) is
//  unaffected. These handler-level tests drive handleOp directly with a teams mock and
//  an in-memory share state - no crypto needed (the seal/open is exercised separately).

/** An in-memory RelayShareState recording touches, so a test can assert a permitted
 * delivery refreshed the share. */
export function memShareState(shared: Array<[string, string]> = []): RelayShareState & { touched: string[] } {
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
export function memShareStateStore(shared: Array<[string, string]> = []): CrossDomainShareState {
	const s = new CrossDomainShareState(path.join(os.tmpdir(), `fed-xd-share-${Math.random().toString(36).slice(2)}`));
	for (const [sessionTarget, domainId] of shared) s.share(sessionTarget, { kind: "domain", domainId });
	return s;
}

/** An in-memory crossDomainBinding lookup, the relay handler's window into the
 * PendingJobStore. A recorded session maps to its `{dstDomainId, keyGateway, returnGateway}`
 * binding (the verified Domain + gateways the local Gateway stamped at create); an unknown
 * session returns undefined (no such job). */
export function memBinding(
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
export function gateRoutes(teams: TeamInfoLite[]) {
	const sendCalls: Record<string, unknown>[] = [];
	const respondCalls: Record<string, unknown>[] = [];
	const consolePushCalls: Array<{ entry: unknown; dedupeKey: string }> = [];
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
		consolePush: (entry: unknown, dedupeKey: string) => {
			consolePushCalls.push({ entry, dedupeKey });
			return { delivered: true };
		},
	};
	return { routes, sendCalls, respondCalls, consolePushCalls };
}

// The bare teams a routes.teams() stub returns. gw matches the handler's localGatewayId
// (routes.teams() always stamps the local gateway id), so the list_teams share filter -
// which keys by each team's canonical gateway/name - lines up with the share records.
export function lib(gw = "hostb"): TeamInfoLite {
	return { team: "lib.dev", gatewayId: gw, status: "online", kind: "devcontainer", queue_depth: 0 };
}
export function scratch(gw = "hostb"): TeamInfoLite {
	return { team: "scratch.dev", gatewayId: gw, status: "online", kind: "loose", queue_depth: 0 };
}
export function unknownKindTeam(gw = "hostb"): TeamInfoLite {
	// A roster entry whose kind the gateway does not recognize (e.g. a remote or forged roster).
	// The share/kind gate must fail closed: only devcontainer/loose sessions are shareable.
	return { team: "unknown-kind.dev", gatewayId: gw, status: "online", kind: "unknown", queue_depth: 0 };
}
export function consoleTeam(gw = "hostb"): TeamInfoLite {
	return { team: "pixel.dev", gatewayId: gw, status: "online", kind: "console", queue_depth: 0 };
}

export const crossSend = (to: string): FederatedOp => ({
	kind: "send",
	from: "alice.alice-gw.app.dev",
	to,
	body: "collab?",
	returnRoute: { srcGateway: "alice-gw", srcConversationId: "c1", srcSession: `conv.c1.alice.hostb.${to}` },
});

////////////////////////////////
//  Harness: cross-Domain send flow (real crypto, two Domains)
//
//  alice-gw (Domain "alice") sends to bob.bob-gw.lib.dev (Domain "bob"). The seal MUST be v2
//  (resolved by the (domainId, gatewayId) pair from the disjoint peer set), evie stays
//  content-blind, and the op lands at bob's destination share gate. The local seal path
//  is untouched (covered by the same-Domain harness above).

export const aliceOwner = generateIdentity();
export const bobOwner = generateIdentity();
export const aliceGw = generateIdentity();
export const bobGw = generateIdentity();

export function soloAllowlist(o: Identity, gwId: string, id: Identity): Allowlist {
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

export function xdPeer(
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

export function peersOf(...peers: CrossDomainPeer[]): CrossDomainPeers {
	const s = new CrossDomainPeers(path.join(os.tmpdir(), `fed-xd-peers-${Math.random().toString(36).slice(2)}`));
	for (const p of peers) s.add(p);
	return s;
}
