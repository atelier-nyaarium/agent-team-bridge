import { describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { frame, jsonRes, OWNER_PUB } from "./helpers/console.js";

describe("console cross-Domain handshake ops", () => {
	// A linked-but-offline peer: written into the peer set by a confirmed link, but its gateway is
	// not online and it has shared nothing back, so it never enters discovery. list_peers must still
	// report it (the roster read the post-link sharing flow depends on).
	const PEER_SET = [
		{ domainId: "bob", gatewayId: "bob-desktop", ownerSignPub: "bob-owner-key" },
		{ domainId: "carol", gatewayId: "carol-laptop", ownerSignPub: "carol-owner-key" },
	];
	function makeCrossDomainHarness() {
		const calls: Record<string, unknown[]> = {
			listen: [],
			request: [],
			confirm: [],
			cancel: [],
			listenState: [],
			listPeers: [],
		};
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
			discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
		};
		const crossDomain = {
			listen: () => {
				calls.listen.push({});
				return {
					listeningToken: "test-host.tok",
					receiverOwnerSignPub: "recv-owner",
					receiverGatewaySignPub: "recv-gw-sign",
					receiverGatewayBoxPub: "recv-gw-box",
					receiverDomainId: "alice",
					receiverGatewayId: "test-host",
					expiresAt: 123,
				};
			},
			request: async (args: Record<string, unknown>) => {
				calls.request.push(args);
				return {
					sas: "421717930842",
					requesterOwnerSignPub: args.requesterOwnerSignPub as string,
					receiverOwnerSignPub: "recv-owner",
					receiverDomainId: "bob",
					receiverGatewayId: "bob-desktop",
					receiverGatewaySignPub: "recv-gw-sign",
					receiverGatewayBoxPub: "recv-gw-box",
				};
			},
			confirm: (args: Record<string, unknown>) => {
				calls.confirm.push(args);
				return { ok: true };
			},
			cancel: (args: Record<string, unknown>) => {
				calls.cancel.push(args);
				return true;
			},
			listenState: (listeningToken: string) => {
				calls.listenState.push({ listeningToken });
				return {
					pairingArrived: true,
					pin: "thepin",
					sas: "421717930842",
					friendOwnerSignPub: "friend-owner",
					friendGatewaySignPub: "friend-gw-sign",
					friendGatewayBoxPub: "friend-gw-box",
					friendDomainId: "bob",
					friendGatewayId: "bob-desktop",
					expiresAt: 123,
				};
			},
			listPeers: () => {
				calls.listPeers.push({});
				return { peers: PEER_SET };
			},
		};
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes,
			crossDomain,
		});
		return { handler, calls };
	}

	const link = {
		link: {
			myOwnerSignPub: "mo",
			peerOwnerSignPub: "po",
			peerDomainId: "bob",
			peerGatewayId: "bob-desktop",
			peerSignPub: "ps",
			peerBoxPub: "pb",
			issuedAt: 1,
			nonce: "n",
		},
		ownerSignPub: "mo",
		signature: "sig",
	};

	it("cross_domain_listen returns the minted token + receiver keys", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_listen" }, "l1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ listeningToken: "test-host.tok", receiverGatewayId: "test-host" });
		expect(h.calls.listen).toHaveLength(1);
	});

	it("cross_domain_request passes the VERIFIED owner key (the frame's), not the op's, to the coordinator", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_request",
					listeningToken: "bob-desktop.tok",
					pin: "thepin",
					// A console could LIE here; the gateway must ignore it and use the verified owner.
					requesterOwnerSignPub: "ATTACKER-CLAIMED-OWNER",
					requesterDomainId: "alice",
					requesterGatewayId: "test-host",
				},
				"rq1",
			),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ sas: "421717930842" });
		// The dispatch forwarded the FRAME's ownerSignPub (OWNER_PUB), never the op's claim.
		expect(h.calls.request[0]).toMatchObject({
			listeningToken: "bob-desktop.tok",
			pin: "thepin",
			requesterOwnerSignPub: OWNER_PUB,
			requesterDomainId: "alice",
			requesterGatewayId: "test-host",
		});
	});

	it("cross_domain_confirm forwards only this owner's link side and returns ok (Model A)", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_confirm", pin: "thepin", mySignedLink: link }, "cf1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.confirm[0]).toEqual({ pin: "thepin", mySignedLink: link });
	});

	it("cross_domain_listen_state forwards the token and returns the receiver's pairing state", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_listen_state", listeningToken: "test-host.tok" }, "ls1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({
			pairingArrived: true,
			sas: "421717930842",
			friendGatewayId: "bob-desktop",
		});
		expect(h.calls.listenState[0]).toEqual({ listeningToken: "test-host.tok" });
	});

	it("cross_domain_listen_state is a fresh read: a retried opId re-runs (never cached)", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_listen_state", listeningToken: "test-host.tok" }, "dup-ls");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		// The receiver polls this, so each call must hit the coordinator (not replay a cached reply).
		expect(h.calls.listenState).toHaveLength(2);
	});

	it("cross_domain_list_peers returns the peer set, listing a linked-but-offline peer", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_list_peers" }, "lp1"));
		expect(reply.ok).toBe(true);
		// The roster carries every linked peer projected to (domainId, gatewayId), regardless of
		// online / shared-back state, so the offline peer is present and PeerDetail is reachable.
		expect(reply.result).toEqual({
			peers: [
				{ domainId: "bob", gatewayId: "bob-desktop", ownerSignPub: "bob-owner-key" },
				{ domainId: "carol", gatewayId: "carol-laptop", ownerSignPub: "carol-owner-key" },
			],
		});
		expect(h.calls.listPeers).toHaveLength(1);
	});

	it("cross_domain_list_peers is a fresh read: a retried opId re-runs (never cached)", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_list_peers" }, "dup-lp");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		// A roster read must reflect live peer-set state, so each poll hits the coordinator.
		expect(h.calls.listPeers).toHaveLength(2);
	});

	it("a bare cross_domain_cancel stays a sweep-only no-op (no token/pin forwarded)", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_cancel" }, "cx1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ cancelled: true });
		expect(h.calls.cancel).toHaveLength(1);
		// A bare cancel carries neither field, so the coordinator only sweeps.
		expect(h.calls.cancel[0]).toEqual({ listeningToken: undefined, pin: undefined });
	});

	it("cross_domain_cancel forwards the listening token + pin so the named window is invalidated", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_cancel", listeningToken: "test-host.tok", pin: "thepin" }, "cx2"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ cancelled: true });
		expect(h.calls.cancel).toHaveLength(1);
		// The token/pin reach the coordinator, which invalidates that window (so a subsequent
		// request to the token is rejected; see the coordinator's own cancel tests).
		expect(h.calls.cancel[0]).toEqual({ listeningToken: "test-host.tok", pin: "thepin" });
	});

	it("a retried cross_domain_confirm opId replays the cached reply without re-running", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_confirm", pin: "thepin", mySignedLink: link }, "dup-cf");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The coordinator's confirm ran ONCE (the opId cache absorbed the retry), so a
		// single-use pairing is never double-consumed by an honest retry.
		expect(h.calls.confirm).toHaveLength(1);
	});

	it("the cross_domain_* ops error cleanly when federation is not wired", async () => {
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});
		const reply = await handler.handleFrame(frame({ kind: "cross_domain_listen" }, "nf1"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
	});
});

describe("console cross-Domain unlink op", () => {
	// The unlink dep fans out to the three local cleanup primitives (peers / shares / jobs)
	// and returns their counts. The harness stands in a fake that records the domainId it was
	// called with and returns canned counts, so the dispatch wiring is observable end to end.
	function makeUnlinkHarness(
		opts: { counts?: Record<string, { peers: number; shares: number; jobs: number }> } = {},
	) {
		const calls: string[] = [];
		const counts = opts.counts ?? { carol: { peers: 1, shares: 2, jobs: 3 } };
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
			discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
		};
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes,
			// An unknown/already-unlinked Domain yields zero counts (the real primitives return 0).
			unlinkDomain: (domainId) => {
				calls.push(domainId);
				const c = counts[domainId] ?? { peers: 0, shares: 0, jobs: 0 };
				return { peersRemoved: c.peers, sharesDropped: c.shares, jobsExpired: c.jobs };
			},
		});
		return { handler, calls };
	}

	it("cross_domain_unlink runs the local cleanup and returns the counts", async () => {
		const h = makeUnlinkHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "carol" }, "ul1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ peersRemoved: 1, sharesDropped: 2, jobsExpired: 3 });
		expect(h.calls).toEqual(["carol"]);
	});

	it("unlinking an unknown/already-unlinked Domain is a clean zero-count success", async () => {
		const h = makeUnlinkHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "ghost" }, "ul2"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
		expect(h.calls).toEqual(["ghost"]);
	});

	it("a retried cross_domain_unlink opId replays the cached counts without re-running", async () => {
		const h = makeUnlinkHarness();
		const f = frame({ kind: "cross_domain_unlink", domainId: "carol" }, "dup-ul");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The opId cache absorbed the retry, so the cleanup ran exactly once - the second call
		// replays the first non-zero counts rather than re-running and reporting zero.
		expect(h.calls).toEqual(["carol"]);
	});

	it("cross_domain_unlink errors cleanly when federation is not wired", async () => {
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});
		const reply = await handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "carol" }, "nf-ul"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
	});
});
