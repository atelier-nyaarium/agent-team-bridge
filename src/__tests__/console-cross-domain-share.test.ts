import { describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { frame, jsonRes } from "./helpers/console.js";

describe("console cross-Domain share ops", () => {
	// A team list mixing every kind, so the kind gate can be exercised: a devcontainer and a
	// loose session are shareable; a session of an unrecognized kind, a console-kind device, and an
	// unknown name are not. Each team is a composite `spawn.session` local field; teams() carries
	// each team's gatewayId (the canonical target's gw).
	function teamsList(): Response {
		return jsonRes([
			{ team: "app.dev", gatewayId: "test-host", status: "online", kind: "devcontainer", queue_depth: 0 },
			{ team: "scratch-1.dev", gatewayId: "test-host", status: "online", kind: "loose", queue_depth: 0 },
			{ team: "unknown-kind.dev", gatewayId: "test-host", status: "online", kind: "unknown", queue_depth: 0 },
			{ team: "pixel.dev", gatewayId: "test-host", status: "online", kind: "console", queue_depth: 0 },
		]);
	}

	function makeShareHarness(opts: { linkedDomains?: string[] } = {}) {
		const linked = new Set(opts.linkedDomains ?? ["carol"]);
		const calls: Record<string, unknown[]> = { share: [], unshare: [], listShares: [], expireSessionJobs: [] };
		type ShareTarget = { kind: "domain"; domainId: string } | { kind: "everyone_trusted" };
		const tk = (t: ShareTarget) => (t.kind === "domain" ? `domain:${t.domainId}` : "everyone_trusted");
		// An in-memory share map so the dispatch's effect is observable end to end.
		const set = new Map<string, { sessionTarget: string; target: ShareTarget }>();
		const key = (sessionTarget: string, target: ShareTarget) => `${sessionTarget} ${tk(target)}`;
		const crossDomainShare = {
			share: (sessionTarget: string, target: ShareTarget) => {
				calls.share.push({ sessionTarget, target });
				set.set(key(sessionTarget, target), { sessionTarget, target });
			},
			unshare: (sessionTarget: string, target: ShareTarget): boolean => {
				calls.unshare.push({ sessionTarget, target });
				return set.delete(key(sessionTarget, target));
			},
			expireSessionJobsForTarget: (sessionTarget: string, target: ShareTarget) => {
				calls.expireSessionJobs.push({ sessionTarget, target });
			},
			listShares: () => {
				calls.listShares.push({});
				return [...set.values()];
			},
			isLinkedDomain: (domainId: string) => linked.has(domainId),
		};
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: teamsList,
			discover: async () => teamsList(),
		};
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes,
			crossDomainShare,
		});
		return { handler, calls, set };
	}

	it("cross_domain_share marks a devcontainer session shared (hits the store)", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"s1",
			),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.share).toEqual([
			{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } },
		]);
	});

	it("cross_domain_share allows a loose session", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.scratch-1.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"s2",
			),
		);
		expect(reply.ok).toBe(true);
		expect(h.calls.share).toHaveLength(1);
	});

	it("cross_domain_unshare withdraws a share AND expires its in-flight jobs (hits the store)", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"s1",
			),
		);
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_unshare",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"u1",
			),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.unshare).toEqual([
			{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } },
		]);
		expect(h.set.size).toBe(0);
		// The un-share also settled any in-flight cross-Domain job for this (session, friend)
		// pair so an already-accepted send's reply stops at the destination, not just fresh sends.
		expect(h.calls.expireSessionJobs).toEqual([
			{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } },
		]);
	});

	it("cross_domain_unshare on an absent share does NOT expire jobs (no-op stays cheap)", async () => {
		const h = makeShareHarness();
		// Nothing shared yet: the unshare removes nothing, so it must skip the job expiry.
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_unshare",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"u1",
			),
		);
		expect(reply.ok).toBe(true);
		expect(h.calls.unshare).toHaveLength(1);
		expect(h.calls.expireSessionJobs).toHaveLength(0);
	});

	it("cross_domain_list_shares returns the current shares (hits the store)", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"s1",
			),
		);
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "ls1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({
			shares: [{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } }],
		});
		expect(h.calls.listShares).toHaveLength(1);
	});

	it("rejects sharing a session of an unrecognized kind and never hits the store", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.unknown-kind.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"g1",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing a console-kind team", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.pixel.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"c1",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing an unknown session", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.nope.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"n1",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing a session on another Gateway (only local sessions)", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.other-gw.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"x1",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only local sessions");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing to an unlinked Domain and never hits the store", async () => {
		const h = makeShareHarness({ linkedDomains: ["carol"] });
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "dave" },
				},
				"d1",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not a linked Domain");
		expect(h.calls.share).toHaveLength(0);
	});

	it("a retried cross_domain_share opId replays the cached ack without re-running", async () => {
		const h = makeShareHarness();
		const f = frame(
			{
				kind: "cross_domain_share",
				sessionTarget: "test-domain.test-host.app.dev",
				target: { kind: "domain", domainId: "carol" },
			},
			"dup-s",
		);
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The opId cache absorbed the retry, so the store saw exactly one share.
		expect(h.calls.share).toHaveLength(1);
	});

	it("a retried cross_domain_unshare opId replays the cached ack without re-running", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-domain.test-host.app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"s1",
			),
		);
		const f = frame(
			{
				kind: "cross_domain_unshare",
				sessionTarget: "test-domain.test-host.app.dev",
				target: { kind: "domain", domainId: "carol" },
			},
			"dup-u",
		);
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		expect(h.calls.unshare).toHaveLength(1);
	});

	it("the share ops error cleanly when federation is not wired", async () => {
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
			},
		});
		const reply = await handler.handleFrame(
			frame(
				{
					kind: "cross_domain_share",
					sessionTarget: "test-host/app",
					target: { kind: "domain", domainId: "carol" },
				},
				"nf-s",
			),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
		const lr = await handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "nf-ls"));
		expect(lr.ok).toBe(false);
		expect(lr.error).toContain("not available");
	});

	// An UNDER-QUALIFIED share (the local `spawn.session` form, without the domain.gateway prefix)
	// must be stored under the CANONICAL `domain.gateway.spawn.session` key, the same form the relay
	// gate / sweep / discovery compare against. A local-form share ("app.dev") stored raw is filed as
	// "app.dev", so the relay's "test-domain.test-host.app.dev" lookup never matches and the share
	// silently never takes effect (fail-closed).
	it("an under-qualified share is stored under the canonical key the relay looks up", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{ kind: "cross_domain_share", sessionTarget: "app.dev", target: { kind: "domain", domainId: "carol" } },
				"bare-s",
			),
		);
		expect(reply.ok).toBe(true);
		// The store was handed the CANONICAL "test-domain.test-host.app.dev", not the raw local
		// "app.dev" - so the relay gate, which looks up the canonical key, will actually find it.
		expect(h.calls.share).toEqual([
			{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } },
		]);
		// And the canonical form is what list_shares (the console's read) reports.
		const lr = await h.handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "bare-ls"));
		expect(lr.result).toEqual({
			shares: [{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } }],
		});
	});

	it("an under-qualified unshare withdraws the canonical share it created", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame(
				{ kind: "cross_domain_share", sessionTarget: "app.dev", target: { kind: "domain", domainId: "carol" } },
				"bare-s",
			),
		);
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_unshare",
					sessionTarget: "app.dev",
					target: { kind: "domain", domainId: "carol" },
				},
				"bare-u",
			),
		);
		expect(reply.ok).toBe(true);
		// The unshare canonicalizes too, so it keys identically to the share and removes it.
		expect(h.calls.unshare).toEqual([
			{ sessionTarget: "test-domain.test-host.app.dev", target: { kind: "domain", domainId: "carol" } },
		]);
		expect(h.set.size).toBe(0);
	});
});
